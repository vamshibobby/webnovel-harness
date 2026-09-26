import {
  defaultCharter,
  type NamingCharter,
  type NamingCulture,
} from '../engine/naming/charter.js';
import { isNamingPack } from '../engine/naming/formulas.js';
import { DEFAULT_SOUND_WORLD_ID, isSoundWorldId } from '../engine/naming/lexicons.js';
import type { Novel } from './types.js';

/**
 * Validation for naming-charter writes.
 *
 * Two callers, the same rules — the author editing the charter through the
 * Naming page (errors become 400s) and the derive agent writing through a tool
 * call (errors go back to the model as tool output so it corrects itself). Same
 * contract as bibleValidate.ts, for the same reason: a malformed charter must
 * never reach Firestore, and the agent must be told exactly what was wrong.
 *
 * The caps are small because the charter is prompt-visible on every chapter of
 * the novel — it rides in the cached system prompt, so an unbounded charter is
 * an unbounded prefix that every generation pays to write once and read forever.
 */

export const NAMING_LIMITS = {
  cultures: 6,
  cultureId: 40,
  label: 60,
  appliesTo: 240,
  banned: 40,
  bannedWord: 40,
  notes: 600,
} as const;

export class NamingValidationError extends Error {}

const fail = (msg: string): never => {
  throw new NamingValidationError(msg);
};

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

/** "the northern clans" -> "the-northern-clans". Culture ids seed the generator. */
export function slugifyCultureLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, NAMING_LIMITS.cultureId);
  return slug || fail('a culture needs a name with at least one letter or digit');
}

export interface NamingCharterPatch {
  cultures?: NamingCulture[];
  pack?: NamingCharter['pack'];
  banned?: string[];
  notes?: string;
}

export function validateCharterPatch(raw: unknown): NamingCharterPatch {
  if (typeof raw !== 'object' || raw === null) fail('the charter must be an object');
  const input = raw as Record<string, unknown>;
  const patch: NamingCharterPatch = {};

  if (input.cultures !== undefined) {
    if (!Array.isArray(input.cultures)) fail('cultures must be an array');
    const list = input.cultures as unknown[];
    if (!list.length) fail('a charter needs at least one culture');
    if (list.length > NAMING_LIMITS.cultures) {
      fail(`too many cultures (max ${NAMING_LIMITS.cultures})`);
    }
    const seen = new Set<string>();
    patch.cultures = list.map((item) => {
      if (typeof item !== 'object' || item === null) fail('every culture must be an object');
      const c = item as Record<string, unknown>;
      const label = str(c.label, 'culture label', NAMING_LIMITS.label, { required: true });
      const id = c.id ? slugifyCultureLabel(String(c.id)) : slugifyCultureLabel(label);
      if (seen.has(id)) fail(`two cultures share the name "${label}"`);
      seen.add(id);
      // An unknown sound world is corrected rather than refused: the author is
      // editing a form, and a rejected save over a value they did not type is
      // a dead end they cannot escape.
      const soundWorldId = isSoundWorldId(c.soundWorldId)
        ? String(c.soundWorldId)
        : DEFAULT_SOUND_WORLD_ID;
      return {
        id,
        label,
        soundWorldId,
        appliesTo: str(c.appliesTo, 'appliesTo', NAMING_LIMITS.appliesTo),
      };
    });
  }

  if (input.pack !== undefined) {
    if (isNamingPack(input.pack)) patch.pack = input.pack;
    else fail('pack must be one of: western, xianxia, litrpg, modern');
  }

  if (input.banned !== undefined) {
    if (!Array.isArray(input.banned)) fail('banned must be an array of words');
    const words = input.banned as unknown[];
    if (words.length > NAMING_LIMITS.banned) {
      fail(`too many banned words (max ${NAMING_LIMITS.banned})`);
    }
    patch.banned = words.map((w) => str(w, 'a banned word', NAMING_LIMITS.bannedWord)).filter(Boolean);
  }

  if (input.notes !== undefined) {
    patch.notes = str(input.notes, 'notes', NAMING_LIMITS.notes);
  }

  return patch;
}

/**
 * Apply a validated patch. `current` is the stored charter, or null — in which
 * case the novel's default is the base, so an author who edits one field of a
 * charter they never wrote gets that field changed and nothing else invented.
 */
export function applyCharterPatch(
  current: NamingCharter | null,
  novel: Pick<Novel, 'id' | 'premise' | 'styleNotes' | 'title'>,
  patch: NamingCharterPatch,
  source: NamingCharter['source'] = 'author'
): NamingCharter {
  const base = current ?? defaultCharter(novel);
  return {
    cultures: patch.cultures ?? base.cultures,
    pack: patch.pack ?? base.pack,
    banned: patch.banned ?? base.banned,
    notes: patch.notes ?? base.notes,
    source,
    updatedAt: Date.now(),
  };
}

/**
 * Repair a charter read back from Firestore. Older deploys, hand edits and
 * removed sound worlds all land here; the novel must still generate names
 * today, so every field falls back rather than throwing.
 */
export function normalizeCharter(
  raw: unknown,
  novel: Pick<Novel, 'id' | 'premise' | 'styleNotes' | 'title'>
): NamingCharter {
  const fallback = defaultCharter(novel);
  if (typeof raw !== 'object' || raw === null) return fallback;
  const data = raw as Record<string, unknown>;

  const cultures = Array.isArray(data.cultures)
    ? (data.cultures as unknown[])
        .slice(0, NAMING_LIMITS.cultures)
        .map((item, i) => {
          const c = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
          const label = typeof c.label === 'string' && c.label.trim() ? c.label.trim() : `Culture ${i + 1}`;
          return {
            id: typeof c.id === 'string' && c.id.trim() ? c.id.trim() : `culture-${i + 1}`,
            label,
            soundWorldId: isSoundWorldId(c.soundWorldId)
              ? String(c.soundWorldId)
              : fallback.cultures[0].soundWorldId,
            appliesTo: typeof c.appliesTo === 'string' ? c.appliesTo : '',
          };
        })
    : [];

  return {
    cultures: cultures.length ? cultures : fallback.cultures,
    pack: isNamingPack(data.pack) ? data.pack : fallback.pack,
    banned: Array.isArray(data.banned)
      ? (data.banned as unknown[]).filter((w): w is string => typeof w === 'string').slice(0, NAMING_LIMITS.banned)
      : [],
    notes: typeof data.notes === 'string' ? data.notes : '',
    source:
      data.source === 'author' || data.source === 'model' || data.source === 'default'
        ? data.source
        : 'author',
    updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0,
  };
}
