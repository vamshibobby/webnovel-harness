import * as store from '../../lib/store.js';
import type { Novel } from '../../lib/types.js';
import type { AgentEvent } from '../agent.js';
import { streamChat, type ChatMessage, type MessageContent, type Usage } from '../openrouter.js';
import {
  createMapToolDefinition,
  formatMap,
  getMapToolDefinition,
  handleCreateMap,
  handleUpsertGeofacts,
  upsertGeofactsToolDefinition,
  type ToolContext,
} from './tools.js';
import type { GeoMap } from './types.js';

/**
 * The Atlas agents — three ways facts reach one map.
 *
 *  - runMapUpdate: reads a full chapter after accept (or in a catch-up run)
 *    and extracts geography. Cheap fixed model, bible-agent discipline, and
 *    "No map changes needed." as the expected common outcome.
 *  - runMapDictation: the author describes their world in text. Everything
 *    lands as confidence 'author' — canon the extraction path can never
 *    supersede.
 *  - runMapSketch: the author draws. A vision model reads the drawing for
 *    RELATIONSHIPS only; positions come from the sketch itself as pins the
 *    solver treats as immovable.
 *
 * The map is visualization only, by hard product rule: nothing here is ever
 * injected into chapter generation.
 */

export const MAP_MODEL = 'deepseek/deepseek-v4-flash';
/** Flash cannot see; the sketch reader needs eyes. */
export const MAP_VISION_MODEL = 'openai/gpt-5.6-luna';

const MAX_ROUNDS = 6;

const EMPTY_USAGE: Usage = {
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
};

function addUsage(a: Usage, b: Usage | null): Usage {
  if (!b) return a;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cost: a.cost + b.cost,
  };
}

/**
 * The extraction prompt, validated by the research spike. Each rule states the
 * failure mode it exists to prevent — the compass-phrase rule earned its place
 * by an agent putting a border town on the wrong side of an empire.
 */
const CHAPTER_SYSTEM_PROMPT = [
  "You maintain the MAP of a serialised novel's world: a database of spatial FACTS — never",
  'coordinates. You state relationships ("Velmora lies in the north of the Dominion", "the port',
  'faces the Sea of Glass") and a deterministic renderer draws them. Rough is correct: unknown',
  'borders are drawn as hypothetical automatically, and they firm up as later chapters add facts.',
  '',
  'You have three tools: get_map, create_map, upsert_geofacts. The chapter text is in the user',
  'message.',
  '',
  '## PROCESS — in order',
  '1. Call get_map.',
  '2. Read the chapter and decide: does it establish GEOGRAPHIC-SCALE spatial relationships',
  '   between two or more places? Most chapters do not. If not, say "No map changes needed."',
  '   and stop — that is the correct outcome, not a failure.',
  '3. If no map exists and the bar below is met, create_map, then upsert the places and facts.',
  '4. If a map exists, upsert only what this chapter ADDS or CHANGES.',
  '5. Finish with one short line summarising what you did.',
  '',
  '## THE WARRANTED-MAP BAR',
  'Create a map only when the chapter relates two or more places at geographic scale.',
  '- A single city described from inside — streets, taverns, districts — is NOT a map. No call.',
  '- An empire with a named city in its north IS a map: the empire as a region (its border will',
  '  be hypothetical), the city placed north within it.',
  'Over-mapping is the way maps die. Expect ZERO tool calls more often than not.',
  '',
  '## FACT DISCIPLINE',
  '- Record only what the text states or unmistakably implies. "The capital lay far to the',
  '  south" → direction S + distance far, confidence stated. "He traveled to Harrow" → NOTHING:',
  '  travel proves places exist, not where they are.',
  '- Use confidence "implied" for anything you inferred rather than read.',
  '- Entity ids are kebab-case slugs and stable forever: sea-of-glass, veyron-empire. When a',
  "  place already has a story-bible entry, use that entry's id.",
  '- Always set `extent` — how much of the WORLD a place occupies, which is not the same as how',
  '  much the story cares about it. A continent-spanning empire or an open sea is "vast"; a',
  '  kingdom, a wilderness or a named sea is "large"; a province or a great city is "medium"; a',
  '  town or a lake is "small". Without it every realm draws the same size, which tells the',
  '  reader nothing.',
  '- Prefer few strong facts over many weak ones. 0-6 facts per chapter is normal.',
  '- Never invent adjacencies or directions to make the map tidier. Gaps are fine; the renderer',
  '  dashes what is unknown.',
  '',
  '## RELATION VOCABULARY',
  'within(subject, container) · direction(subject, anchor, dir N/NE/E/SE/S/SW/W/NW) ·',
  'distance(a, b, adjacent|near|far) · adjacent-region(a, b) · on-coast(subject, water) ·',
  'between(subject, a, b) · connects(road, a, b)',
  '"X lies south of Y" is direction(subject: X, anchor: Y, dir: S).',
  'Read compass phrases carefully. "A town on the NORTHERN border of the Empire" is N of that',
  'empire, not S — the border named is the side it sits on. A reversed compass point puts a',
  'place on the wrong side of a realm and nothing downstream can recover it.',
  '',
  '## WHAT IS NOT YOURS TO FIX',
  'The tool may report "constraint(s) drawn best-effort". That is the RENDERER working with',
  'incomplete canon — it is not an error, and you must never supersede or rewrite a correct',
  'fact to make the drawing tidier. Supersede only when the CHAPTER contradicts a fact.',
  '',
  '## CONTRADICTIONS',
  'When a fact you send contradicts an established one, the tool returns an error naming both.',
  'The NEWER chapter is canon: re-send your fact with supersede:["<old fact id>"]. Never drop',
  'the new fact to avoid the conflict, and never supersede facts the chapter does not actually',
  'contradict. The one exception: a fact marked AUTHOR-STATED is the author speaking directly',
  'and always wins — if your extraction conflicts with one, your reading is wrong. Skip it.',
  '',
  '## HARD RULES',
  '- If a tool call errors, read the error, fix the call, retry once.',
  '- Do not re-state facts already on the map; the tool ignores duplicates.',
  '- You cannot delete entities. Canon that changes is superseded, not erased.',
].join('\n');

const DICTATION_SYSTEM_PROMPT = [
  "You record an author's OWN description of their novel's geography as spatial FACTS — never",
  'coordinates. The author is speaking directly: everything they state is canon and will be',
  'stored as author-stated fact, outranking anything ever extracted from chapters.',
  '',
  'You have three tools: get_map, create_map, upsert_geofacts. The author\'s description is in',
  'the user message.',
  '',
  '## PROCESS — in order',
  '1. Call get_map.',
  '2. If no map exists yet, create_map (scope "world" unless the author clearly describes a',
  '   single region or city).',
  '3. Translate the author\'s statements into entities and facts. Where the author contradicts',
  '   a fact already on the map — including earlier author statements — supersede it: the',
  '   author is changing their mind, and the newest statement wins.',
  '4. Finish with one short line summarising what you recorded.',
  '',
  '## FACT DISCIPLINE',
  '- Record what the author SAID, completely — but never invent what they did not say. If they',
  '  named five places and related three, two places may go unrelated; ask nothing, add nothing.',
  '- Entity ids are kebab-case slugs and stable forever. When a place already exists on the map',
  '  or in the story bible, reuse its id — never create a twin.',
  '- Always set `extent` (vast/large/medium/small) — physical size, not importance. "Very big"',
  '  empires are vast. Seas default large; oceans vast.',
  '- Read compass phrases carefully: "a town on the NORTHERN border of the Empire" is N of that',
  '  empire. Reversing a compass point puts the place on the wrong side of a realm.',
  '',
  '## RELATION VOCABULARY',
  'within(subject, container) · direction(subject, anchor, dir N/NE/E/SE/S/SW/W/NW) ·',
  'distance(a, b, adjacent|near|far) · adjacent-region(a, b) · on-coast(subject, water) ·',
  'between(subject, a, b) · connects(road, a, b)',
  '',
  '## HARD RULES',
  '- If a tool call errors, read the error, fix the call, retry once.',
  '- You cannot delete entities. Canon that changes is superseded, not erased.',
].join('\n');

const SKETCH_SYSTEM_PROMPT = [
  "You convert an author's rough hand-drawn sketch of their novel's world into spatial FACTS.",
  'You are given the sketch image AND a structured list of every shape the author drew: its',
  'kind (region / water / settlement), its label, and its exact position in map space (0-1000,',
  'y grows downward). The author drew it, so everything here is canon, stored as author-stated',
  'fact.',
  '',
  'You have three tools: get_map, create_map, upsert_geofacts.',
  '',
  '## DIVISION OF LABOUR — positions are not yours',
  'The shape list already gives every entity its exact position. Pass each position through as',
  'the entity\'s `pin`, unchanged. Your job is the RELATIONSHIPS the drawing shows, which the',
  'list alone cannot: look at the image and record',
  '- within(dot, blob) for every settlement drawn inside a region,',
  '- adjacent-region(a, b) for regions drawn sharing a border,',
  '- on-coast(settlement, water) for settlements drawn touching a water body,',
  '- direction(a, b, dir) between the major features (regions, seas) so the arrangement is',
  '  stated, not just drawn,',
  '- between(x, a, b) where the drawing clearly shows it.',
  '',
  '## PROCESS — in order',
  '1. Call get_map.',
  '2. If no map exists, create_map (scope "world", title from the labels or simply',
  '   "The World").',
  '3. One upsert_geofacts call with every labelled shape as an entity (kind from the list,',
  '   `pin` from the list, `extent` judged from the DRAWN relative size — the biggest blob on',
  '   the canvas is vast or large, a small one is small) and the relations you read off the',
  '   image.',
  '4. Finish with one short line summarising what you recorded.',
  '',
  '## HARD RULES',
  '- Never invent a place that is not in the shape list; never drop one that is.',
  '- Entity ids are kebab-case slugs of the labels. Reuse existing map/bible ids for the same',
  '  place — the author redrawing their world is refining it, not duplicating it.',
  '- Where the sketch contradicts existing facts, supersede them: the drawing is the author\'s',
  '  newest word.',
  '- If a tool call errors, read the error, fix the call, retry once.',
].join('\n');

export interface MapUpdateResult {
  usage: Usage;
  /** Display names of places added this run — shown to the author. */
  entitiesAdded: string[];
  factsAdded: number;
  summary: string;
}

/** One shape from the sketch canvas, already normalized to solver space. */
export interface SketchShape {
  kind: 'region' | 'settlement' | 'water';
  label: string;
  x: number;
  y: number;
  /** Fraction of the canvas the shape covers, 0-1 — extent evidence. */
  area?: number;
}

/**
 * The shared loop: bibleAgent's shape exactly — ≤6 rounds, the last round
 * drops tools to force the closing line, validation errors return as tool
 * output, every successful write persists immediately so a crash mid-run
 * keeps the progress made.
 */
async function runLoop(args: {
  apiKey: string;
  novel: Novel;
  model: string;
  systemPrompt: string;
  userContent: MessageContent;
  ctx: ToolContext;
  logTag: string;
  signal?: AbortSignal;
  emit?: (event: AgentEvent) => void;
}): Promise<MapUpdateResult> {
  const emit = args.emit ?? (() => {});
  const ctx = args.ctx;
  let total = EMPTY_USAGE;
  let summary = '';
  const entitiesAdded: string[] = [];
  let factsAdded = 0;

  const messages: ChatMessage[] = [
    { role: 'system', content: args.systemPrompt },
    { role: 'user', content: args.userContent },
  ];

  for (let round = 0; round <= MAX_ROUNDS; round++) {
    const forceStop = round === MAX_ROUNDS;
    const result = await streamChat({
      role: 'map',
      apiKey: args.apiKey,
      model: args.model,
      messages,
      tools: forceStop
        ? undefined
        : [getMapToolDefinition, createMapToolDefinition, upsertGeofactsToolDefinition],
      maxTokens: 2500,
      signal: args.signal,
    });
    total = addUsage(total, result.usage);

    if (result.finishReason !== 'tool_calls' || result.toolCalls.length === 0) {
      summary = (result.content || '').trim();
      break;
    }

    messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });

    for (const call of result.toolCalls) {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        parsed = {};
      }

      let output: string;
      switch (call.function.name) {
        case 'get_map':
          output = formatMap(ctx.map);
          break;
        case 'create_map':
          output = handleCreateMap(ctx, parsed);
          if (!output.startsWith('Error')) {
            emit({ type: 'trace', data: `Map: created "${ctx.map?.title}"` });
            await persist(args.novel.id, ctx.map!);
          }
          break;
        case 'upsert_geofacts': {
          const beforeIds = new Set(Object.keys(ctx.map?.entities ?? {}));
          const beforeFacts = ctx.map?.facts.length ?? 0;
          output = handleUpsertGeofacts(ctx, parsed);
          if (!output.startsWith('Error') && ctx.map) {
            for (const id of Object.keys(ctx.map.entities)) {
              if (!beforeIds.has(id)) entitiesAdded.push(ctx.map.entities[id].name);
            }
            factsAdded += ctx.map.facts.length - beforeFacts;
            emit({ type: 'trace', data: `Map: ${output.split('\n')[0]}` });
            await persist(args.novel.id, ctx.map);
          }
          break;
        }
        default:
          output = `Unknown tool: ${call.function.name}`;
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
    }
  }

  console.log(
    `[map] novel=${args.novel.id} ${args.logTag} added=${entitiesAdded.length} ` +
      `facts=${factsAdded} cost=$${total.cost.toFixed(5)}`
  );
  return { usage: total, entitiesAdded, factsAdded, summary };
}

/**
 * Write the agent's working copy through the transactional store path. The
 * agent's copy wins within its own run (same exposure the bible agent accepts
 * for cross-round writes); linking to bible entries happens here so a place
 * whose entry appeared this very accept still gets its click-through.
 */
async function persist(novelId: string, map: GeoMap): Promise<void> {
  try {
    const entries = await store.listBibleEntries(novelId);
    const locations = new Map(entries.filter((e) => e.type === 'location').map((e) => [e.id, e]));
    for (const entity of Object.values(map.entities)) {
      if (entity.bibleEntryId === null && locations.has(entity.id)) {
        entity.bibleEntryId = entity.id;
      }
    }
  } catch {
    // Linking is best-effort decoration; the map itself must still save.
  }
  await store.transactMap(novelId, () => map);
}

/** Extract geography from one accepted chapter. Always the full text — geography dies in summaries. */
export async function runMapUpdate(args: {
  apiKey: string;
  novel: Novel;
  chapter: { number: number; title: string; content: string };
  signal?: AbortSignal;
  emit?: (event: AgentEvent) => void;
}): Promise<MapUpdateResult> {
  const ctx: ToolContext = {
    map: await store.getMap(args.novel.id),
    chapter: args.chapter.number,
    createRationales: [],
  };
  return runLoop({
    apiKey: args.apiKey,
    novel: args.novel,
    model: MAP_MODEL,
    systemPrompt: CHAPTER_SYSTEM_PROMPT,
    userContent:
      `NOVEL: ${args.novel.title}\nPREMISE: ${args.novel.premise || '(none)'}\n\n` +
      `CHAPTER ${args.chapter.number}${args.chapter.title ? `: ${args.chapter.title}` : ''}\n` +
      `Below is the full text of the chapter.\n\n${args.chapter.content}`,
    ctx,
    logTag: `ch=${args.chapter.number} source=chapter`,
    signal: args.signal,
    emit: args.emit,
  });
}

/** Record the author's typed description of their world. Author canon. */
export async function runMapDictation(args: {
  apiKey: string;
  novel: Novel;
  text: string;
  signal?: AbortSignal;
  emit?: (event: AgentEvent) => void;
}): Promise<MapUpdateResult> {
  const chapter = Math.max(args.novel.mapChapter ?? 0, 1);
  const ctx: ToolContext = {
    map: await store.getMap(args.novel.id),
    chapter,
    createRationales: [],
    authorMode: true,
  };
  return runLoop({
    apiKey: args.apiKey,
    novel: args.novel,
    model: MAP_MODEL,
    systemPrompt: DICTATION_SYSTEM_PROMPT,
    userContent:
      `NOVEL: ${args.novel.title}\nPREMISE: ${args.novel.premise || '(none)'}\n\n` +
      `THE AUTHOR DESCRIBES THEIR WORLD:\n\n${args.text}`,
    ctx,
    logTag: 'source=dictation',
    signal: args.signal,
    emit: args.emit,
  });
}

/** Read the author's canvas sketch. Author canon with pinned positions. */
export async function runMapSketch(args: {
  apiKey: string;
  novel: Novel;
  imageDataUrl: string;
  shapes: SketchShape[];
  signal?: AbortSignal;
  emit?: (event: AgentEvent) => void;
}): Promise<MapUpdateResult> {
  const chapter = Math.max(args.novel.mapChapter ?? 0, 1);
  const ctx: ToolContext = {
    map: await store.getMap(args.novel.id),
    chapter,
    createRationales: [],
    authorMode: true,
    allowPins: true,
  };
  const shapeLines = args.shapes
    .map(
      (s) =>
        `- ${s.kind} "${s.label}" at (${Math.round(s.x)}, ${Math.round(s.y)})` +
        (s.area !== undefined ? ` covering ~${Math.round(s.area * 100)}% of the canvas` : '')
    )
    .join('\n');
  return runLoop({
    apiKey: args.apiKey,
    novel: args.novel,
    model: MAP_VISION_MODEL,
    systemPrompt: SKETCH_SYSTEM_PROMPT,
    userContent: [
      {
        type: 'text',
        text:
          `NOVEL: ${args.novel.title}\nPREMISE: ${args.novel.premise || '(none)'}\n\n` +
          "The author's sketch is attached. Every shape they drew, with exact positions in " +
          'map space (0-1000, y down):\n\n' +
          shapeLines,
      },
      { type: 'image_url', image_url: { url: args.imageDataUrl } },
    ],
    ctx,
    logTag: `source=sketch shapes=${args.shapes.length}`,
    signal: args.signal,
    emit: args.emit,
  });
}
