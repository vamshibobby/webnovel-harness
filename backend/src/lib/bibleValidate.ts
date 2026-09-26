import {
  BIBLE_ENTRY_TYPES,
  type BibleEntry,
  type BibleEntryType,
  type BibleFact,
} from './types.js';

/**
 * Validation for story bible writes.
 *
 * Two callers with different needs share these rules:
 *  - The author, editing an entry through the panel — errors become 400s.
 *  - The update agent, writing through a tool call — errors are returned to
 *    the model as tool output so it can correct itself and retry, which is
 *    the structured-output enforcement: a malformed entity never reaches
 *    Firestore, and the agent is told exactly why.
 *
 * Caps are deliberate: every entry is prompt-visible (the index) and
 * retrievable into generation, so an unbounded entry is unbounded prompt cost.
 */

export const BIBLE_LIMITS = {
  entriesPerNovel: 200,
  name: 120,
  alias: 80,
  aliases: 12,
  summary: 500,
  status: 120,
  attributeKey: 40,
  attributeValue: 300,
  attributes: 15,
  fact: 300,
  factsPerEntry: 60,
  relationships: 20,
  relationshipNature: 120,
} as const;

/** Raised on invalid input; the caller decides whether it becomes a 400 or a tool error. */
export class BibleValidationError extends Error {}

const fail = (msg: string): never => {
  throw new BibleValidationError(msg);
};

/** "Kael Veyron" -> "kael-veyron". Doc ids are slugs so collisions are visible. */
export function slugifyBibleName(name: string): string {
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

export function validBibleType(value: unknown): BibleEntryType {
  if (typeof value !== 'string' || !BIBLE_ENTRY_TYPES.includes(value as BibleEntryType)) {
    fail(`type must be one of: ${BIBLE_ENTRY_TYPES.join(', ')}`);
  }
  return value as BibleEntryType;
}

/**
 * The mutable, caller-writable slice of an entry. Everything the author's
 * PATCH or the agent's upsert may set; server-owned fields (timestamps,
 * firstChapter) are added by the store.
 */
export interface BibleEntryPatch {
  type?: BibleEntryType;
  name?: string;
  aliases?: string[];
  summary?: string;
  status?: string;
  attributes?: Record<string, string>;
  newFacts?: BibleFact[];
  removeFacts?: string[];
  relationships?: Array<{ targetId: string; nature: string }>;
}

/**
 * Validate an untrusted patch (agent tool args or author PATCH body).
 * `chapter` stamps provenance onto new facts.
 */
export function validateBiblePatch(raw: unknown, chapter: number): BibleEntryPatch {
  if (typeof raw !== 'object' || raw === null) fail('entry must be an object');
  const input = raw as Record<string, unknown>;
  const patch: BibleEntryPatch = {};

  if (input.type !== undefined) patch.type = validBibleType(input.type);
  if (input.name !== undefined) {
    patch.name = str(input.name, 'name', BIBLE_LIMITS.name, { required: true });
  }
  if (input.summary !== undefined) {
    patch.summary = str(input.summary, 'summary', BIBLE_LIMITS.summary);
  }
  if (input.status !== undefined) {
    patch.status = str(input.status, 'status', BIBLE_LIMITS.status);
  }

  if (input.aliases !== undefined) {
    if (!Array.isArray(input.aliases)) fail('aliases must be an array of strings');
    const aliases = (input.aliases as unknown[]).map((a, i) =>
      str(a, `aliases[${i}]`, BIBLE_LIMITS.alias, { required: true })
    );
    if (aliases.length > BIBLE_LIMITS.aliases) {
      fail(`too many aliases (max ${BIBLE_LIMITS.aliases}) — keep only names actually used in the text`);
    }
    patch.aliases = [...new Set(aliases)];
  }

  if (input.attributes !== undefined) {
    if (typeof input.attributes !== 'object' || input.attributes === null || Array.isArray(input.attributes)) {
      fail('attributes must be an object of string values');
    }
    const entries = Object.entries(input.attributes as Record<string, unknown>);
    if (entries.length > BIBLE_LIMITS.attributes) {
      fail(`too many attributes (max ${BIBLE_LIMITS.attributes})`);
    }
    const attributes: Record<string, string> = {};
    for (const [key, value] of entries) {
      const k = str(key, 'attribute key', BIBLE_LIMITS.attributeKey, { required: true });
      attributes[k] = str(value, `attributes.${k}`, BIBLE_LIMITS.attributeValue, { required: true });
    }
    patch.attributes = attributes;
  }

  if (input.newFacts !== undefined) {
    if (!Array.isArray(input.newFacts)) fail('newFacts must be an array');
    patch.newFacts = (input.newFacts as unknown[]).map((f, i) => {
      // The agent may send plain strings or { text, supersedes }.
      if (typeof f === 'string') {
        return { text: str(f, `newFacts[${i}]`, BIBLE_LIMITS.fact, { required: true }), chapter };
      }
      if (typeof f === 'object' && f !== null) {
        const obj = f as Record<string, unknown>;
        const fact: BibleFact = {
          text: str(obj.text, `newFacts[${i}].text`, BIBLE_LIMITS.fact, { required: true }),
          chapter,
        };
        const supersedes = str(obj.supersedes, `newFacts[${i}].supersedes`, BIBLE_LIMITS.fact);
        if (supersedes) fact.supersedes = supersedes;
        return fact;
      }
      return fail(`newFacts[${i}] must be a string or { text, supersedes }`) as never;
    });
  }

  if (input.removeFacts !== undefined) {
    if (!Array.isArray(input.removeFacts)) fail('removeFacts must be an array of fact texts');
    patch.removeFacts = (input.removeFacts as unknown[]).map((f, i) =>
      str(f, `removeFacts[${i}]`, BIBLE_LIMITS.fact, { required: true })
    );
  }

  if (input.relationships !== undefined) {
    if (!Array.isArray(input.relationships)) fail('relationships must be an array');
    if ((input.relationships as unknown[]).length > BIBLE_LIMITS.relationships) {
      fail(`too many relationships (max ${BIBLE_LIMITS.relationships})`);
    }
    patch.relationships = (input.relationships as unknown[]).map((r, i) => {
      if (typeof r !== 'object' || r === null) fail(`relationships[${i}] must be an object`);
      const obj = r as Record<string, unknown>;
      return {
        targetId: str(obj.targetId, `relationships[${i}].targetId`, BIBLE_LIMITS.name, { required: true }),
        nature: str(obj.nature, `relationships[${i}].nature`, BIBLE_LIMITS.relationshipNature, { required: true }),
      };
    });
  }

  return patch;
}

/** Merge a validated patch onto an existing entry (or a fresh skeleton). */
export function applyBiblePatch(
  existing: BibleEntry | null,
  id: string,
  patch: BibleEntryPatch,
  chapter: number
): BibleEntry {
  const now = Date.now();
  const base: BibleEntry = existing ?? {
    id,
    type: patch.type ?? fail('type is required when creating an entry'),
    name: patch.name ?? fail('name is required when creating an entry'),
    aliases: [],
    summary: '',
    status: '',
    attributes: {},
    facts: [],
    relationships: [],
    firstChapter: chapter,
    createdAt: now,
    updatedAt: now,
  };

  let facts = base.facts;
  if (patch.removeFacts?.length) {
    const drop = new Set(patch.removeFacts);
    facts = facts.filter((f) => !drop.has(f.text));
  }
  if (patch.newFacts?.length) {
    // Idempotency under agent retries: an identical fact is not appended twice.
    const seen = new Set(facts.map((f) => f.text));
    facts = [...facts, ...patch.newFacts.filter((f) => !seen.has(f.text))];
  }
  if (facts.length > BIBLE_LIMITS.factsPerEntry) {
    fail(
      `entry would have ${facts.length} facts (max ${BIBLE_LIMITS.factsPerEntry}) — ` +
        'consolidate: remove superseded or minor facts with removeFacts'
    );
  }

  return {
    ...base,
    type: patch.type ?? base.type,
    name: patch.name ?? base.name,
    // Aliases union rather than replace: losing an alias silently would
    // re-open the dedup hole the alias existed to close.
    aliases: patch.aliases ? [...new Set([...base.aliases, ...patch.aliases])] : base.aliases,
    summary: patch.summary !== undefined && patch.summary !== '' ? patch.summary : base.summary,
    status: patch.status !== undefined && patch.status !== '' ? patch.status : base.status,
    attributes: patch.attributes ? { ...base.attributes, ...patch.attributes } : base.attributes,
    facts,
    relationships: patch.relationships ?? base.relationships,
    updatedAt: now,
  };
}
