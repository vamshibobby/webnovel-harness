/**
 * Arc planning checks: npx tsx src/arc.test.ts
 *
 * Offline and free. The streaming parser is the load-bearing piece — if a
 * block can close early, or a token boundary can lose a chapter, then showing
 * ten planned chapters one at a time is unsafe and the batch should have been
 * a tool call. So the gates are: identical output however the stream is
 * chopped, a malformed block costs only itself, and nothing is emitted before
 * the evidence that its block ended.
 */
import { authorKnownNames } from './engine/arcAgent.js';
import { BlueprintStream, findNewNames, newNamesInText, parseBlueprints } from './engine/arcParse.js';
import { buildKnownNames, newNamesInText as namesAgainst } from './lib/nameCheck.js';
import { authorPremiseText } from './lib/arcValidate.js';
import {
  ARC_LIMITS,
  applyArcPatch,
  emptyArc,
  firstUnplannedChapter,
  shiftArcAfterChapterDelete,
  slugifyArcTitle,
  validateArcPatch,
  ArcValidationError,
} from './lib/arcValidate.js';
import { ARC_TAGS, type ChapterBlueprint, type StoryArc } from './lib/types.js';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failures.push(label);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
}

const SAMPLE = `Here is the plan.

### CH 26
title: Cold Harbour
tags: political, negotiation
opens: Rennick reaches the Weighing House expecting an assayer and finds the counting floor emptied.
turn: A clerk still packing crates tells him the ledgers went south an hour ago, and names the wrong man as escort.
lands: He leaves knowing someone moved first, and that whoever it was used his own name to do it.

### CH 27
title: The Assayer
tags: investigation, tension, mystery
opens: The Salt Court's assayer catches him in the street before he can reach the Weavers Bridge.
turn: She asks to see the seal, and he stands beside his own forgery while a professional reads it aloud.
lands: She passes it and thanks him, which is a good deal worse than being caught would have been.
`;

// ── the happy path ────────────────────────────────────────────────────────
const whole = parseBlueprints(SAMPLE);
check('parses each block', whole.blueprints.length === 2, `got ${whole.blueprints.length}`);
check('no issues on a clean batch', whole.issues.length === 0, JSON.stringify(whole.issues));
check('chapter numbers come off the headers', whole.blueprints.map((b) => b.chapter).join() === '26,27');
check('summary is opens + turn + lands', whole.blueprints[0].summary === `${whole.blueprints[0].opens} ${whole.blueprints[0].turn} ${whole.blueprints[0].lands}`);
check('a blueprint carries enough for a chapter', whole.blueprints[0].summary.length >= 240, `${whole.blueprints[0].summary.length} chars`);
check('everything the model writes is marked as its own', whole.blueprints.every((b) => b.source === 'model'));
check('preamble before the first header is ignored', !JSON.stringify(whole.blueprints).includes('Here is the plan'));
check('unknown tags are dropped', !whole.blueprints[1].tags.includes('tension'), whole.blueprints[1].tags.join());
check('known tags survive', whole.blueprints[1].tags.includes('investigation'));
check('every kept tag is in the vocabulary', whole.blueprints.every((b) => b.tags.every((t) => (ARC_TAGS as readonly string[]).includes(t))));

// ── the gate that matters ─────────────────────────────────────────────────
function chunked(text: string, size: number): ChapterBlueprint[] {
  const out: ChapterBlueprint[] = [];
  const s = new BlueprintStream((bp) => out.push(bp), () => {});
  for (let i = 0; i < text.length; i += size) s.push(text.slice(i, i + size));
  s.end();
  return out;
}
const reference = JSON.stringify(whole.blueprints);
const broken = [1, 2, 3, 5, 7, 11, 13, 29, 64, 257].filter((n) => JSON.stringify(chunked(SAMPLE, n)) !== reference);
check('identical output at every chunk size, including 1 char', broken.length === 0, broken.length ? `differs at ${broken.join()}` : 'sizes 1..257');
check('a header split across tokens is still recognised', chunked(SAMPLE.replace('### CH 27', '##' + '# CH 2' + '7'), 3).length === 2);

// ── emission timing ───────────────────────────────────────────────────────
const live: ChapterBlueprint[] = [];
const stream = new BlueprintStream((bp) => live.push(bp), () => {});
stream.push(SAMPLE.slice(0, SAMPLE.indexOf('### CH 27')));
check('an unterminated block is NOT emitted early', live.length === 0, `got ${live.length}`);
stream.push('### CH 27\n');
check('the next header closes the previous block', live.length === 1, `got ${live.length}`);

// ── a malformed block costs only itself ───────────────────────────────────
const messy = parseBlueprints(SAMPLE.replace(/### CH 27[\s\S]*$/, '### CH 27\ntitle: Too Short\n'));
check('good blocks survive a bad neighbour', messy.blueprints.length === 1, `got ${messy.blueprints.length}`);
check('the bad block is reported', messy.issues.length === 1 && messy.issues[0].chapter === 27, JSON.stringify(messy.issues));

// A model that packed everything into `opens` planned the chapter fine — it
// just used the wrong headings, and must not lose the work.
const oneField = parseBlueprints(
  '### CH 30\ntitle: The Overlook\ntags: travel\n' +
    'opens: They climb to a hidden ledge above the canyon floor and wait for the noise to pass. ' +
    'Below, a Dominion patrol rides through in single file, unhurried. The boy points to a second ' +
    'path, thinner and steeper, that the patrol has plainly never used.\n'
);
check('all three movements in one field still parses', oneField.blueprints.length === 1, JSON.stringify(oneField.issues));

// ── decoration the planner was never asked for ────────────────────────────
// The format says plain labels. Models decorate anyway — it cost five of six
// sampled chapters their title elsewhere in this app, and here an unmatched
// pattern costs the whole batch rather than one field.
{
  const decorated = parseBlueprints(
    SAMPLE.replace('### CH 26', '## **CH 26**')
      .replace('### CH 27', '### **CH 27 — The Assayer**')
      .replace(/^opens:/gm, '**opens:**')
      .replace(/^title:/gm, '**title**:')
  );
  check(
    'a bolded header and bolded labels still parse',
    decorated.blueprints.length === 2,
    JSON.stringify(decorated.issues)
  );
  check(
    'emphasis is stripped out of the values, not kept in the prose',
    !JSON.stringify(decorated.blueprints).includes('**'),
    decorated.blueprints[0]?.opens.slice(0, 40)
  );
  check(
    'a title written on the header line is used when there is no title field',
    parseBlueprints(SAMPLE.replace('### CH 27', '### CH 27: The Assayer').replace('title: The Assayer\n', ''))
      .blueprints[1]?.title === 'The Assayer'
  );
  check(
    'a title field still wins over one on the header line',
    parseBlueprints(SAMPLE.replace('### CH 26', '### CH 26 — Wrong Title')).blueprints[0].title === 'Cold Harbour'
  );
}
{
  // A rule between blocks used to be glued onto the end of `lands`.
  const ruled = parseBlueprints(SAMPLE.replace('\n### CH 27', '\n---\n\n### CH 27'));
  check('a horizontal rule between blocks is punctuation, not content', !ruled.blueprints[0].lands.includes('--'), ruled.blueprints[0].lands.slice(-20));
  check('and both blocks survive it', ruled.blueprints.length === 2);
}

// ── who and context: the structure the planner now carries ────────────────
{
  const structured = parseBlueprints(
    SAMPLE.replace(
      'lands: He leaves knowing someone moved first, and that whoever it was used his own name to do it.',
      'lands: He leaves knowing someone moved first, and that whoever it was used his own name to do it.\n' +
        'who: Rennick, a dock clerk, the Salt Court\'s assayer, the Weighing House\n' +
        'context: The clerk reports to the Weavers. This is what chapter 34 turns on.'
    )
  );
  const first = structured.blueprints[0];
  check('who becomes a list of roles', first.roles?.length === 4, first.roles?.join(' | '));
  check('the roles keep the plan\'s own wording', first.roles?.includes('a dock clerk') === true, first.roles?.join(' | '));
  check(
    'context becomes future context, split into lines',
    first.futureContext?.length === 2,
    first.futureContext?.join(' | ')
  );
  check(
    'and it is the writer-only half, not something to reveal',
    first.futureContext?.[0] === 'The clerk reports to the Weavers.' && first.reveals === undefined
  );
  check(
    'neither field leaks into what happens',
    !first.summary.includes('Weavers') && !first.lands.includes('Rennick,'),
    first.lands.slice(-30)
  );
  check('the block with neither field keeps both absent', structured.blueprints[1].roles === undefined && structured.blueprints[1].futureContext === undefined);
}
{
  const none = parseBlueprints(
    SAMPLE.replace('title: Cold Harbour', 'title: Cold Harbour\nwho: the sister; the brother\ncontext: none')
  );
  check('"none" is an empty context, not a line saying none', none.blueprints[0].futureContext === undefined);
  check('a semicolon-separated who still splits', none.blueprints[0].roles?.length === 2, none.blueprints[0].roles?.join(' | '));
  check(
    'a bulleted who loses its bullets',
    parseBlueprints(SAMPLE.replace('title: Cold Harbour', 'title: Cold Harbour\nwho: - the sister, - the brother'))
      .blueprints[0].roles?.join('|') === 'the sister|the brother'
  );
  check(
    'a chapter is still valid with neither field',
    parseBlueprints(SAMPLE).blueprints.length === 2,
    'structure is structure, not a floor'
  );
}

// ── braided arcs: the thread/time bookkeeping ─────────────────────────────
// A multi-storyline arc opens `context` with two lines saying which thread the
// chapter belongs to and where it sits in time. Both of these went wrong on
// the first real braided run against a twelve-thread premise.
{
  // The failure exactly as it came back: the model separated the thread's
  // number from its name with "·" — a delimiter this field splits on — and
  // ended neither line with a full stop. Every line of a field is joined with
  // a space before splitting, so the Time line was swallowed by the orphaned
  // name fragment and 0 of 10 blueprints placed themselves in time.
  const run = parseBlueprints(
    SAMPLE.replace(
      'title: Cold Harbour',
      'title: Cold Harbour\ncontext: Thread: 2 · the Refsdal feud\n' +
        'Time: the same fortnight as ch 34, seen from the audit side\n' +
        'The kickbacks are already in the file, but nobody has read that far.'
    )
  ).blueprints[0].futureContext;

  check(
    'a thread line survives a "·" between its number and its name',
    run?.some((c) => /^thread\s*:/i.test(c)) === true,
    run?.join(' | ')
  );
  check(
    'and the time line beside it is not swallowed by it',
    run?.some((c) => /^time\s*:/i.test(c)) === true,
    run?.join(' | ')
  );
  check(
    'the withheld information after them is still its own line',
    run?.some((c) => c.startsWith('The kickbacks')) === true,
    run?.join(' | ')
  );

  // The well-formed shape the prompt actually asks for must keep working too.
  const clean = parseBlueprints(
    SAMPLE.replace(
      'title: Cold Harbour',
      'title: Cold Harbour\ncontext: Thread: the Refsdal feud (2). Time: a week after ch 34. ' +
        'The clerk reports to the Weavers.'
    )
  ).blueprints[0].futureContext;
  check(
    'the documented two-sentence form splits into three lines',
    clean?.length === 3,
    clean?.join(' | ')
  );
}

// A braided chapter spends its first two context lines on bookkeeping, so the
// cap has to leave room for the withheld information the field exists for.
check(
  'context holds the two bookkeeping lines and still has room to work',
  ARC_LIMITS.contextPerBlueprint >= 2 + 4,
  `${ARC_LIMITS.contextPerBlueprint} lines`
);

// The prompt asks each movement for "2 to 4 full sentences". Four sentences of
// a dense chapter ran 500-550 characters and 420 cut the last one mid-word.
check(
  'a movement cap can hold the four sentences the prompt asks for',
  ARC_LIMITS.blueprintPart >= 550,
  `${ARC_LIMITS.blueprintPart} chars`
);

// ── new-name detection ────────────────────────────────────────────────────
const known = new Set(['rennick', 'velmora', 'dominion']);
const withName = parseBlueprints(
  '### CH 31\ntitle: The Broker\ntags: intrigue\n' +
    'opens: Rennick reaches Velmora before the tide and finds the counting house shut against him. ' +
    'A broker called Marren offers to carry the ledger the rest of the way for a price he cannot pay. ' +
    'He leaves owing Marren a favour he does not understand yet, which is worse than owing money.\n'
).blueprints[0];
const names = findNewNames(withName, known);
check('a name the bible never heard of is caught', names.includes('Marren'), names.join());
check('known names are not flagged', !names.includes('Rennick') && !names.includes('Velmora'), names.join());
// The prod regression: a plan opened with "Six-year-old sister…" and the panel
// grew a character called Six. Hyphen-attached capitals are grammar, not names.
check(
  'a hyphenated age is not a name',
  newNamesInText('The sister leaves at dawn. Six-year-old hands cannot carry more.', known).length === 0,
  newNamesInText('The sister leaves at dawn. Six-year-old hands cannot carry more.', known).join()
);
check(
  'a real name after a hyphenated word is still caught',
  newNamesInText('The sister leaves at dawn. Six-year-old hands out bread while Marren watches.', known).join() ===
    'Marren'
);

// ── ordinary English is not an invented name ──────────────────────────────
// The production failure: refine wrote "the audit lands on Monday", the
// checker called Monday a character, three rounds could not not-write
// ordinary English, and the author lost the premise and forty beats. Each
// class gets its own check so a regression names what came back.
{
  const k = new Set(['adrian', 'skarv', 'meridia']);
  const flags = (s: string) => newNamesInText(s, k);
  check('a weekday is not a name', flags('The audit lands on Monday for him.').length === 0, flags('The audit lands on Monday for him.').join());
  check('a month is not a name', flags('The board meets him in March again.').length === 0, flags('The board meets him in March again.').join());
  check('a holiday is not a name', flags('He reads the board on Christmas Eve.').length === 0, flags('He reads the board on Christmas Eve.').join());
  check('a generic org noun is not a name', flags('He briefs the Division and the Board.').length === 0, flags('He briefs the Division and the Board.').join());
  check(
    'a morphological variant of a known name is not a name',
    flags('Adrian flies to Meridian offices this week.').length === 0,
    flags('Adrian flies to Meridian offices this week.').join()
  );
  check('a genuinely invented name is still caught', flags('A broker called Marren offers help.').join() === 'Marren');
}

// A capitalised word the author themselves wrote lowercase is business
// English, not a person — "retail and advice divisions" in the premise makes
// "the Retail Division" fine in the refine.
{
  const kn = buildKnownNames({
    bibleEntries: [],
    designs: [],
    novel: { title: 'Economical Genius', premise: '', styleNotes: '' },
    authorText: 'his marketing projects go from pilot to beta in both retail and advice divisions',
  });
  check(
    'a word the author wrote lowercase is not a name when capitalised',
    namesAgainst('The Retail beta lands while the Advice heads watch.', kn).length === 0,
    namesAgainst('The Retail beta lands while the Advice heads watch.', kn).join()
  );
  check(
    'the author writing "retail" does not clear "Marren"',
    namesAgainst('The beta grows while Marren runs the Retail side.', kn).join() === 'Marren',
    namesAgainst('The beta grows while Marren runs the Retail side.', kn).join()
  );
}

// ── a re-refine cannot launder a name the first refine invented ───────────
// authorKnownNames must read the AUTHOR'S text. After one refine the premise
// is model-written; feeding it back would approve every name that refine
// invented. previousPremise is where the author's own words live then.
{
  const laundered = authorKnownNames({
    novel: { title: 'Salt', premise: 'A courier.', styleNotes: '' },
    arcPremise: authorPremiseText({
      premise: 'Marren carries the ledger north.',
      premiseSource: 'model',
      previousPremise: 'Someone carries the ledger north.',
    }),
    bibleEntries: [],
    designs: [],
  });
  check('a model-written premise does not whitelist its own names', !laundered.has('marren'));
  const authored = authorPremiseText({ premise: 'Marren carries the ledger.', premiseSource: 'author', previousPremise: '' });
  check("the author's own premise is still their own", authored.includes('Marren'));
}

// ── validation ────────────────────────────────────────────────────────────
check('slug is kebab-case', slugifyArcTitle('The Salt Court!') === 'the-salt-court');
const arc = emptyArc('the-salt-court', 'The Salt Court', 2, 21);
check('a new arc owns a range', arc.fromChapter === 21 && arc.toChapter === 21);
check('a new arc does not steer', arc.steer === false);

let threw = false;
try {
  validateArcPatch({ nonsense: 1 });
} catch (e) {
  threw = e instanceof ArcValidationError;
}
check('unknown fields are refused', threw);

const patched = applyArcPatch(arc, validateArcPatch({ fromChapter: 21, toChapter: 5 }));
check('an inverted range is clamped, not rejected', patched.toChapter === 21, `to=${patched.toChapter}`);

const beats = validateArcPatch({ beats: ['the ledger is read', { text: 'the court summons him', source: 'model' }] }).beats!;
check('a bare string beat is accepted as the author\'s', beats[0].source === 'author');
check('a model beat keeps its provenance', beats[1].source === 'model');

// ── the premise has to hold a list of storylines ──────────────────────────
// The cap is in CHARACTERS. It was 4,000, and the premise that motivated the
// braided planner — eight months, eleven concurrent threads, each with its own
// timing and its own ending — is 5,769, so the author could not save it at all.
{
  const eleven = validateArcPatch({ premise: 'x'.repeat(6000) });
  check('a six-thousand-character premise saves', eleven.premise?.length === 6000);
  check(
    'the premise cap holds a multi-storyline arc',
    ARC_LIMITS.premise >= 10000,
    `${ARC_LIMITS.premise} chars`
  );
  let refused = false;
  try {
    validateArcPatch({ premise: 'x'.repeat(ARC_LIMITS.premise + 1) });
  } catch (e) {
    refused = e instanceof ArcValidationError;
  }
  check('and one character past the cap is still refused', refused);
}

// ── the limits must not contradict each other ────────────────────────
// A summary IS opens + turn + lands joined, so the summary cap has to be able
// to hold three full-length parts. It could not (1200 vs 1262), and because a
// PATCH carries every blueprint, one long chapter refused the whole arc's save.
check(
  'the summary cap can hold three full-length movements',
  ARC_LIMITS.blueprintSummary >= 3 * ARC_LIMITS.blueprintPart + 2,
  `summary ${ARC_LIMITS.blueprintSummary} vs 3 parts ${3 * ARC_LIMITS.blueprintPart + 2}`
);

const maximal = validateArcPatch({
  blueprints: [
    {
      chapter: 40,
      title: 'Long',
      tags: ['drama'],
      opens: 'o'.repeat(ARC_LIMITS.blueprintPart),
      turn: 't'.repeat(ARC_LIMITS.blueprintPart),
      lands: 'l'.repeat(ARC_LIMITS.blueprintPart),
    },
  ],
}).blueprints!;
check('three maximal parts validate rather than throwing', maximal.length === 1);
check(
  'and the joined summary survives whole',
  maximal[0].summary.length === 3 * ARC_LIMITS.blueprintPart + 2,
  `${maximal[0].summary.length} chars`
);

// An over-long summary with no parts is clipped, never refused: losing the
// last sentence beats losing the plan.
const overlong = validateArcPatch({
  blueprints: [{ chapter: 41, title: 'X', tags: [], summary: 'x'.repeat(5000) }],
}).blueprints!;
check(
  'an over-long summary is clipped, not rejected',
  overlong[0].summary.length === ARC_LIMITS.blueprintSummary
);

// ── where planning starts (the backfill case) ─────────────────────────────
const backfilled: StoryArc = { ...arc, fromChapter: 21, toChapter: 70, blueprints: [] };
check(
  'an arc covering written chapters starts planning after them',
  firstUnplannedChapter(backfilled, 30) === 31,
  `got ${firstUnplannedChapter(backfilled, 30)}`
);
check(
  'an arc ahead of the story starts at its own beginning',
  firstUnplannedChapter({ ...backfilled, fromChapter: 40 }, 30) === 40
);
check(
  'planning resumes after what is already planned',
  firstUnplannedChapter({ ...backfilled, blueprints: [{ chapter: 35 } as ChapterBlueprint] }, 30) === 36
);

// ── deleting a chapter must not slide the forward plan ────────────────────
/*
 * Reported: the author deleted chapter 12 — the last one written — in order to
 * rewrite it, and found the plan FOR chapter 12 gone and chapter 13's plan in
 * its place. Every later blueprint had slid down one with it, so the whole
 * forward plan pointed at the wrong chapter and nothing said so.
 *
 * The rule the fix turns on: a blueprint numbers a chapter that has not been
 * written, so it may only move when a written chapter actually moved.
 */
const planned: StoryArc = {
  ...arc,
  fromChapter: 1,
  toChapter: 20,
  blueprints: [11, 12, 13, 14, 16].map((chapter) => ({ chapter, title: `plan ${chapter}` } as ChapterBlueprint)),
};
const numbers = (a: StoryArc): number[] => a.blueprints.map((b) => b.chapter);
const titles = (a: StoryArc): string[] => a.blueprints.map((b) => b.title);

// n was the last written chapter: nothing moved, so nothing may move.
const lastDeleted = shiftArcAfterChapterDelete(planned, 12, false);
check(
  'deleting the last chapter keeps the plan for it',
  numbers(lastDeleted).includes(12) && titles(lastDeleted).includes('plan 12'),
  titles(lastDeleted).join(', ')
);
check(
  'and does not slide the chapters planned after it',
  JSON.stringify(numbers(lastDeleted)) === JSON.stringify([11, 12, 13, 14, 16]),
  numbers(lastDeleted).join(',')
);
check(
  'and leaves the arc range alone',
  lastDeleted.fromChapter === 1 && lastDeleted.toChapter === 20,
  `${lastDeleted.fromChapter}-${lastDeleted.toChapter}`
);
check('the arc is returned untouched, not rebuilt', lastDeleted === planned);

// n had chapters above it: those really did move, so their plans follow.
const middleDeleted = shiftArcAfterChapterDelete(planned, 12, true);
check(
  'deleting a middle chapter drops the plan that described it',
  !titles(middleDeleted).includes('plan 12'),
  titles(middleDeleted).join(', ')
);
check(
  'and moves every later plan down with its chapter',
  JSON.stringify(numbers(middleDeleted)) === JSON.stringify([11, 12, 13, 15]),
  numbers(middleDeleted).join(',')
);
check(
  'the plan now at 12 is the one that was at 13',
  middleDeleted.blueprints.find((b) => b.chapter === 12)?.title === 'plan 13'
);
check(
  'and the range shifts with it',
  middleDeleted.fromChapter === 1 && middleDeleted.toChapter === 19,
  `${middleDeleted.fromChapter}-${middleDeleted.toChapter}`
);
check(
  'an arc entirely inside the deleted region is clamped, never emptied',
  ((a) => a.fromChapter === 1 && a.toChapter === 1)(
    shiftArcAfterChapterDelete({ ...planned, fromChapter: 1, toChapter: 1 }, 5, true)
  )
);

console.log(`\n${passed}/${passed + failures.length} passed`);
if (failures.length) {
  console.log('failed:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
