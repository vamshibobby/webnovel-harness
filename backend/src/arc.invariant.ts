/**
 * Offline check that arc steering cannot damage prompt caching.
 *   npx tsx src/arc.invariant.ts
 *
 * Free — no API calls. The arc block is the newest thing to ride in a chapter
 * prompt, and it changes whenever the author edits the plan, so it must sit in
 * the per-chapter instruction and never in the cached prefix. The only way to
 * know that stays true is to assert it: build the same generation twice, with
 * and without a steered arc, and prove everything before the final instruction
 * is byte-identical.
 *
 * The twin of design.invariant.ts, and for the same reason.
 */
import { buildArcBlock, buildGenerationMessages } from './engine/context.js';
import { emptyArc } from './lib/arcValidate.js';
import type { Chapter, Novel, StoryArc } from './lib/types.js';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) failures++;
}

const MODEL = 'anthropic/claude-haiku-4.5';

const novel: Novel = {
  id: 'test',
  ownerUid: 'test',
  title: 'The Drowned Ledger',
  premise: 'A courier in a flooded city discovers a conspiracy hidden in shipping manifests.',
  styleNotes: 'Close third person, wry, atmospheric.',
  style: 'webnovel',
  defaultModel: MODEL,
  chapterLength: 0,
  chapterCount: 0,
  wordCount: 0,
  hidden: false,
  arcMode: 'on',
  createdAt: 0,
  updatedAt: 0,
};

function makeChapter(number: number): Chapter {
  const body = Array.from(
    { length: 40 },
    (_, i) =>
      `Paragraph ${i + 1} of chapter ${number}. Mara rowed the flooded arcade past the drowned ` +
      `lamp posts, counting doorways as the tide pressed in.`
  ).join('\n\n');
  return {
    number,
    title: `Chapter ${number}`,
    content: body,
    status: 'accepted',
    summary: `Chapter ${number} summary.`,
    userPrompt: '',
    revisionNotes: [],
    model: MODEL,
    createdAt: 0,
    updatedAt: 0,
  };
}

const previous = [1, 2, 3].map(makeChapter);

function makeArc(steer: boolean): StoryArc {
  const arc = emptyArc('the-customs-house', 'The Customs House', 1, 1);
  arc.toChapter = 50;
  arc.steer = steer;
  arc.premise = 'Mara is forced to choose between delivering the ledger and burning it.';
  arc.beats = [{ id: 'b0', text: 'The syndicate calls in her debt.', source: 'author' }];
  arc.blueprints = [
    {
      chapter: 4,
      title: 'The Customs House',
      tags: ['political'],
      summary: 'She reaches the customs house and finds the manifest already altered.',
      opens: 'She reaches the customs house.',
      turn: 'The manifest has already been altered.',
      lands: 'She leaves owing someone she cannot name.',
      source: 'model',
    },
  ];
  return arc;
}

const base = {
  novel,
  chapterNumber: 4,
  previous,
  userPrompt: 'Mara reaches the customs house.',
  model: MODEL,
};

const without = buildGenerationMessages(base);
const steered = buildGenerationMessages({ ...base, arc: makeArc(true) });
const unsteered = buildGenerationMessages({ ...base, arc: makeArc(false) });

const prefix = (messages: ReturnType<typeof buildGenerationMessages>) =>
  JSON.stringify(messages.slice(0, -1));

check(
  'everything before the final instruction is byte-identical',
  prefix(without) === prefix(steered),
  'a steered arc changed the cached prefix — it must ride in the instruction only'
);
check('an arc that is not steered changes nothing at all', JSON.stringify(without) === JSON.stringify(unsteered));

const last = (messages: ReturnType<typeof buildGenerationMessages>) => JSON.stringify(messages.at(-1));
check('a steered arc DOES reach the final instruction', last(without) !== last(steered));

// The block itself must never name what is coming. This is the property the
// leak eval measured; asserting it here stops a later edit from reintroducing
// upcoming beats as "helpful context".
const block = buildArcBlock(makeArc(true), 4);
check('the steer block names no future chapter content', !block.includes('customs house'.toUpperCase()) && !block.includes('manifest'));
check('the steer block does not list blueprints', !block.includes('The Customs House') || !block.includes('altered'));
check('the steer block says advancing is optional', block.includes('Advancing the arc is not required'));
check('an unsteered arc produces no block', buildArcBlock(makeArc(false), 4) === '');
check('no arc produces no block', buildArcBlock(null, 4) === '');

/*
 * The cast a blueprint carries reaches the writer through the author's prompt
 * box — GET /arcs/blueprint/:n builds the block, the composer concatenates it,
 * and the author can read and edit it before pressing anything. It must never
 * find its own way into the prompt the app assembles, both because that is the
 * "into the box, never straight out" contract and because a per-chapter cast
 * block in the prefix would invalidate the novel's cache on every accept.
 */
const withCast = makeArc(true);
withCast.blueprints = withCast.blueprints.map((bp) => ({
  ...bp,
  cast: [{ name: 'Mara Vey', note: 'a customs clerk at the river gate' }],
  reveals: ['The manifest was altered before she arrived.'],
  futureContext: ['The clerk answers to the harbour master.'],
}));
check(
  'a blueprint carrying a cast changes nothing the app sends',
  JSON.stringify(buildGenerationMessages({ ...base, arc: withCast })) === JSON.stringify(steered),
  'the cast block belongs in the prompt box, not in the generation messages'
);
check('and the steer block still never mentions it', !buildArcBlock(withCast, 4).includes('Mara Vey'));

/*
 * The braided-arc fields ride the same contract. Threads, the timeline, the
 * braid report and per-blueprint thread/day bookkeeping exist for the
 * PLANNER and the prompt box — none of it may reach what the app sends for a
 * chapter, or every batch would invalidate the novel's cache.
 */
const braided = makeArc(true);
braided.threads = [
  { id: 't1', label: 'the customs conspiracy', authorNumber: 1, anchor: 'early', source: 'author' },
  { id: 't2', label: 'the sister arrives', authorNumber: 2, anchor: 'mid', endsOpen: true, source: 'author' },
];
braided.timeline = { spanDays: 240, note: 'over eight months' };
braided.nameFlags = [{ name: 'Marren', where: 'premise', at: 1 }];
braided.braid = {
  at: 1,
  from: 4,
  to: 13,
  clocks: [{ id: 't1', lastChapter: 4, lastDay: 12, count: 1, darkFor: 0 }],
  findings: [
    { kind: 'thread-dark', message: 'the sister arrives has been dark', chapters: [4], threads: ['t2'], severity: 'warn' },
  ],
  weaveRate: 0,
  longestRun: 1,
  unplaced: 0,
};
braided.blueprints = braided.blueprints.map((bp) => ({ ...bp, threads: ['t1'], time: { day: 12, hint: 'a week later' } }));
check(
  'threads, timeline, flags and the braid report change nothing the app sends',
  JSON.stringify(buildGenerationMessages({ ...base, arc: braided })) === JSON.stringify(steered),
  'braid data belongs to the planner and the prompt box, never the generation messages'
);
const braidedBlock = buildArcBlock(braided, 4);
check('the steer block names no thread', !braidedBlock.includes('customs conspiracy') && !braidedBlock.includes('sister'));
check('the steer block carries no day number', !/\bday\s*\d/i.test(braidedBlock) && !braidedBlock.includes('240'));

console.log(failures === 0 ? '\nAll invariants hold.' : `\n${failures} failed.`);
if (failures > 0) process.exit(1);
