/**
 * Arc cast checks: npx tsx src/cast.test.ts
 *
 * Offline and free. Everything the cast pass decides is pure by construction —
 * runCastPass does the I/O, parseCast and substituteCast and formatCastBlock do
 * not — and that is a design constraint rather than an accident, because these
 * are the parts that rewrite an author's plan and leak a character's secrets if
 * they are wrong.
 *
 * The gates: a role phrase substitutes to a CAPITALISED name (the whole reason
 * applySubstitution exists), a mention scoped to one chapter cannot touch
 * another, the summary stays equal to its three parts, every refusal comes back
 * as a correctable string rather than a throw, and nothing marked unrevealed
 * ever appears on the "may use" side.
 */
import { authorKnownNames, checkRefineNames } from './engine/arcAgent.js';
import {
  expandMention,
  formatCastBlock,
  parseCast,
  parseCastContext,
  substituteCast,
  type CastAssignment,
} from './engine/arcCast.js';
import { ARC_LIMITS, validateBlueprint } from './lib/arcValidate.js';
import type {
  BibleEntry,
  BlueprintCastMember,
  CharacterDesign,
  ChapterBlueprint,
} from './lib/types.js';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failures.push(label);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
}

function blueprint(chapter: number, parts: Partial<ChapterBlueprint>): ChapterBlueprint {
  const opens = parts.opens ?? '';
  const turn = parts.turn ?? '';
  const lands = parts.lands ?? '';
  return {
    chapter,
    title: parts.title ?? `Chapter ${chapter}`,
    tags: [],
    opens,
    turn,
    lands,
    summary: parts.summary ?? [opens, turn, lands].filter(Boolean).join(' '),
    source: parts.source ?? 'model',
    ...(parts.newNames ? { newNames: parts.newNames } : {}),
    ...(parts.cast ? { cast: parts.cast } : {}),
  };
}

function entry(id: string, over: Partial<BibleEntry> = {}): BibleEntry {
  return {
    id,
    type: 'character',
    name: over.name ?? id,
    aliases: [],
    summary: '',
    status: '',
    attributes: {},
    facts: [],
    relationships: [],
    firstChapter: 1,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

// ── expandMention ─────────────────────────────────────────────────────────

console.log('\nexpandMention');
check(
  'widens over the article the model left off',
  expandMention('Rennick waits while a dock clerk seals the crate.', 'dock clerk') === 'a dock clerk'
);
check(
  'does not widen a mention that already has its article',
  expandMention('Rennick waits while a dock clerk seals the crate.', 'a dock clerk') === 'a dock clerk'
);
check(
  'widens over a possessive determiner',
  expandMention('He ignores her assayer entirely.', 'assayer') === 'her assayer'
);
check(
  'leaves a mention at the start of the text alone',
  expandMention('Dock clerks are not paid to argue.', 'Dock clerks') === 'Dock clerks'
);
check(
  'takes the text’s own casing, not the model’s',
  expandMention('The Dock Clerk refuses him.', 'dock clerk') === 'The Dock Clerk'
);
check(
  'returns the mention untouched when it is not in the text',
  expandMention('Nobody is here.', 'a dock clerk') === 'a dock clerk'
);

// ── substituteCast ────────────────────────────────────────────────────────

console.log('\nsubstituteCast');

const assignments: CastAssignment[] = [
  {
    name: 'Wenna Skarrow',
    note: 'a dock clerk at the Salt Quay',
    mentions: ['a dock clerk', 'the clerk'],
    chapters: [26],
  },
];

const ch26 = blueprint(26, {
  opens: 'Rennick reaches the Weighing House at first light and finds the counting floor emptied of everyone but a dock clerk.',
  turn: 'The clerk tells him the ledgers went south an hour ago, and names the wrong man as their escort.',
  lands: 'He leaves knowing someone moved first, and that they used his own name to do it.',
});
const out26 = substituteCast(ch26, assignments);

check(
  'a lowercase role phrase becomes a CAPITALISED name',
  out26.blueprint.opens.includes('Wenna Skarrow') && !out26.blueprint.opens.includes('wenna skarrow'),
  out26.blueprint.opens.slice(-40)
);
check(
  'a sentence-initial mention keeps its capital and is still replaced',
  out26.blueprint.turn.startsWith('Wenna Skarrow tells him'),
  out26.blueprint.turn.slice(0, 30)
);
check('every occurrence is counted', out26.substituted === 2, String(out26.substituted));
check(
  'summary stays equal to the three parts joined',
  out26.blueprint.summary ===
    [out26.blueprint.opens, out26.blueprint.turn, out26.blueprint.lands].filter(Boolean).join(' ')
);
check('the previous wording is kept so the row can show what changed', out26.blueprint.previousSummary === ch26.summary);
check('a cast member is attached', out26.blueprint.cast?.[0]?.name === 'Wenna Skarrow');
check(
  'someone the novel does not have yet carries no bible id',
  out26.blueprint.cast?.[0]?.entryId === undefined,
  'the plan owns them, not the bible'
);
check('and carries the one line about who they are', out26.blueprint.cast?.[0]?.note === 'a dock clerk at the Salt Quay');
check('source is not flipped by a substitution', out26.blueprint.source === 'model');

const ch29 = blueprint(29, {
  opens: 'A different clerk, older and slower, keeps the ledgers at the Salt Quay and will not look up.',
  turn: 'Rennick waits an hour before the clerk admits the second book exists at all.',
  lands: 'He walks out with a name and no proof of anything behind it.',
});
const out29 = substituteCast(ch29, assignments);
check(
  'a mention scoped to chapter 26 does not touch chapter 29',
  out29.substituted === 0 && out29.blueprint === ch29
);

const authored = blueprint(31, {
  summary: 'Rennick corners a dock clerk in the rain and gets the truth out of him at last.',
  source: 'author',
});
const outAuthored = substituteCast(authored, [{ ...assignments[0], chapters: [31] }]);
check(
  'an author-edited blueprint with no parts still substitutes into its summary',
  outAuthored.blueprint.summary.includes('Wenna Skarrow'),
  outAuthored.blueprint.summary
);
check('an author-edited blueprint stays the author’s', outAuthored.blueprint.source === 'author');

const already = substituteCast(
  blueprint(26, { opens: 'Wenna Skarrow is already here and already named.' }),
  [{ ...assignments[0], mentions: ['Wenna Skarrow'] }]
);
check('a mention that is already the name is not substituted onto itself', already.substituted === 0);
check(
  'and nothing was attempted, so a re-accept does not read as an author edit',
  already.attempted === 0
);
{
  // The real "you edited this while the panel was open" case: phrases to
  // apply, none of them still in the text.
  const moved = substituteCast(blueprint(26, { opens: 'The whole scene was rewritten overnight.' }), assignments);
  check('a chapter whose phrase is gone reports an attempt that found nothing', moved.attempted > 0 && moved.substituted === 0);
}

const twice = substituteCast(out26.blueprint, [
  { name: 'Serel Vance', note: 'the assayer', mentions: ['the wrong man'], chapters: [26] },
]);
check(
  'a second pass adds to the cast rather than forgetting the first',
  twice.blueprint.cast?.length === 2 &&
    twice.blueprint.cast.some((m) => m.name === 'Wenna Skarrow') &&
    twice.blueprint.cast.some((m) => m.name === 'Serel Vance')
);

// ── parseCast ─────────────────────────────────────────────────────────────

console.log('\nparseCast');

const batch = [ch26, ch29];
const entries = [entry('serel-vance', { name: 'Serel Vance' })];

function refusal(cast: unknown, label: string, fragment: string): void {
  const result = parseCast({ cast }, batch, entries);
  const ok = typeof result === 'string' && result.startsWith('Error:') && result.includes(fragment);
  check(label, ok, typeof result === 'string' ? result.slice(0, 80) : 'parsed');
}

refusal(
  [{ role: 'the clerk', kind: 'character', mentions: ['a dock clerk'], chapters: [26], entryId: 'nobody' }],
  'an unknown entry id is refused with the id named',
  'nobody'
);
refusal(
  [{ role: 'the clerk', kind: 'character', mentions: ['a dock clerk'], chapters: [41] }],
  'a chapter outside the batch is refused',
  'chapter 41'
);
refusal(
  [{ role: 'the clerk', kind: 'character', mentions: ['a warehouse supervisor'], chapters: [26] }],
  'a paraphrased mention is refused — the load-bearing check',
  'exactly as the blueprint writes it'
);
refusal(
  [{ role: 'the clerk', kind: 'wizard', mentions: ['a dock clerk'], chapters: [26] }],
  'an invented kind is refused with the list',
  'is not a kind'
);
refusal(
  [{ role: 'the clerk', kind: 'character', mentions: ['him'], chapters: [26] }],
  'a mention too short to replace safely is refused',
  'too short'
);
refusal(
  [{ role: 'the clerk', kind: 'character', mentions: ['a dock clerk'], chapters: [] }],
  'a row with no chapters is refused',
  'no chapters'
);
refusal('not an array', 'a non-array cast is refused', 'must be an array');

{
  // One entity on two rows is the model failing at the dedup the pass exists
  // for — code can union the rows more reliably than a repair round can.
  const merged = parseCast(
    {
      cast: [
        { role: 'the dock clerk', kind: 'character', mentions: ['a dock clerk'], chapters: [26], recurs: false },
        { role: 'a dock clerk', kind: 'character', mentions: ['The clerk'], chapters: [26], recurs: true },
      ],
    },
    batch,
    entries
  );
  check(
    'one entity split across two rows is merged, not refused',
    Array.isArray(merged) && merged.length === 1,
    Array.isArray(merged) ? `${merged.length} rows` : merged.slice(0, 60)
  );
  if (Array.isArray(merged) && merged.length === 1) {
    check(
      'the merge unions the phrase map',
      merged[0].mentions.length === 2 && merged[0].mentions.includes('The clerk')
    );
    check('a twin that recurs makes the merged row recur', merged[0].recurs === true);
  }
}

{
  // Every repair round is a full re-answer, so all the problems have to come
  // back at once — one-at-a-time is where the first prod run's minutes went.
  const multi = parseCast(
    {
      cast: [
        { role: 'the clerk', kind: 'wizard', mentions: ['a dock clerk'], chapters: [26] },
        { role: 'the assayer', kind: 'character', mentions: ['a warehouse supervisor'], chapters: [26] },
      ],
    },
    batch,
    entries
  );
  check(
    'every problem is reported in one refusal',
    typeof multi === 'string' &&
      multi.includes('is not a kind') &&
      multi.includes('exactly as the blueprint writes it'),
    typeof multi === 'string' ? multi.slice(0, 60) : 'parsed'
  );
}

const parsed = parseCast(
  {
    cast: [
      { role: 'the dock clerk', kind: 'character', mentions: ['dock clerk', 'The clerk'], chapters: [26], recurs: true },
      { role: 'the assayer', kind: 'character', entryId: 'serel-vance', mentions: ['the ledgers'], chapters: [26, 29], recurs: false },
    ],
  },
  batch,
  entries
);
check('a clean answer parses', Array.isArray(parsed) && parsed.length === 2);
if (Array.isArray(parsed)) {
  check('an existing entity keeps its id', parsed[1].entryId === 'serel-vance');
  check('a new entity has no id', parsed[0].entryId === null);
  check('recurs survives as written', parsed[0].recurs === true && parsed[1].recurs === false);
  check('chapters are deduped and sorted', parsed[1].chapters.join(',') === '26,29');
  check('rows get stable ids', parsed[0].id.startsWith('c') && parsed[0].id !== parsed[1].id);
}
check(
  'an empty cast is a valid answer, not an error',
  Array.isArray(parseCast({ cast: [] }, batch, entries))
);

// ── formatCastBlock ───────────────────────────────────────────────────────

console.log('\nformatCastBlock');

const design: CharacterDesign = {
  id: 'serel-vance',
  name: 'Serel Vance',
  linkedEntryId: 'serel-vance',
  state: 'active',
  steer: false,
  essentials: { role: "the Salt Court's assayer", age: '40s', appearance: '', voice: 'flat and short' },
  motivation: { want: '', need: '', fear: '', lie: 'she owes the Court nothing' },
  personality: { traits: [], flaws: [], virtues: [] },
  history: {
    backstory: '',
    secrets: [
      { text: 'she refused the Weavers’ retainer', revealed: true },
      { text: 'she already knows the seal is forged', revealed: false },
    ],
  },
  arcs: [],
  relationships: [],
  notes: '',
  createdAt: 0,
  updatedAt: 0,
};

const cast: BlueprintCastMember[] = [
  { name: 'Serel Vance', note: 'the assayer', entryId: 'serel-vance' },
  { name: 'Wenna Skarrow', note: 'a dock clerk at the Salt Quay' },
];

const blockEntries = [
  entry('serel-vance', {
    name: 'Serel Vance',
    summary: 'Reads seals for a living.',
    firstChapter: 12,
    attributes: { role: 'assayer' },
    facts: [{ text: 'Refused the Weavers’ retainer', chapter: 19 }],
  }),
];

const block = formatCastBlock(
  { cast, reveals: ['The second ledger exists.'], futureContext: ['The clerk reports to the Weavers.'] },
  blockEntries,
  [design],
  { namingOn: false }
);

check('a matched member is enriched from the live entry', block.includes('In the story since chapter 12'));
check(
  'a member the novel does not have yet says exactly that',
  block.includes('Wenna Skarrow — a dock clerk at the Salt Quay. New to the story here'),
  block.split('\n').find((l) => l.startsWith('Wenna'))
);
check(
  'and gets no "may use", because nothing about them is true yet',
  !block.split('Wenna Skarrow')[1].split('THIS CHAPTER')[0].includes('may use'),
  'inventing detail for someone who does not exist is the thing to avoid'
);
check('an unrevealed secret is on the never-state side', block.includes('never state or hint: she already knows the seal is forged'));
check(
  'an unrevealed secret is NOT on the may-use side',
  !block.split('never state or hint')[0].includes('already knows the seal is forged')
);
check('a revealed secret is usable', block.includes('she refused the Weavers’ retainer'));
check('the lie the character believes is withheld', block.includes('she owes the Court nothing'));
check('a fact carries its chapter provenance', block.includes('(ch 19)'));

check('planned reveals get their own section', block.includes('THIS CHAPTER PUTS IN FRONT OF THE READER:\n- The second ledger exists.'));
check(
  'future context is stated as a prohibition, not as background',
  block.includes('FUTURE CONTEXT') &&
    block.includes('Do not state it, hint at it, foreshadow it') &&
    block.includes('- The clerk reports to the Weavers.')
);
check(
  'future context never appears under may use',
  !block.split('FUTURE CONTEXT')[0].includes('reports to the Weavers'),
  'the whole point is that the writer must not put it on the page'
);
check(
  'with naming off, the author is asked to leave extras unnamed',
  block.trimEnd().endsWith('and the author will name it.')
);
check(
  'with naming on, the writer is pointed at coin_name instead',
  formatCastBlock({ cast }, blockEntries, [design], { namingOn: true }).includes('coin_name')
);
check('an empty blueprint produces no block at all', formatCastBlock({}, blockEntries, [], { namingOn: false }) === '');
check(
  'context alone still produces a block',
  formatCastBlock({ futureContext: ['x'] }, [], [], { namingOn: false }).includes('FUTURE CONTEXT')
);
check(
  'a cast whose bible entry was deleted still renders from the plan',
  formatCastBlock({ cast }, [], [], { namingOn: false }).includes('Serel Vance'),
  'the plan carries its own cast; the bible only enriches it'
);

// ── roles: the planner's own cast, before anyone is named ─────────────────
{
  const roleBlock = formatCastBlock(
    { roles: ['the sister', 'a dock clerk', 'the Weighing House'] },
    [],
    [],
    { namingOn: false }
  );
  check('a chapter planned but not yet cast still says who is in it', roleBlock.includes('- a dock clerk'), roleBlock.split('\n')[0]);
  check(
    'and the writer is told to keep the plan’s wording rather than name them',
    roleBlock.includes('not a name you chose') && roleBlock.includes("the author's to do")
  );
  check(
    'with naming on, coin_name is the sanctioned route instead',
    formatCastBlock({ roles: ['a dock clerk'] }, [], [], { namingOn: true }).includes('coin_name')
  );
  check(
    'roles are never presented as names to use exactly',
    !roleBlock.includes('use these names exactly'),
    'telling a writer to name someone "a dock clerk" is the failure here'
  );

  /*
   * The supersede rule, which is the whole reason roles and cast are separate
   * fields: after the author names the cast, the un-named list must not still
   * be in the block. A writer given both is given two different sets of people.
   */
  const superseded = formatCastBlock(
    { cast, roles: ['a dock clerk', 'the assayer'] },
    blockEntries,
    [design],
    { namingOn: false }
  );
  check(
    'a named cast supersedes the planner’s roles',
    !superseded.includes('- a dock clerk') && !superseded.includes('IN THIS CHAPTER'),
    'naming the cast is what settles them'
  );
  check('and the names are what survives', superseded.includes('Wenna Skarrow'));

  check(
    'roles alone still produce a block',
    formatCastBlock({ roles: ['the sister'] }, [], [], { namingOn: false }) !== ''
  );
}

// ── parseCastContext ──────────────────────────────────────────────────────

console.log('\nparseCastContext');
{
  const parsedContext = parseCastContext(
    {
      context: [
        { chapter: 29, reveals: ['b'], future: [] },
        { chapter: 26, reveals: ['a'], future: ['secret'] },
        { chapter: 41, reveals: ['nope'] },
        { chapter: 26, reveals: ['twin'] },
        { chapter: 29 },
      ],
    },
    batch
  );
  check('context is sorted by chapter', parsedContext.map((c) => c.chapter).join(',') === '26,29');
  check('a chapter outside the batch is dropped, not refused', !parsedContext.some((c) => c.chapter === 41));
  check('a duplicate chapter keeps the first', parsedContext[0].reveals[0] === 'a');
  check('both buckets survive', parsedContext[0].future[0] === 'secret');
  check('an entry with nothing in it is dropped', parsedContext.length === 2);
}

// ── the completeness net ──────────────────────────────────────────────────

console.log('\ncompleteness net');
{
  /*
   * The regression that broke the first version: refine invented "Marren", the
   * name reached the blueprints, and every scan that could have caught it was
   * built from a `known` set that included the premise refine had just written.
   */
  const leaked = blueprint(26, {
    opens: 'Marren waits at the counting floor with the ledgers already boxed and sealed.',
    turn: 'Rennick asks who signed for them and Marren gives a name that means nothing to him.',
    lands: 'He leaves with a name and no idea who it belongs to.',
  });
  const authorNames = authorKnownNames({
    novel: { title: 'Salt', premise: 'Rennick works the docks.', styleNotes: '' },
    arcPremise: '',
    bibleEntries: [],
    designs: [],
  });

  const silent = parseCast({ cast: [] }, [leaked], [], authorNames);
  check(
    'a cast answer that ignores a name in the plan is refused',
    typeof silent === 'string' && silent.includes('Marren') && silent.includes('chapter 26'),
    typeof silent === 'string' ? silent.slice(0, 90) : 'parsed'
  );
  check(
    'without the net the same answer would have passed — which is the old bug',
    Array.isArray(parseCast({ cast: [] }, [leaked], []))
  );

  const accounted = parseCast(
    {
      cast: [
        {
          role: 'the clerk holding the ledgers',
          kind: 'character',
          currentName: 'Marren',
          mentions: ['Marren'],
          chapters: [26],
          recurs: true,
        },
      ],
    },
    [leaked],
    [],
    authorNames
  );
  check('accounting for it passes', Array.isArray(accounted));
  check(
    'and it comes back as a row carrying the name the plan already uses',
    Array.isArray(accounted) && accounted[0].currentName === 'Marren'
  );
}

// ── refine name enforcement ───────────────────────────────────────────────

console.log('\ncheckRefineNames');
{
  const known = authorKnownNames({
    novel: { title: 'Salt', premise: 'Rennick works the docks at Hallow Quay.', styleNotes: '' },
    arcPremise: 'Rennick loses the ledger.',
    bibleEntries: [entry('serel-vance', { name: 'Serel Vance', aliases: ['the assayer'] })],
    designs: [],
  });

  check(
    'a refine that invents a character is refused with a correctable error',
    (checkRefineNames('Rennick meets Marren at the quay.', [], known) ?? '').startsWith('Error:')
  );
  check(
    'the refusal names what was invented and says what to do instead',
    (checkRefineNames('Rennick meets Marren.', [], known) ?? '').includes('"Marren"') &&
      (checkRefineNames('Rennick meets Marren.', [], known) ?? '').includes('unnamed role')
  );
  check('a name invented in a BEAT is caught too', checkRefineNames('', ['They reach Vellhold by dusk.'], known) !== null);
  check(
    'names the author already owns pass',
    checkRefineNames('Rennick asks Serel Vance about Hallow Quay.', ['Rennick loses the ledger.'], known) === null
  );
  check('an alias counts as owned', checkRefineNames('The assayer refuses him.', [], known) === null);
  check('unnamed roles pass, which is what refine is told to use', checkRefineNames('A dock clerk refuses him.', [], known) === null);
}

// ── validation round-trip ─────────────────────────────────────────────────

console.log('\nvalidateBlueprint');

const roundTripped = validateBlueprint(
  {
    ...out26.blueprint,
    cast: [...(out26.blueprint.cast ?? []), { note: 'no name' }],
    reveals: ['a reveal'],
    futureContext: ['a secret'],
  },
  0
);
check('a valid cast row survives a patch', roundTripped.cast?.[0]?.name === 'Wenna Skarrow');
check('a row with no name is dropped, not rejected', roundTripped.cast?.length === 1);
check('reveals and future context survive', roundTripped.reveals?.[0] === 'a reveal' && roundTripped.futureContext?.[0] === 'a secret');
check(
  'a blueprint with none of it keeps the fields absent',
  validateBlueprint(ch29, 0).cast === undefined && validateBlueprint(ch29, 0).futureContext === undefined
);
check(
  'roles survive a patch round-trip',
  validateBlueprint({ ...ch26, roles: ['the sister', 'a dock clerk'] }, 0).roles?.length === 2
);
check(
  'duplicate roles collapse',
  validateBlueprint({ ...ch26, roles: ['the sister', 'the sister'] }, 0).roles?.length === 1
);
check(
  'roles are capped per blueprint',
  (validateBlueprint({ ...ch26, roles: Array.from({ length: 20 }, (_, i) => `r${i}`) }, 0).roles?.length ?? 0) === 8
);
check(
  'cast written by the first version of this feature still loads',
  validateBlueprint({ ...ch26, cast: [{ entryId: 'x', name: 'X', mention: 'the x', origin: 'coined' }] }, 0).cast?.[0]
    ?.note === 'the x',
  'the old mention becomes the note rather than a blank line'
);
check(
  'cast is capped per blueprint',
  (validateBlueprint(
    { ...ch26, cast: Array.from({ length: 20 }, (_, i) => ({ name: `N${i}`, note: 'x' })) },
    0
  ).cast?.length ?? 0) === 8
);
check(
  'context is capped per blueprint',
  (validateBlueprint({ ...ch26, futureContext: Array.from({ length: 20 }, (_, i) => `s${i}`) }, 0).futureContext
    ?.length ?? 0) === ARC_LIMITS.contextPerBlueprint,
  // Read from the limit rather than repeated as a literal: this cap moved when
  // braided arcs started spending the first two lines on thread bookkeeping,
  // and a hardcoded 6 here failed for no reason a reader could see.
  `${ARC_LIMITS.contextPerBlueprint} lines`
);

console.log(`\n${passed}/${passed + failures.length} passed`);
if (failures.length) {
  console.log('failed:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
