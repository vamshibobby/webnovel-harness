import type { BibleEntry } from '../lib/types.js';
import type { ToolDefinition } from './openrouter.js';

/**
 * Story bible tools, shared by two agents:
 *  - the chapter-writing agent gets the read pair (search + get) to ground
 *    scenes in current canon;
 *  - the update agent additionally gets upsert, whose parameter schema is the
 *    structured-output enforcement for entries.
 *
 * All of them operate on the in-memory entry list the caller loaded — the
 * bible is small by design (hard cap 200 entries), so there is no reason to
 * touch Firestore per tool call.
 */

export const searchBibleToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'search_story_bible',
    description:
      'Search the story bible (structured entries for characters, factions, locations, items, ' +
      'weapons, creatures, techniques, concepts, events) by name, alias, or content. ' +
      'Matches against names, aliases/synonyms, summaries, attribute values and facts. ' +
      'Returns compact matches with entry ids. Use before assuming an entity does or does not exist — ' +
      'entities often appear under titles or nicknames that are stored as aliases.',
    parameters: {
      type: 'object',
      properties: {
        terms: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Names or phrases to search, including plausible synonyms and titles, ' +
            'e.g. ["Kael", "the young master", "Veyron heir"].',
        },
      },
      required: ['terms'],
    },
  },
};

export const getBibleToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'get_story_bible_entries',
    description:
      'Fetch full story bible entries by id (current status, attributes, relationships, and the ' +
      'complete fact log with chapter numbers). Use before writing a scene that involves an ' +
      'established character, faction, item or place — especially for state that may have changed: ' +
      'who is alive, who holds what, current allegiances, known abilities and their limits. ' +
      'Prefer this over guessing; prefer search_previous_chapters for exact phrasing and scene ' +
      'detail, this for current facts.',
    parameters: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Entry ids from the STORY BIBLE INDEX or from search_story_bible results.',
        },
      },
      required: ['ids'],
    },
  },
};

export const upsertBibleToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'upsert_story_bible_entry',
    description:
      'Create a new story bible entry, or update an existing one. To UPDATE, pass its exact "id" ' +
      'and ONLY the fields that change. To CREATE, omit "id" — always search_story_bible first ' +
      'to be sure the entity does not already exist under another name. Facts are appended via ' +
      'newFacts (never rewrite history); state changes go to status/attributes.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Exact id of an existing entry to update. Omit when creating.',
        },
        type: {
          type: 'string',
          enum: [
            'character',
            'faction',
            'location',
            'item',
            'weapon',
            'creature',
            'technique',
            'concept',
            'event',
          ],
          description: 'Required when creating.',
        },
        name: { type: 'string', description: 'Canonical name. Required when creating.' },
        aliases: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Other names actually used in the text: titles, nicknames, epithets, shorthand. ' +
            'These are merged into the existing alias list, never replace it.',
        },
        summary: {
          type: 'string',
          description: 'One or two sentences describing the entity as of NOW. Replaces the old summary.',
        },
        status: {
          type: 'string',
          description:
            'Current state in a word or two: alive, dead, destroyed, disbanded, missing, ' +
            'imprisoned, unknown. Update whenever it changes.',
        },
        attributes: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'Flat key→value strings, merged with existing. Use the conventional keys for the type ' +
            '(character: role, age, appearance, voice, goal; faction: leader, seat, strength, ' +
            'stance; location: region, controlledBy; item/weapon: owner, powers, origin; ' +
            'technique: user, cost, limits).',
        },
        newFacts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                description: 'One atomic, concrete claim. Use names, not pronouns.',
              },
              supersedes: {
                type: 'string',
                description:
                  'When this fact CHANGES established canon, the exact text of the fact it replaces.',
              },
            },
            required: ['text'],
          },
          description: 'Facts to append, with this chapter as provenance.',
        },
        removeFacts: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Exact texts of facts to delete. Only for consolidating superseded or duplicated facts.',
        },
        relationships: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              targetId: { type: 'string', description: 'Id of an entry that already exists.' },
              nature: { type: 'string', description: 'e.g. "sworn enemy", "master of", "owns"' },
            },
            required: ['targetId', 'nature'],
          },
          description: 'REPLACES the relationship list — include the full current set when changing it.',
        },
      },
      required: [],
    },
  },
};

// ── Formatting ────────────────────────────────────────────────────────────

/**
 * The one-line-per-entry index. Sent with every generation call (outside the
 * cached prefix) and at the top of every update-agent run, so both agents know
 * what exists and which ids/keys to use — kept deliberately terse because it
 * is the recurring cost of having a bible at all.
 */
export function formatBibleIndex(entries: BibleEntry[]): string {
  if (entries.length === 0) return '';
  return entries
    .map((e) => {
      const alias = e.aliases.length ? ` (aka ${e.aliases.join(', ')})` : '';
      const status = e.status ? ` — ${e.status}` : '';
      return `${e.id} · ${e.type} · ${e.name}${alias}${status}`;
    })
    .join('\n');
}

export function formatBibleEntry(e: BibleEntry): string {
  const lines = [
    `id: ${e.id}`,
    `type: ${e.type}`,
    `name: ${e.name}`,
    e.aliases.length ? `aliases: ${e.aliases.join(', ')}` : '',
    e.status ? `status: ${e.status}` : '',
    e.summary ? `summary: ${e.summary}` : '',
  ].filter(Boolean);
  for (const [k, v] of Object.entries(e.attributes)) lines.push(`${k}: ${v}`);
  if (e.relationships.length) {
    lines.push(`relationships: ${e.relationships.map((r) => `${r.nature} → ${r.targetId}`).join('; ')}`);
  }
  if (e.facts.length) {
    lines.push('facts:');
    for (const f of e.facts) {
      lines.push(`  - [ch ${f.chapter}] ${f.text}${f.supersedes ? ` (supersedes: "${f.supersedes}")` : ''}`);
    }
  }
  return lines.join('\n');
}

interface BibleMatch {
  entry: BibleEntry;
  score: number;
}

/** Substring search across name, aliases, summary, attributes and facts. */
export function searchBibleEntries(entries: BibleEntry[], terms: string[]): BibleEntry[] {
  const needles = terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 1);
  if (needles.length === 0) return [];

  const matches: BibleMatch[] = [];
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    const aliases = entry.aliases.map((a) => a.toLowerCase());
    const body = [
      entry.summary,
      entry.status,
      ...Object.values(entry.attributes),
      ...entry.facts.map((f) => f.text),
    ]
      .join('\n')
      .toLowerCase();

    let score = 0;
    for (const needle of needles) {
      if (name === needle || aliases.includes(needle)) score += 20;
      else if (name.includes(needle) || aliases.some((a) => a.includes(needle))) score += 10;
      else if (body.includes(needle)) score += 3;
    }
    if (score > 0) matches.push({ entry, score });
  }

  return matches
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, 10)
    .map((m) => m.entry);
}

export function formatBibleSearchResults(found: BibleEntry[]): string {
  if (found.length === 0) {
    return 'No story bible entries match those terms. If the entity matters, it does not exist yet.';
  }
  return found
    .map((e) => {
      const alias = e.aliases.length ? ` (aka ${e.aliases.join(', ')})` : '';
      const status = e.status ? ` [${e.status}]` : '';
      return `${e.id} · ${e.type} · ${e.name}${alias}${status}${e.summary ? ` — ${e.summary}` : ''}`;
    })
    .join('\n');
}
