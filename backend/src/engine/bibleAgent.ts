import { BibleValidationError, applyBiblePatch, slugifyBibleName, validateBiblePatch, BIBLE_LIMITS } from '../lib/bibleValidate.js';
import * as store from '../lib/store.js';
import type { BibleEntry, Chapter, Novel } from '../lib/types.js';
import type { AgentEvent } from './agent.js';
import {
  formatBibleEntry,
  formatBibleIndex,
  formatBibleSearchResults,
  getBibleToolDefinition,
  searchBibleEntries,
  searchBibleToolDefinition,
  upsertBibleToolDefinition,
} from './bibleTools.js';
import {
  findPowerSystems,
  formatPowerIndex,
  formatPowerSystem,
  getPowerToolDefinition,
  handleUpsertPowerSystem,
  upsertPowerToolDefinition,
} from './powerTools.js';
import { streamChat, type ChatMessage, type Usage } from './openrouter.js';

/**
 * The model is fixed and cheap on purpose. Bible maintenance is bookkeeping,
 * not prose — it runs on every accept, so it must cost cents per hundred
 * chapters, and it must never be the novel's (possibly expensive) model.
 */
export const BIBLE_MODEL = 'deepseek/deepseek-v4-flash';

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
 * The update agent's instructions. Deliberately long: this prompt IS the
 * feature. It teaches selection (most entities do not belong in a bible),
 * dedup through alias search, and the update-vs-overwrite discipline —
 * each with the failure mode it exists to prevent.
 */
const UPDATE_SYSTEM_PROMPT = [
  'You maintain the STORY BIBLE for a serialised novel: a small, structured database of the',
  'entities that matter to the story — characters, factions, locations, items, weapons,',
  'creatures, techniques, concepts, events. Future chapters are written against this bible, so',
  'every entry you write will be read back as canon. Your job for each chapter: identify what',
  'changed or was introduced that FUTURE CHAPTERS MUST NOT CONTRADICT, and record exactly that.',
  '',
  'You have three tools: search_story_bible, get_story_bible_entries, upsert_story_bible_entry.',
  'The full entry index is below; the chapter text is in the user message.',
  '',
  '## PROCESS — follow it in order',
  '1. Read the chapter and list (mentally) the candidate entities: things named, things changed.',
  '2. Apply the selection bar below. Most candidates fail it. Expect 0-5 entities per chapter.',
  '3. For EACH survivor: search_story_bible with its name AND plausible synonyms — the title,',
  '   the nickname, the shorthand the text uses. Entities are often already present under',
  '   another name.',
  '4. If found: get_story_bible_entries to read the current entry, then upsert with ONLY what',
  '   changed. If truly absent: upsert without an id to create.',
  '5. Finish with one short line summarising what you did, e.g.',
  '   "Updated kael-veyron (status: dead), created the-ashen-concord." Nothing else.',
  '',
  '## SELECTION BAR — what belongs in a bible',
  'An entity earns an entry only if ALL three hold:',
  '  (a) it recurs, or the chapter clearly sets it up to recur;',
  '  (b) it has a name, or is unmistakably identifiable ("the black tower over the bay");',
  '  (c) it carries state a future chapter could contradict — allegiance, location, condition,',
  '      ownership, abilities, secrets known.',
  '',
  'YES: a named character who speaks and acts. A named sword that grants something. The sect',
  'the protagonist joins. A technique with stated costs or limits. A city the plot returns to.',
  'A bargain, oath or debt with future consequences (an *event* entry).',
  '',
  'NO — these are the over-collection failure, and over-collection is the way bibles die:',
  '- The innkeeper who serves one meal and vanishes. (But the innkeeper who takes a bribe and',
  '  knows the protagonist\'s name? Yes — she now carries a secret.)',
  '- A sword someone merely draws. (A NAMED sword: yes.)',
  '- Unnamed guards, merchants, crowds, servants. Weather. Meals. Furniture.',
  '- A village passed through in one line and never returned to.',
  '- Generic techniques ("he punched"), unnamed streets, background nobles at a banquet.',
  'If an update touches ten entities, you are almost certainly over-collecting. Stop and re-apply',
  'the bar.',
  '',
  '## DEDUP — search before every create, including synonyms',
  'The same entity appears as "Kael", "the young master", "the Veyron heir", "him of the broken',
  'crest". These are ONE entry with aliases, never four entries.',
  '- Before creating, search the canonical name AND every synonym the chapter uses.',
  '- If you find the entity under another name, UPDATE it and add the new name to aliases.',
  '- Creating a duplicate is the worst mistake you can make: from then on, half the facts land',
  '  on each twin and the bible actively misleads. When unsure whether X is the same entity,',
  '  prefer updating the existing entry and noting the uncertainty as a fact.',
  '',
  '## UPDATE ≠ OVERWRITE',
  '- Current state lives in `status` and `attributes` — change them freely; they mean "as of now".',
  '- History lives in `facts` — append via newFacts, one atomic claim each, concrete, with names',
  '  not pronouns. "Lost his left eye duelling Ren" — good. "He was hurt" — useless.',
  '- When new canon CHANGES old canon (a death, a betrayal, a broken oath), set the state AND',
  '  append a fact naming what it supersedes. Do not delete the past: a dead character\'s life',
  '  is still canon.',
  '- Rewrite `summary` only to reflect the new current truth. Never erase a character\'s past',
  '  from the summary — compress it.',
  '- removeFacts is ONLY for consolidating: a fact now superseded and re-stated, or an exact',
  '  duplicate. It is not for cleaning up history you find untidy.',
  '',
  '## ATTRIBUTES — use the conventional keys',
  'character: role, age, appearance, voice (how they speak), goal',
  'faction: leader, seat, strength, stance',
  'location: region, controlledBy, description',
  'item / weapon: owner, powers, origin',
  'creature: species, habitat, threat',
  'technique: user, cost, limits',
  'concept / event: chapter-relevant keys of your choosing, kept short',
  'Consistent keys are what make the bible searchable. Values are short strings, not essays.',
  '',
  '## RELATIONSHIPS',
  'Only between entries that BOTH exist — create first, then link. The `relationships` field',
  'replaces the whole list, so when changing it, send the complete current set. Keep natures',
  'short: "sworn enemy", "master of", "owns", "member of".',
  '',
  '## HARD RULES',
  '- Never invent. Record only what this chapter states or unmistakably implies. If the text is',
  '  ambiguous, record the ambiguity ("fate unknown — fell from the bridge, body not found").',
  '- When the chapter contradicts the bible, the CHAPTER wins — it is newer canon. Update state',
  '  and record the supersession.',
  '- If a tool call returns an error, read the error, fix the arguments, and retry once. The',
  '  errors are precise (caps, missing fields, id collisions).',
  '- If NOTHING in the chapter clears the selection bar, that is a valid outcome: make no',
  '  writes and say "No bible changes needed."',
  `- The bible is capped at ${BIBLE_LIMITS.entriesPerNovel} entries per novel. Near the cap, only`,
  '  genuinely major entities justify creation.',
].join('\n');

/**
 * Appended only when the novel has power systems, so a novel without any
 * never pays these tokens — and within a batch catch-up the system prompt is
 * stable either way, keeping the warm-prefix property the message comment
 * below relies on.
 */
const POWER_PROMPT_SECTION = [
  '',
  '## POWER SYSTEMS — the ladder is canon',
  'This novel has structured power systems (their index is in the user message). Two more tools',
  'apply: get_power_system and upsert_power_system. Record only what the chapter ESTABLISHES OR',
  'CHANGES about them:',
  '- a character\'s rank stated or changed: upsertRanks with the rank\'s id and the character\'s',
  '  bible id in characterIds. The character entry must exist FIRST — create it, then link.',
  '- a capability demonstrated at a rank the system does not yet record.',
  '- a named technique, weapon or item tied to the ladder: create its bible entry first, then',
  '  link it via upsertArtifacts with how it scales.',
  '- a claim about a region\'s power level: upsertRegions.',
  'Read the system with get_power_system before writing to it. Never invent ranks the chapter',
  'does not name; a fight is not a rank change; a breakthrough is (set the character on the new',
  'rank, not the old one). Do NOT create new power systems — that is the author\'s act; if the',
  'chapter implies a system that does not exist, note it as a fact on a concept entry instead.',
  'Most chapters change nothing here, and that is the expected outcome.',
].join('\n');

export interface BibleUpdateResult {
  usage: Usage;
  /** Display names of entries touched — these are shown to the author. */
  updated: string[];
  created: string[];
  /** Names of power systems the chapter changed. */
  power: string[];
}

/**
 * Run the bible update for one chapter. Best-effort by contract: callers wrap
 * this and a failure must never block the accept (or the batch run) it is
 * part of.
 *
 * `source` calibrates the agent's confidence: a summary omitting an entity is
 * not evidence of absence, so summary runs are told to be conservative.
 */
export async function runBibleUpdate(args: {
  apiKey: string;
  novel: Novel;
  chapter: Chapter;
  source: 'chapter' | 'summary';
  signal?: AbortSignal;
  emit?: (event: AgentEvent) => void;
}): Promise<BibleUpdateResult> {
  const emit = args.emit ?? (() => {});
  let entries = await store.listBibleEntries(args.novel.id);
  // One cheap query per run on a ≤5-doc collection. Empty means no power
  // tools, no prompt section, and no index line — the feature costs nothing
  // until the author builds a system.
  let systems = await store.listPowerSystems(args.novel.id);
  let total = EMPTY_USAGE;
  const updated: string[] = [];
  const created: string[] = [];
  const power: string[] = [];

  const text =
    args.source === 'chapter'
      ? args.chapter.content
      : args.chapter.summary.trim() || args.chapter.content.slice(0, 4000);

  const sourceNote =
    args.source === 'chapter'
      ? 'Below is the full text of the newly accepted chapter.'
      : 'Below is the stored SUMMARY of the chapter (not the full text). It omits detail, so be ' +
        'conservative: only record what the summary itself establishes, and never treat an ' +
        "entity's absence from the summary as meaningful.";

  // Index first and chapter text last: consecutive runs (a batch catch-up)
  // share the system prompt as a warm prefix on the fixed cheap model.
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: systems.length > 0 ? UPDATE_SYSTEM_PROMPT + POWER_PROMPT_SECTION : UPDATE_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content:
        `NOVEL: ${args.novel.title}\nPREMISE: ${args.novel.premise || '(none)'}\n\n` +
        `STORY BIBLE INDEX (${entries.length} entries):\n${formatBibleIndex(entries) || '(empty — this is a new bible)'}\n\n` +
        (systems.length > 0 ? `POWER SYSTEMS:\n${formatPowerIndex(systems)}\n\n` : '') +
        `CHAPTER ${args.chapter.number}${args.chapter.title ? `: ${args.chapter.title}` : ''}\n` +
        `${sourceNote}\n\n${text}`,
    },
  ];

  for (let round = 0; round <= MAX_ROUNDS; round++) {
    const forceStop = round === MAX_ROUNDS;
    const result = await streamChat({
      apiKey: args.apiKey,
      model: BIBLE_MODEL,
      messages,
      tools: forceStop
        ? undefined
        : [
            searchBibleToolDefinition,
            getBibleToolDefinition,
            upsertBibleToolDefinition,
            // Only when a system exists: the agent maintains ladders, it never
            // invents them, and "no system yet" is the common case — offering
            // a tool whose answer is an instructive error would waste a round
            // on every accept.
            ...(systems.length > 0 ? [getPowerToolDefinition, upsertPowerToolDefinition] : []),
          ],
      maxTokens: 2000,
      signal: args.signal,
    });
    total = addUsage(total, result.usage);

    if (result.finishReason !== 'tool_calls' || result.toolCalls.length === 0) {
      break; // the closing one-line summary
    }

    messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });

    for (const call of result.toolCalls) {
      let output: string;
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        parsed = {};
      }

      switch (call.function.name) {
        case 'search_story_bible': {
          const terms = Array.isArray(parsed.terms) ? parsed.terms.map(String) : [];
          // Traced so the client has something to show during the seconds
          // before the first write — silence reads as a hang.
          if (terms.length) emit({ type: 'trace', data: `Bible: looking up ${terms.slice(0, 4).join(', ')}` });
          output = formatBibleSearchResults(searchBibleEntries(entries, terms));
          break;
        }
        case 'get_story_bible_entries': {
          const ids = Array.isArray(parsed.ids) ? parsed.ids.map(String) : [];
          const found = entries.filter((e) => ids.includes(e.id));
          if (found.length) emit({ type: 'trace', data: `Bible: reading ${found.map((e) => e.name).join(', ')}` });
          output = found.length
            ? found.map(formatBibleEntry).join('\n\n---\n\n')
            : 'No entries with those ids. Check the index or search first.';
          break;
        }
        case 'upsert_story_bible_entry': {
          output = await handleUpsert(args.novel.id, args.chapter.number, parsed, entries, {
            onUpdated: (e) => {
              updated.push(e.name);
              emit({ type: 'trace', data: `Bible: updated ${e.name}` });
            },
            onCreated: (e) => {
              created.push(e.name);
              emit({ type: 'trace', data: `Bible: created ${e.name}` });
            },
          });
          // Refresh the in-memory view so later rounds see this write.
          entries = await store.listBibleEntries(args.novel.id);
          break;
        }
        case 'get_power_system': {
          const ids = Array.isArray(parsed.ids) ? parsed.ids.map(String).slice(0, 5) : [];
          const found = findPowerSystems(systems, ids);
          if (found.length) {
            emit({ type: 'trace', data: `Power: reading ${found.map((s) => s.name).join(', ')}` });
          }
          output = found.length
            ? found.map((s) => formatPowerSystem(s, entries)).join('\n\n---\n\n')
            : 'No power systems with those ids — check the POWER SYSTEMS index.';
          break;
        }
        case 'upsert_power_system': {
          output = await handleUpsertPowerSystem(
            args.novel.id,
            parsed,
            systems,
            entries,
            'model',
            (s) => {
              power.push(s.name);
              emit({ type: 'trace', data: `Power: updated ${s.name}` });
            }
          );
          // Same refresh contract as the bible upsert above.
          systems = await store.listPowerSystems(args.novel.id);
          break;
        }
        default:
          output = `Unknown tool: ${call.function.name}`;
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
    }
  }

  console.log(
    `[bible] novel=${args.novel.id} ch=${args.chapter.number} source=${args.source} ` +
      `created=${created.length} updated=${updated.length} power=${power.length} cost=$${total.cost.toFixed(5)}`
  );
  return { usage: total, updated, created, power: [...new Set(power)] };
}

/**
 * Validate and apply one upsert. Validation failures come back as tool output
 * — precise, correctable, and never a crash — which is what lets the schema
 * act as enforcement rather than as a landmine.
 */
async function handleUpsert(
  novelId: string,
  chapter: number,
  raw: Record<string, unknown>,
  entries: BibleEntry[],
  on: { onUpdated: (e: BibleEntry) => void; onCreated: (e: BibleEntry) => void }
): Promise<string> {
  try {
    const patch = validateBiblePatch(raw, chapter);
    const requestedId = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null;

    if (requestedId) {
      const existing = entries.find((e) => e.id === requestedId);
      if (!existing) {
        return `Error: no entry with id "${requestedId}". Use search_story_bible to find the right id, or omit id to create.`;
      }
      const next = await store.transactBibleEntry(novelId, requestedId, (current) =>
        applyBiblePatch(current ?? existing, requestedId, patch, chapter)
      );
      on.onUpdated(next);
      return `Updated ${next.id}:\n${formatBibleEntry(next)}`;
    }

    // Create path.
    if (!patch.name || !patch.type) {
      return 'Error: creating an entry requires both name and type.';
    }
    const id = slugifyBibleName(patch.name);
    const collision = entries.find((e) => e.id === id);
    if (collision) {
      return (
        `Error: an entry with id "${id}" already exists (${collision.name}). ` +
        'If this is the same entity, upsert with that id; if it is genuinely different, use a more specific name.'
      );
    }
    // The same entity under a known alias is a near-collision worth blocking.
    const aliasTwin = entries.find(
      (e) =>
        e.name.toLowerCase() === patch.name!.toLowerCase() ||
        e.aliases.some((a) => a.toLowerCase() === patch.name!.toLowerCase())
    );
    if (aliasTwin) {
      return `Error: "${patch.name}" is already a name or alias of entry "${aliasTwin.id}". Update that entry instead.`;
    }
    if (entries.length >= BIBLE_LIMITS.entriesPerNovel) {
      return `Error: the bible is at its ${BIBLE_LIMITS.entriesPerNovel}-entry cap. Only update existing entries.`;
    }

    const next = await store.transactBibleEntry(novelId, id, (current) =>
      applyBiblePatch(current, id, patch, chapter)
    );
    on.onCreated(next);
    return `Created ${next.id}:\n${formatBibleEntry(next)}`;
  } catch (err) {
    if (err instanceof BibleValidationError) {
      return `Error: ${err.message}`;
    }
    throw err;
  }
}
