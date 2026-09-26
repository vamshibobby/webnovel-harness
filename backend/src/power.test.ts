/**
 * What this pins down.
 *
 *   npx tsx src/power.test.ts
 *
 * The power system's validation and merge rules — the contract both the
 * author routes and the agent tools depend on:
 *  - linked ids must resolve to bible entries of the right type, with
 *    error messages that tell the model what to do instead;
 *  - rank references are checked against the ladder as it will be AFTER the
 *    patch's own rank ops apply;
 *  - upserts merge by id (lists union, scalars replace when non-empty), so
 *    re-applying the same patch is a no-op — idempotency under agent retries;
 *  - provenance lands on 'mixed' when the other hand touches the system;
 *  - unlinkEntryFromSystem strips a deleted entry everywhere it appears.
 */

import { buildGenerationMessages, buildPowerBlock } from './engine/context.js';
import { parseGenerateProposal } from './engine/powerAgent.js';
import {
  formatPowerIndex,
  formatPowerSystem,
  handleUpsertPowerSystem,
} from './engine/powerTools.js';
import { emptyDesign } from './lib/designValidate.js';
import {
  applyPowerSystemPatch,
  PowerValidationError,
  POWER_LIMITS,
  slugifyPowerName,
  unlinkEntryFromSystem,
  validatePowerSystemPatch,
} from './lib/powerValidate.js';
import type { BibleEntry, BibleEntryType, Chapter, Novel, PowerSystem } from './lib/types.js';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passed++;
  else failures.push(label);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
}

function rejects(label: string, fn: () => unknown, contains: string): void {
  try {
    fn();
    check(label, false, 'did not throw');
  } catch (err) {
    const msg = err instanceof PowerValidationError ? err.message : `wrong error: ${err}`;
    check(label, err instanceof PowerValidationError && msg.includes(contains), msg);
  }
}

function entry(id: string, type: BibleEntryType): BibleEntry {
  return {
    id,
    type,
    name: id,
    aliases: [],
    summary: '',
    status: '',
    attributes: {},
    facts: [],
    relationships: [],
    firstChapter: 1,
    createdAt: 0,
    updatedAt: 0,
  };
}

const ENTRIES: BibleEntry[] = [
  entry('kael-veyron', 'character'),
  entry('azure-sect', 'faction'),
  entry('azure-sword-song', 'technique'),
  entry('starfall-blade', 'weapon'),
  entry('western-marches', 'location'),
];

/** Timestamps aside, two systems should be identical after a retried patch. */
function stripTimes(s: PowerSystem): Omit<PowerSystem, 'createdAt' | 'updatedAt'> {
  const { createdAt: _c, updatedAt: _u, ...rest } = s;
  return rest;
}

// ── slugs ──────────────────────────────────────────────────────────────────

console.log('slugifyPowerName');
check('slugs like the bible does', slugifyPowerName('Qi Cultivation') === 'qi-cultivation');
check('strips accents', slugifyPowerName('Éther Noir') === 'ether-noir');
rejects('rejects the unsluggable', () => slugifyPowerName('!!!'), 'at least one letter');

// ── validation: links ──────────────────────────────────────────────────────

console.log('validatePowerSystemPatch — links');
const ctx = { entries: ENTRIES, existing: null };

rejects(
  'unknown character id names the fix',
  () =>
    validatePowerSystemPatch(
      { upsertRanks: [{ name: 'Foundation', characterIds: ['nobody'] }] },
      ctx
    ),
  'upsert_story_bible_entry first'
);
rejects(
  'a faction cannot stand at a rank',
  () =>
    validatePowerSystemPatch(
      { upsertRanks: [{ name: 'Foundation', characterIds: ['azure-sect'] }] },
      ctx
    ),
  'is a faction'
);
rejects(
  'a character is not an artifact',
  () =>
    validatePowerSystemPatch(
      { upsertArtifacts: [{ entryId: 'kael-veyron', scaling: '', note: '' }] },
      ctx
    ),
  'technique | weapon | item'
);
rejects(
  'a region link must be a location',
  () =>
    validatePowerSystemPatch(
      {
        upsertRanks: [{ name: 'Foundation' }],
        upsertRegions: [
          { region: 'The Marches', locationEntryId: 'azure-sect', typicalRankId: 'foundation', note: '' },
        ],
      },
      ctx
    ),
  'location'
);
check(
  'valid links of every kind pass',
  (() => {
    validatePowerSystemPatch(
      {
        name: 'Qi Cultivation',
        upsertRanks: [{ name: 'Foundation', characterIds: ['kael-veyron'] }],
        upsertProfessions: [
          { name: 'Sword Cultivator', factionIds: ['azure-sect'], characterIds: ['kael-veyron'] },
        ],
        upsertArtifacts: [
          { entryId: 'azure-sword-song', scaling: 'sharpens with the core', rankId: 'foundation', note: '' },
          { entryId: 'starfall-blade', scaling: '', note: '' },
        ],
        upsertRegions: [
          {
            region: 'Western Marches',
            locationEntryId: 'western-marches',
            typicalRankId: 'foundation',
            note: '',
          },
        ],
      },
      ctx
    );
    return true;
  })()
);

// ── validation: rank references against the merged ladder ─────────────────

console.log('validatePowerSystemPatch — merged-ladder rank refs');
rejects(
  'a region cannot reference a rank nobody added',
  () =>
    validatePowerSystemPatch(
      { upsertRegions: [{ region: 'The Marches', typicalRankId: 'ghost-rank', note: '' }] },
      ctx
    ),
  'unknown rank id "ghost-rank"'
);
check(
  'a patch may add a rank and reference it in the same call',
  (() => {
    validatePowerSystemPatch(
      {
        upsertRanks: [{ name: 'Core Formation' }],
        upsertRegions: [{ region: 'The Marches', typicalRankId: 'core-formation', note: '' }],
      },
      ctx
    );
    return true;
  })()
);

const withLadder = applyPowerSystemPatch(
  null,
  'qi-cultivation',
  validatePowerSystemPatch(
    { name: 'Qi Cultivation', upsertRanks: [{ name: 'Foundation' }, { name: 'Core Formation' }] },
    ctx
  ),
  'author'
);
rejects(
  'removing a rank invalidates references to it in the same patch',
  () =>
    validatePowerSystemPatch(
      {
        removeRankIds: ['foundation'],
        upsertRegions: [{ region: 'The Marches', typicalRankId: 'foundation', note: '' }],
      },
      { entries: ENTRIES, existing: withLadder }
    ),
  'unknown rank id "foundation"'
);

// ── validation: caps ───────────────────────────────────────────────────────

console.log('validatePowerSystemPatch — caps');
rejects(
  'too many capabilities names the cap',
  () =>
    validatePowerSystemPatch(
      {
        upsertRanks: [
          {
            name: 'Foundation',
            capabilities: Array.from({ length: POWER_LIMITS.capabilitiesPerRank + 1 }, (_, i) => `cap ${i}`),
          },
        ],
      },
      ctx
    ),
  String(POWER_LIMITS.capabilitiesPerRank)
);
rejects(
  'an over-long name is refused with the limit',
  () => validatePowerSystemPatch({ name: 'x'.repeat(POWER_LIMITS.name + 1) }, ctx),
  String(POWER_LIMITS.name)
);
rejects(
  'the ladder cap is enforced on the merged result',
  () =>
    applyPowerSystemPatch(
      null,
      'big',
      validatePowerSystemPatch(
        {
          name: 'Big',
          upsertRanks: Array.from({ length: POWER_LIMITS.ranksPerSystem + 1 }, (_, i) => ({
            name: `Rank ${i}`,
          })),
        },
        ctx
      ),
      'author'
    ),
  'removeRankIds'
);

// ── apply: create, merge, idempotency ─────────────────────────────────────

console.log('applyPowerSystemPatch — create and merge');
rejects(
  'creating without a name is refused',
  () => applyPowerSystemPatch(null, 'x', {}, 'author'),
  'name is required'
);

const created = applyPowerSystemPatch(
  null,
  'qi-cultivation',
  validatePowerSystemPatch(
    {
      name: 'Qi Cultivation',
      summary: 'Meridians and cores.',
      energyName: 'qi',
      upsertRanks: [
        { name: 'Foundation', capabilities: ['temper the body'], rarity: 'common' },
        { name: 'Core Formation', capabilities: ['fly short hops'] },
      ],
    },
    ctx
  ),
  'model'
);
check('create fills the skeleton', created.name === 'Qi Cultivation' && created.source === 'model');
check('ladder order is array order', created.ranks.map((r) => r.id).join(',') === 'foundation,core-formation');

const patch2 = validatePowerSystemPatch(
  {
    upsertRanks: [
      { name: 'Foundation', capabilities: ['temper the body', 'sense qi'], characterIds: ['kael-veyron'] },
    ],
  },
  { entries: ENTRIES, existing: created }
);
const merged = applyPowerSystemPatch(created, created.id, patch2, 'model');
check(
  'capabilities union without duplicates',
  merged.ranks[0].capabilities.join('|') === 'temper the body|sense qi'
);
check('characterIds land on the rank', merged.ranks[0].characterIds.join(',') === 'kael-veyron');
check('untouched ranks survive', merged.ranks[1].capabilities.join('|') === 'fly short hops');

const mergedTwice = applyPowerSystemPatch(merged, merged.id, patch2, 'model');
check(
  'the same patch twice is a no-op',
  JSON.stringify(stripTimes(mergedTwice)) === JSON.stringify(stripTimes(merged))
);

const emptied = applyPowerSystemPatch(
  merged,
  merged.id,
  validatePowerSystemPatch({ upsertRanks: [{ name: 'Foundation', summary: '' }] }, { entries: ENTRIES, existing: merged }),
  'model'
);
check('an empty scalar does not clobber', emptied.ranks[0].capabilities.length === 2);

// ── apply: remove and reorder ─────────────────────────────────────────────

console.log('applyPowerSystemPatch — remove and reorder');
const reordered = applyPowerSystemPatch(
  merged,
  merged.id,
  validatePowerSystemPatch(
    { rankOrder: ['core-formation', 'foundation'] },
    { entries: ENTRIES, existing: merged }
  ),
  'author'
);
check(
  'rankOrder reorders the ladder',
  reordered.ranks.map((r) => r.id).join(',') === 'core-formation,foundation'
);

const partialOrder = applyPowerSystemPatch(
  merged,
  merged.id,
  validatePowerSystemPatch({ rankOrder: ['core-formation'] }, { entries: ENTRIES, existing: merged }),
  'author'
);
check(
  'a partial order keeps forgotten ranks',
  partialOrder.ranks.map((r) => r.id).join(',') === 'core-formation,foundation'
);

const removedRank = applyPowerSystemPatch(
  merged,
  merged.id,
  validatePowerSystemPatch({ removeRankIds: ['core-formation'] }, { entries: ENTRIES, existing: merged }),
  'author'
);
check('removeRankIds removes', removedRank.ranks.map((r) => r.id).join(',') === 'foundation');

// ── apply: artifacts and regions merge by their own keys ──────────────────

console.log('applyPowerSystemPatch — artifacts and regions');
const withArtifact = applyPowerSystemPatch(
  merged,
  merged.id,
  validatePowerSystemPatch(
    {
      upsertArtifacts: [{ entryId: 'azure-sword-song', scaling: 'grows with the core', note: '' }],
      upsertRegions: [{ region: 'Western Marches', typicalRankId: 'foundation', note: 'quiet lands' }],
    },
    { entries: ENTRIES, existing: merged }
  ),
  'model'
);
const artifactAgain = applyPowerSystemPatch(
  withArtifact,
  withArtifact.id,
  validatePowerSystemPatch(
    {
      upsertArtifacts: [
        { entryId: 'azure-sword-song', scaling: '', rankId: 'core-formation', note: 'sect treasure' },
      ],
      upsertRegions: [{ region: 'western marches', typicalRankId: 'core-formation', note: '' }],
    },
    { entries: ENTRIES, existing: withArtifact }
  ),
  'model'
);
check('artifact merges by entryId', artifactAgain.artifacts.length === 1);
check(
  'a model write keeps the scaling and gains the rank',
  artifactAgain.artifacts[0].scaling === 'grows with the core' &&
    artifactAgain.artifacts[0].rankId === 'core-formation' &&
    artifactAgain.artifacts[0].note === 'sect treasure'
);
check('region merges by slug, case-insensitively', artifactAgain.regions.length === 1);
check(
  'a model write takes the new rank, keeps the note',
  artifactAgain.regions[0].typicalRankId === 'core-formation' &&
    artifactAgain.regions[0].note === 'quiet lands'
);

// ── apply: author writes replace, model writes union ──────────────────────

console.log('applyPowerSystemPatch — author replace vs model union');
const authorTrimmed = applyPowerSystemPatch(
  merged,
  merged.id,
  validatePowerSystemPatch(
    { upsertRanks: [{ name: 'Foundation', capabilities: ['sense qi'], characterIds: [] }] },
    { entries: ENTRIES, existing: merged }
  ),
  'author'
);
check(
  'an author save IS the list — removal works',
  authorTrimmed.ranks[0].capabilities.join('|') === 'sense qi' &&
    authorTrimmed.ranks[0].characterIds.length === 0
);
const modelAdded = applyPowerSystemPatch(
  merged,
  merged.id,
  validatePowerSystemPatch(
    { upsertRanks: [{ name: 'Foundation', capabilities: ['walk on water'] }] },
    { entries: ENTRIES, existing: merged }
  ),
  'model'
);
check(
  'a model write unions — nothing is lost',
  modelAdded.ranks[0].capabilities.join('|') === 'temper the body|sense qi|walk on water'
);
const authorCleared = applyPowerSystemPatch(
  merged,
  merged.id,
  validatePowerSystemPatch(
    { upsertRanks: [{ name: 'Foundation', rarity: '' }] },
    { entries: ENTRIES, existing: merged }
  ),
  'author'
);
check('an author can clear a scalar to empty', authorCleared.ranks[0].rarity === '');
const authorUnpinned = applyPowerSystemPatch(
  artifactAgain,
  artifactAgain.id,
  validatePowerSystemPatch(
    { upsertArtifacts: [{ entryId: 'azure-sword-song', scaling: 'grows with the core', note: '' }] },
    { entries: ENTRIES, existing: artifactAgain }
  ),
  'author'
);
check(
  'an author save replaces the artifact row — unpinning works',
  authorUnpinned.artifacts[0].rankId === undefined && authorUnpinned.artifacts[0].note === ''
);

// ── provenance ─────────────────────────────────────────────────────────────

console.log('provenance');
check('author touch on a model system goes mixed', reordered.source === 'mixed');
const authorMade = applyPowerSystemPatch(
  null,
  'knight-orders',
  validatePowerSystemPatch({ name: 'Knight Orders', upsertRanks: [{ name: 'Squire' }] }, ctx),
  'author'
);
const modelTouched = applyPowerSystemPatch(
  authorMade,
  authorMade.id,
  validatePowerSystemPatch(
    { upsertRanks: [{ name: 'Squire', rarity: 'most boys of the shires' }] },
    { entries: ENTRIES, existing: authorMade }
  ),
  'model'
);
check('model touch on an author system goes mixed', modelTouched.source === 'mixed');
const mixedStays = applyPowerSystemPatch(
  modelTouched,
  modelTouched.id,
  validatePowerSystemPatch({ summary: 'Steel and vows.' }, { entries: ENTRIES, existing: modelTouched }),
  'author'
);
check('mixed is sticky', mixedStays.source === 'mixed');

// ── the generate proposal parser ───────────────────────────────────────────

console.log('parseGenerateProposal');
{
  const missing = parseGenerateProposal({ name: 'X', ranks: [{ name: 'A' }, { name: 'B' }] });
  check(
    'a proposal without a reading is an error string',
    typeof missing === 'string' && missing.includes('reading.genre')
  );

  const short = parseGenerateProposal({
    reading: { genre: 'cultivation', constraints: 'none' },
    name: 'X',
    ranks: [{ name: 'Only' }],
  });
  check('a one-rung ladder is refused', typeof short === 'string' && short.includes('two ranks'));

  const good = parseGenerateProposal({
    reading: { genre: 'cultivation', constraints: 'qi, breakthroughs' },
    name: 'Qi Cultivation',
    summary: 'Meridians and cores.',
    ranks: [
      { name: 'Foundation', summary: 's', capabilities: ['temper the body'], advancement: 'a' },
      { name: 'Core Formation', summary: 's', capabilities: ['fly'], advancement: 'a' },
    ],
    professions: [{ name: 'Sword Cultivator', summary: 's', role: 'duelist' }],
    regions: [{ region: 'The Marches', typicalRank: 'Foundation', apexRank: 'Core Formation' }],
    openQuestions: ['who guards the manuals?'],
  });
  check('a valid proposal parses', typeof good !== 'string');
  if (typeof good !== 'string') {
    const system = applyPowerSystemPatch(null, slugifyPowerName(good.name), good.patch, 'model');
    check('region rank NAMES are slugged to rank ids', system.regions[0].typicalRankId === 'foundation' && system.regions[0].apexRankId === 'core-formation');
    check('the generated system carries model provenance', system.source === 'model');
  }

  const badRegion = parseGenerateProposal({
    reading: { genre: 'g', constraints: 'c' },
    name: 'X',
    ranks: [{ name: 'A', summary: 's', capabilities: [], advancement: 'a' }, { name: 'B', summary: 's', capabilities: [], advancement: 'a' }],
    professions: [],
    regions: [{ region: 'Y', typicalRank: 'Ghost Rank' }],
    openQuestions: [],
  });
  check(
    'a region naming an unknown rank is an error string',
    typeof badRegion === 'string' && badRegion.includes('ghost-rank')
  );
}

// ── unlink on bible entry delete ───────────────────────────────────────────

console.log('unlinkEntryFromSystem');
const linked = applyPowerSystemPatch(
  withArtifact,
  withArtifact.id,
  validatePowerSystemPatch(
    {
      upsertProfessions: [
        { name: 'Sword Cultivator', factionIds: ['azure-sect'], characterIds: ['kael-veyron'] },
      ],
      upsertRegions: [
        {
          region: 'Western Marches',
          locationEntryId: 'western-marches',
          typicalRankId: 'foundation',
          note: '',
        },
      ],
    },
    { entries: ENTRIES, existing: withArtifact }
  ),
  'author'
);

// ── formatters: byte-stable, link-resolving ───────────────────────────────

console.log('formatters');
{
  const a = applyPowerSystemPatch(
    null,
    'alpha',
    validatePowerSystemPatch({ name: 'Alpha', upsertRanks: [{ name: 'One' }, { name: 'Two' }] }, ctx),
    'author'
  );
  const b = applyPowerSystemPatch(
    null,
    'beta',
    validatePowerSystemPatch({ name: 'Beta', upsertRanks: [{ name: 'Low' }] }, ctx),
    'author'
  );
  check(
    'formatPowerIndex is byte-identical from either input order',
    formatPowerIndex([a, b]) === formatPowerIndex([b, a])
  );
  check(
    'the index carries the ladder chain',
    formatPowerIndex([a]).includes('One → Two (2 ranks)')
  );

  const NAMED = ENTRIES.map((e) =>
    e.id === 'kael-veyron' ? { ...e, name: 'Kael Veyron' } : e
  );
  const full = formatPowerSystem(linked, NAMED);
  check(
    'formatPowerSystem resolves character links to names',
    full.includes('Kael Veyron (kael-veyron)')
  );
  check('formatPowerSystem shows rank ids for the refiner', full.includes('(foundation)'));

  const dangling = formatPowerSystem(linked, []);
  check('a dangling id degrades to the bare id, not a crash', dangling.includes('kael-veyron'));

  check('an empty roster formats to nothing', formatPowerIndex([]) === '');
}

const noKael = unlinkEntryFromSystem(linked, 'kael-veyron');
check('strips a character from ranks and professions', !!noKael &&
  noKael.ranks.every((r) => !r.characterIds.includes('kael-veyron')) &&
  noKael.professions.every((p) => !p.characterIds.includes('kael-veyron')));

const noTechnique = unlinkEntryFromSystem(linked, 'azure-sword-song');
check('drops the artifact row entirely', !!noTechnique && noTechnique.artifacts.length === 0);

const noLocation = unlinkEntryFromSystem(linked, 'western-marches');
check(
  'a region keeps its name but loses the dead link',
  !!noLocation &&
    noLocation.regions.length === 1 &&
    noLocation.regions[0].locationEntryId === undefined
);

check('an untouched system returns null', unlinkEntryFromSystem(linked, 'starfall-blade') === null);

// ── the agents' upsert handler: error paths (no store call is reached) ────

console.log('handleUpsertPowerSystem — errors as tool output');
{
  const noId = await handleUpsertPowerSystem('nv', {}, [withLadder], ENTRIES, 'model');
  check('a call without an id is refused with the fix', noId.startsWith('Error: id is required'));

  const ghost = await handleUpsertPowerSystem('nv', { id: 'ghost' }, [withLadder], ENTRIES, 'model');
  check(
    'an unknown system names the roster and forbids creation',
    ghost.includes('qi-cultivation') && ghost.includes('Do not create new systems')
  );

  const badLink = await handleUpsertPowerSystem(
    'nv',
    { id: 'qi-cultivation', upsertRanks: [{ name: 'Foundation', characterIds: ['nobody'] }] },
    [withLadder],
    ENTRIES,
    'model'
  );
  check(
    'a validation failure comes back as correctable tool output',
    badLink.startsWith('Error:') && badLink.includes('upsert_story_bible_entry first')
  );
}

// ── cache and ordering invariants ─────────────────────────────────────────
// The power block must never reach the cached prefix, must sit between the
// bible index and the designs (design.invariant.ts asserts bible < designs;
// this pins the block's slot between them), and must render byte-identically
// whatever order systems arrive in.

console.log('generation cache invariants');
{
  const MODEL = 'anthropic/claude-haiku-4.5';
  const novel: Novel = {
    id: 'test',
    ownerUid: 'test',
    title: 'The Drowned Ledger',
    premise: 'A courier in a flooded city discovers a conspiracy hidden in shipping manifests.',
    styleNotes: '',
    style: 'webnovel',
    defaultModel: MODEL,
    chapterLength: 0,
    chapterCount: 0,
    wordCount: 0,
    hidden: false,
    createdAt: 0,
    updatedAt: 0,
  };
  const makeChapter = (number: number): Chapter => ({
    number,
    title: `Chapter ${number}`,
    content: Array.from(
      { length: 40 },
      (_, i) => `Paragraph ${i + 1} of chapter ${number}. Mara rowed the flooded arcade.`
    ).join('\n\n'),
    status: 'accepted',
    summary: '',
    userPrompt: '',
    revisionNotes: [],
    model: MODEL,
    createdAt: 0,
    updatedAt: 0,
  });
  const base = {
    novel,
    chapterNumber: 4,
    previous: [1, 2, 3].map(makeChapter),
    userPrompt: 'Mara reaches the customs house.',
    model: MODEL,
  };

  const without = buildGenerationMessages(base);
  const withPower = buildGenerationMessages({ ...base, powerSystems: [withLadder] });
  check('message count is unchanged by power systems', without.length === withPower.length);
  check(
    'system prompt and chapter history are byte-identical',
    without.slice(0, -1).every((m, i) => JSON.stringify(m) === JSON.stringify(withPower[i]))
  );
  check(
    'only the final instruction message differs',
    JSON.stringify(without.at(-1)) !== JSON.stringify(withPower.at(-1))
  );

  const design = emptyDesign('mara', 'Mara');
  design.state = 'active';
  const instruction = JSON.stringify(
    buildGenerationMessages({
      ...base,
      bibleEntries: ENTRIES,
      powerSystems: [withLadder],
      designs: [design],
    }).at(-1)
  );
  check(
    'the power block sits after the bible index and before the designs',
    instruction.indexOf('STORY BIBLE INDEX') < instruction.indexOf('POWER SYSTEMS') &&
      instruction.indexOf('POWER SYSTEMS') < instruction.indexOf('CHARACTER DESIGNS')
  );
  check('the block names the read tool', instruction.includes('get_power_system'));

  const two = [withLadder, applyPowerSystemPatch(null, 'other', validatePowerSystemPatch({ name: 'Other', upsertRanks: [{ name: 'Novice' }, { name: 'Adept' }] }, ctx), 'author')];
  check(
    'system order does not change the rendered instruction',
    JSON.stringify(buildGenerationMessages({ ...base, powerSystems: [...two] }).at(-1)) ===
      JSON.stringify(buildGenerationMessages({ ...base, powerSystems: [...two].reverse() }).at(-1))
  );

  check('no systems renders an empty block', buildPowerBlock([]) === '');

  const bigLadder = applyPowerSystemPatch(
    null,
    'big',
    validatePowerSystemPatch(
      { name: 'Big', upsertRanks: Array.from({ length: 9 }, (_, i) => ({ name: `Rank ${i + 1}` })) },
      ctx
    ),
    'author'
  );
  const block = buildPowerBlock([bigLadder]);
  check(
    'long ladders disclose what the block withholds',
    block.includes('3 more ranks — read them with get_power_system')
  );
}

// ───────────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
