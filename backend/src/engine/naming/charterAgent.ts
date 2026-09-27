/**
 * Deriving a naming charter from the novel the author has already written.
 *
 * The default charter (charter.ts) is a keyword guess and works from the first
 * chapter. This is the upgrade: one cheap call that reads the premise, the
 * style notes and every name the novel has actually used, and proposes which
 * sound worlds the peoples of this world should draw on.
 *
 * Explicitly author-triggered, never lazy. Deriving on the generate path would
 * put a network call inside the setup of a streaming request, which is the one
 * cost the whole feature is built to avoid.
 *
 * The model does not invent sound worlds — it picks from the catalog, the same
 * way the design assist agent recommends from ARC_DEVICES rather than inventing
 * arc shapes. That is what makes the answer usable: a chosen id resolves to
 * inventories the generator can actually run.
 */

import { applyCharterPatch, validateCharterPatch } from '../../lib/namingValidate.js';
import type { BibleEntry, Novel } from '../../lib/types.js';
import type { AgentEvent } from '../agent.js';
import { formatBibleIndex } from '../bibleTools.js';
import { streamChat, type ChatMessage, type ToolDefinition, type Usage } from '../openrouter.js';
import { detectPack, type NamingCharter } from './charter.js';
import { NAMING_PACKS, PACK_LABELS } from './formulas.js';
import { SOUND_WORLDS } from './lexicons.js';

export const CHARTER_MODEL = 'deepseek/deepseek-v4-flash';

const MAX_ROUNDS = 3;

const EMPTY_USAGE: Usage = {
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
};

/**
 * The catalog, embedded in the prompt. Same shape as designCatalog's device
 * block: the model recommends from the vocabulary the author sees, so nothing
 * it suggests is unreachable in the UI.
 */
const CATALOG_BLOCK = [
  'THE SOUND WORLDS you may choose from. Use the id exactly:',
  ...SOUND_WORLDS.map((w) => `- ${w.id}: ${w.label}. ${w.blurb}`),
  '',
  'THE NAMING PACKS, which decide the SHAPE of names rather than their sound:',
  ...NAMING_PACKS.map((p) => `- ${p}: ${PACK_LABELS[p].label}. ${PACK_LABELS[p].blurb}`),
].join('\n');

const SYSTEM_PROMPT = [
  'You read a novel and work out what its names should sound like. You are not naming anything — you are writing the rules a name generator will follow for the rest of the book.',

  CATALOG_BLOCK,

  [
    'HOW MANY CULTURES:',
    'One is the normal answer and you should reach for it first. A second is worth it only when the novel genuinely spans peoples whose names should not sound alike — an empire and the steppe it is fighting, a sect and the mortal towns below it, the living and whatever the dead are called. Two cultures that sound different for no reason in the story is worse than one, because every name then implies a distinction the reader will look for and not find.',
    'Never more than three unless the premise plainly demands it.',
  ].join('\n'),

  [
    'HOW TO CHOOSE:',
    '- If the novel has already named things, the names it has ALREADY USED are the strongest evidence you have. Match them. A world that has been calling its places Skarrholt and Vennskard for twenty chapters does not want a soft romance-vowel world in chapter twenty-one.',
    '- If it has named almost nothing, go on the premise: where it is set, when, who holds power, what the register of the prose is.',
    '- The pack follows the genre, not the sound. A cultivation novel is xianxia even if its people sound northern.',
  ].join('\n'),

  [
    'THE appliesTo FIELD is what a writer mid-chapter will read to decide which culture a new name belongs to. Name the factions, regions and families concretely — "the capital, House Arrego, anyone with a seat on the council" — not "the civilised south".',
    'THE notes FIELD is for a rule the sound world cannot express, and it is usually empty. Good: "sect techniques always name a number and an element". Bad: "names should feel evocative".',
  ].join('\n'),

  'Fill the reading object first, from the novel in front of you. Then call propose_charter once. Nothing else.',
].join('\n\n');

const proposeToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'propose_charter',
    description: 'Deliver your reading of the novel, then the naming rules it should follow.',
    parameters: {
      type: 'object',
      properties: {
        reading: {
          type: 'object',
          description: 'What the novel already tells you about its names. Fill this first.',
          properties: {
            existingNames: {
              type: 'string',
              description:
                'What the names already in this novel have in common — length, hardness, how they end. Say "none yet" if it has not named anything.',
            },
            setting: {
              type: 'string',
              description: 'Where and when this is set, and who holds power, from the premise.',
            },
            peoples: {
              type: 'string',
              description:
                'Whether the novel spans peoples whose names should differ, and which. Say so plainly if it does not.',
            },
          },
          required: ['existingNames', 'setting', 'peoples'],
        },
        pack: { type: 'string', enum: [...NAMING_PACKS] },
        cultures: {
          type: 'array',
          description: 'One to three. The first is the default for anything unclear.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'What the author would call them. Three or four words.' },
              soundWorldId: { type: 'string', enum: SOUND_WORLDS.map((w) => w.id) },
              appliesTo: {
                type: 'string',
                description: 'The factions, regions and families this covers. Concrete names.',
              },
            },
            required: ['label', 'soundWorldId', 'appliesTo'],
          },
        },
        notes: {
          type: 'string',
          description: 'A naming rule the sound world cannot express. Usually empty.',
        },
      },
      required: ['reading', 'pack', 'cultures'],
    },
  },
};

const WORLD_IDS = new Set(SOUND_WORLDS.map((w) => w.id));

/**
 * Validate a proposal, returning the charter or an error string that goes back
 * as tool output. The sound-world check is the one that matters: an id the
 * catalog does not have resolves to a fallback at read time, which would
 * silently give the author a world nobody chose.
 */
function parseProposal(raw: Record<string, unknown>, novel: Novel): NamingCharter | string {
  const reading = raw.reading as Record<string, unknown> | undefined;
  if (!reading || !String(reading.existingNames ?? '').trim()) {
    return 'Error: reading.existingNames is required — say what the novel’s existing names have in common before proposing anything.';
  }
  if (!Array.isArray(raw.cultures) || !raw.cultures.length) {
    return 'Error: propose at least one culture.';
  }
  if (raw.cultures.length > 3) {
    return `Error: ${raw.cultures.length} cultures is too many. One is the normal answer; two only when the novel genuinely spans peoples whose names should not sound alike.`;
  }

  for (const item of raw.cultures as unknown[]) {
    const culture = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const id = String(culture.soundWorldId ?? '');
    if (!WORLD_IDS.has(id)) {
      return `Error: "${id}" is not a sound world. Use one of: ${[...WORLD_IDS].join(', ')}.`;
    }
  }

  try {
    const patch = validateCharterPatch({
      cultures: raw.cultures,
      pack: raw.pack,
      notes: raw.notes,
    });
    return applyCharterPatch(null, novel, patch, 'model');
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

export interface DeriveResult {
  charter: NamingCharter;
  usage: Usage;
}

export async function runCharterDerive(args: {
  apiKey: string;
  novel: Novel;
  bibleEntries?: BibleEntry[];
  /** Names from anywhere, used when the bible is off or empty. */
  taken?: readonly string[];
  signal?: AbortSignal;
  emit?: (event: AgentEvent) => void;
}): Promise<DeriveResult> {
  const emit = args.emit ?? (() => {});
  const { novel } = args;

  const namesBlock = args.bibleEntries?.length
    ? `EVERY NAME THIS NOVEL HAS USED:\n${formatBibleIndex(args.bibleEntries)}`
    : args.taken?.length
      ? `EVERY NAME THIS NOVEL HAS USED:\n${args.taken.slice(0, 60).join(', ')}`
      : 'THIS NOVEL HAS NOT NAMED ANYTHING YET. Go on the premise alone.';

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `NOVEL: ${novel.title}`,
        novel.premise.trim() ? `PREMISE:\n${novel.premise.trim()}` : '',
        novel.styleNotes.trim() ? `AUTHOR'S NOTES:\n${novel.styleNotes.trim()}` : '',
        namesBlock,
        'Propose the naming rules for this novel.',
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  ];

  emit({ type: 'trace', data: 'Reading the novel for what its names should sound like…' });

  let total = EMPTY_USAGE;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const result = await streamChat({
      role: 'naming',
      apiKey: args.apiKey,
      model: CHARTER_MODEL,
      messages,
      tools: [proposeToolDefinition],
      toolChoice: { type: 'function', function: { name: 'propose_charter' } },
      maxTokens: 1200,
      pinProvider: false,
      signal: args.signal,
    });
    total = {
      promptTokens: total.promptTokens + (result.usage?.promptTokens ?? 0),
      completionTokens: total.completionTokens + (result.usage?.completionTokens ?? 0),
      cachedTokens: total.cachedTokens + (result.usage?.cachedTokens ?? 0),
      cacheWriteTokens: total.cacheWriteTokens + (result.usage?.cacheWriteTokens ?? 0),
      cost: total.cost + (result.usage?.cost ?? 0),
    };

    const call = result.toolCalls[0];
    if (!call) {
      messages.push({ role: 'assistant', content: result.content || null });
      messages.push({ role: 'user', content: 'Call propose_charter now.' });
      continue;
    }

    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
    } catch {
      parsed = {};
    }

    const charter = parseProposal(parsed, novel);
    if (typeof charter !== 'string') {
      // The pack the model chose is kept, but a premise that plainly says
      // "cultivation" overrides a model that answered "western" — the keyword
      // detector is dumb and right more often than it is wrong about genre.
      const detected = detectPack(novel);
      if (detected !== 'western' && charter.pack === 'western') charter.pack = detected;
      console.log(
        `[charter] novel=${novel.id} cultures=${charter.cultures.length} pack=${charter.pack} ` +
          `cost=$${total.cost.toFixed(5)}`
      );
      emit({ type: 'trace', data: 'Naming rules ready' });
      return { charter, usage: total };
    }

    messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });
    messages.push({ role: 'tool', tool_call_id: call.id, content: charter });
  }

  throw new Error('The naming agent did not produce usable rules. Try again, or set them by hand.');
}

export { parseProposal as parseCharterProposal };
