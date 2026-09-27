import { currentArc } from '../lib/designValidate.js';
import type {
  BibleEntry,
  Chapter,
  CharacterDesign,
  Novel,
  PowerSystem,
  StoryArc,
} from '../lib/types.js';
import { formatBibleIndex } from './bibleTools.js';
import { cachePolicyFor, MIN_CACHEABLE_TOKENS } from './cache.js';
import { deviceLabel } from './designCatalog.js';
import { formatDesignIndexLine } from './designTools.js';
import type { NamingCharter } from './naming/charter.js';
import { sampleNames } from './naming/generator.js';
import { soundWorld } from './naming/lexicons.js';
import { styleFor } from './styles.js';
import type { ChatMessage, TextPart } from './openrouter.js';

/**
 * Rough token estimate (~4 chars/token). Good enough for budgeting; the exact
 * tokenizer varies per model anyway.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Conservative default budget for prior-chapter context. Most modern models
// have >=128k contexts; we stay well under to leave room for the reply.
const CONTEXT_BUDGET_TOKENS = 60_000;

/**
 * Prompt variant under evaluation, selected by EVAL_PROMPT_VARIANT.
 *
 * Unset — and therefore in production — this changes nothing. It exists so
 * research/eval can run the shipped prompt and a candidate prompt against the
 * same fixtures in one process, and report a paired difference rather than two
 * runs that might differ for any reason.
 *
 * The slot is EMPTY right now, and that is not an oversight: the candidate it
 * used to hold shipped, and its rules moved into craftRules() below. The
 * machinery stays so the next candidate is a one-branch diff.
 *
 * The warning matters more than it looks. An A/B whose two arms are both the
 * shipped prompt runs happily, costs money, and reports a null difference that
 * reads exactly like a candidate having no effect.
 */
const PROMPT_VARIANT = (): string => process.env.EVAL_PROMPT_VARIANT ?? '';

function variantRules(): string[] {
  const variant = PROMPT_VARIANT();
  if (variant) {
    console.warn(
      `[context] EVAL_PROMPT_VARIANT=${variant} is set, but no candidate is defined — ` +
        `both arms will be the shipped prompt.`
    );
  }
  return [];
}

/**
 * Craft rules that every chapter gets, promoted out of the `v2` prompt variant
 * after it was measured (research/eval/README.md, "Optimising the prompt").
 *
 * Every line here is answering a number, not a hunch. The short version:
 *
 *   endings          the reference ends on dialogue 31% of the time and on a
 *                    thematic summation 1.5%; the prompt before this said
 *                    nothing about endings beyond "something must change".
 *                    v2 moved ends-on-dialogue from 50% to 63.6%, 3 of 4 cases.
 *   dose             with the dose left unstated, a grief beat asked for in
 *                    passing ran longer and, in one sample of three, threaded
 *                    across the whole chapter. v2 collapsed dose spread from
 *                    0.19 to 0.02 against a reference 0.23 — the largest single
 *                    effect the A/B measured.
 *   turns            0.95% of generated dialogue turns break off or trail away,
 *                    against 7.7% in the reference: every turn finishes its
 *                    thought. Turn coda fell 4.67% to 2.35%, 3 of 4 cases.
 *   em dashes        8.85 per 1,000 words against the reference's 0.27, checked
 *                    against the raw PDF (0.09) so it is not an extraction
 *                    artefact. The loudest single tell measured; v2 cut the rate
 *                    about a quarter.
 *
 * Two cautions carried over with the text, both load-bearing:
 *
 * The wording is byte-identical to the measured arm. v2 differs from v1 only in
 * having its negations removed and its own long dashes stripped, and that
 * difference is most of why it worked — so "tidying" these lines is a change to
 * a measured artefact, not an edit.
 *
 * Nine metrics improved and three regressed, at n=4 with sampling variance that
 * exceeds most measured effects. This is the best-evidenced prompt available,
 * which is not the same as a certified one.
 */
function craftRules(): string[] {
  return [
    [
      'ENDING:',
      '- End inside the scene, on something happening: a line of speech, an action, a thing noticed.',
      '- Do NOT end on a sentence that explains what the chapter meant, or on a line about how nothing',
      '  would ever be the same. If the last line could be moved to the end of any other chapter, cut it.',
      '- Stop one beat earlier than feels comfortable. Trust the reader to carry the rest.',
    ].join('\n'),
    [
      'PROPORTION. How much room a thing gets:',
      '- Give each element of the instructions the weight the instructions give it. Something mentioned',
      '  in passing stays in passing: a line or two, then the scene moves on.',
      '- A feeling does not need to be developed to count. Touch it once and leave it; do not return to',
      '  it later in the chapter unless you were asked to.',
      '- If the instructions describe an atmosphere, that atmosphere governs the whole chapter. A sad',
      '  note inside a happy scene stays a note; it does not recolour the scene around it.',
    ].join('\n'),
    [
      'SPEECH:',
      '- Let people interrupt each other, talk over each other, and trail off. Not every turn reaches',
      '  its full stop, and a turn that gets cut short is more alive than one that completes neatly.',
      '- Vary turn length hard. One character answering in two words while the other runs on is what a',
      '  real exchange looks like; turns of similar size read as a written debate.',
      '- Do not round a line off. When a character has made their point, stop. No summarising tail, no',
      '  tidy list of what was just said.',
    ].join('\n'),
    // Stated positively and, deliberately, without using the mark it is asking
    // you to avoid. The v1 wording of this rule contained an em dash in the
    // instruction itself, and the em-dash rate went UP.
    [
      'PUNCTUATION: join clauses with a full stop, a comma, or a semicolon. Keep long dashes rare enough',
      'to notice, at most once or twice in a chapter, and only to mark speech being cut off.',
    ].join('\n'),
  ];
}

/**
 * The naming charter, as the writer reads it.
 *
 * It lives in the SYSTEM prompt rather than the per-chapter instruction, and
 * that is not an oversight about the cache-breakpoint rule below. The charter
 * varies per author edit, not per chapter — exactly the class `premise` and
 * `styleNotes` are in, both of which already sit in the cached prefix. Editing
 * it invalidates that prefix once, the same way editing the premise does, and
 * every chapter afterwards reads it for free.
 *
 * Two decisions worth defending:
 *
 * The three sample names per culture are GENERATED, deterministically, from the
 * novel id. Showing the register beats describing it, and seeding off the novel
 * keeps the block byte-identical across every chapter of that novel — which is
 * the only reason it can live in a cache prefix at all.
 *
 * There is no list of banned names here, and there deliberately never will be.
 * The FORMAT note below records that enumerating unwanted behaviours in this
 * prompt PRIMED them. "Never write Elara" puts Elara in the context window. The
 * cliché list is a rejection filter in engine/naming/blocklist.ts, applied to
 * candidates before the model ever sees them, and the model is never told it
 * exists.
 */
function buildNamingBlock(novel: Novel, charter: NamingCharter): string {
  const lines = [
    'NAMES:',
    '- Every proper noun this novel has not used yet comes from coin_name. Before you name a person, place, faction, item, weapon, creature, technique or event for the first time, call it and choose from what it gives you. Blend two of its candidates if you like. Do not write a name it did not offer.',
    '- Names the story has already established stay exactly as they are. coin_name is only for what has no name yet.',
  ];

  const describe = (cultureId: string, soundWorldId: string): string => {
    const world = soundWorld(soundWorldId);
    const samples = sampleNames(novel.id, cultureId, soundWorldId, charter.pack);
    return `${world.blurb} Names in it run like ${samples.join(', ')}.`;
  };

  if (charter.cultures.length === 1) {
    const only = charter.cultures[0];
    lines.push(`- The sound of this world: ${describe(only.id, only.soundWorldId)}`);
  } else {
    lines.push('- The peoples of this world do not sound alike:');
    for (const culture of charter.cultures) {
      const scope = culture.appliesTo.trim() ? ` (${culture.appliesTo.trim()})` : '';
      lines.push(`  · ${culture.label}${scope} — ${describe(culture.id, culture.soundWorldId)}`);
    }
  }

  if (charter.notes.trim()) lines.push(`- The author's naming rules: ${charter.notes.trim()}`);

  return lines.join('\n');
}

/**
 * Stable across every chapter of a novel — deliberately free of the current
 * chapter number so that system + chapter history form one long reusable
 * cache prefix for the whole novel.
 */
export function buildSystemPrompt(novel: Novel, charter?: NamingCharter | null): string {
  const style = styleFor(novel.style);

  const parts: string[] = [
    // Role first, in plain terms. The old prompt asked for "immersive,
    // engaging prose", which is the kind of instruction that produces
    // overwritten, over-literary output. Concrete rules work better.
    'You are writing a web novel for the user, one part at a time. You are the author, not an assistant. Output the story text only — no preamble, notes, or commentary.',

    // Only genuinely style-neutral craft belongs here. Anything about word
    // choice, sentence length or how much interiority to write lives in the
    // style block instead — putting "keep it plain and short" here would
    // contradict the Literary and Mythic registers.
    [
      'ALWAYS:',
      '- Dramatise scenes rather than summarising them. The reader should be present for what matters.',
      '- Be specific. Cut anything that could be said of any story.',
      // "Recognisable without attribution", which this line used to ask for, is
      // a request for MARKED speech: a line characteristic enough to identify
      // its speaker alone. The cheapest way to satisfy that is to give everyone
      // a quotable register, which is how a blacksmith and a twelve-year-old end
      // up trading epigrams. Distinguishing by content costs the model more and
      // is the thing actually wanted. See research/eval/GRAVITY.md.
      '- Distinguish characters by what they care about, what they notice, and how much they say, rather than by how quotable their lines are.',
      '- Avoid clichés and stock phrasing.',
      '- Do not repeat a beat the reader has already been given.',
      '- Something must change by the end. Never mark time.',
    ].join('\n'),

    style.prompt,

    `TITLE: ${novel.title}`,
  ];

  if (novel.premise.trim()) parts.push(`PREMISE:\n${novel.premise.trim()}`);
  if (novel.styleNotes.trim()) {
    parts.push(`AUTHOR'S NOTES (these override the style rules above):\n${novel.styleNotes.trim()}`);
  }
  if (novel.chapterLength > 0) {
    // Worded to avoid "chapter <number>" — the system prompt is the shared
    // cache prefix for every chapter of the novel and must stay identical.
    parts.push(
      `LENGTH: aim for roughly ${novel.chapterLength} words per part. Let a scene breathe rather than padding or cutting it to hit the number exactly.`
    );
  }

  parts.push(
    [
      'CONSISTENCY:',
      '- Never contradict what earlier parts established: names, appearances, personalities, timeline, world rules, or open plot threads.',
      '- If the instructions point at a character, event, or detail you are not certain about, call search_previous_chapters and look it up before writing. Search rather than guess.',
    ].join('\n')
  );

  const naming = charter ? buildNamingBlock(novel, charter) : '';
  if (naming) parts.push(naming);

  if (novel.proseProfile?.genre) parts.push(`GENRE AND REGISTER: ${novel.proseProfile.genre}`);
  if (novel.proseProfile?.voiceSample) parts.push(`AUTHOR'S VOICE SAMPLE (match its register and rhythm, without copying its events):\n${novel.proseProfile.voiceSample}`);
  parts.push(...craftRules());

  /*
   * PEOPLE — the one block here with no measurement behind it yet.
   *
   * It answers two reported failures the harness cannot currently see, both
   * written up in research/eval/GRAVITY.md:
   *
   *   a character meeting the protagonist for the first time spoke about their
   *   history and their ambition, neither of which anyone had told them; and
   *
   *   a supporting character's turn existed to certify the protagonist ("the
   *   first honest thing anyone's said to me today") rather than to want
   *   anything of their own.
   *
   * Stated positively, and that is deliberate rather than stylistic. The FORMAT
   * note below records the finding these lines are shaped around: naming an
   * unwanted behaviour in this prompt in order to forbid it has been measured to
   * PRIME it. So neither line says what not to write, and the second describes
   * where esteem belongs rather than banning praise.
   *
   * Being unmeasured, this is the block to pull first if the next A/B comes back
   * worse — the craft rules above have numbers, and this does not.
   */
  parts.push(
    [
      'PEOPLE:',
      '- Characters speak from what they know of each other. Every fact one character shows they know about another has to have reached them on the page.',
      '- Fetch participating characters with get_story_bible_entries and inspect their knowledge records. World truth is not shared knowledge. Beliefs may be wrong; unaware means the character has not learned the fact; secrets remain private until the scene actually reveals them. Missing records are uncertainty, never proof of knowledge.',
      '- Everyone in a scene wants something of their own. What one person thinks of another shows in how they treat them, not in an assessment delivered aloud.',
    ].join('\n')
  );

  parts.push(...variantRules());

  // The FORMAT line goes last so it is the final thing read before writing
  // starts. The v1 wording is longer than a format note deserves because the
  // shipped one was not enough: models opened with a sentence about being ready
  // to write, then emitted the heading in markdown bold, and the product's title
  // regex takes neither.
  // The shipped FORMAT line is kept verbatim in every variant, and that is a
  // finding rather than an omission.
  //
  // v1 replaced it with an exhaustive one: a list of everything not to put
  // first, naming each unwanted behaviour to rule it out. Measured against the
  // shipped line on the same fixtures, preamble rose from 0 to 30.5 words per
  // chapter and the product's title regex went from parsing 44% of chapters to
  // parsing none. Enumerating the failures appears to prime them; the terse
  // positive instruction outperforms the careful negative one.
  parts.push(
    'FORMAT: First line is exactly "Chapter N: Title", where N is the number you are given. Then the prose. Nothing else.'
  );

  return parts.join('\n\n');
}

/**
 * Render each previous chapter as its own block, compacting like a coding
 * agent: full text while under budget; once over, the OLDEST chapters fall
 * back to the summaries stored at accept time.
 *
 * One block per chapter matters for prompt caching: chapter history is
 * append-only, so blocks 1..N-1 stay byte-identical when chapter N is added
 * and the provider can reuse the cached prefix instead of re-reading the
 * whole novel. (Crossing the compaction budget rewrites the block that gets
 * demoted to a summary and invalidates the cache from that point once — the
 * next request re-establishes it.)
 */
export function buildPreviousChapterBlocks(previous: Chapter[]): string[] {
  if (previous.length === 0) return [];

  // Walk newest-first, spending budget on full text; older chapters that
  // don't fit fall back to their summaries.
  let budget = CONTEXT_BUDGET_TOKENS;
  const fullSet = new Set<number>();
  for (let i = previous.length - 1; i >= 0; i--) {
    const cost = estimateTokens(previous[i].content);
    if (cost <= budget) {
      budget -= cost;
      fullSet.add(previous[i].number);
    } else {
      break; // everything older than the first non-fitting chapter gets summarized
    }
  }

  return previous.map((c) => {
    const header = `=== Chapter ${c.number}${c.title ? `: ${c.title}` : ''} ===`;
    if (fullSet.has(c.number)) return `${header}\n${c.content}`;
    const summary = c.summary.trim() || c.content.slice(0, 2000);
    return `${header}\n[SUMMARY — full text available via search_previous_chapters]\n${summary}`;
  });
}

/** Kept for callers that just want the flat text (smoke tests, debugging). */
export function buildPreviousChaptersBlock(previous: Chapter[]): string {
  return buildPreviousChapterBlocks(previous).join('\n\n');
}

/**
 * At most this many steered arcs get their own instruction line. Beyond it,
 * the extra designs stay in the index and reachable by tool — a prompt full of
 * competing arcs steers nothing, and every line is paid for on every chapter.
 */
const MAX_STEERED_DESIGNS = 5;

/**
 * The character-design block: an index so the tool is discoverable, plus steer
 * lines for the arcs the author has switched on.
 *
 * The framing around those lines is the careful part. An arc handed to a
 * writer without it reads as this chapter's assignment, and the chapter bends
 * itself to deliver a beat the story had no room for. So the rules say the
 * opposite out loud: advance only on a natural opening, advancing nothing is a
 * valid outcome, and the arc yields to the instructions and to canon rather
 * than the other way round.
 */
/**
 * The arc steer block — the most restrained thing in this file, deliberately.
 *
 * A plan handed to a writer reads as an instruction sheet, and the writer
 * starts delivering chapter 40's reveal in chapter 30 "as setup". So this
 * block does NOT list a single upcoming beat: it says where the story stands
 * in the arc and nothing about where it goes. A beat the writer cannot see is
 * a beat it cannot leak, which is the whole mechanism — the wording below is
 * a second line of defence, not the first.
 *
 * Even subtler than the character-design nudge, on purpose. That one names a
 * stage and a direction to lean; this one names neither.
 *
 * Validated in research/arcplan/leak.eval.ts: the same chapter written with
 * and without this block carried the same number of future-plan words, and
 * read side by side the UNSTEERED draft was the more forward-leaning one.
 */
export function buildArcBlock(arc: StoryArc | null, chapterNumber: number): string {
  if (!arc || !arc.steer) return '';
  const span = Math.max(1, arc.toChapter - arc.fromChapter);
  const through = Math.round(((chapterNumber - arc.fromChapter) / span) * 100);
  const shape = arc.premise.trim().split(/\n+/)[0]?.slice(0, 300) ?? '';

  return [
    '',
    '',
    'STORY ARC — context, not an assignment.',
    `This chapter sits about ${clampPercent(through)}% of the way through "${arc.title}" (chapters ${arc.fromChapter}–${arc.toChapter}).`,
    ...(shape ? [`The arc is broadly about: ${shape}`] : []),
    'Rules:',
    '- Write ONLY this chapter. You have not been told what later chapters contain, and you must',
    '  not invent, hint at, or reach for them.',
    '- Do not plant objects, names, or lines of dialogue in order to set something up later. If a',
    '  detail is not doing work in THIS chapter, leave it out.',
    '- Foreshadowing is allowed only where the scene already gives you a reason for it — a mood, a',
    '  thing a character would notice anyway. Never a nod to the reader.',
    '- Advancing the arc is not required. A chapter that only does what its instructions say is a',
    '  success. The arc bends to the story and to the instructions, never the other way round.',
  ].join('\n');
}

const clampPercent = (n: number) => Math.min(100, Math.max(0, n));

export function buildDesignBlock(designs: CharacterDesign[], bibleEntries: BibleEntry[]): string {
  if (designs.length === 0) return '';

  // Sorted by name so the instruction is byte-stable across the agent's tool
  // rounds, which re-send the whole conversation each time.
  const sorted = [...designs].sort((a, b) => a.name.localeCompare(b.name));
  const byId = new Map(bibleEntries.map((e) => [e.id, e]));

  const index = sorted
    .map((d) => formatDesignIndexLine(d, d.linkedEntryId ? byId.get(d.linkedEntryId) : null))
    .join('\n');

  const steered = sorted.filter((d) => d.steer && currentArc(d));
  const shown = [...steered]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_STEERED_DESIGNS)
    .sort((a, b) => a.name.localeCompare(b.name));
  const omitted = steered.length - shown.length;

  const block = [
    '',
    '',
    'CHARACTER DESIGNS (author-prepared sheets — fetch with get_character_design before writing a scene that features one):',
    index,
  ];

  if (shown.length > 0) {
    const lines = shown.map((d) => {
      const arc = currentArc(d)!;
      const stage = `stage ${arc.currentStage + 1}/${arc.stages.length} "${arc.stages[arc.currentStage] ?? ''}"`;
      const nudge = arc.nudge ? `. Nudge: ${arc.nudge}` : '';
      return `- ${d.name} — ${deviceLabel(arc.device, arc.customLabel)}, ${stage}${nudge}`;
    });

    block.push(
      '',
      'ARC STEERING — read carefully.',
      'The author is steering these characters along planned arcs. An arc is a long-horizon',
      'trajectory across many chapters, not this chapter\'s agenda:',
      ...lines,
      ...(omitted > 0
        ? [`(${omitted} more steered ${omitted === 1 ? 'design' : 'designs'} — fetch with get_character_design.)`]
        : []),
      'Rules:',
      '- Advance an arc only when this chapter\'s events offer a natural opening. A small, true',
      '  beat is worth more than a forced leap; advancing nothing is a valid outcome.',
      '- Never bend events, dialogue, or other characters to serve an arc. If the chapter',
      '  instructions or established canon conflict with an arc, they win — the arc bends, not',
      '  the story.',
      '- Never state, narrate, or foreshadow an arc\'s destination, a character\'s unrevealed',
      '  secrets, or the author\'s future intents. Let them surface only through behaviour a',
      '  reader could plausibly reinterpret later.'
    );
  }

  return block.join('\n');
}

/** Rank summaries shown per system before the block defers to the tool. */
const MAX_POWER_DETAIL_RANKS = 6;

/**
 * The power systems as the writer sees them: a compact index, not the whole
 * document. A maxed system is tens of kilobytes and must never ride in the
 * instruction — the ladder and a line per rank are enough to keep prose
 * inside the rules, and get_power_system holds the rest (the bible's
 * index/get split).
 *
 * Byte-identical for a given set of systems whatever order they arrive in —
 * the instruction's cache breakpoint survives the agent's tool rounds only
 * if this string does not wobble. Sorted by id; inner lists in stored order.
 */
export function buildPowerBlock(systems: PowerSystem[]): string {
  if (systems.length === 0) return '';

  const lines: string[] = ['\n\nPOWER SYSTEMS — the ladders this world runs on:'];
  for (const s of [...systems].sort((a, b) => a.id.localeCompare(b.id))) {
    const ladder =
      s.ranks.length > 0
        ? `${s.ranks.map((r) => r.name).join(' → ')} (${s.ranks.length} ranks, weakest first)`
        : 'no ranks defined yet';
    lines.push(`${s.name} (${s.id}) — ${ladder}`);
    if (s.energyName) lines.push(`  energy: ${s.energyName}`);
    if (s.costsAndLimits) lines.push(`  cost: ${s.costsAndLimits}`);
    for (const rank of s.ranks.slice(0, MAX_POWER_DETAIL_RANKS)) {
      const capabilities = rank.capabilities.length
        ? rank.capabilities.join('; ')
        : rank.summary || '(no detail recorded)';
      lines.push(`  - ${rank.name}: ${capabilities}`);
    }
    if (s.ranks.length > MAX_POWER_DETAIL_RANKS) {
      lines.push(
        `  (${s.ranks.length - MAX_POWER_DETAIL_RANKS} more ranks — read them with get_power_system.)`
      );
    }
  }
  lines.push(
    'These ladders are canon. A character acts within their rank’s capabilities; what a rank ' +
      'cannot do is as binding as what it can. Nothing here is an assignment — a chapter that ' +
      'advances nobody is a success. Before writing a breakthrough, a cross-rank fight, or the ' +
      'limits of a technique, fetch the system with get_power_system.'
  );
  return lines.join('\n');
}

export function buildGenerationMessages(args: {
  novel: Novel;
  chapterNumber: number;
  previous: Chapter[];
  userPrompt: string;
  model: string;
  /** Present when revising an existing draft. */
  currentDraft?: string;
  revisionNotes?: string;
  /** Story bible entries; the index rides in the instruction message. */
  bibleEntries?: BibleEntry[];
  /** Power systems; a compact block rides beside the bible index. */
  powerSystems?: PowerSystem[];
  /** Active character designs; index + steer lines ride in the same place. */
  designs?: CharacterDesign[];
  /** The arc owning this chapter, when the author has switched steering on. */
  arc?: StoryArc | null;
  /** The naming charter; null when the author has naming switched off. */
  charter?: NamingCharter | null;
}): ChatMessage[] {
  const policy = cachePolicyFor(args.model);
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(args.novel, args.charter) },
  ];

  const blocks = buildPreviousChapterBlocks(args.previous);
  if (blocks.length > 0) {
    const historyTokens = blocks.reduce((sum, b) => sum + estimateTokens(b), 0);
    const worthCaching = policy.explicit && historyTokens >= MIN_CACHEABLE_TOKENS;

    const parts: TextPart[] = [
      { type: 'text', text: 'Here are the previous chapters of the novel for context:' },
      ...blocks.map((text): TextPart => ({ type: 'text', text })),
    ];

    if (worthCaching) {
      // Breakpoint on the last block caches the whole history. A second one on
      // the block before it guarantees the *previous* chapter's cached prefix
      // is still addressable once a new chapter is appended, even for novels
      // longer than the provider's automatic prefix lookback.
      const marker = { type: 'ephemeral' as const, ...(policy.ttl ? { ttl: policy.ttl } : {}) };
      parts[parts.length - 1].cache_control = marker;
      if (parts.length > 2) parts[parts.length - 2].cache_control = marker;
    }

    messages.push({ role: 'user', content: parts });
    messages.push({
      role: 'assistant',
      content:
        'Understood. I have the previous chapters in mind and will search them for any detail I am unsure about.',
    });
  }

  // The bible index changes after every accept, so it must ride HERE — in the
  // per-chapter instruction, after the cache breakpoints — and never in the
  // system prompt or history, where it would invalidate the novel's whole
  // cached prefix each chapter. Character designs change even more often
  // (every author edit), so they ride in the same place for the same reason.
  const bibleIndex =
    args.bibleEntries && args.bibleEntries.length > 0
      ? `\n\nSTORY BIBLE INDEX (fetch entries with get_story_bible_entries before writing scenes that involve them):\n${formatBibleIndex(args.bibleEntries)}`
      : '';

  // Between the bible index and the designs — the ordering design.invariant.ts
  // asserts (bible index before designs) stays true with the block between.
  const powerBlock = buildPowerBlock(args.powerSystems ?? []);
  const designBlock = buildDesignBlock(args.designs ?? [], args.bibleEntries ?? []);
  const arcBlock = buildArcBlock(args.arc ?? null, args.chapterNumber);

  const instruction =
    (args.currentDraft && args.revisionNotes
      ? `You are now writing CHAPTER ${args.chapterNumber}.\n\nHere is the current draft:\n\n${args.currentDraft}\n\n` +
        `Original instructions for this chapter:\n${args.userPrompt}\n\n` +
        `Revise the draft according to these notes, and output the complete revised chapter:\n${args.revisionNotes}`
      : `You are now writing CHAPTER ${args.chapterNumber}. Instructions:\n${args.userPrompt}`) +
    bibleIndex +
    powerBlock +
    designBlock +
    arcBlock;

  // A breakpoint here keeps the instruction (and, when revising, the full
  // draft) cached across the agent's tool-call rounds, which re-send the
  // entire conversation each round.
  if (policy.explicit && estimateTokens(instruction) >= MIN_CACHEABLE_TOKENS) {
    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: instruction,
          cache_control: { type: 'ephemeral', ...(policy.ttl ? { ttl: policy.ttl } : {}) },
        },
      ],
    });
  } else {
    messages.push({ role: 'user', content: instruction });
  }

  return messages;
}

export function buildSummaryMessages(novel: Novel, chapter: Chapter): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        "You summarize novel chapters for an author's story bible. Capture plot events, character developments, introductions/deaths, revealed information, and unresolved threads. Be factual and dense. Around 150 words. Output only the summary.",
    },
    {
      role: 'user',
      content: `Novel: ${novel.title}\n\nChapter ${chapter.number}${chapter.title ? `: ${chapter.title}` : ''}\n\n${chapter.content}`,
    },
  ];
}
