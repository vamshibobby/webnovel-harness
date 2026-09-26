/**
 * Offline check that character designs cannot damage prompt caching.
 *   npx tsx src/design.invariant.ts
 *
 * Free — no API calls. The whole point of the feature's placement is that a
 * design block never reaches the cached prefix, and the only way to know that
 * stays true is to assert it: build the same generation twice, with and
 * without designs, and prove that everything before the final instruction is
 * byte-identical.
 */
import { buildGenerationMessages } from './engine/context.js';
import type { Chapter, CharacterDesign, Novel } from './lib/types.js';
import { emptyDesign } from './lib/designValidate.js';

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
  designMode: 'on',
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

function makeDesign(name: string, steer: boolean): CharacterDesign {
  const d = emptyDesign(name.toLowerCase().replace(/\s+/g, '-'), name);
  d.state = 'active';
  d.steer = steer;
  d.essentials.voice = 'Clipped, never finishes a threat.';
  d.motivation = {
    want: 'the ledger delivered',
    need: 'to stop treating debts as identity',
    fear: 'being owed nothing by anyone',
    lie: 'a debt is the only thing that makes someone stay',
  };
  d.history.secrets = [{ text: 'She forged the seal herself.', revealed: false }];
  d.arcs = [
    {
      device: 'slow-burn-betrayal',
      summary: 'Turns on the harbour syndicate over several chapters.',
      stages: ['genuine loyalty', 'the first private grievance', 'the turn'],
      currentStage: 1,
      nudge: 'Let her be useful to them in a way that costs her something.',
      state: 'current',
    },
  ];
  return d;
}

const base = { novel, chapterNumber: 4, previous, userPrompt: 'Mara reaches the customs house.', model: MODEL };

const without = buildGenerationMessages(base);
const with1 = buildGenerationMessages({ ...base, designs: [makeDesign('Mara', true)] });

check('message count is unchanged by designs', without.length === with1.length,
  `${without.length} vs ${with1.length}`);

const prefixIdentical = without
  .slice(0, -1)
  .every((m, i) => JSON.stringify(m) === JSON.stringify(with1[i]));
check('system prompt and full chapter history are byte-identical', prefixIdentical,
  'a design block reached the cached prefix — every chapter would re-read the whole novel');

const lastWithout = JSON.stringify(without[without.length - 1]);
const lastWith = JSON.stringify(with1[with1.length - 1]);
check('only the final instruction message differs', lastWithout !== lastWith);

// The block must sit after the bible index, so the two are appended in a
// stable order and neither displaces the other.
const bibleEntries = [
  {
    id: 'mara',
    type: 'character' as const,
    name: 'Mara',
    aliases: [],
    summary: 'A courier.',
    status: 'alive',
    attributes: {},
    facts: [],
    relationships: [],
    firstChapter: 1,
    createdAt: 0,
    updatedAt: 0,
  },
];
const both = buildGenerationMessages({ ...base, bibleEntries, designs: [makeDesign('Mara', true)] });
const instruction = JSON.stringify(both[both.length - 1]);
check(
  'design block follows the story bible index',
  instruction.indexOf('STORY BIBLE INDEX') < instruction.indexOf('CHARACTER DESIGNS') &&
    instruction.includes('CHARACTER DESIGNS')
);

check('steer framing appears for a steered design with a current arc', instruction.includes('ARC STEERING'));
check(
  'the framing tells the writer an arc may yield',
  instruction.includes('advancing nothing is a valid outcome')
);

// Unsteered designs are discoverable but do not press on the chapter.
const quiet = JSON.stringify(
  buildGenerationMessages({ ...base, designs: [makeDesign('Mara', false)] }).at(-1)
);
check('an unsteered design is indexed but not steered', quiet.includes('CHARACTER DESIGNS') && !quiet.includes('ARC STEERING'));

// Secrets and arc destinations must never ride in the prompt — they are
// tool-fetched, behind the sheet's author-private framing.
check('unrevealed secrets never ride in the instruction', !instruction.includes('forged the seal'));
check('the lie they believe never rides in the instruction', !instruction.includes('a debt is the only thing'));

// Steer-line cap: six steered designs, five lines.
const many = Array.from({ length: 6 }, (_, i) => makeDesign(`Char ${i}`, true));
const capped = JSON.stringify(buildGenerationMessages({ ...base, designs: many }).at(-1));
// Steer lines quote the stage text; index lines only parenthesise the number.
const steerLines = (capped.match(/stage \d+\/\d+ \\"/g) ?? []).length;
check('at most five steer lines are injected', steerLines === 5, `saw ${steerLines}`);
check('the omitted steered design is disclosed', capped.includes('1 more steered design'));

// Byte-stability across tool rounds: the instruction is re-sent each round and
// must hash the same, so a breakpoint on it keeps working.
const a = JSON.stringify(buildGenerationMessages({ ...base, designs: [...many] }).at(-1));
const b = JSON.stringify(buildGenerationMessages({ ...base, designs: [...many].reverse() }).at(-1));
check('design order does not change the rendered instruction', a === b);

console.log(failures === 0 ? '\nAll invariants hold.' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
