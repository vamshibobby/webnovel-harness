/**
 * Designing a power system from the novel's theme and the author's answers.
 *
 * The charterAgent pattern end to end: one forced tool call, a parser that
 * returns error STRINGS as tool output so the model corrects itself, and a
 * fixed cheap model — this is assist bookkeeping, never the novel's voice.
 *
 * Two flows share the machinery:
 *  - generate: premise + styleNotes + questionnaire answers + optional author
 *    suggestions → a whole new system, saved with source 'model'.
 *  - refine: an existing system + free-text instructions → the smallest set
 *    of merge ops the instructions require, applied with source 'model'
 *    (which is what lands an author-built system on 'mixed').
 *
 * The generator proposes NO bible links: a fresh system usually predates the
 * entries it would link, and an invented id is worse than an empty list. It
 * names gaps in openQuestions instead; the bible pass and the author wire up
 * links as the story establishes them. The refiner, which is shown the bible
 * index, may link.
 */

import {
  PowerValidationError,
  applyPowerSystemPatch,
  slugifyPowerName,
  validatePowerSystemPatch,
  type PowerSystemPatch,
} from '../lib/powerValidate.js';
import type { BibleEntry, Novel, PowerSystem } from '../lib/types.js';
import type { AgentEvent } from './agent.js';
import { formatBibleIndex } from './bibleTools.js';
import { streamChat, type ChatMessage, type ToolDefinition, type Usage } from './openrouter.js';
import { formatAnswersBlock } from './powerCatalog.js';
import { formatPowerIndex, formatPowerSystem } from './powerTools.js';

/**
 * The same model the cast pass settled on, and for a related reason: this is a
 * long, deeply nested tool call, and deepseek-v4-flash served it at roughly
 * five tokens a second in production — one design took 278 seconds against a
 * 300-second request ceiling, which is not a margin, it is a coin toss.
 */
export const POWER_MODEL = 'google/gemini-3.5-flash-lite';

const MAX_ROUNDS = 3;

/**
 * The whole run, repair rounds included, must finish inside this — comfortably
 * under Cloud Run's 300s request timeout.
 *
 * Without it the only deadline was the platform's, and hitting that kills the
 * response mid-flight: the author waits four minutes and gets nothing, because
 * the system is saved after the agent returns and the agent never returns.
 * Failing at 200s with a sentence they can act on is strictly better.
 */
const DEADLINE_MS = 200_000;

/** How often to tell the client we are still going. */
const HEARTBEAT_MS = 15_000;

const EMPTY_USAGE: Usage = {
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
};

const addUsage = (a: Usage, b: Usage | null | undefined): Usage => ({
  promptTokens: a.promptTokens + (b?.promptTokens ?? 0),
  completionTokens: a.completionTokens + (b?.completionTokens ?? 0),
  cachedTokens: a.cachedTokens + (b?.cachedTokens ?? 0),
  cacheWriteTokens: a.cacheWriteTokens + (b?.cacheWriteTokens ?? 0),
  cost: a.cost + (b?.cost ?? 0),
});

const rankItem = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'The rank name an author would print on the page.' },
    summary: { type: 'string', description: 'One line: what this tier means.' },
    capabilities: {
      type: 'array',
      items: { type: 'string' },
      description: 'What one CAN DO at this level — atomic, concrete claims. Three to six.',
    },
    skills: { type: 'array', items: { type: 'string' }, description: 'The typical skillset.' },
    advancement: { type: 'string', description: 'How this rank is reached from the one below.' },
    rarity: { type: 'string', description: 'Population feel: "one in a thousand cultivators".' },
  },
  required: ['name', 'summary', 'capabilities', 'advancement'],
};

const professionItem = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    summary: { type: 'string' },
    role: { type: 'string', description: 'Combat or social function in the world.' },
    advancement: { type: 'string', description: 'ONLY where it diverges from the shared ladder.' },
    signatureSkills: {
      type: 'array',
      items: { type: 'string' },
      description: 'Named techniques or spells this path is known for, as text.',
    },
  },
  required: ['name', 'summary', 'role'],
};

const regionItem = {
  type: 'object',
  properties: {
    region: { type: 'string', description: 'A country or territory from the premise, by name.' },
    typicalRank: { type: 'string', description: 'The common ceiling there — a rank NAME from your ladder.' },
    apexRank: { type: 'string', description: 'The strongest known presence, when it differs.' },
    note: { type: 'string' },
  },
  required: ['region', 'typicalRank'],
};

const proposeToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'propose_power_system',
    description: 'Deliver your reading of the premise, then the complete power system.',
    parameters: {
      type: 'object',
      properties: {
        reading: {
          type: 'object',
          description: 'What the premise and answers already decide. Fill this first.',
          properties: {
            genre: {
              type: 'string',
              description: 'What kind of story this is and what its power fantasy runs on.',
            },
            constraints: {
              type: 'string',
              description: 'Which answers pin the design down, and what they rule out.',
            },
          },
          required: ['genre', 'constraints'],
        },
        name: { type: 'string', description: 'What this system is called in-world.' },
        summary: { type: 'string', description: 'The system in a sentence or two.' },
        energyName: { type: 'string', description: 'The resource: qi, mana… Empty if none.' },
        costsAndLimits: { type: 'string', description: 'The price of power, taboos, hard limits.' },
        rarityNote: { type: 'string', description: 'How steep the pyramid is, worldwide.' },
        crossSystemNote: {
          type: 'string',
          description: 'Only when the novel has other systems: who wins and why.',
        },
        ranks: {
          type: 'array',
          items: rankItem,
          description: 'The ladder, WEAKEST FIRST. Five to nine ranks unless the answers demand otherwise.',
        },
        professions: {
          type: 'array',
          items: professionItem,
          description: 'Two to five paths that climb this ladder.',
        },
        regions: {
          type: 'array',
          items: regionItem,
          description: 'Only regions the premise actually names. Empty is correct for a blank map.',
        },
        openQuestions: {
          type: 'array',
          items: { type: 'string' },
          description:
            'What you deliberately left undecided — including characters, factions or named ' +
            'artifacts the story will need to place on this ladder later.',
        },
      },
      required: ['reading', 'name', 'summary', 'ranks', 'professions', 'openQuestions'],
    },
  },
};

/** The refiner edits through the same granular ops the author route uses. */
const refineToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'refine_power_system',
    description:
      'Deliver the smallest set of changes the instructions require. Upserts merge by id: ' +
      'send only the ranks, professions, artifacts or regions you are changing, and only ' +
      'the fields you are changing on them. Never resend sections the instructions do not touch.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        energyName: { type: 'string' },
        costsAndLimits: { type: 'string' },
        rarityNote: { type: 'string' },
        crossSystemNote: { type: 'string' },
        openQuestions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replaces the list — include it in full when adding or resolving one.',
        },
        upsertRanks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'The existing rank id, when changing one.' },
              name: { type: 'string' },
              summary: { type: 'string' },
              capabilities: { type: 'array', items: { type: 'string' } },
              skills: { type: 'array', items: { type: 'string' } },
              advancement: { type: 'string' },
              rarity: { type: 'string' },
              characterIds: {
                type: 'array',
                items: { type: 'string' },
                description: 'Bible character ids ONLY, from the index.',
              },
              note: { type: 'string' },
            },
            required: ['name'],
          },
        },
        removeRankIds: { type: 'array', items: { type: 'string' } },
        rankOrder: {
          type: 'array',
          items: { type: 'string' },
          description: 'Every rank id, weakest first — only when reordering the ladder.',
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
        removeProfessionIds: { type: 'array', items: { type: 'string' } },
        upsertArtifacts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              entryId: { type: 'string', description: 'A bible entry id of type technique, weapon or item.' },
              scaling: { type: 'string' },
              rankId: { type: 'string' },
              note: { type: 'string' },
            },
            required: ['entryId'],
          },
        },
        removeArtifactEntryIds: { type: 'array', items: { type: 'string' } },
        upsertRegions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              region: { type: 'string' },
              locationEntryId: { type: 'string' },
              typicalRankId: { type: 'string' },
              apexRankId: { type: 'string' },
              note: { type: 'string' },
            },
            required: ['region', 'typicalRankId'],
          },
        },
        removeRegions: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

const GENERATE_SYSTEM_PROMPT = [
  'You design power systems for serial fiction — the ladder of ranks a story climbs for hundreds of chapters. You are not writing prose; you are writing the rules the writer will treat as canon.',

  [
    'WHAT MAKES A LADDER USABLE:',
    '- Each rank must CHANGE WHAT SCENES ARE POSSIBLE. "Stronger qi" is not a rank; "can fly short hops, so walls stop mattering" is.',
    '- Capabilities are hard limits as much as powers. State what a rank CANNOT do by what the next one finally can.',
    '- Advancement is the engine of the story. Each breakthrough should be writable as an arc: a price, a bottleneck, a way it usually goes wrong.',
    '- Rarity gives every rank social meaning: if one in ten thousand reaches it, meeting one is a scene.',
  ].join('\n'),

  [
    'RESPECT WHAT THE AUTHOR ANSWERED. Every answer is a decision already made — design within it, never around it.',
    'Where the author wrote their own suggestions, those outrank everything else in this prompt.',
    'Unanswered questions are yours to decide from the premise. Decide them; do not hedge.',
  ].join('\n'),

  [
    'LINKS AND NAMES:',
    '- Do NOT invent character, faction or item ids — you have none to link. Name the gaps in openQuestions instead ("which sect guards the Core Formation manuals?").',
    '- Signature techniques belong in professions.signatureSkills as plain text.',
    '- Regions only when the premise names places. An empty regions list is correct for a blank map.',
  ].join('\n'),

  'Fill the reading object first. Then call propose_power_system once. Nothing else.',
].join('\n\n');

const REFINE_SYSTEM_PROMPT = [
  'You refine an existing power system to an author\'s instructions. The system below is CANON the author already owns.',

  [
    'RESPECT WHAT EXISTS. This is the whole job.',
    '- Change ONLY what the instructions require. Every rank, profession and note they do not touch must survive untouched — the cheapest way to guarantee that is to not send it.',
    '- Upserts merge by id. To change one capability of one rank, send that rank with that field and nothing else.',
    '- If an instruction is impossible as stated (a rank that does not exist, a link the bible cannot support), do the nearest possible thing and say what you changed in openQuestions.',
  ].join('\n'),

  [
    'LINKS:',
    '- characterIds, factionIds, artifact entryIds and locationEntryIds must come from the STORY BIBLE INDEX below. Never invent an id.',
    '- When the instructions name someone the bible does not have, put the gap in openQuestions rather than faking a link.',
  ].join('\n'),

  'Call refine_power_system once, with the smallest patch that does the job.',
].join('\n\n');

/**
 * Turn a raw generate proposal into a validated create patch, or an error
 * string for the repair loop. Region rank references arrive as rank NAMES
 * (the model has no ids yet) and are slugged to match the ranks they name.
 */
export function parseGenerateProposal(
  raw: Record<string, unknown>
): { name: string; patch: PowerSystemPatch } | string {
  const reading = raw.reading as Record<string, unknown> | undefined;
  if (!reading || !String(reading.genre ?? '').trim()) {
    return 'Error: reading.genre is required — say what kind of story this is before designing anything.';
  }
  if (!Array.isArray(raw.ranks) || raw.ranks.length < 2) {
    return 'Error: propose at least two ranks — a ladder with one rung is not a ladder.';
  }

  const regions = Array.isArray(raw.regions)
    ? (raw.regions as Array<Record<string, unknown>>).map((r) => ({
        region: r.region,
        typicalRankId: r.typicalRank ? slugifyPowerName(String(r.typicalRank)) : '',
        apexRankId: r.apexRank ? slugifyPowerName(String(r.apexRank)) : undefined,
        note: r.note,
      }))
    : [];

  try {
    const patch = validatePowerSystemPatch(
      {
        name: raw.name,
        summary: raw.summary,
        energyName: raw.energyName,
        costsAndLimits: raw.costsAndLimits,
        rarityNote: raw.rarityNote,
        crossSystemNote: raw.crossSystemNote,
        openQuestions: raw.openQuestions,
        upsertRanks: raw.ranks,
        upsertProfessions: raw.professions,
        upsertRegions: regions,
      },
      // No links are allowed out of generation, so the bible is irrelevant
      // here — an invented id fails validation exactly as it should.
      { entries: [], existing: null }
    );
    if (!patch.name) return 'Error: name is required.';
    return { name: patch.name, patch };
  } catch (err) {
    if (err instanceof PowerValidationError) return `Error: ${err.message}`;
    throw err;
  }
}

/** Shared round loop: force the tool, feed errors back, give up after three. */
async function runProposalLoop<T>(args: {
  apiKey: string;
  messages: ChatMessage[];
  tool: ToolDefinition;
  maxTokens: number;
  parse: (raw: Record<string, unknown>) => Promise<T | string> | (T | string);
  signal?: AbortSignal;
  emit: (event: AgentEvent) => void;
  /** What the client is waiting for, for the heartbeat line. */
  waitingFor: string;
  failure: string;
}): Promise<{ value: T; usage: Usage }> {
  const { messages } = args;
  let total = EMPTY_USAGE;

  const started = Date.now();
  // The deadline is our own, and separate from the caller's abort so the two
  // can be told apart: a client that navigated away is not an error worth a
  // message, a provider that ran long is.
  const deadline = new AbortController();
  const expiry = setTimeout(() => deadline.abort(), DEADLINE_MS);
  // A forced tool call streams its arguments as one JSON string that is only
  // readable once closed, so there is no token-by-token progress to report.
  // Elapsed time is the honest substitute for a spinner that says nothing.
  const heartbeat = setInterval(() => {
    args.emit({
      type: 'trace',
      data: `${args.waitingFor} — ${Math.round((Date.now() - started) / 1000)}s so far`,
    });
  }, HEARTBEAT_MS);

  try {
    return await runRounds();
  } catch (err) {
    if (deadline.signal.aborted && !args.signal?.aborted) {
      throw new Error(
        'The designer took too long to answer and was stopped before it could finish. ' +
          'This is usually a busy model provider — try again, or build the system by hand.'
      );
    }
    throw err;
  } finally {
    clearTimeout(expiry);
    clearInterval(heartbeat);
  }

  async function runRounds(): Promise<{ value: T; usage: Usage }> {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const result = await streamChat({
      role: 'power',
      apiKey: args.apiKey,
      model: POWER_MODEL,
      messages,
      tools: [args.tool],
      toolChoice: { type: 'function', function: { name: args.tool.function.name } },
      maxTokens: args.maxTokens,
      pinProvider: false,
      signal: args.signal
        ? AbortSignal.any([args.signal, deadline.signal])
        : deadline.signal,
    });
    total = addUsage(total, result.usage);

    const call = result.toolCalls[0];
    if (!call) {
      messages.push({ role: 'assistant', content: result.content || null });
      messages.push({ role: 'user', content: `Call ${args.tool.function.name} now.` });
      continue;
    }

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    const outcome =
      parsed === null
        ? result.finishReason === 'length'
          ? 'Error: the call was cut off before the JSON closed. Send a tighter proposal — shorter capability lists, fewer words per field.'
          : 'Error: the tool arguments were not valid JSON. Send the call again.'
        : await args.parse(parsed);

    if (typeof outcome !== 'string') return { value: outcome, usage: total };

    args.emit({ type: 'trace', data: 'Correcting the proposal…' });
    messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });
    messages.push({ role: 'tool', tool_call_id: call.id, content: outcome });
  }

  throw new Error(args.failure);
  }
}

export interface PowerAgentResult {
  system: PowerSystem;
  usage: Usage;
}

/** Design a new system from the questionnaire. The route saves the result. */
export async function runPowerGenerate(args: {
  apiKey: string;
  novel: Novel;
  entries: BibleEntry[];
  /** Existing systems, so the new one is designed to be distinct. */
  systems: PowerSystem[];
  answers: Array<{ id: string; answer: string }>;
  suggestions?: string;
  signal?: AbortSignal;
  emit?: (event: AgentEvent) => void;
}): Promise<PowerAgentResult> {
  const emit = args.emit ?? (() => {});
  const { novel } = args;

  const messages: ChatMessage[] = [
    { role: 'system', content: GENERATE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `NOVEL: ${novel.title}`,
        // The premise is the theme carrier — there is no genre field, by
        // design (engine/styles.ts): genre lives in the words the author wrote.
        novel.premise.trim() ? `PREMISE:\n${novel.premise.trim()}` : '',
        novel.styleNotes.trim() ? `AUTHOR'S NOTES:\n${novel.styleNotes.trim()}` : '',
        `THE AUTHOR'S ANSWERS:\n${formatAnswersBlock(args.answers)}`,
        args.suggestions?.trim()
          ? `THE AUTHOR'S OWN SUGGESTIONS — these outrank everything else:\n${args.suggestions.trim()}`
          : '',
        args.systems.length
          ? `THIS NOVEL ALREADY HAS THESE SYSTEMS — design one that is DISTINCT from them, and fill crossSystemNote:\n${formatPowerIndex(args.systems)}`
          : '',
        'Design the power system.',
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  ];

  emit({ type: 'trace', data: 'Reading the premise and your answers…' });

  const { value, usage } = await runProposalLoop({
    apiKey: args.apiKey,
    messages,
    tool: proposeToolDefinition,
    // The designs that come back run ~1300 tokens; 4000 leaves room for a
    // generous one without reserving capacity nobody uses, which some
    // providers price into how long they make you wait.
    maxTokens: 4000,
    signal: args.signal,
    emit,
    waitingFor: 'Designing the ladder',
    parse: (raw) => parseGenerateProposal(raw),
    failure: 'The designer did not produce a usable system. Try again, or build it by hand.',
  });

  const id = slugifyPowerName(value.name);
  const system = applyPowerSystemPatch(null, id, value.patch, 'model');
  console.log(
    `[power] generate novel=${novel.id} system=${id} ranks=${system.ranks.length} ` +
      `professions=${system.professions.length} cost=$${usage.cost.toFixed(5)}`
  );
  emit({ type: 'trace', data: `Designed ${system.name}: ${system.ranks.length} ranks` });
  return { system, usage };
}

/** Apply free-text instructions to an existing system. */
export async function runPowerRefine(args: {
  apiKey: string;
  novel: Novel;
  entries: BibleEntry[];
  system: PowerSystem;
  instructions: string;
  signal?: AbortSignal;
  emit?: (event: AgentEvent) => void;
}): Promise<PowerAgentResult> {
  const emit = args.emit ?? (() => {});
  const bibleIndex = formatBibleIndex(args.entries);

  const messages: ChatMessage[] = [
    { role: 'system', content: REFINE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `THE SYSTEM AS IT STANDS:\n${formatPowerSystem(args.system, args.entries)}`,
        bibleIndex ? `STORY BIBLE INDEX (the only ids you may link):\n${bibleIndex}` : 'THE STORY BIBLE IS EMPTY — link nothing.',
        `THE AUTHOR'S INSTRUCTIONS:\n${args.instructions.trim()}`,
      ].join('\n\n'),
    },
  ];

  emit({ type: 'trace', data: `Refining ${args.system.name}…` });

  const { value, usage } = await runProposalLoop<PowerSystemPatch>({
    apiKey: args.apiKey,
    messages,
    tool: refineToolDefinition,
    maxTokens: 4000,
    signal: args.signal,
    emit,
    waitingFor: `Refining ${args.system.name}`,
    parse: (raw) => {
      try {
        return validatePowerSystemPatch(raw, { entries: args.entries, existing: args.system });
      } catch (err) {
        if (err instanceof PowerValidationError) return `Error: ${err.message}`;
        throw err;
      }
    },
    failure: 'The refiner did not produce a usable change. Try rephrasing the instruction.',
  });

  const system = applyPowerSystemPatch(args.system, args.system.id, value, 'model');
  console.log(
    `[power] refine novel=${args.novel.id} system=${system.id} cost=$${usage.cost.toFixed(5)}`
  );
  emit({ type: 'trace', data: `Refined ${system.name}` });
  return { system, usage };
}
