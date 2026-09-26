/**
 * The on-demand coiner: the author picks a kind, writes a line, and gets names.
 *
 * The generator has already done the hard part before the model is called. It
 * draws a spec, builds twelve to sixteen phonotactically legal candidates, and
 * rejects anything cliché, banned or too close to a name the novel has spent.
 * The model's whole job is to READ THE WORLD and choose — which is what it is
 * genuinely good at, and it is doing it over a list where every option is
 * already acceptable.
 *
 * The enforcement point is `parseChoice`. A model handed a slate it dislikes
 * will cheerfully answer "Elara", and if that were accepted every filter
 * upstream would be advisory. So a returned name must either be on the slate or
 * be a visible blend of two of its parts, and it is re-checked against the slop
 * list and the taken list regardless. A failure comes back as tool output and
 * the model corrects itself — the same contract the bible, drift and suggestion
 * agents use.
 *
 * With no API key the procedural slate is returned as-is. That is the payoff
 * for having built a real generator rather than a prompt: the feature degrades
 * to fully working.
 */

import type { BibleEntryType, Novel } from '../../lib/types.js';
import type { AgentEvent } from '../agent.js';
import { streamChat, type ChatMessage, type ToolDefinition, type Usage } from '../openrouter.js';
import { formatBibleIndex } from '../bibleTools.js';
import type { BibleEntry } from '../../lib/types.js';
import { normalizeName } from './blocklist.js';
import { resolveCulture, type NamingCharter } from './charter.js';
import { checkName, generateSlate, type Candidate, type Palette } from './generator.js';

/**
 * Fixed and cheap, like the bible, design and suggestion agents. This is not
 * writing, it is choosing from a list someone else made — paying the novel's
 * model for it would be paying prose rates to read fourteen words.
 */
export const NAMING_MODEL = 'deepseek/deepseek-v4-flash';

/** Rounds available for correcting a bad choice before giving up. */
const MAX_ROUNDS = 3;

/** More than the writer's tool offers: a human is choosing, and can skim. */
const SLATE_SIZE = 14;

/** How many the model returns. Three is a choice; eight is a second problem. */
const PICKS = 4;

const LIMITS = { name: 60, etymology: 200, why: 200 };

const EMPTY_USAGE: Usage = {
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
};

export interface NameProposal {
  name: string;
  /** Straight off the slate, or two of its parts welded together. */
  source: 'candidate' | 'blend';
  /** Where the name comes from inside the world. One sentence. */
  etymology: string;
  /** Why it suits this particular thing. One sentence, for the author. */
  why: string;
}

export interface CoinResult {
  proposals: NameProposal[];
  /** The raw procedural slate, so the author can pick something the model passed over. */
  slate: Candidate[];
  /** Null when there was no key and the slate was returned unjudged. */
  usage: Usage | null;
}

/**
 * The prompt.
 *
 * The load-bearing part is the same trick suggestAgent.ts documents: the
 * reasoning is a REQUIRED FIELD of the tool call rather than a request to think
 * first. Asked politely to consider the register, a model writes a sentence
 * about registers and then picks the name it was always going to pick. Made to
 * state what the world already sounds like and what is already taken before it
 * may name anything, it has to look at the world it was given.
 *
 * Note what the prompt does NOT contain: any list of names to avoid. That list
 * exists, in blocklist.ts, and putting it here would prime the very names it
 * bans — a finding recorded against this codebase's own FORMAT line.
 */
const SYSTEM_PROMPT = [
  'You name things for a novel, out of a vocabulary you are given. A generator has already built candidates that fit this world’s sounds and clash with nothing already in it, and has listed the parts they were made from. Your job is the part it cannot do: read what this thing actually IS, and make the name say so.',

  [
    'WHY YOU ARE HERE AND NOT A GENERATOR:',
    'The generator knows what this world sounds like. It does not know what the thing is for. A technique of overwhelming, crushing strength called "Ochre Rending" is in perfect register and tells a reader nothing — the words are right for the world and wrong for the thing. You have read the brief. Pick, or build, names whose WORDS MEAN WHAT THIS IS.',
    'A name that is merely legal is a failure here. A name that is legal and apt is the whole job.',
  ].join('\n'),

  [
    'YOU MAY:',
    '- Take a candidate exactly as written, when one already fits.',
    '- BUILD one from the parts you are given — combine them the way the candidates are combined. This is usually the better answer, because you can choose words that suit the thing and the generator could only guess.',
    '- Blend two invented words: the front of one and the back of another. Say so.',
    'YOU MAY NOT:',
    '- Use any word that is neither in a candidate nor on the parts list. Not one. There is no word you can add that will fit this world better than the ones you were given, and anything from outside will be refused.',
    '- Reuse or near-rhyme with a name the novel already has.',
    '- Stack more than three words. A name is a handle, not a description.',
  ].join('\n'),

  [
    'THE ETYMOLOGY FIELD is where the name stops being a noise and becomes part of the world: what it meant to whoever coined it, in one sentence. "The pass where the salt carts turn back", "her grandmother’s name, unfashionable for two generations", "the sound a bell makes in the sect’s founding story". Invent it — that is the point — but make it fit the premise you were given.',
    'THE WHY FIELD is one sentence for the author on why this name suits THIS thing, and not the next thing they will need to name.',
  ].join('\n'),

  [
    'SPREAD YOUR PICKS. Four names that are variations of one idea are one name shown four times. Range across what you were given: something plain, something that carries weight, something a person would shorten. If the thing has two aspects — what it does and what it costs — let different picks take different ones.',
  ].join('\n'),

  'Fill the reading object first, from the world in front of you. Then call choose_names once. Nothing else.',
].join('\n\n');

const chooseToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'choose_names',
    description: 'Deliver your reading of the world, then the names you have chosen from the candidates.',
    parameters: {
      type: 'object',
      properties: {
        reading: {
          type: 'object',
          description: 'What the world already sounds like. Fill this before choosing anything.',
          properties: {
            register: {
              type: 'string',
              description:
                'What the names already in this novel have in common — length, hardness, how they end.',
            },
            taken: {
              type: 'array',
              description: 'The existing names a new one is most likely to be confused with. 0 to 6.',
              items: { type: 'string' },
            },
            wants: {
              type: 'string',
              description:
                'What THIS thing needs from its name, given what it is and who named it. Name the two or three words on the parts list that carry that meaning.',
            },
          },
          required: ['register', 'wants'],
        },
        picks: {
          type: 'array',
          description: `Exactly ${PICKS}, best first, genuinely different from each other.`,
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description:
                  'A candidate as written, or one you built from the parts. Every word must come from what you were given.',
              },
              source: { type: 'string', enum: ['candidate', 'blend'] },
              etymology: {
                type: 'string',
                description: 'One sentence: where the name comes from inside the world.',
              },
              why: { type: 'string', description: 'One sentence for the author: why this one.' },
            },
            required: ['name', 'source', 'etymology', 'why'],
          },
        },
      },
      required: ['reading', 'picks'],
    },
  },
};

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Every word the model is allowed to use.
 *
 * The candidates, the words they were assembled from, the invented stems, and
 * the structural joins. This is the whole vocabulary, and it is why letting the
 * model COMPOSE is safe rather than a hole: a model that wants to answer
 * "Aetherium" has nothing to build it out of. It can only rearrange this world.
 */
function allowedWords(slate: readonly Candidate[], palette: Palette): Set<string> {
  const out = new Set<string>();
  const add = (text: string): void => {
    for (const word of text.split(/[\s-]+/)) {
      const flat = normalizeName(word);
      if (flat) out.add(flat);
    }
  };
  for (const c of slate) add(c.name);
  for (const stem of palette.stems) add(stem);
  for (const { options } of palette.words) for (const option of options) add(option);
  for (const word of palette.structural) add(word);
  return out;
}

/**
 * Is this name built out of what was offered?
 *
 * Three ways to pass: it is a candidate outright; every word of it is on the
 * allowed list; or it is a genuine blend of two invented stems. The blend rule
 * is generous on purpose — "Skarr" plus "-vennes" is exactly the kind of thing
 * worth allowing, and demanding exact substrings of both would refuse it. What
 * none of the three admits is a word from outside this world, which is what
 * "Elara" looks like from here.
 */
function fromSlate(name: string, slate: readonly Candidate[], palette?: Palette): boolean {
  const flat = normalizeName(name);
  if (!flat) return false;

  const parts = slate.map((c) => normalizeName(c.name));
  if (parts.includes(flat)) return true;

  const words = name.split(/[\s-]+/).map(normalizeName).filter(Boolean);

  if (palette) {
    const allowed = allowedWords(slate, palette);
    if (words.length && words.every((w) => allowed.has(w))) return true;
  } else if (words.length > 1 && words.every((w) => parts.some((p) => p.includes(w) || w.includes(p)))) {
    // Slate-only fallback, for callers that have no palette to offer.
    return true;
  }

  // A true blend: a prefix of one invented word and a suffix of another, each
  // long enough to be recognisable rather than a coincidence.
  const stems = [...parts, ...(palette?.stems ?? []).map(normalizeName)];
  for (const a of stems) {
    for (const b of stems) {
      if (a === b) continue;
      for (let cut = 2; cut < flat.length - 1; cut++) {
        if (a.startsWith(flat.slice(0, cut)) && b.endsWith(flat.slice(cut))) return true;
      }
    }
  }
  return false;
}

/**
 * Validate the model's answer. Returns the picks, or an error string that goes
 * back as tool output so a near miss is corrected rather than lost.
 */
function parseChoice(
  raw: Record<string, unknown>,
  slate: readonly Candidate[],
  charter: NamingCharter,
  taken: readonly string[],
  palette?: Palette
): NameProposal[] | string {
  const reading = raw.reading as Record<string, unknown> | undefined;
  if (!reading || !String(reading.register ?? '').trim()) {
    return 'Error: reading.register is required — say what the names already in this novel have in common before choosing anything.';
  }
  if (!Array.isArray(raw.picks)) return 'Error: picks must be an array.';
  if (!raw.picks.length) return 'Error: pick at least one name from the candidates.';

  const out: NameProposal[] = [];
  const seen = new Set<string>();

  for (const item of raw.picks.slice(0, PICKS) as unknown[]) {
    if (typeof item !== 'object' || item === null) return 'Error: every pick must be an object.';
    const pick = item as Record<string, unknown>;
    const name = String(pick.name ?? '').trim();
    if (!name) return 'Error: every pick needs a name.';

    const flat = normalizeName(name);
    if (seen.has(flat)) return `Error: "${name}" appears twice. Four picks means four different names.`;
    seen.add(flat);

    // The gate. Without it every filter the generator applied is advisory.
    if (!fromSlate(name, slate, palette)) {
      return (
        `Error: "${name}" uses a word that was not offered. Every word of a name must be a ` +
        `candidate, one of the parts listed under it, or a blend of two invented words. A word ` +
        `from outside that list does not belong to this world.`
      );
    }

    const problem = checkName(name, { banned: charter.banned, taken });
    if (problem) return `Error: "${name}" cannot be used — ${problem}. Choose another.`;

    const etymology = String(pick.etymology ?? '').trim();
    if (etymology.length < 15) {
      return `Error: "${name}" has no etymology. One sentence on where the name comes from inside the world — that is what turns it from a noise into part of the novel.`;
    }

    out.push({
      name: clip(name, LIMITS.name),
      source: pick.source === 'blend' ? 'blend' : 'candidate',
      etymology: clip(etymology, LIMITS.etymology),
      why: clip(String(pick.why ?? '').trim(), LIMITS.why),
    });
  }

  return out;
}

export interface CoinArgs {
  /** Absent runs the generator alone and returns the slate unjudged. */
  apiKey: string | null;
  novel: Novel;
  charter: NamingCharter;
  kind: BibleEntryType;
  brief: string;
  culture?: string;
  /** Every name the novel has spent. */
  taken: readonly string[];
  /** For the model's reading of the world. */
  bibleEntries?: BibleEntry[];
  nonce?: number;
  signal?: AbortSignal;
  emit?: (event: AgentEvent) => void;
}

export async function runCoin(args: CoinArgs): Promise<CoinResult> {
  const emit = args.emit ?? (() => {});
  const culture = resolveCulture(args.charter, args.culture);
  const slate = generateSlate({
    novelId: args.novel.id,
    cultureId: culture.id,
    soundWorldId: culture.soundWorldId,
    pack: args.charter.pack,
    type: args.kind,
    brief: args.brief,
    count: SLATE_SIZE,
    taken: args.taken,
    banned: args.charter.banned,
    nonce: args.nonce,
  });

  // No key, no problem: the generator is the feature, the model is the polish.
  if (!args.apiKey) return { proposals: [], slate: slate.candidates, usage: null };

  const context = [
    `NOVEL: ${args.novel.title}`,
    args.novel.premise.trim() ? `PREMISE:\n${args.novel.premise.trim()}` : '',
    args.novel.styleNotes.trim() ? `AUTHOR'S NOTES:\n${args.novel.styleNotes.trim()}` : '',
    args.charter.notes.trim() ? `THE AUTHOR'S NAMING RULES:\n${args.charter.notes.trim()}` : '',
    args.charter.cultures.length > 1
      ? `THIS NAME BELONGS TO: ${culture.label}${culture.appliesTo.trim() ? ` — ${culture.appliesTo.trim()}` : ''}`
      : '',
    args.bibleEntries?.length
      ? `WHAT THE NOVEL HAS NAMED SO FAR:\n${formatBibleIndex(args.bibleEntries)}`
      : args.taken.length
        ? `WHAT THE NOVEL HAS NAMED SO FAR:\n${args.taken.slice(0, 40).join(', ')}`
        : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const width = Math.max(...slate.candidates.map((c) => c.name.length), 0);
  const candidateBlock = slate.candidates
    .map((c, i) => `  ${i + 1}. ${c.name.padEnd(width)}   ${c.note}`)
    .join('\n');

  const paletteBlock = [
    slate.palette.stems.length ? `  invented words: ${slate.palette.stems.join(', ')}` : '',
    ...slate.palette.words
      .filter((w) => w.options.length)
      .map((w) => `  ${w.bank}: ${w.options.join(', ')}`),
    `  joining words: ${slate.palette.structural.join(', ')}`,
  ]
    .filter(Boolean)
    .join('\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      // The candidates go LAST: they are what the answer must come from, and
      // last is where a model looks hardest.
      content:
        `${context}\n\n` +
        `WHAT NEEDS A NAME — a ${args.kind}: ${args.brief || '(no description given)'}\n\n` +
        `The register of this culture: ${slate.spec.register}\n` +
        `How its names are built: ${slate.spec.shape}\n\n` +
        `CANDIDATES — ready to use as they are:\n${candidateBlock}\n\n` +
        `THE PARTS THEY ARE MADE FROM — build your own from these when none of the candidates ` +
        `says what this thing is. Nothing outside this list may appear in a name:\n${paletteBlock}\n\n` +
        `Choose or build ${PICKS}.`,
    },
  ];

  emit({ type: 'trace', data: `Reading the world for a ${args.kind} name…` });

  let total = EMPTY_USAGE;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const result = await streamChat({
      apiKey: args.apiKey,
      model: NAMING_MODEL,
      messages,
      tools: [chooseToolDefinition],
      // Forced: the choice IS the deliverable, and there is nothing useful this
      // agent could say in prose instead.
      toolChoice: { type: 'function', function: { name: 'choose_names' } },
      maxTokens: 1500,
      // Every request carries a different slate, so there is no cached prefix
      // for a pin to protect.
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
      messages.push({ role: 'user', content: 'Call choose_names now.' });
      continue;
    }

    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
    } catch {
      parsed = {};
    }

    const proposals = parseChoice(parsed, slate.candidates, args.charter, args.taken, slate.palette);
    if (typeof proposals !== 'string') {
      console.log(
        `[coin] novel=${args.novel.id} kind=${args.kind} picks=${proposals.length} ` +
          `cost=$${total.cost.toFixed(5)}`
      );
      emit({ type: 'trace', data: `${proposals.length} names ready` });
      return { proposals, slate: slate.candidates, usage: total };
    }

    messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });
    messages.push({ role: 'tool', tool_call_id: call.id, content: proposals });
  }

  // Three rounds of a model refusing to pick from a list of fourteen is a model
  // problem, and the author still gets the slate — which is what they came for.
  console.log(`[coin] novel=${args.novel.id} kind=${args.kind} fell back to the raw slate`);
  return { proposals: [], slate: slate.candidates, usage: total };
}

export { fromSlate as isFromSlate, parseChoice as parseNameChoice };
