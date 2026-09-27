import type {
  BibleEntry,
  Chapter,
  CharacterDesign,
  Novel,
  PowerSystem,
  StoryArc,
} from '../lib/types.js';
import {
  formatBibleEntry,
  formatBibleSearchResults,
  getBibleToolDefinition,
  searchBibleEntries,
  searchBibleToolDefinition,
} from './bibleTools.js';
import { findPowerSystems, formatPowerSystem, getPowerToolDefinition } from './powerTools.js';
import {
  formatDesignSheet,
  getDesignToolDefinition,
  makeTargetResolver,
  matchDesignsByName,
} from './designTools.js';
import { buildGenerationMessages } from './context.js';
import { hasChapterBody, looksLikeReasoning } from './planning.js';
import type { NamingCharter } from './naming/charter.js';
import { coinNameToolDefinition, parseCoinArgs, runCoinName } from './naming/nameTools.js';
import { streamChat, type ChatMessage, type Usage } from './openrouter.js';
import { formatSearchResults, searchChapters, searchToolDefinition } from './search.js';

const MAX_TOOL_ROUNDS = 5;

/**
 * Rounds spent purely on coin_name do not count against MAX_TOOL_ROUNDS.
 *
 * That budget exists to bound RESEARCH — every other tool pulls text back into
 * the prompt and costs a round-trip. A naming call reads nothing, contacts
 * nothing, and returns in under a millisecond, so making it compete with a
 * canon lookup would trade a fact the chapter needs for a name it could have
 * had free. It still has to be bounded, or a model that keeps disliking its
 * slate never gets round to writing.
 */
const FREE_NAMING_ROUNDS = 2;

/**
 * Prose shorter than this alongside a tool call is throat-clearing ("Let me
 * pick a name first."), not a chapter opening. Above it, the model has started
 * writing and the fragment has to be dealt with — see the restart below.
 */
const PARTIAL_PROSE_CHARS = 400;

/**
 * The chapter's first line, as the FORMAT contract promises it.
 *
 * Used to decide, mid-stream, whether what is arriving is the chapter or the
 * model talking about fetching things first. Deliberately matches the heading
 * PREFIX rather than a whole line: the decision has to be made from a few
 * tokens, long before the title has finished arriving.
 */
const CHAPTER_OPENING = /^\s*(?:[*_#]{1,4}\s*){0,3}chapter\s+\d+/i;

/**
 * The tools the model is offered. No chapter of a novel contains these strings,
 * so finding one in what came back as prose means the model wrote out the call
 * it wanted to make instead of making it.
 */
const TOOL_NAME = /\b(search_previous_chapters|search_story_bible|get_story_bible_entries|get_character_design|get_power_system|coin_name)\b/;

/**
 * Is this a chapter, or did the model fail to answer?
 *
 * Not every model emits tool calls reliably. Some — especially on the round
 * where tools are taken away to force an answer — describe the call in prose
 * instead: a fenced block containing `search_previous_chapters` and nothing
 * else. That came back with finish_reason `stop`, which the loop read as "the
 * chapter is written", so it was returned, given a title, saved, and counted
 * towards the novel's word count. The author got a chapter that was three words
 * of tool name.
 *
 * Returns a description of the problem, or null when the text is usable.
 */
/**
 * Strip a fenced tool-call block from the front of a reply.
 *
 * Measured on x-ai/grok-4.5: even on turns where it emits a perfectly good tool
 * call, the content alongside it is often ```` ```search_previous_chapters``` ````
 * plus a stray `keywords:` line. On a turn where it also writes the chapter,
 * that lands at the top of the prose — past the length guard below, because the
 * chapter is long. No chapter opens with a code fence, so this is safe: the
 * format contract is that the first line is "Chapter N: Title".
 */
function stripNarratedCall(content: string): string {
  let text = content.trimStart();
  // Possibly more than one, and the fence is sometimes malformed ("``` steptype").
  for (let i = 0; i < 3; i++) {
    const fence = text.match(/^```[^\n`]*\n?([\s\S]{0,200}?)```\s*/);
    if (fence && TOOL_NAME.test(fence[0])) {
      text = text.slice(fence[0].length).trimStart();
      // The call is often followed by its arguments on the next line.
      text = text.replace(/^keywords[^\n]*\n?/i, '').trimStart();
      continue;
    }
    break;
  }
  return text === content.trimStart() ? content : text;
}

interface ChapterProblem {
  /** Completes "The model …", for the trace and the error. */
  problem: string;
  /** What to tell it on the retry. */
  correction: string;
}

function notAChapter(content: string): ChapterProblem | null {
  const text = content.trim();
  if (!text) {
    return {
      problem: 'returned nothing',
      correction: 'That was empty. Write the complete chapter now, starting with the "Chapter N: Title" line.',
    };
  }
  // A real chapter is thousands of characters. Something short that names a
  // tool is the model talking about its own plumbing.
  if (text.length < 600 && TOOL_NAME.test(text)) {
    return {
      problem: 'described a search instead of running one',
      correction:
        'That was not the chapter — you described a tool call rather than making one. ' +
        'You have no tools available now. Write the complete chapter using what you already ' +
        'know from the context above, starting with the "Chapter N: Title" line.',
    };
  }
  // A reply that plans AND THEN writes is left alone on purpose. extractTitle
  // strips the plan for free, where discarding the reply would buy a cleaner
  // stream at the price of a second full generation the author pays for. Only a
  // plan with no chapter under it is thrown away — that one has to be
  // regenerated regardless, because there is no chapter in it.
  if (looksLikeReasoning(text) && !hasChapterBody(text)) {
    return {
      problem: 'wrote out its plan instead of the chapter',
      correction:
        'That was your planning, not the chapter — it began by working out what to write rather ' +
        'than writing it. Do not show your reasoning. Reply with the finished chapter only: the ' +
        '"Chapter N: Title" line, then the prose itself, and nothing else. No notes on word ' +
        'count, no paragraph labels, no alternative phrasings.',
    };
  }
  return null;
}

export interface AgentEvent {
  /**
   * `restart` tells the client to discard the tokens streamed so far: the model
   * produced something that was not a chapter and is being asked again.
   */
  type: 'token' | 'reasoning' | 'trace' | 'tool' | 'usage' | 'done' | 'error' | 'restart';
  data: string;
}

export interface AgentResult {
  content: string;
  usage: Usage;
  /** The model stopped at its output limit, so the chapter ends mid-scene. */
  truncated?: boolean;
}

/**
 * How much room to give the model for the chapter itself.
 *
 * This used to be left unset, which means "whatever the provider defaults to" —
 * and some default to a couple of thousand tokens, which is half a chapter. The
 * result was a draft that stopped mid-sentence with nothing anywhere saying why.
 *
 * The generous headroom on top of the target length is not for prose: a
 * reasoning model spends output tokens THINKING before it writes a word, and
 * they come out of the same budget. Nothing is paid for tokens never produced.
 * The ceiling exists because a long prompt plus a huge reservation can exceed a
 * smaller model's context window outright.
 */
function outputBudget(chapterLength: number): number {
  const words = chapterLength > 0 ? chapterLength : 2_500;
  return Math.min(8_000, Math.round(words * 1.6) + 2_500);
}

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
 * Run the chapter-writing agent loop: stream from OpenRouter, execute
 * search_previous_chapters tool calls between rounds, and emit events.
 */
export async function runChapterAgent(args: {
  apiKey: string;
  model: string;
  novel: Novel;
  chapterNumber: number;
  previous: Chapter[];
  userPrompt: string;
  currentDraft?: string;
  revisionNotes?: string;
  /** Story bible entries for grounding; empty when the bible is off or empty. */
  bibleEntries?: BibleEntry[];
  /** Active character designs; empty when designs are off or none are active. */
  designs?: CharacterDesign[];
  /** Power systems; empty when the novel has none. */
  powerSystems?: PowerSystem[];
  /** The arc owning this chapter; null unless the author steers it. */
  arc?: StoryArc | null;
  /** The naming charter; null when naming is off, which also hides coin_name. */
  charter?: NamingCharter | null;
  /** Names the novel has already spent, for coin_name to avoid. */
  takenNames?: string[];
  signal?: AbortSignal;
  /** Decoding parameters, forwarded verbatim. Absent in production. */
  sampling?: Record<string, number>;
  providerOverride?: { order: string[]; allow_fallbacks: boolean };
  emit: (event: AgentEvent) => void;
}): Promise<AgentResult> {
  const messages: ChatMessage[] = buildGenerationMessages(args);
  const bible = args.bibleEntries ?? [];
  const designs = args.designs ?? [];
  const powerSystems = args.powerSystems ?? [];
  // Each tool only appears when there is something for it to read — a tool
  // that always answers "empty" teaches the model to stop calling tools at all.
  const tools = [
    searchToolDefinition,
    ...(bible.length > 0 ? [searchBibleToolDefinition, getBibleToolDefinition] : []),
    ...(designs.length > 0 ? [getDesignToolDefinition] : []),
    ...(powerSystems.length > 0 ? [getPowerToolDefinition] : []),
    // The rule above does not apply to this one: it is the only tool here that
    // manufactures its answer instead of reading one, so there is never nothing
    // for it to return. It appears whenever the author has naming switched on.
    ...(args.charter ? [coinNameToolDefinition] : []),
  ];
  // Names already spent. Coined names are added as they are handed out, so two
  // calls in one chapter cannot collide — nothing is persisted, because the
  // model may use none of what it was offered and the bible records at accept
  // time what actually survived into prose.
  const taken = new Set(args.takenNames ?? []);
  let coinCalls = 0;
  let total = EMPTY_USAGE;

  args.emit({ type: 'trace', data: `Sending prompt to ${args.model}` });

  // Set when a round comes back with something that is not a chapter, so the
  // retry has the tools taken away — the model has just demonstrated it cannot
  // use them, and asking again with the same offer tends to fail the same way.
  let forceNextAnswer = false;

  // Rounds that did research, as opposed to rounds that only coined names.
  let spent = 0;

  for (let round = 0; round <= MAX_TOOL_ROUNDS + FREE_NAMING_ROUNDS; round++) {
    const forceAnswer =
      forceNextAnswer || spent >= MAX_TOOL_ROUNDS || round === MAX_TOOL_ROUNDS + FREE_NAMING_ROUNDS;
    if (round > 0) {
      args.emit({ type: 'trace', data: `Continuing with search results (round ${round + 1})` });
    }
    /*
     * Content is held back until it identifies itself as the chapter.
     *
     * A model that is about to call a tool narrates the fact first — "Let me
     * search for the relevant characters before writing.", "Now let me coin some
     * names for the neighbouring town." That arrives in the CONTENT channel, so
     * it used to be streamed straight into the chapter column, one sentence per
     * tool round, in the prose font. Thirteen rounds of it read as the chapter
     * having been written by an assistant talking to itself.
     *
     * It cannot be classified as it arrives: the round that finally writes the
     * chapter is usually one where tools were still on offer, so the finish
     * reason is not known until the round ends. Buffering everything until then
     * would cost live streaming entirely.
     *
     * So the buffer opens on evidence instead, and either kind of evidence is
     * enough: the FORMAT heading, which real chapters start with, or simply
     * more text than throat-clearing ever runs to. The first covers compliant
     * models on their first tokens; the second bounds the delay for everyone
     * else at PARTIAL_PROSE_CHARS, which is a sentence or two.
     *
     * A buffer that never opens is narration by definition — the round ended
     * without ever looking like a chapter — and is routed to the reasoning
     * panel below rather than thrown away. The author can still read it; it
     * just stops pretending to be their novel.
     */
    let held = '';
    let flowing = false;
    const openProse = (): void => {
      if (held) args.emit({ type: 'token', data: held });
      held = '';
      flowing = true;
    };

    const result = await streamChat({
      role: 'writer',
      apiKey: args.apiKey,
      model: args.model,
      sampling: args.sampling,
      providerOverride: args.providerOverride,
      messages,
      tools: forceAnswer ? undefined : tools,
      maxTokens: outputBudget(args.novel.chapterLength),
      signal: args.signal,
      onToken: (token) => {
        if (flowing) {
          args.emit({ type: 'token', data: token });
          return;
        }
        held += token;
        if (CHAPTER_OPENING.test(held) || held.length > PARTIAL_PROSE_CHARS) openProse();
      },
      onReasoning: (token) => args.emit({ type: 'reasoning', data: token }),
      onProvider: (provider) => args.emit({ type: 'trace', data: `Routed to ${provider}` }),
    });

    total = addUsage(total, result.usage);
    if (result.usage) {
      const u = result.usage;
      if (u.cachedTokens > 0) {
        const pct = Math.round((100 * u.cachedTokens) / Math.max(u.promptTokens, 1));
        args.emit({
          type: 'trace',
          data: `Reused ${u.cachedTokens.toLocaleString()} cached prompt tokens (${pct}%)`,
        });
      } else if (u.cacheWriteTokens > 0) {
        args.emit({
          type: 'trace',
          data: `Cached ${u.cacheWriteTokens.toLocaleString()} prompt tokens for next time`,
        });
      }
      console.log(
        `[agent] novel=${args.novel.id} ch=${args.chapterNumber} round=${round} ` +
          `prompt=${u.promptTokens} cached=${u.cachedTokens} cache_write=${u.cacheWriteTokens} cost=$${u.cost.toFixed(5)}`
      );
    }

    if (result.finishReason !== 'tool_calls' || result.toolCalls.length === 0) {
      // No tool call came, so whatever is still held was the answer after all —
      // a chapter short enough, or unheaded enough, never to have tripped the
      // gate. It is about to be returned and saved, so the author has to have
      // seen it stream. If it turns out not to be a chapter, the restart below
      // takes it back the same way it always did.
      openProse();
      const cleaned = stripNarratedCall(result.content);
      const problem = notAChapter(cleaned);
      if (!problem) {
        // A chapter that stops mid-sentence is still the author's to keep or
        // regenerate — but they have to be TOLD, or they read it as the model
        // simply writing badly.
        const truncated = result.finishReason === 'length';
        if (truncated) {
          args.emit({
            type: 'trace',
            data: 'The model stopped at its output limit — the chapter is cut off',
          });
        }
        return { content: cleaned, usage: total, truncated };
      }

      // Saving this would put the model's own plumbing in the novel, so it is
      // never the answer. One corrective turn usually is.
      if (forceAnswer) {
        throw new Error(
          `The model ${problem.problem} and did not write the chapter. Try again, or choose a ` +
            `different model — some handle tool use and hidden reasoning poorly.`
        );
      }
      forceNextAnswer = true;
      args.emit({ type: 'trace', data: `The model ${problem.problem} — asking it again` });
      // The client has already been streamed this text token by token, so tell
      // it to throw away what it has before the real chapter starts arriving.
      args.emit({ type: 'restart', data: '' });
      /*
       * The rejected text is NOT echoed back. It is up to 21,000 characters of
       * the model talking to itself, and putting it in the conversation both
       * costs the retry a large prompt and gives the model its own bad answer
       * to anchor on. A short acknowledgement is enough for the turn to be
       * well-formed.
       */
      messages.push({ role: 'assistant', content: '(discarded)' });
      messages.push({ role: 'user', content: problem.correction });
      continue;
    }

    messages.push({
      role: 'assistant',
      content: result.content || null,
      tool_calls: result.toolCalls,
    });

    // Prose written BEFORE a tool call is a fragment, and a dangerous one: the
    // client has already been streamed it token by token, but the value this
    // function returns is the LAST round's content alone, so the fragment would
    // be shown to the author and then silently dropped from what gets saved.
    //
    // Latent until now, because models search before they write. coin_name
    // makes "write nine hundred words, reach the moment something needs a name,
    // call" the ordinary case — so the fragment gets discarded on the client
    // and the model is asked to start the chapter again with the names in hand.
    //
    // `flowing` is the test rather than a length, now that the gate above
    // decides what reaches the client: it is true exactly when something was
    // streamed into the chapter column, which is the only thing a restart has
    // to undo. A round that stayed inside the buffer left the column untouched
    // and needs no restart at all — which is the ordinary case, and used to be
    // a sentence of the model's narration parked in the author's novel.
    const restarting = flowing;
    if (restarting) {
      args.emit({ type: 'trace', data: 'Starting the chapter again with the names in hand' });
      args.emit({ type: 'restart', data: '' });
    } else if (held.trim()) {
      // Narration. It never reached the chapter column, so there is nothing to
      // take back — it just goes where thinking goes.
      args.emit({ type: 'reasoning', data: `${held.trim()}\n\n` });
    }
    held = '';

    let namingOnly = result.toolCalls.length > 0;

    for (const call of result.toolCalls) {
      if (call.function.name !== 'coin_name') namingOnly = false;
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        /* run the tool with empty args; it will say so */
      }

      let output: string;
      switch (call.function.name) {
        case 'search_previous_chapters': {
          const keywords = Array.isArray(parsed.keywords) ? parsed.keywords.map(String) : [];
          // Model-supplied, so clamp it: a large value would paste the whole
          // novel back into the prompt at the user's expense.
          let maxResults = 8;
          if (typeof parsed.max_results === 'number' && Number.isFinite(parsed.max_results)) {
            maxResults = Math.min(Math.max(Math.round(parsed.max_results), 1), 20);
          }
          // Deliberately not logging the keywords themselves — they are derived
          // from the user's story (character names, places, plot points) and are
          // the only narrative content that would otherwise reach our logs.
          console.log(
            `[agent] novel=${args.novel.id} ch=${args.chapterNumber} round=${round} ` +
              `search: ${keywords.length} keyword(s)`
          );
          args.emit({ type: 'tool', data: `Searching previous chapters: ${keywords.join(', ')}` });
          output = formatSearchResults(searchChapters(args.previous, keywords, maxResults));
          break;
        }
        case 'search_story_bible': {
          const terms = Array.isArray(parsed.terms) ? parsed.terms.map(String) : [];
          args.emit({ type: 'tool', data: `Searching the story bible: ${terms.join(', ')}` });
          output = formatBibleSearchResults(searchBibleEntries(bible, terms));
          break;
        }
        case 'get_story_bible_entries': {
          const ids = Array.isArray(parsed.ids) ? parsed.ids.map(String).slice(0, 12) : [];
          const found = bible.filter((e) => ids.includes(e.id));
          args.emit({
            type: 'tool',
            data: `Reading story bible: ${found.map((e) => e.name).join(', ') || ids.join(', ')}`,
          });
          output = found.length
            ? found.map(formatBibleEntry).join('\n\n---\n\n')
            : 'No entries with those ids — check the STORY BIBLE INDEX or search_story_bible.';
          break;
        }
        case 'get_character_design': {
          const names = Array.isArray(parsed.names) ? parsed.names.map(String).slice(0, 6) : [];
          const found = matchDesignsByName(designs, names);
          args.emit({
            type: 'tool',
            data: `Reading character designs: ${found.map((d) => d.name).join(', ') || names.join(', ')}`,
          });
          const resolve = makeTargetResolver(bible, designs);
          output = found.length
            ? found.map((d) => formatDesignSheet(d, resolve)).join('\n\n---\n\n')
            : 'No character designs with those names — check the CHARACTER DESIGNS index.';
          break;
        }
        case 'get_power_system': {
          // Clamp: five full systems is already the whole roster, and each
          // render is prompt cost the author pays for.
          const ids = Array.isArray(parsed.ids) ? parsed.ids.map(String).slice(0, 5) : [];
          const found = findPowerSystems(powerSystems, ids);
          args.emit({
            type: 'tool',
            data: `Reading power system: ${found.map((s) => s.name).join(', ') || ids.join(', ')}`,
          });
          output = found.length
            ? found.map((s) => formatPowerSystem(s, bible)).join('\n\n---\n\n')
            : 'No power systems with those ids — check the POWER SYSTEMS block.';
          break;
        }
        case 'coin_name': {
          const coinArgs = parseCoinArgs(parsed);
          // Never the brief: it is derived from the author's story and is more
          // narrative than the search keywords deliberately kept out of the log
          // above. The client is the author, so the trace may say more.
          console.log(
            `[agent] novel=${args.novel.id} ch=${args.chapterNumber} round=${round} ` +
              `coin: ${coinArgs.kind} x${coinArgs.count}`
          );
          args.emit({ type: 'tool', data: `Coining a name for a new ${coinArgs.kind}` });
          const coined = runCoinName(coinArgs, {
            novelId: args.novel.id,
            charter: args.charter as NamingCharter,
            taken: [...taken],
            nonce: coinCalls++,
          });
          output = coined.text;
          // Everything offered is treated as spent for the rest of this
          // generation. The model may take one; it must not be offered the
          // other five again two paragraphs later for something different.
          for (const name of coined.offered) taken.add(name);
          break;
        }
        default:
          output = `Unknown tool: ${call.function.name}`;
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
    }

    // Only research counts against the budget; see FREE_NAMING_ROUNDS.
    if (!namingOnly) spent++;

    if (restarting) {
      messages.push({
        role: 'user',
        content:
          `That was the start of the chapter, not the chapter. Write CHAPTER ${args.chapterNumber} ` +
          `complete and from the beginning, starting with the "Chapter ${args.chapterNumber}: Title" ` +
          `line, using what you were just given.`,
      });
    }
  }

  // Unreachable: the final round runs without tools and returns above.
  throw new Error('Agent exceeded maximum tool rounds');
}
