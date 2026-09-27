import {
  POWER_LIMITS,
  PowerValidationError,
  applyPowerSystemPatch,
  slugifyPowerName,
  validatePowerSystemPatch,
} from '../lib/powerValidate.js';
import * as store from '../lib/store.js';
import type { BibleEntry, PowerSource, PowerSystem } from '../lib/types.js';
import type { ToolDefinition } from './openrouter.js';

/**
 * Power system tools and formatters.
 *
 * The bibleTools contract: tool definitions are data, formatters are pure,
 * and everything operates on an in-memory systems array the caller loaded —
 * a novel holds at most five systems, so there is never a per-call read.
 *
 * Every formatter orders by id and renders byte-identically from any input
 * order: the writer's prompt block is built from this output, and the
 * instruction's cache breakpoint depends on it not wobbling between rounds.
 */

export const getPowerToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'get_power_system',
    description:
      'Full detail of one or more power systems: every rank with its capabilities and ' +
      'advancement, professions, scaling techniques and gear, regional power levels. ' +
      'Use before writing a breakthrough, a cross-rank fight, or the limits of a technique.',
    parameters: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'System ids from the POWER SYSTEMS block, e.g. ["qi-cultivation"].',
        },
      },
      required: ['ids'],
    },
  },
};

export const upsertPowerToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'upsert_power_system',
    description:
      'Record what a chapter ESTABLISHED OR CHANGED about an existing power system: a rank ' +
      'gained or named for a bible character, a capability demonstrated at a rank, a ' +
      'technique or weapon tied to a rank, a regional power claim. Send only the ops the ' +
      'chapter supports — upserts merge by id, so never restate what has not changed. ' +
      'Characters, factions, techniques, weapons, items and locations are STORY BIBLE ' +
      'entries: create them with upsert_story_bible_entry FIRST, then link their ids here. ' +
      'Never restate their contents.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The system id from the POWER SYSTEMS block.' },
        upsertRanks: {
          type: 'array',
          description: 'Ranks to update (matched by id or slug of name). New ranks append at the strong end.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Existing rank id, when updating one.' },
              name: { type: 'string' },
              summary: { type: 'string' },
              capabilities: {
                type: 'array',
                items: { type: 'string' },
                description: 'Only capabilities this chapter demonstrated or stated.',
              },
              skills: { type: 'array', items: { type: 'string' } },
              advancement: { type: 'string' },
              rarity: { type: 'string' },
              characterIds: {
                type: 'array',
                items: { type: 'string' },
                description: 'Bible character ids now known to stand at this rank.',
              },
              note: { type: 'string' },
            },
            required: ['name'],
          },
        },
        upsertProfessions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              summary: { type: 'string' },
              role: { type: 'string' },
              advancement: { type: 'string' },
              signatureSkills: { type: 'array', items: { type: 'string' } },
              factionIds: { type: 'array', items: { type: 'string' } },
              characterIds: { type: 'array', items: { type: 'string' } },
              note: { type: 'string' },
            },
            required: ['name'],
          },
        },
        upsertArtifacts: {
          type: 'array',
          description: 'Techniques, weapons or items that scale — by BIBLE ENTRY id.',
          items: {
            type: 'object',
            properties: {
              entryId: { type: 'string', description: 'A bible entry id of type technique, weapon or item.' },
              scaling: { type: 'string', description: 'How it grows with the ladder.' },
              rankId: { type: 'string', description: 'The rank it is tied to, when the chapter says.' },
              note: { type: 'string' },
            },
            required: ['entryId'],
          },
        },
        upsertRegions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              region: { type: 'string' },
              locationEntryId: { type: 'string', description: 'Bible location id, when one exists.' },
              typicalRankId: { type: 'string' },
              apexRankId: { type: 'string' },
              note: { type: 'string' },
            },
            required: ['region', 'typicalRankId'],
          },
        },
        openQuestions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replaces the list. Include to add or resolve open questions.',
        },
      },
      required: ['id'],
    },
  },
};

/** One line per system: what exists, so the model knows what to fetch. */
export function formatPowerIndex(systems: PowerSystem[]): string {
  if (systems.length === 0) return '';
  return [...systems]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) => {
      const ladder =
        s.ranks.length > 0
          ? `ladder: ${s.ranks.map((r) => r.name).join(' → ')} (${s.ranks.length} ranks)`
          : 'no ranks yet';
      const professions =
        s.professions.length > 0
          ? ` · professions: ${s.professions.map((p) => p.name).join(', ')}`
          : '';
      return `${s.id} · ${s.name} — ${ladder}${professions}`;
    })
    .join('\n');
}

/** Resolve a bible id to `Name (id)`, degrading to the bare id. */
function named(id: string, entries: BibleEntry[]): string {
  const entry = entries.find((e) => e.id === id);
  return entry ? `${entry.name} (${id})` : id;
}

/** The full render of one system — what get_power_system returns. */
export function formatPowerSystem(s: PowerSystem, entries: BibleEntry[]): string {
  const lines: string[] = [`POWER SYSTEM: ${s.name} (${s.id})`];
  if (s.summary) lines.push(s.summary);
  if (s.energyName) lines.push(`Energy: ${s.energyName}`);
  if (s.costsAndLimits) lines.push(`Costs and limits: ${s.costsAndLimits}`);
  if (s.rarityNote) lines.push(`Rarity: ${s.rarityNote}`);
  if (s.crossSystemNote) lines.push(`Against other systems: ${s.crossSystemNote}`);

  if (s.ranks.length > 0) {
    lines.push('', 'LADDER (weakest first):');
    s.ranks.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.name} (${r.id})${r.summary ? ` — ${r.summary}` : ''}`);
      if (r.capabilities.length) lines.push(`   can: ${r.capabilities.join('; ')}`);
      if (r.skills.length) lines.push(`   skills: ${r.skills.join('; ')}`);
      if (r.advancement) lines.push(`   reached by: ${r.advancement}`);
      if (r.rarity) lines.push(`   rarity: ${r.rarity}`);
      if (r.characterIds.length) {
        lines.push(`   characters: ${r.characterIds.map((id) => named(id, entries)).join(', ')}`);
      }
      if (r.note) lines.push(`   note: ${r.note}`);
    });
  }

  if (s.professions.length > 0) {
    lines.push('', 'PROFESSIONS:');
    for (const p of s.professions) {
      const parts = [
        `- ${p.name} (${p.id})${p.summary ? `: ${p.summary}` : ''}`,
        p.role ? `  role: ${p.role}` : '',
        p.advancement ? `  advancement: ${p.advancement}` : '',
        p.signatureSkills.length ? `  signature: ${p.signatureSkills.join('; ')}` : '',
        p.factionIds.length
          ? `  gatekept by: ${p.factionIds.map((id) => named(id, entries)).join(', ')}`
          : '',
        p.characterIds.length
          ? `  practitioners: ${p.characterIds.map((id) => named(id, entries)).join(', ')}`
          : '',
        p.note ? `  note: ${p.note}` : '',
      ].filter(Boolean);
      lines.push(...parts);
    }
  }

  if (s.artifacts.length > 0) {
    lines.push('', 'SCALING TECHNIQUES AND GEAR (details live in the story bible):');
    for (const a of [...s.artifacts].sort((x, y) => x.entryId.localeCompare(y.entryId))) {
      const rank = a.rankId ? ` · from rank ${a.rankId}` : '';
      lines.push(
        `- ${named(a.entryId, entries)}${a.scaling ? ` — scales: ${a.scaling}` : ''}${rank}${a.note ? ` · ${a.note}` : ''}`
      );
    }
  }

  if (s.regions.length > 0) {
    lines.push('', 'POWER BY REGION:');
    const rankName = (id?: string) => (id ? (s.ranks.find((r) => r.id === id)?.name ?? id) : '');
    for (const region of [...s.regions].sort((x, y) => x.region.localeCompare(y.region))) {
      const apex = region.apexRankId ? `, strongest known ${rankName(region.apexRankId)}` : '';
      lines.push(
        `- ${region.region}: typically ${rankName(region.typicalRankId)}${apex}${region.note ? ` — ${region.note}` : ''}`
      );
    }
  }

  if (s.openQuestions.length > 0) {
    lines.push('', 'OPEN QUESTIONS (undecided — do not treat as canon):');
    for (const q of s.openQuestions) lines.push(`- ${q}`);
  }

  return lines.join('\n');
}

/** Look systems up by the ids a model asked for, tolerating name-for-id. */
export function findPowerSystems(systems: PowerSystem[], ids: string[]): PowerSystem[] {
  const wanted = ids.map((id) => id.trim().toLowerCase()).filter(Boolean);
  return systems.filter(
    (s) => wanted.includes(s.id.toLowerCase()) || wanted.includes(s.name.toLowerCase())
  );
}

/**
 * The upsert handler both agents share. Validates, writes through the store,
 * and returns tool output — the formatted system on success so the model sees
 * what it wrote, an "Error: …" string on failure so it can correct itself.
 */
export async function handleUpsertPowerSystem(
  novelId: string,
  raw: Record<string, unknown>,
  systems: PowerSystem[],
  entries: BibleEntry[],
  source: PowerSource,
  onWrote?: (system: PowerSystem) => void,
  stage?: (id: string, merge: (current: PowerSystem | null) => PowerSystem) => Promise<PowerSystem>
): Promise<string> {
  try {
    const id = String(raw.id ?? '').trim();
    if (!id) return 'Error: id is required — use a system id from the POWER SYSTEMS block.';
    const existing = findPowerSystems(systems, [id])[0] ?? null;
    if (!existing) {
      // The bible agent never invents a power system: creation is the
      // author's act (wizard or form), extraction only keeps one current.
      const known = systems.map((s) => s.id).join(', ') || 'none';
      return `Error: unknown power system "${id}". This novel has: ${known}. Do not create new systems — record against an existing one, or skip.`;
    }

    const patch = validatePowerSystemPatch(raw, { entries, existing });
    const next = await (stage ?? ((id, merge) => store.transactPowerSystem(novelId, id, merge)))(existing.id, (current) =>
      applyPowerSystemPatch(current ?? existing, existing.id, patch, source)
    );
    onWrote?.(next);
    return `Updated ${next.name}.\n${formatPowerSystem(next, entries)}`;
  } catch (err) {
    if (err instanceof PowerValidationError) return `Error: ${err.message}`;
    throw err;
  }
}

export { POWER_LIMITS, slugifyPowerName };
