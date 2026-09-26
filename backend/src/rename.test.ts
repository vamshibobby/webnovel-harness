// Offline checks: npx tsx src/rename.test.ts (no network, no API key)
//
// Renaming touches every document a novel has, including forty chapters of
// prose the author cannot easily check by eye. Every rule in renameText.ts came
// out of a way the obvious version gets that wrong, so each has an assertion
// here, and planRename is pinned field by field — a field silently missed from
// the cascade is a novel that contradicts itself and no error anywhere.
import { planRename, DEFAULT_RENAME_OPTIONS, type RenameDocs } from './engine/naming/rename.js';
import {
  applyRename,
  applySubstitution,
  compileRename,
  countRename,
  matchCase,
  type RenamePair,
} from './lib/renameText.js';
import type { BibleEntry, Chapter, CharacterDesign, Novel, StoryArc } from './lib/types.js';
import type { GeoMap } from './engine/map/types.js';

let passed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) passed++;
  else failures.push(detail ? `${label} — ${detail}` : label);
}

/** Rewrite `text` with one or more pairs, the way a route would. */
function rename(text: string, pairs: RenamePair[]): string {
  const re = compileRename(pairs);
  return re ? applyRename(text, re, pairs).text : text;
}

function hits(text: string, pairs: RenamePair[]): number {
  const re = compileRename(pairs);
  return re ? countRename(text, re, pairs).count : 0;
}

const KAEL: RenamePair[] = [{ from: 'Kael', to: 'Ryn' }];

// ── Whole-word matching ────────────────────────────────────────────────────

{
  check('a plain name is replaced', rename('Kael waited.', KAEL) === 'Ryn waited.');
  check(
    'a longer name containing it is left alone',
    rename('Kaelen waited.', KAEL) === 'Kaelen waited.',
    rename('Kaelen waited.', KAEL)
  );
  check('a name inside a word is left alone', rename('unKaelish', KAEL) === 'unKaelish');
  check(
    "a possessive survives",
    rename("Kael's sword", KAEL) === "Ryn's sword",
    rename("Kael's sword", KAEL)
  );
  check(
    'a curly possessive survives',
    rename('Kael’s sword', KAEL) === 'Ryn’s sword',
    rename('Kael’s sword', KAEL)
  );
  check('punctuation around it is kept', rename('"Kael," she said.', KAEL) === '"Ryn," she said.');
  check('a hyphen is a boundary', rename('Kael-born', KAEL) === 'Ryn-born');
}

{
  // `\b` is ASCII-word-based, so it breaks on exactly the names invented
  // worlds use. These three are the regression.
  check("an apostrophe name matches", rename("Zh'ar fell.", [{ from: "Zh'ar", to: 'Venn' }]) === 'Venn fell.');
  check(
    'a hyphenated name matches',
    rename('Al-Rashid waited.', [{ from: 'Al-Rashid', to: 'Hask' }]) === 'Hask waited.'
  );
  check(
    'an accented name matches',
    rename('Rénka waited.', [{ from: 'Rénka', to: 'Hask' }]) === 'Hask waited.'
  );
  check(
    'either apostrophe in the source matches',
    rename('Zh’ar fell.', [{ from: "Zh'ar", to: 'Venn' }]) === 'Venn fell.'
  );
}

{
  const across = 'She found Kael\nVeyron at the gate.';
  check(
    'a name broken across a line break still matches',
    rename(across, [{ from: 'Kael Veyron', to: 'Ryn Ashgrove' }]) === 'She found Ryn Ashgrove at the gate.',
    rename(across, [{ from: 'Kael Veyron', to: 'Ryn Ashgrove' }])
  );
}

// ── Case preservation ──────────────────────────────────────────────────────

{
  check('shouted dialogue stays shouted', rename('"KAEL!"', KAEL) === '"RYN!"');
  check('a generic lowercase use stays lowercase', rename('the kael blade', KAEL) === 'the ryn blade');
  check('title case takes the author’s spelling', rename('Kael', KAEL) === 'Ryn');
  check(
    'mixed case is not second-guessed',
    rename('McKay', [{ from: 'McKay', to: 'Ashgrove' }]) === 'Ashgrove',
    'inventing internal capitals is worse than keeping the author’s'
  );
  check('matchCase handles a single capital letter', matchCase('K', 'R') === 'R');
}

// ── Multiple pairs, one pass ───────────────────────────────────────────────

{
  const pairs: RenamePair[] = [
    { from: 'Kael', to: 'Ryn' },
    { from: 'Kael Veyron', to: 'Ryn Ashgrove' },
    { from: 'Veyron', to: 'Ashgrove' },
  ];
  const out = rename('Kael Veyron told Kael that the Veyron name was finished.', pairs);
  check(
    'the longest pair wins at a shared position',
    out === 'Ryn Ashgrove told Ryn that the Ashgrove name was finished.',
    out
  );
  check(
    'pair order in the request does not matter',
    rename('Kael Veyron', [pairs[2], pairs[0], pairs[1]]) === 'Ryn Ashgrove'
  );
  check(
    'one pass means no cascading',
    rename('Kael', [{ from: 'Kael', to: 'Veyron' }, { from: 'Veyron', to: 'Hask' }]) === 'Veyron',
    'a two-pass implementation would produce "Hask"'
  );
}

// ── Counting ───────────────────────────────────────────────────────────────

{
  const text = 'Kael went. Kaelen stayed. KAEL shouted. kael, quietly.';
  check('every case is counted', hits(text, KAEL) === 3, String(hits(text, KAEL)));
  check(
    'a preview count equals the apply count',
    hits(text, KAEL) === (text.match(/\bkael\b/gi) ?? []).length,
    'preview and apply must not disagree'
  );
  const re = compileRename(KAEL)!;
  const { samples } = countRename(text, re, KAEL);
  check('samples carry context', samples.length === 3 && samples[0].includes('Kael went'), samples[0]);
  check('an empty pair list compiles to nothing', compileRename([{ from: '', to: 'x' }]) === null);
}

// ── planRename over a whole novel ──────────────────────────────────────────

const novel: Novel = {
  id: 'nv', ownerUid: 'u', title: 'Kael Rising',
  premise: 'Kael leaves the salt port.', styleNotes: 'Kael speaks plainly.',
  style: 'webnovel', defaultModel: 'x/y', chapterLength: 2000, chapterCount: 1,
  wordCount: 8, hidden: false, createdAt: 0, updatedAt: 0,
};

const entry: BibleEntry = {
  id: 'kael-veyron', type: 'character', name: 'Kael Veyron',
  aliases: ['Kael', 'the young master'], summary: 'Kael is the heir.',
  status: 'alive', attributes: { role: 'Kael, heir of the house', voice: 'flat' },
  facts: [{ text: 'Kael broke the seal.', chapter: 1, supersedes: 'Kael kept it.' }],
  relationships: [{ targetId: 'mirin', nature: 'Kael trusts her' }],
  firstChapter: 1, createdAt: 0, updatedAt: 0,
};

const design: CharacterDesign = {
  id: 'kael-veyron', name: 'Kael Veyron', linkedEntryId: 'kael-veyron', state: 'active', steer: true,
  essentials: { role: 'Kael the heir', age: '19', appearance: 'tall', voice: 'flat' },
  motivation: { want: 'Kael wants out', need: 'to be known', fear: 'the house', lie: 'Kael is owed' },
  personality: { traits: ['Kael is stubborn'], flaws: ['proud'], virtues: ['loyal'] },
  history: { backstory: 'Kael grew up here.', secrets: [{ text: 'Kael lied.', revealed: false }] },
  arcs: [{ device: 'redemption', customLabel: 'Kael pays', summary: 'Kael changes', stages: ['Kael refuses'], currentStage: 0, nudge: 'push Kael', state: 'current' }],
  relationships: [{ targetId: 'mirin', targetKind: 'bible', nature: 'Kael trusts her', intent: 'Kael will not' }],
  notes: 'Kael notes.', createdAt: 0, updatedAt: 0,
};

const arc: StoryArc = {
  id: 'arc-1', number: 1, title: 'Kael Leaves', premise: 'Kael goes.',
  previousPremise: 'Kael stays.', fromChapter: 1, toChapter: 10, status: 'active', steer: true,
  beats: [{ id: 'b1', text: 'Kael packs.', source: 'author', previousText: 'Kael waits.' }],
  blueprints: [{
    chapter: 1, title: 'Kael Goes', tags: ['travel'], summary: 'Kael leaves.',
    opens: 'Open on Kael.', turn: 'Kael is stopped.', lands: 'Kael goes anyway.',
    source: 'model', previousSummary: 'Kael waits.', newNames: ['Kael'],
    cast: [{ entryId: 'kael-veyron', name: 'Kael Veyron', note: 'the Kael boy, heir of the house' }],
    roles: ['Kael Veyron', 'a dock clerk'],
    reveals: ['Kael learns the seal is forged.'],
    futureContext: ['Kael will inherit nothing.'],
  }],
  createdAt: 0, updatedAt: 0,
};

const map = {
  id: 'world', scope: 'world', title: 'Kael’s world', seed: 1,
  entities: { 'kael-hold': { id: 'kael-hold', kind: 'settlement', name: 'Kael Hold', aliases: ['Kael'], bibleEntryId: null, importance: 2, firstChapter: 1 } },
  facts: [{ id: 'f-1-1', relation: { type: 'within', subject: 'kael-hold', container: 'x' }, confidence: 'stated', chapter: 1, evidence: 'Kael said so', supersededBy: null }],
  relations: [], layout: null, chapter: 1, createdAt: 0, updatedAt: 0,
} as unknown as GeoMap;

const chapter: Chapter = {
  number: 1, title: 'Kael at the Gate', content: 'Kael waited. Kaelen did not.',
  status: 'accepted', summary: 'Kael waits.', userPrompt: 'Write Kael at the gate.',
  revisionNotes: ['More Kael.'], model: 'x/y',
  nextSuggestions: [{ move: 'follow', title: 'Kael goes on', prompt: 'Kael walks.', rationale: 'Kael must move.' }],
  createdAt: 0, updatedAt: 0,
};

const docs: RenameDocs = { novel, bible: [entry], designs: [design], arcs: [arc], map, chapters: [chapter] };

{
  const { plan, rewrites } = planRename(docs, KAEL, {
    ...DEFAULT_RENAME_OPTIONS,
    renameNovelTitle: true,
  });

  check('every kind is touched', Object.values(plan.totals).every((n) => n > 0), JSON.stringify(plan.totals));

  const next = rewrites.bible[0];
  check('the entry name changes', next.name === 'Ryn Veyron', next.name);
  check('aliases change', next.aliases.includes('Ryn'));
  check('the summary changes', next.summary === 'Ryn is the heir.');
  check('attribute VALUES change', next.attributes.role === 'Ryn, heir of the house');
  check(
    'attribute KEYS do not',
    'role' in next.attributes && 'voice' in next.attributes,
    'a renamed key would drop the attribute'
  );
  check('facts change', next.facts[0].text === 'Ryn broke the seal.');
  check('a superseded fact changes', next.facts[0].supersedes === 'Ryn kept it.');
  check('relationship prose changes', next.relationships[0].nature === 'Ryn trusts her');
  check('the doc id does NOT change', next.id === 'kael-veyron', 'ids are foreign keys everywhere');
  check('relationship targets do NOT change', next.relationships[0].targetId === 'mirin');

  const d = rewrites.designs[0];
  check('the design name changes', d.name === 'Ryn Veyron');
  check('essentials change', d.essentials.role === 'Ryn the heir');
  check('motivation changes', d.motivation.want === 'Ryn wants out' && d.motivation.lie === 'Ryn is owed');
  check('personality arrays change', d.personality.traits[0] === 'Ryn is stubborn');
  check('backstory and secrets change', d.history.backstory === 'Ryn grew up here.' && d.history.secrets[0].text === 'Ryn lied.');
  check('arc prose changes', d.arcs[0].summary === 'Ryn changes' && d.arcs[0].stages[0] === 'Ryn refuses');
  check('the arc nudge and label change', d.arcs[0].nudge === 'push Ryn' && d.arcs[0].customLabel === 'Ryn pays');
  check('relationship intent changes', d.relationships[0].intent === 'Ryn will not');
  check('notes change', d.notes === 'Ryn notes.');
  check('the design id and link do NOT change', d.id === 'kael-veyron' && d.linkedEntryId === 'kael-veyron');
  check('the arc DEVICE does NOT change', d.arcs[0].device === 'redemption');

  const a = rewrites.arcs[0];
  check('the arc title and premise change', a.title === 'Ryn Leaves' && a.premise === 'Ryn goes.');
  check('the previous premise changes', a.previousPremise === 'Ryn stays.');
  check('beats and their history change', a.beats[0].text === 'Ryn packs.' && a.beats[0].previousText === 'Ryn waits.');
  check(
    'every blueprint field changes',
    a.blueprints[0].summary === 'Ryn leaves.' && a.blueprints[0].opens === 'Open on Ryn.' &&
      a.blueprints[0].turn === 'Ryn is stopped.' && a.blueprints[0].lands === 'Ryn goes anyway.' &&
      a.blueprints[0].title === 'Ryn Goes' && a.blueprints[0].previousSummary === 'Ryn waits.'
  );
  check('newNames changes', a.blueprints[0].newNames?.[0] === 'Ryn');
  check(
    'the cast name and note change with the book',
    a.blueprints[0].cast?.[0]?.name === 'Ryn Veyron' &&
      a.blueprints[0].cast?.[0]?.note === 'the Ryn boy, heir of the house',
    JSON.stringify(a.blueprints[0].cast?.[0])
  );
  check(
    'the cast entryId does NOT change — it is the join, not a name',
    a.blueprints[0].cast?.[0]?.entryId === 'kael-veyron'
  );
  check(
    'planned reveals and future context move with the book too',
    a.blueprints[0].reveals?.[0] === 'Ryn learns the seal is forged.' &&
      a.blueprints[0].futureContext?.[0] === 'Ryn will inherit nothing.',
    JSON.stringify([a.blueprints[0].reveals, a.blueprints[0].futureContext])
  );
  check(
    'a role naming someone the bible owns is renamed',
    a.blueprints[0].roles?.[0] === 'Ryn Veyron',
    a.blueprints[0].roles?.join(' | ')
  );
  check(
    'an unnamed role is left exactly as the planner wrote it',
    a.blueprints[0].roles?.[1] === 'a dock clerk',
    'a rename has nothing to say about "a dock clerk"'
  );
  check('the arc id and range do NOT change', a.id === 'arc-1' && a.fromChapter === 1);

  const m = rewrites.map!;
  check('map entity names change', m.entities['kael-hold'].name === 'Ryn Hold');
  check('map aliases change', m.entities['kael-hold'].aliases[0] === 'Ryn');
  check('map evidence changes', m.facts[0].evidence === 'Ryn said so');
  check('the map title changes', m.title === 'Ryn’s world');
  check(
    'map entity KEYS and ids do NOT change',
    'kael-hold' in m.entities && m.entities['kael-hold'].id === 'kael-hold',
    'the solved layout is keyed by these'
  );
  check('the layout is untouched', m.layout === null);

  const ch = rewrites.chapters[0];
  check('chapter prose changes', ch.content === 'Ryn waited. Kaelen did not.', ch.content);
  check('the chapter title changes', ch.title === 'Ryn at the Gate');
  check('the summary changes', ch.summary === 'Ryn waits.');
  check('the instructions change', ch.userPrompt === 'Write Ryn at the gate.');
  check('revision notes change', ch.revisionNotes[0] === 'More Ryn.');
  check(
    'stored suggestions are rewritten, not cleared',
    ch.nextSuggestions?.[0].prompt === 'Ryn walks.' && ch.nextSuggestions?.[0].title === 'Ryn goes on',
    'unlike a hand edit, this pass does not change what happens'
  );

  check('the novel title changes', rewrites.novel?.title === 'Ryn Rising');
  check('the premise changes', rewrites.novel?.premise === 'Ryn leaves the salt port.');
  check("the author's notes change", rewrites.novel?.styleNotes === 'Ryn speaks plainly.');
  check('one-for-one names leave the word count alone', plan.wordDelta === 0, String(plan.wordDelta));
}

{
  // A one-word name becoming two moves countWords, and the novel's counter has
  // to move with it or the dashboard starts lying.
  const { plan, rewrites } = planRename(docs, [{ from: 'Kael', to: 'Ryn Ashgrove' }], DEFAULT_RENAME_OPTIONS);
  check('a longer name raises the word count', plan.wordDelta === 1, String(plan.wordDelta));
  check('the novel patch carries it', rewrites.novel?.wordCount === novel.wordCount + 1, String(rewrites.novel?.wordCount));
}

{
  const { plan, rewrites } = planRename(docs, KAEL, { ...DEFAULT_RENAME_OPTIONS, includeChapters: false });
  check('chapters can be left alone', rewrites.chapters.length === 0 && plan.totals.chapter === 0);
  check('and everything else still changes', rewrites.bible.length === 1);
}

{
  const { rewrites } = planRename(docs, KAEL, { ...DEFAULT_RENAME_OPTIONS, keepOldAsAlias: true });
  check('the old name can be kept as an alias', rewrites.bible[0].aliases.includes('Kael Veyron'));
}

{
  const { rewrites } = planRename(docs, KAEL, DEFAULT_RENAME_OPTIONS);
  check(
    'the novel title is left alone by default',
    rewrites.novel?.title === undefined,
    'renaming a character should not rename the book'
  );
}

{
  // Only what actually moved is written back — otherwise renaming one
  // character rewrites every chapter of the novel for nothing.
  const untouched: RenameDocs = {
    ...docs,
    chapters: [chapter, { ...chapter, number: 2, title: 'Quiet', content: 'Nothing happened.', summary: '', userPrompt: '', revisionNotes: [], nextSuggestions: undefined }],
  };
  const { rewrites } = planRename(untouched, KAEL, DEFAULT_RENAME_OPTIONS);
  check('untouched documents are not rewritten', rewrites.chapters.length === 1, `${rewrites.chapters.length}`);
  check('and the one that changed is the right one', rewrites.chapters[0].number === 1);
}

// ── Warnings ───────────────────────────────────────────────────────────────

{
  const { plan } = planRename(docs, [{ from: 'Kael', to: 'Kael Veyron' }], DEFAULT_RENAME_OPTIONS);
  check(
    'a replacement containing the original is flagged',
    plan.warnings.some((w) => w.includes('still contains')),
    plan.warnings.join(' | ')
  );
}

{
  const { plan } = planRename(docs, [{ from: 'Dawn', to: 'Venn' }], DEFAULT_RENAME_OPTIONS);
  check(
    'an ordinary English word is flagged',
    plan.warnings.some((w) => w.includes('ordinary English word')),
    plan.warnings.join(' | ')
  );
  check(
    'a name that appears nowhere is flagged',
    plan.warnings.some((w) => w.includes('does not appear')),
    plan.warnings.join(' | ')
  );
}

{
  const { plan } = planRename(docs, [{ from: 'Kael', to: 'the young master' }], DEFAULT_RENAME_OPTIONS);
  check(
    'a collision with an existing name is flagged',
    plan.warnings.some((w) => w.includes('already the name')),
    plan.warnings.join(' | ')
  );
}

{
  const { plan, rewrites } = planRename(docs, [{ from: '', to: '' }], DEFAULT_RENAME_OPTIONS);
  check('an empty rename changes nothing', rewrites.bible.length === 0 && plan.totals.bible === 0);
  check('and says so', plan.warnings.length > 0);
}

{
  const { plan } = planRename(docs, KAEL, DEFAULT_RENAME_OPTIONS);
  check('per-pair hit counts are reported', (plan.pairs[0].hits ?? 0) > 0, String(plan.pairs[0].hits));
  check('hits carry context for the preview', plan.hits.every((h) => h.count > 0 && h.label.length > 0));
  check('nothing is truncated for a small novel', plan.truncated === false);
}

/*
 * applySubstitution — the sibling applyRename grew when the arc cast pass
 * needed to swap a common-noun phrase for a proper noun. Everything delicate is
 * shared with applyRename by construction; the assertions below are the case
 * rule that is NOT shared, plus a guard that extracting the shared core left
 * applyRename byte-identical.
 */
{
  const pairs: RenamePair[] = [{ from: 'a dock clerk', to: 'Wenna Skarrow' }];
  const re = compileRename(pairs)!;
  const line = 'Rennick waits while a dock clerk seals the crate.';

  check(
    'a substitution does NOT carry the phrase’s lowercase across',
    applySubstitution(line, re, pairs).text === 'Rennick waits while Wenna Skarrow seals the crate.',
    applySubstitution(line, re, pairs).text
  );
  check(
    'and applyRename still does, which is why there are two of them',
    applyRename(line, re, pairs).text === 'Rennick waits while wenna skarrow seals the crate.',
    applyRename(line, re, pairs).text
  );
  check('a substitution counts what it changed', applySubstitution(line, re, pairs).count === 1);

  const possessive: RenamePair[] = [{ from: 'the assayer', to: 'Serel Vance' }];
  const possessiveRe = compileRename(possessive)!;
  check(
    'a possessive survives a substitution',
    applySubstitution("the assayer's ledger", possessiveRe, possessive).text === "Serel Vance's ledger"
  );
  check(
    'a phrase broken across a line break still matches',
    applySubstitution('waits while a dock\nclerk seals it', re, pairs).text ===
      'waits while Wenna Skarrow seals it'
  );
  check(
    'a phrase inside a longer word is not touched',
    applySubstitution('the assayers guild', possessiveRe, possessive).count === 0
  );
}

{
  // The refactor guard: the cases above the fold are the ones that came out of
  // real novels getting renamed wrong, and pulling the shared core out must not
  // have moved any of them.
  const pairs: RenamePair[] = [{ from: 'Kael Veyron', to: 'Ryn Ashgrove' }, { from: 'Kael', to: 'Ryn' }];
  const re = compileRename(pairs)!;
  const fixtures = [
    "Kael's sword",
    'KAEL!',
    'the kael blade',
    'Kael Veyron told Kael',
    'Kaelen stayed',
    'Kael\nVeyron walked',
  ];
  const expected = [
    "Ryn's sword",
    'RYN!',
    'the ryn blade',
    'Ryn Ashgrove told Ryn',
    'Kaelen stayed',
    'Ryn Ashgrove walked',
  ];
  check(
    'applyRename is unchanged by the extraction, case by case',
    fixtures.every((f, i) => applyRename(f, re, pairs).text === expected[i]),
    fixtures.map((f) => applyRename(f, re, pairs).text).join(' | ')
  );
}

console.log(`\n${passed}/${passed + failures.length} passed`);
if (failures.length) {
  for (const f of failures) console.error(`FAIL  ${f}`);
  process.exit(1);
}
