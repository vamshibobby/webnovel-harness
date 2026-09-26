import type {
  BibleEntry,
  PowerArtifact,
  PowerProfession,
  PowerRank,
  PowerSource,
  PowerSystem,
  RegionalPowerLevel,
} from './types.js';

/**
 * Validation for power system writes.
 *
 * The bibleValidate contract: two callers with different needs share one set
 * of rules —
 *  - the author, editing through the Power view — errors become 400s;
 *  - an agent (bible pass or the generator), writing through a tool call —
 *    errors are returned as tool output so the model corrects itself.
 *
 * Two rules do most of the work here:
 *  - every linked id must resolve to a bible entry of the right type, so a
 *    system can never describe something the bible has not heard of;
 *  - patches are granular merge ops (upsert/remove per section), matched by
 *    id, so re-sending the same patch is a no-op — the idempotency the agent
 *    retry loop depends on.
 */

export const POWER_LIMITS = {
  systemsPerNovel: 5,
  name: 120,
  summary: 500,
  /** costsAndLimits, rarityNote, crossSystemNote. */
  freeText: 500,
  note: 300,
  ranksPerSystem: 20,
  capabilitiesPerRank: 8,
  capability: 200,
  skillsPerRank: 10,
  skill: 200,
  professionsPerSystem: 12,
  aliases: 8,
  alias: 80,
  artifactsPerSystem: 40,
  scaling: 300,
  regionsPerSystem: 20,
  region: 120,
  charactersPerList: 15,
  factionsPerProfession: 8,
  openQuestions: 12,
  openQuestion: 300,
} as const;

/** Raised on invalid input; the caller decides whether it becomes a 400 or a tool error. */
export class PowerValidationError extends Error {}

const fail = (msg: string): never => {
  throw new PowerValidationError(msg);
};

/** "Qi Cultivation" -> "qi-cultivation". Doc ids are slugs so collisions are visible. */
export function slugifyPowerName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || fail('name must contain at least one letter or digit');
}

function str(value: unknown, field: string, max: number, { required = false } = {}): string {
  if (value === undefined || value === null) {
    if (required) fail(`${field} is required`);
    return '';
  }
  if (typeof value !== 'string') fail(`${field} must be a string`);
  const trimmed = (value as string).trim();
  if (required && !trimmed) fail(`${field} is required`);
  if (trimmed.length > max) fail(`${field} is too long (max ${max} characters)`);
  return trimmed;
}

function strList(
  value: unknown,
  field: string,
  maxItems: number,
  maxLen: number
): string[] {
  if (!Array.isArray(value)) fail(`${field} must be an array of strings`);
  const items = (value as unknown[]).map((v, i) =>
    str(v, `${field}[${i}]`, maxLen, { required: true })
  );
  if (items.length > maxItems) fail(`too many ${field} (max ${maxItems})`);
  return [...new Set(items)];
}

/**
 * The mutable, caller-writable slice of a system: granular merge ops, never
 * whole-document replacement. Upserts are matched by id (or slug of name for
 * ranks/professions), so an agent can touch one rank without restating the
 * ladder, and restating it anyway changes nothing.
 */
export interface PowerSystemPatch {
  name?: string;
  summary?: string;
  energyName?: string;
  costsAndLimits?: string;
  rarityNote?: string;
  crossSystemNote?: string;
  /** Small; replaces the list. */
  openQuestions?: string[];
  upsertRanks?: Array<Partial<PowerRank> & { name: string }>;
  removeRankIds?: string[];
  /** Full ladder order when reordering; otherwise new ranks append. */
  rankOrder?: string[];
  upsertProfessions?: Array<Partial<PowerProfession> & { name: string }>;
  removeProfessionIds?: string[];
  /** Matched by entryId. */
  upsertArtifacts?: PowerArtifact[];
  removeArtifactEntryIds?: string[];
  /** Matched by slug of region. */
  upsertRegions?: RegionalPowerLevel[];
  removeRegions?: string[];
}

/** The entry types an artifact may link to. */
const ARTIFACT_ENTRY_TYPES = ['technique', 'weapon', 'item'] as const;

function requireEntry(
  entries: BibleEntry[],
  id: string,
  allowed: readonly string[],
  field: string
): void {
  const entry = entries.find((e) => e.id === id);
  if (!entry) {
    fail(
      `${field}: unknown entry id "${id}" — create it with upsert_story_bible_entry first, then link it`
    );
  }
  if (!allowed.includes(entry!.type)) {
    fail(
      `${field}: entry "${id}" is a ${entry!.type}, but only ${allowed.join(' | ')} can be linked here`
    );
  }
}

function validateRankPatch(raw: unknown, i: number): Partial<PowerRank> & { name: string } {
  if (typeof raw !== 'object' || raw === null) fail(`upsertRanks[${i}] must be an object`);
  const input = raw as Record<string, unknown>;
  const out: Partial<PowerRank> & { name: string } = {
    name: str(input.name, `upsertRanks[${i}].name`, POWER_LIMITS.name, { required: true }),
  };
  if (input.id !== undefined) out.id = str(input.id, `upsertRanks[${i}].id`, POWER_LIMITS.name);
  if (input.summary !== undefined) {
    out.summary = str(input.summary, `upsertRanks[${i}].summary`, POWER_LIMITS.summary);
  }
  if (input.capabilities !== undefined) {
    out.capabilities = strList(
      input.capabilities,
      `upsertRanks[${i}].capabilities`,
      POWER_LIMITS.capabilitiesPerRank,
      POWER_LIMITS.capability
    );
  }
  if (input.skills !== undefined) {
    out.skills = strList(
      input.skills,
      `upsertRanks[${i}].skills`,
      POWER_LIMITS.skillsPerRank,
      POWER_LIMITS.skill
    );
  }
  if (input.advancement !== undefined) {
    out.advancement = str(input.advancement, `upsertRanks[${i}].advancement`, POWER_LIMITS.freeText);
  }
  if (input.rarity !== undefined) {
    out.rarity = str(input.rarity, `upsertRanks[${i}].rarity`, POWER_LIMITS.note);
  }
  if (input.characterIds !== undefined) {
    out.characterIds = strList(
      input.characterIds,
      `upsertRanks[${i}].characterIds`,
      POWER_LIMITS.charactersPerList,
      POWER_LIMITS.name
    );
  }
  if (input.note !== undefined) {
    out.note = str(input.note, `upsertRanks[${i}].note`, POWER_LIMITS.note);
  }
  return out;
}

function validateProfessionPatch(
  raw: unknown,
  i: number
): Partial<PowerProfession> & { name: string } {
  if (typeof raw !== 'object' || raw === null) fail(`upsertProfessions[${i}] must be an object`);
  const input = raw as Record<string, unknown>;
  const out: Partial<PowerProfession> & { name: string } = {
    name: str(input.name, `upsertProfessions[${i}].name`, POWER_LIMITS.name, { required: true }),
  };
  if (input.id !== undefined) {
    out.id = str(input.id, `upsertProfessions[${i}].id`, POWER_LIMITS.name);
  }
  if (input.aliases !== undefined) {
    out.aliases = strList(
      input.aliases,
      `upsertProfessions[${i}].aliases`,
      POWER_LIMITS.aliases,
      POWER_LIMITS.alias
    );
  }
  if (input.summary !== undefined) {
    out.summary = str(input.summary, `upsertProfessions[${i}].summary`, POWER_LIMITS.summary);
  }
  if (input.role !== undefined) {
    out.role = str(input.role, `upsertProfessions[${i}].role`, POWER_LIMITS.note);
  }
  if (input.advancement !== undefined) {
    out.advancement = str(
      input.advancement,
      `upsertProfessions[${i}].advancement`,
      POWER_LIMITS.freeText
    );
  }
  if (input.signatureSkills !== undefined) {
    out.signatureSkills = strList(
      input.signatureSkills,
      `upsertProfessions[${i}].signatureSkills`,
      POWER_LIMITS.skillsPerRank,
      POWER_LIMITS.skill
    );
  }
  if (input.factionIds !== undefined) {
    out.factionIds = strList(
      input.factionIds,
      `upsertProfessions[${i}].factionIds`,
      POWER_LIMITS.factionsPerProfession,
      POWER_LIMITS.name
    );
  }
  if (input.characterIds !== undefined) {
    out.characterIds = strList(
      input.characterIds,
      `upsertProfessions[${i}].characterIds`,
      POWER_LIMITS.charactersPerList,
      POWER_LIMITS.name
    );
  }
  if (input.note !== undefined) {
    out.note = str(input.note, `upsertProfessions[${i}].note`, POWER_LIMITS.note);
  }
  return out;
}

function validateArtifactPatch(raw: unknown, i: number): PowerArtifact {
  if (typeof raw !== 'object' || raw === null) fail(`upsertArtifacts[${i}] must be an object`);
  const input = raw as Record<string, unknown>;
  const out: PowerArtifact = {
    entryId: str(input.entryId, `upsertArtifacts[${i}].entryId`, POWER_LIMITS.name, {
      required: true,
    }),
    scaling: str(input.scaling, `upsertArtifacts[${i}].scaling`, POWER_LIMITS.scaling),
    note: str(input.note, `upsertArtifacts[${i}].note`, POWER_LIMITS.note),
  };
  const rankId = str(input.rankId, `upsertArtifacts[${i}].rankId`, POWER_LIMITS.name);
  if (rankId) out.rankId = rankId;
  return out;
}

function validateRegionPatch(raw: unknown, i: number): RegionalPowerLevel {
  if (typeof raw !== 'object' || raw === null) fail(`upsertRegions[${i}] must be an object`);
  const input = raw as Record<string, unknown>;
  const out: RegionalPowerLevel = {
    region: str(input.region, `upsertRegions[${i}].region`, POWER_LIMITS.region, {
      required: true,
    }),
    typicalRankId: str(input.typicalRankId, `upsertRegions[${i}].typicalRankId`, POWER_LIMITS.name, {
      required: true,
    }),
    note: str(input.note, `upsertRegions[${i}].note`, POWER_LIMITS.note),
  };
  const locationEntryId = str(
    input.locationEntryId,
    `upsertRegions[${i}].locationEntryId`,
    POWER_LIMITS.name
  );
  if (locationEntryId) out.locationEntryId = locationEntryId;
  const apexRankId = str(input.apexRankId, `upsertRegions[${i}].apexRankId`, POWER_LIMITS.name);
  if (apexRankId) out.apexRankId = apexRankId;
  return out;
}

/**
 * Validate an untrusted patch (agent tool args or author body).
 *
 * `entries` is the novel's bible — every linked id must resolve there with the
 * right type. `existing` is the system being patched (null on create); rank
 * references (`rankId`, `typicalRankId`, `apexRankId`) are validated against
 * the ladder AS IT WILL BE after the patch's own rank ops apply, so a patch
 * may add a rank and reference it in the same call.
 */
export function validatePowerSystemPatch(
  raw: unknown,
  ctx: { entries: BibleEntry[]; existing: PowerSystem | null }
): PowerSystemPatch {
  if (typeof raw !== 'object' || raw === null) fail('patch must be an object');
  const input = raw as Record<string, unknown>;
  const patch: PowerSystemPatch = {};

  if (input.name !== undefined) {
    patch.name = str(input.name, 'name', POWER_LIMITS.name, { required: true });
  }
  if (input.summary !== undefined) {
    patch.summary = str(input.summary, 'summary', POWER_LIMITS.summary);
  }
  if (input.energyName !== undefined) {
    patch.energyName = str(input.energyName, 'energyName', POWER_LIMITS.name);
  }
  if (input.costsAndLimits !== undefined) {
    patch.costsAndLimits = str(input.costsAndLimits, 'costsAndLimits', POWER_LIMITS.freeText);
  }
  if (input.rarityNote !== undefined) {
    patch.rarityNote = str(input.rarityNote, 'rarityNote', POWER_LIMITS.freeText);
  }
  if (input.crossSystemNote !== undefined) {
    patch.crossSystemNote = str(input.crossSystemNote, 'crossSystemNote', POWER_LIMITS.freeText);
  }
  if (input.openQuestions !== undefined) {
    patch.openQuestions = strList(
      input.openQuestions,
      'openQuestions',
      POWER_LIMITS.openQuestions,
      POWER_LIMITS.openQuestion
    );
  }

  if (input.upsertRanks !== undefined) {
    if (!Array.isArray(input.upsertRanks)) fail('upsertRanks must be an array');
    patch.upsertRanks = (input.upsertRanks as unknown[]).map(validateRankPatch);
  }
  if (input.removeRankIds !== undefined) {
    patch.removeRankIds = strList(
      input.removeRankIds,
      'removeRankIds',
      POWER_LIMITS.ranksPerSystem,
      POWER_LIMITS.name
    );
  }
  if (input.rankOrder !== undefined) {
    patch.rankOrder = strList(
      input.rankOrder,
      'rankOrder',
      POWER_LIMITS.ranksPerSystem,
      POWER_LIMITS.name
    );
  }

  if (input.upsertProfessions !== undefined) {
    if (!Array.isArray(input.upsertProfessions)) fail('upsertProfessions must be an array');
    patch.upsertProfessions = (input.upsertProfessions as unknown[]).map(validateProfessionPatch);
  }
  if (input.removeProfessionIds !== undefined) {
    patch.removeProfessionIds = strList(
      input.removeProfessionIds,
      'removeProfessionIds',
      POWER_LIMITS.professionsPerSystem,
      POWER_LIMITS.name
    );
  }

  if (input.upsertArtifacts !== undefined) {
    if (!Array.isArray(input.upsertArtifacts)) fail('upsertArtifacts must be an array');
    patch.upsertArtifacts = (input.upsertArtifacts as unknown[]).map(validateArtifactPatch);
  }
  if (input.removeArtifactEntryIds !== undefined) {
    patch.removeArtifactEntryIds = strList(
      input.removeArtifactEntryIds,
      'removeArtifactEntryIds',
      POWER_LIMITS.artifactsPerSystem,
      POWER_LIMITS.name
    );
  }

  if (input.upsertRegions !== undefined) {
    if (!Array.isArray(input.upsertRegions)) fail('upsertRegions must be an array');
    patch.upsertRegions = (input.upsertRegions as unknown[]).map(validateRegionPatch);
  }
  if (input.removeRegions !== undefined) {
    patch.removeRegions = strList(
      input.removeRegions,
      'removeRegions',
      POWER_LIMITS.regionsPerSystem,
      POWER_LIMITS.region
    );
  }

  // Link checks — every id the patch introduces must resolve in the bible.
  for (const rank of patch.upsertRanks ?? []) {
    for (const id of rank.characterIds ?? []) {
      requireEntry(ctx.entries, id, ['character'], 'characterIds');
    }
  }
  for (const prof of patch.upsertProfessions ?? []) {
    for (const id of prof.characterIds ?? []) {
      requireEntry(ctx.entries, id, ['character'], 'characterIds');
    }
    for (const id of prof.factionIds ?? []) {
      requireEntry(ctx.entries, id, ['faction'], 'factionIds');
    }
  }
  for (const artifact of patch.upsertArtifacts ?? []) {
    requireEntry(ctx.entries, artifact.entryId, ARTIFACT_ENTRY_TYPES, 'artifacts');
  }
  for (const region of patch.upsertRegions ?? []) {
    if (region.locationEntryId) {
      requireEntry(ctx.entries, region.locationEntryId, ['location'], 'regions');
    }
  }

  // Rank references are checked against the MERGED ladder: existing ranks,
  // minus removals, plus this patch's upserts.
  const ladder = new Set<string>();
  for (const rank of ctx.existing?.ranks ?? []) ladder.add(rank.id);
  for (const id of patch.removeRankIds ?? []) ladder.delete(id);
  for (const rank of patch.upsertRanks ?? []) ladder.add(rank.id ?? slugifyPowerName(rank.name));
  const requireRank = (id: string | undefined, field: string) => {
    if (id && !ladder.has(id)) {
      fail(`${field}: unknown rank id "${id}" — add the rank with upsertRanks first, or use an existing rank id`);
    }
  };
  for (const artifact of patch.upsertArtifacts ?? []) requireRank(artifact.rankId, 'artifacts.rankId');
  for (const region of patch.upsertRegions ?? []) {
    requireRank(region.typicalRankId, 'regions.typicalRankId');
    requireRank(region.apexRankId, 'regions.apexRankId');
  }

  return patch;
}

const slugOf = (explicit: string | undefined, name: string): string =>
  explicit || slugifyPowerName(name);

/**
 * Merge a validated patch onto an existing system (or a fresh skeleton).
 *
 * `source` is who is writing, and it decides two things:
 *  - provenance: an author write onto a model-made system (or the reverse)
 *    lands the system on 'mixed', and it never goes back — the badge is a
 *    history, not a state machine;
 *  - list semantics: a MODEL write unions lists (an agent adds one capability
 *    without restating the rest, and retries stay idempotent), while an
 *    AUTHOR write replaces them (the form shows the whole list, so what the
 *    author saved IS the list — union would make removal impossible).
 */
export function applyPowerSystemPatch(
  existing: PowerSystem | null,
  id: string,
  patch: PowerSystemPatch,
  source: PowerSource
): PowerSystem {
  const authorMode = source === 'author';
  /** Model: union (dedup by exact text). Author: the patch is the list. */
  const mergeList = (base: string[], add: string[] | undefined): string[] =>
    add === undefined ? base : authorMode ? [...new Set(add)] : [...new Set([...base, ...add])];
  /** Model: '' never clobbers. Author: what the form sent is the value. */
  const keep = (base: string, next: string | undefined): string =>
    next === undefined ? base : authorMode || next !== '' ? next : base;
  const now = Date.now();
  const base: PowerSystem = existing ?? {
    id,
    name: patch.name ?? fail('name is required when creating a power system'),
    summary: '',
    source,
    energyName: '',
    costsAndLimits: '',
    rarityNote: '',
    crossSystemNote: '',
    ranks: [],
    professions: [],
    artifacts: [],
    regions: [],
    openQuestions: [],
    createdAt: now,
    updatedAt: now,
  };

  // Ranks: merge by id, remove, then order.
  let ranks = base.ranks;
  if (patch.removeRankIds?.length) {
    const drop = new Set(patch.removeRankIds);
    ranks = ranks.filter((r) => !drop.has(r.id));
  }
  if (patch.upsertRanks?.length) {
    ranks = [...ranks];
    for (const up of patch.upsertRanks) {
      const rankId = slugOf(up.id, up.name);
      const at = ranks.findIndex((r) => r.id === rankId);
      const prev: PowerRank =
        at >= 0
          ? ranks[at]
          : {
              id: rankId,
              name: up.name,
              summary: '',
              capabilities: [],
              skills: [],
              advancement: '',
              rarity: '',
              characterIds: [],
              note: '',
            };
      const next: PowerRank = {
        ...prev,
        name: up.name || prev.name,
        summary: keep(prev.summary, up.summary),
        capabilities: mergeList(prev.capabilities, up.capabilities),
        skills: mergeList(prev.skills, up.skills),
        advancement: keep(prev.advancement, up.advancement),
        rarity: keep(prev.rarity, up.rarity),
        characterIds: mergeList(prev.characterIds, up.characterIds),
        note: keep(prev.note, up.note),
      };
      if (at >= 0) ranks[at] = next;
      else ranks.push(next);
    }
  }
  if (patch.rankOrder?.length) {
    // Named ranks in the given order, then any the order forgot, in place.
    const byId = new Map(ranks.map((r) => [r.id, r]));
    const ordered: PowerRank[] = [];
    for (const rankId of patch.rankOrder) {
      const rank = byId.get(rankId);
      if (rank) {
        ordered.push(rank);
        byId.delete(rankId);
      }
    }
    ranks = [...ordered, ...ranks.filter((r) => byId.has(r.id))];
  }
  if (ranks.length > POWER_LIMITS.ranksPerSystem) {
    fail(
      `system would have ${ranks.length} ranks (max ${POWER_LIMITS.ranksPerSystem}) — ` +
        'merge sub-stages into one rank or remove ranks with removeRankIds'
    );
  }

  // Professions: merge by id, remove.
  let professions = base.professions;
  if (patch.removeProfessionIds?.length) {
    const drop = new Set(patch.removeProfessionIds);
    professions = professions.filter((p) => !drop.has(p.id));
  }
  if (patch.upsertProfessions?.length) {
    professions = [...professions];
    for (const up of patch.upsertProfessions) {
      const profId = slugOf(up.id, up.name);
      const at = professions.findIndex((p) => p.id === profId);
      const prev: PowerProfession =
        at >= 0
          ? professions[at]
          : {
              id: profId,
              name: up.name,
              aliases: [],
              summary: '',
              role: '',
              advancement: '',
              signatureSkills: [],
              factionIds: [],
              characterIds: [],
              note: '',
            };
      const next: PowerProfession = {
        ...prev,
        name: up.name || prev.name,
        aliases: mergeList(prev.aliases, up.aliases),
        summary: keep(prev.summary, up.summary),
        role: keep(prev.role, up.role),
        advancement: keep(prev.advancement, up.advancement),
        signatureSkills: mergeList(prev.signatureSkills, up.signatureSkills),
        factionIds: mergeList(prev.factionIds, up.factionIds),
        characterIds: mergeList(prev.characterIds, up.characterIds),
        note: keep(prev.note, up.note),
      };
      if (at >= 0) professions[at] = next;
      else professions.push(next);
    }
  }
  if (professions.length > POWER_LIMITS.professionsPerSystem) {
    fail(
      `system would have ${professions.length} professions (max ${POWER_LIMITS.professionsPerSystem}) — ` +
        'remove some with removeProfessionIds'
    );
  }

  // Artifacts: merge by entryId, remove.
  let artifacts = base.artifacts;
  if (patch.removeArtifactEntryIds?.length) {
    const drop = new Set(patch.removeArtifactEntryIds);
    artifacts = artifacts.filter((a) => !drop.has(a.entryId));
  }
  if (patch.upsertArtifacts?.length) {
    artifacts = [...artifacts];
    for (const up of patch.upsertArtifacts) {
      const at = artifacts.findIndex((a) => a.entryId === up.entryId);
      if (at < 0) {
        artifacts.push(up);
      } else if (authorMode) {
        // The form shows the whole row; what the author saved IS the row —
        // including an absent rankId, which is how an artifact is unpinned.
        artifacts[at] = up;
      } else {
        const prev = artifacts[at];
        const next: PowerArtifact = {
          ...prev,
          scaling: keep(prev.scaling, up.scaling),
          note: keep(prev.note, up.note),
        };
        if (up.rankId) next.rankId = up.rankId;
        artifacts[at] = next;
      }
    }
  }
  if (artifacts.length > POWER_LIMITS.artifactsPerSystem) {
    fail(
      `system would have ${artifacts.length} artifacts (max ${POWER_LIMITS.artifactsPerSystem}) — ` +
        'keep only the ones that matter to scaling; remove the rest with removeArtifactEntryIds'
    );
  }

  // Regions: merge by slug of region name, remove (by name or slug).
  let regions = base.regions;
  if (patch.removeRegions?.length) {
    const drop = new Set(patch.removeRegions.map((r) => slugifyPowerName(r)));
    regions = regions.filter((r) => !drop.has(slugifyPowerName(r.region)));
  }
  if (patch.upsertRegions?.length) {
    regions = [...regions];
    for (const up of patch.upsertRegions) {
      const key = slugifyPowerName(up.region);
      const at = regions.findIndex((r) => slugifyPowerName(r.region) === key);
      if (at < 0) {
        regions.push(up);
      } else if (authorMode) {
        regions[at] = up;
      } else {
        const prev = regions[at];
        const next: RegionalPowerLevel = {
          ...prev,
          typicalRankId: up.typicalRankId || prev.typicalRankId,
          note: keep(prev.note, up.note),
        };
        if (up.locationEntryId) next.locationEntryId = up.locationEntryId;
        if (up.apexRankId) next.apexRankId = up.apexRankId;
        regions[at] = next;
      }
    }
  }
  if (regions.length > POWER_LIMITS.regionsPerSystem) {
    fail(
      `system would have ${regions.length} regions (max ${POWER_LIMITS.regionsPerSystem}) — ` +
        'remove some with removeRegions'
    );
  }

  return {
    ...base,
    name: patch.name ?? base.name,
    summary: keep(base.summary, patch.summary),
    // 'mixed' is sticky: once both hands have touched it, it stays touched.
    source: existing && existing.source !== source ? 'mixed' : base.source,
    energyName: keep(base.energyName, patch.energyName),
    costsAndLimits: keep(base.costsAndLimits, patch.costsAndLimits),
    rarityNote: keep(base.rarityNote, patch.rarityNote),
    crossSystemNote: keep(base.crossSystemNote, patch.crossSystemNote),
    ranks,
    professions,
    artifacts,
    regions,
    openQuestions: patch.openQuestions ?? base.openQuestions,
    updatedAt: now,
  };
}

/**
 * Strip a deleted bible entry out of a system. Returns null when nothing
 * referenced it, so the caller writes only the systems that changed.
 */
export function unlinkEntryFromSystem(system: PowerSystem, entryId: string): PowerSystem | null {
  let touched = false;

  const ranks = system.ranks.map((r) => {
    if (!r.characterIds.includes(entryId)) return r;
    touched = true;
    return { ...r, characterIds: r.characterIds.filter((id) => id !== entryId) };
  });
  const professions = system.professions.map((p) => {
    if (!p.characterIds.includes(entryId) && !p.factionIds.includes(entryId)) return p;
    touched = true;
    return {
      ...p,
      characterIds: p.characterIds.filter((id) => id !== entryId),
      factionIds: p.factionIds.filter((id) => id !== entryId),
    };
  });
  const artifacts = system.artifacts.filter((a) => {
    if (a.entryId !== entryId) return true;
    touched = true;
    return false;
  });
  const regions = system.regions.map((r) => {
    if (r.locationEntryId !== entryId) return r;
    touched = true;
    const { locationEntryId: _dropped, ...rest } = r;
    return rest;
  });

  if (!touched) return null;
  return { ...system, ranks, professions, artifacts, regions, updatedAt: Date.now() };
}
