import { ARC_DEVICES, CUSTOM_DEVICE_ID } from '../engine/designCatalog.js';
import type {
  ArcState,
  CharacterDesign,
  DesignArc,
  DesignRelationship,
  DesignSecret,
} from './types.js';

/**
 * Validation for character design writes.
 *
 * Same two-caller contract as bibleValidate: the author's PATCH turns errors
 * into 400s, the assist agent's tool turns them into tool output it can read
 * and retry against.
 *
 * Merge semantics differ from the bible on purpose. The bible is an
 * append-only fact log maintained by a machine, so it merges defensively. A
 * design is an author-owned workspace: nested objects shallow-merge (so an
 * agent filling `motivation.want` cannot blank `motivation.need`), but lists
 * the author curates — arcs, secrets, relationships — replace wholesale,
 * because "remove the third secret" has to be expressible.
 *
 * `state` and `steer` are absent from DesignPatch by design: activating a
 * design or pressing its arc into every prompt is always an explicit author
 * action, so the assist agent structurally cannot do either.
 */

export const DESIGN_LIMITS = {
  designsPerNovel: 50,
  name: 120,
  essential: 300,
  voice: 500,
  motivationField: 300,
  traitItem: 80,
  traitsPerList: 10,
  backstory: 2000,
  secret: 300,
  secrets: 20,
  arcs: 5,
  arcSummary: 500,
  arcStage: 160,
  arcStagesMin: 2,
  arcStages: 7,
  arcNudge: 200,
  customLabel: 80,
  relationships: 20,
  relationshipNature: 120,
  relationshipIntent: 300,
  notes: 2000,
} as const;

const ARC_STATES: readonly ArcState[] = ['potential', 'current', 'done', 'dropped'];

export class DesignValidationError extends Error {}

const fail = (msg: string): never => {
  throw new DesignValidationError(msg);
};

/** "Kael Veyron" -> "kael-veyron". Same rules as the bible, separate namespace. */
export function slugifyDesignName(name: string): string {
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

function strList(value: unknown, field: string, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(value)) fail(`${field} must be an array of strings`);
  const list = (value as unknown[])
    .map((v, i) => str(v, `${field}[${i}]`, maxLen))
    .filter(Boolean);
  if (list.length > maxItems) fail(`too many entries in ${field} (max ${maxItems})`);
  return [...new Set(list)];
}

/** Partial objects merge field-by-field, so an agent filling one key keeps the rest. */
function partialRecord<T extends Record<string, string>>(
  value: unknown,
  field: string,
  keys: Array<keyof T & string>,
  maxFor: (key: string) => number
): Partial<T> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }
  const input = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of Object.keys(input)) {
    if (!keys.includes(key as keyof T & string)) {
      fail(`unknown ${field} key "${key}" — allowed: ${keys.join(', ')}`);
    }
    out[key] = str(input[key], `${field}.${key}`, maxFor(key));
  }
  return out as Partial<T>;
}

function validateArc(raw: unknown, i: number): DesignArc {
  if (typeof raw !== 'object' || raw === null) fail(`arcs[${i}] must be an object`);
  const input = raw as Record<string, unknown>;

  const device = str(input.device, `arcs[${i}].device`, 80, { required: true });
  const known = device === CUSTOM_DEVICE_ID || ARC_DEVICES.some((d) => d.id === device);
  if (!known) {
    fail(
      `arcs[${i}].device "${device}" is not a known narrative device — use one of: ` +
        `${ARC_DEVICES.map((d) => d.id).join(', ')}, or "${CUSTOM_DEVICE_ID}" with a customLabel`
    );
  }
  const customLabel = str(input.customLabel, `arcs[${i}].customLabel`, DESIGN_LIMITS.customLabel);
  if (device === CUSTOM_DEVICE_ID && !customLabel) {
    fail(`arcs[${i}].customLabel is required when device is "${CUSTOM_DEVICE_ID}"`);
  }

  const stages = strList(
    input.stages ?? [],
    `arcs[${i}].stages`,
    DESIGN_LIMITS.arcStages,
    DESIGN_LIMITS.arcStage
  );
  if (stages.length < DESIGN_LIMITS.arcStagesMin) {
    fail(
      `arcs[${i}].stages needs at least ${DESIGN_LIMITS.arcStagesMin} beats — ` +
        'an arc without beats cannot be steered chapter to chapter'
    );
  }

  const state = str(input.state, `arcs[${i}].state`, 20) || 'potential';
  if (!ARC_STATES.includes(state as ArcState)) {
    fail(`arcs[${i}].state must be one of: ${ARC_STATES.join(', ')}`);
  }

  let currentStage = 0;
  if (typeof input.currentStage === 'number' && Number.isFinite(input.currentStage)) {
    currentStage = Math.min(Math.max(Math.round(input.currentStage), 0), stages.length - 1);
  }

  const arc: DesignArc = {
    device,
    summary: str(input.summary, `arcs[${i}].summary`, DESIGN_LIMITS.arcSummary),
    stages,
    currentStage,
    nudge: str(input.nudge, `arcs[${i}].nudge`, DESIGN_LIMITS.arcNudge),
    state: state as ArcState,
  };
  if (customLabel) arc.customLabel = customLabel;
  return arc;
}

function validateSecret(raw: unknown, i: number): DesignSecret {
  if (typeof raw === 'string') {
    return { text: str(raw, `secrets[${i}]`, DESIGN_LIMITS.secret, { required: true }), revealed: false };
  }
  if (typeof raw !== 'object' || raw === null) fail(`secrets[${i}] must be an object or string`);
  const input = raw as Record<string, unknown>;
  return {
    text: str(input.text, `secrets[${i}].text`, DESIGN_LIMITS.secret, { required: true }),
    revealed: input.revealed === true,
  };
}

function validateRelationship(raw: unknown, i: number): DesignRelationship {
  if (typeof raw !== 'object' || raw === null) fail(`relationships[${i}] must be an object`);
  const input = raw as Record<string, unknown>;
  const kind = str(input.targetKind, `relationships[${i}].targetKind`, 10) || 'bible';
  if (kind !== 'bible' && kind !== 'design') {
    fail(`relationships[${i}].targetKind must be "bible" or "design"`);
  }
  return {
    targetId: str(input.targetId, `relationships[${i}].targetId`, DESIGN_LIMITS.name, { required: true }),
    targetKind: kind as 'bible' | 'design',
    nature: str(input.nature, `relationships[${i}].nature`, DESIGN_LIMITS.relationshipNature, {
      required: true,
    }),
    intent: str(input.intent, `relationships[${i}].intent`, DESIGN_LIMITS.relationshipIntent),
  };
}

/** The author- and agent-writable slice of a design. */
export interface DesignPatch {
  name?: string;
  /** null clears the link to a bible entry. */
  linkedEntryId?: string | null;
  essentials?: Partial<CharacterDesign['essentials']>;
  motivation?: Partial<CharacterDesign['motivation']>;
  personality?: Partial<CharacterDesign['personality']>;
  history?: { backstory?: string; secrets?: DesignSecret[] };
  arcs?: DesignArc[];
  relationships?: DesignRelationship[];
  notes?: string;
}

export function validateDesignPatch(raw: unknown): DesignPatch {
  if (typeof raw !== 'object' || raw === null) fail('design must be an object');
  const input = raw as Record<string, unknown>;
  const patch: DesignPatch = {};

  if (input.name !== undefined) {
    patch.name = str(input.name, 'name', DESIGN_LIMITS.name, { required: true });
  }
  if (input.linkedEntryId !== undefined) {
    patch.linkedEntryId =
      input.linkedEntryId === null || input.linkedEntryId === ''
        ? null
        : str(input.linkedEntryId, 'linkedEntryId', DESIGN_LIMITS.name, { required: true });
  }
  if (input.notes !== undefined) patch.notes = str(input.notes, 'notes', DESIGN_LIMITS.notes);

  if (input.essentials !== undefined) {
    patch.essentials = partialRecord<CharacterDesign['essentials']>(
      input.essentials,
      'essentials',
      ['role', 'age', 'appearance', 'voice'],
      (key) => (key === 'voice' ? DESIGN_LIMITS.voice : DESIGN_LIMITS.essential)
    );
  }

  if (input.motivation !== undefined) {
    patch.motivation = partialRecord<CharacterDesign['motivation']>(
      input.motivation,
      'motivation',
      ['want', 'need', 'fear', 'lie'],
      () => DESIGN_LIMITS.motivationField
    );
  }

  if (input.personality !== undefined) {
    if (typeof input.personality !== 'object' || input.personality === null) {
      fail('personality must be an object');
    }
    const p = input.personality as Record<string, unknown>;
    const out: Partial<CharacterDesign['personality']> = {};
    for (const key of Object.keys(p)) {
      if (key !== 'traits' && key !== 'flaws' && key !== 'virtues') {
        fail(`unknown personality key "${key}" — allowed: traits, flaws, virtues`);
        continue;
      }
      out[key] = strList(
        p[key],
        `personality.${key}`,
        DESIGN_LIMITS.traitsPerList,
        DESIGN_LIMITS.traitItem
      );
    }
    patch.personality = out;
  }

  if (input.history !== undefined) {
    if (typeof input.history !== 'object' || input.history === null) fail('history must be an object');
    const h = input.history as Record<string, unknown>;
    const history: { backstory?: string; secrets?: DesignSecret[] } = {};
    if (h.backstory !== undefined) {
      history.backstory = str(h.backstory, 'history.backstory', DESIGN_LIMITS.backstory);
    }
    if (h.secrets !== undefined) {
      if (!Array.isArray(h.secrets)) fail('history.secrets must be an array');
      const secrets = (h.secrets as unknown[]).map(validateSecret);
      if (secrets.length > DESIGN_LIMITS.secrets) {
        fail(`too many secrets (max ${DESIGN_LIMITS.secrets})`);
      }
      history.secrets = secrets;
    }
    patch.history = history;
  }

  if (input.arcs !== undefined) {
    if (!Array.isArray(input.arcs)) fail('arcs must be an array');
    if ((input.arcs as unknown[]).length > DESIGN_LIMITS.arcs) {
      fail(`too many arcs (max ${DESIGN_LIMITS.arcs}) — a character can only be going one place at a time`);
    }
    const arcs = (input.arcs as unknown[]).map(validateArc);
    const current = arcs.filter((a) => a.state === 'current');
    if (current.length > 1) {
      fail(
        'only one arc can be "current" at a time — mark the others "potential", "done" or "dropped"'
      );
    }
    patch.arcs = arcs;
  }

  if (input.relationships !== undefined) {
    if (!Array.isArray(input.relationships)) fail('relationships must be an array');
    if ((input.relationships as unknown[]).length > DESIGN_LIMITS.relationships) {
      fail(`too many relationships (max ${DESIGN_LIMITS.relationships})`);
    }
    patch.relationships = (input.relationships as unknown[]).map(validateRelationship);
  }

  return patch;
}

/** A blank design — every field present, so callers never guard on undefined. */
export function emptyDesign(id: string, name: string): CharacterDesign {
  const now = Date.now();
  return {
    id,
    name,
    state: 'draft',
    steer: false,
    essentials: { role: '', age: '', appearance: '', voice: '' },
    motivation: { want: '', need: '', fear: '', lie: '' },
    personality: { traits: [], flaws: [], virtues: [] },
    history: { backstory: '', secrets: [] },
    arcs: [],
    relationships: [],
    notes: '',
    createdAt: now,
    updatedAt: now,
  };
}

export function applyDesignPatch(
  existing: CharacterDesign | null,
  id: string,
  patch: DesignPatch
): CharacterDesign {
  const base = existing ?? emptyDesign(id, patch.name ?? fail('name is required when creating a design'));

  const next: CharacterDesign = {
    ...base,
    name: patch.name ?? base.name,
    essentials: { ...base.essentials, ...patch.essentials },
    motivation: { ...base.motivation, ...patch.motivation },
    personality: { ...base.personality, ...patch.personality },
    history: {
      backstory: patch.history?.backstory ?? base.history.backstory,
      secrets: patch.history?.secrets ?? base.history.secrets,
    },
    arcs: patch.arcs ?? base.arcs,
    relationships: patch.relationships ?? base.relationships,
    notes: patch.notes ?? base.notes,
    updatedAt: Date.now(),
  };

  if (patch.linkedEntryId === null) delete next.linkedEntryId;
  else if (patch.linkedEntryId !== undefined) next.linkedEntryId = patch.linkedEntryId;

  return next;
}

/** The one arc a steer line would describe, if any. */
export function currentArc(design: CharacterDesign): DesignArc | null {
  return design.arcs.find((a) => a.state === 'current') ?? null;
}
