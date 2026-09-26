/**
 * Arc planning: the batch planner.
 *
 * Two prompts and no tools. Unlike the bible and design agents this one writes
 * nothing itself — the route persists what the parser yields — so there is no
 * tool contract to get wrong and nothing it says can change the novel.
 *
 * The design decisions here were all settled by research/arcplan, and the
 * reasons are worth keeping close to the code:
 *
 *  - **Not Flash.** Every other background agent in this app runs on
 *    deepseek-v4-flash. This one does not, and it is the only exception.
 *    Asked for blueprints dense enough to write a 500–2000 word chapter from,
 *    Flash staffs the story with invented people — across three spike runs it
 *    produced named characters every time, one of them recurring 52 times.
 *    Sharpening the rule made it worse, which is what a capability limit looks
 *    like. Luna plans fifty chapters with none.
 *  - **Three movements, not a summary.** A single free-text field reliably
 *    produces one beat dressed as a chapter, which hands the author back the
 *    hardest part of the job. opens/turn/lands is the same shape suggestAgent
 *    arrived at, for the same reason: a ceiling on size needs a floor beside it.
 *  - **Ten at a time, streamed one at a time.** See arcParse.ts.
 */
import { ARC_LIMITS, authorPremiseText, validateTags } from '../lib/arcValidate.js';
import { stageOk, stagePartial, type RefineOutput } from '../lib/arcStages.js';
import {
  ARC_TAGS,
  type ArcBeat,
  type ArcNameFlag,
  type ArcSource,
  type ArcThread,
  type ArcTimeline,
  type BibleEntry,
  type Chapter,
  type CharacterDesign,
  type Novel,
  type StoryArc,
  type ThreadAnchor,
} from '../lib/types.js';
import { formatBibleIndex } from './bibleTools.js';
import { formatDesignIndexLine } from './designTools.js';
import { BlueprintStream, findNewNames, newNamesInText, readBookkeeping, type BlueprintIssue } from './arcParse.js';
import { formatBraidBrief, formatThreadRoster, validateBraid } from './arcBraid.js';
import { streamChat, type ChatMessage, type Usage } from './openrouter.js';
import type { ChapterBlueprint } from '../lib/types.js';

/**
 * Refine and AI edit. Both are single short answers into a forced tool call
 * where judgement about the author's own words is the whole job, and luna is
 * the model that does not flatten them. See the note above;
 * research/arcplan/README.md has the numbers.
 */
export const ARC_MODEL = 'openai/gpt-5.6-luna';

/**
 * The batch planner, which is a different job from refine and now a different
 * model.
 *
 * The original note above still stands — Flash-class models invent names when
 * asked for dense blueprints — but two things changed under it. The generation
 * that could not hold the rule is not this one, and the rule is no longer only
 * asked for: `findNewNames` flags every proper noun a blueprint invents, and
 * the cast pass makes the author confirm each one before it reaches the plan.
 * A slip is now visible and correctable rather than silent, which is what made
 * the expensive model load-bearing.
 *
 * What the planner actually needs is length under a rigid format: ten blocks,
 * fifteen labelled fields, ascending, no commentary — held across 12k tokens
 * without drifting. Gemini Flash is built for exactly that, and it is roughly
 * an order of magnitude cheaper per batch, which matters for the one call in
 * this app an author makes fifty times.
 */
export const PLAN_MODEL = 'google/gemini-3.7-flash';

/** Summaries of recent chapters that ride along as the run-up. */
const RUN_UP = 8;

/** Attempts refine gets to answer without inventing a name. */
const REFINE_ROUNDS = 3;

/**
 * A forced tool call that ran out of room comes back as truncated JSON, which
 * parses as gibberish — so "returned something unreadable" was technically true
 * and told the author nothing they could act on. Name the real cause.
 */
function toolCallFailed(what: string, finishReason: string | null): Error {
  return new Error(
    finishReason === 'length'
      ? `The ${what} hit its output limit before it finished. Try a shorter instruction, or split this into two edits.`
      : `The ${what} returned something unreadable. Try again.`
  );
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

export const BLUEPRINT_SYSTEM_PROMPT = [
  'You plan a web novel arc chapter by chapter. You are not writing prose. You are writing the',
  'author a working blueprint: what each chapter DOES to the story.',
  '',
  'FORMAT — exactly this, nothing before it and nothing after it:',
  '',
  '### CH <number>',
  'title: <4 words or fewer>',
  'tags: <1 to 3, comma separated, from the list below>',
  'opens: <where the chapter starts and what situation it puts on the page>',
  'turn: <what happens in the middle that changes it — the events, concretely>',
  'lands: <what is different by the end, and what it costs or opens>',
  'who: <everyone and everywhere this chapter uses, comma separated>',
  'context: <what the writer must know that must NOT reach the page — or "none">',
  '',
  'Repeat that block for every chapter you were asked for, in ascending order, with no gaps: if you',
  'were asked for chapters 21 to 30 there are exactly ten blocks and the numbers run 21, 22, 23 …',
  '30. No preamble, no commentary between blocks, no closing note, no summary of what you did.',
  '',
  'Write the labels in plain lowercase followed by a colon, exactly as shown. Do not bold them, do',
  'not bullet them, do not put a horizontal rule between blocks, and do not restate the title on',
  'the ### line. Each label starts a new line and everything after the colon is that field.',
  '',
  'ALL THREE of opens, turn and lands are required on EVERY block. Do not merge them, do not drop',
  'them, and do not carry the whole chapter in `opens`. Three labelled movements is the format.',
  'Each of the three is 2 to 4 full sentences. One sentence is a note, not a movement.',
  '',
  'WHO — the people and places the chapter actually uses, comma separated, in the SAME words you',
  'used for them in opens/turn/lands. "the sister, the brother, a bully at his school, the workshop".',
  'Write each one the same way every time it appears, in this chapter and in the others: "the team',
  'lead" in all ten blocks is one person the author can name in a single decision, while "the team',
  'lead" here and "his manager" there is two people who will get two different names.',
  'Anyone the story bible already has goes in by their real name. Everyone else stays a role.',
  '',
  'CONTEXT — what the WRITER of this chapter needs to know that the READER must not be given yet.',
  'The writer of one chapter sees that chapter and nothing else, so a thing you are planning to pay',
  'off later has to be told to them here or it will not be set up — and told to them as something to',
  'keep OFF the page, or they will spend it early. Put here: what someone is really after, what a',
  'later chapter will turn on, why a detail that looks small is not. Write "none" when a chapter',
  'genuinely has nothing held back, which is common and completely fine. Never invent a secret to',
  'fill this in — a made-up one becomes real the moment the author reads it.',
  'ONE EXCEPTION, and it overrides the "none" above: when the arc has more than one storyline,',
  '`context` always opens with two short bookkeeping lines before anything else —',
  '  Threads: <every storyline this chapter carries, named in the author\'s own words, each with',
  '  its number in brackets, comma separated. One, two or three. Never more than three.>',
  '  Day: <a whole number of days since the arc opened, then an em dash, then the phrase a reader',
  '  would feel — "Day: 47 — a week after ch 34". The number is the important half: it is how the',
  '  book knows two threads have not quietly drifted three months apart. Estimate it; never omit',
  '  it.>',
  'Write them as the first two sentences of `context`, each ending in a full stop, exactly one per',
  'line. Example:',
  '  context: Threads: the Refsdal feud (2), the audit (5). Day: 47 — the same fortnight as ch 34,',
  '  seen from the audit side. The kickbacks are already in the file, but nobody has read that far.',
  'Those two are for the writer and must never reach the page, which is exactly why they live here.',
  '',
  'Plan every chapter you were asked for. If you find yourself running short of material, that is a',
  'signal to slow the arc down and let a chapter be small — not to stop early or to merge two',
  'chapters into one block.',
  '',
  `TAGS — use ONLY these words, exactly as spelled here: ${ARC_TAGS.join(', ')}`,
  'A tag outside that list is discarded, so a chapter tagged only with invented words ends up with',
  'no tags at all.',
  'Pick the tag that is most DISTINCTIVE of the chapter, not the most defensible. Almost every',
  'chapter of a novel could be tagged "drama"; that makes it a useless tag. If two chapters in a',
  'row would carry the same tag, one of them is mistagged or the two are the same chapter.',
  '',
  'SIZE — the mistake to avoid above all others:',
  'Each blueprint has to be enough for a chapter of 500 to 2000 words. Three fields is not a',
  'formality: it is the floor. A blueprint like "She tells him she is glad he did not burn the',
  'ledger. He offers her the deed. She refuses it." is ONE beat — it would be over in 150 words',
  'and it hands the author back the hard part.',
  'Enough for a chapter means roughly: a situation with something already in motion, two or three',
  'concrete events, at least one exchange or decision that goes differently than expected, and a',
  'changed position at the end. Name the things that happen. Do not name the theme.',
  '',
  'WHERE THE EXTRA MATERIAL COMES FROM — read this twice:',
  'Filling three movements does NOT mean inventing people to fill them with. Everything comes from',
  'the cast and places already in the story bible, or from UNNAMED roles: "a dock clerk", "the',
  'assayer", "the woman who keeps the ledgers". Those are free, and you should use them.',
  'You may not give any of them a name. A new proper noun — a new character, town, sect or house —',
  'is the worst thing you can put in this plan, because the author now has a person in their novel',
  'that they never invented and their story bible has never heard of. The author names them later,',
  'in one pass over the finished plan, and an unnamed role is what lets that work. Write "the team',
  'lead" every time and it stays one person; invent "Mara" and you have decided something that was',
  "not yours to decide. If a chapter needs a person the story does not have, that person is a role.",
  '',
  'WHAT MAKES A CHAPTER BLUEPRINT GOOD:',
  '- It advances its thread through several events — or weaves two, when they have met. Either',
  '  way: few threads, many beats. Never one beat dressed as a chapter.',
  '- It says what CHANGES. "Rennick investigates the ledger" is a topic; "Rennick reads the first',
  '  page, recognises his own city\'s debt, and re-seals it before the clerk returns" is a chapter.',
  '- Consecutive chapters must not be the same beat twice. Vary what the chapter is FOR: pressure,',
  '  discovery, cost, quiet, reversal.',
  '- Some chapters should be small. A fifty-chapter arc of escalation is exhausting and false.',
  '  Small still means several things happening — it is the stakes that drop, not the content.',
  '',
  'STORYLINES — an arc is usually several at once, and they DO NOT TAKE TURNS:',
  'The author\'s description of the arc may be one story, or it may be a numbered list of a dozen.',
  'When it is a list, those are THREADS RUNNING IN PARALLEL across the same span of time. The',
  'numbering is how the author grouped them. It is NOT chronology, and it is not a running order.',
  'Authors say this outright — "all of this happens over the next eight months and not in this',
  'order" — and they mean it. An arc that opens with a list of ten storylines is one arc with ten',
  'threads in it, never ten little arcs to plan back to back.',
  '',
  'BEFORE YOU WRITE A SINGLE BLOCK, work each thread out. Do not print this — just do it:',
  '- WHERE IT STARTS. Some threads are already running when the arc opens. Some begin halfway in.',
  '- WHAT ANCHORS IT IN TIME. "early in the arc", "by the middle", "in the back half", "at the very',
  '  end", "in the eighth month" are the author scheduling their own book. Honour them exactly.',
  '  They outrank your instinct about pacing, and they outrank the order the threads were listed.',
  '- HOW MUCH ROOM IT NEEDS. A thread that is one domestic scene is not the size of a thread that',
  '  is eight months of company politics. Give each the number of chapters it actually needs, and',
  '  do not pad a small thread out to match a large one.',
  '- WHAT IT WAITS ON. Threads cause each other. When the author says one thread only resolves',
  '  BECAUSE another one succeeded, the cause has to be on the page in an EARLIER chapter than the',
  '  effect. Putting an effect before its cause is the worst failure a braided plan can have —',
  '  worse than bad pacing, because it cannot be fixed by moving one chapter.',
  '- WHERE IT ENDS, OR WHETHER IT ENDS AT ALL. Some threads close inside the arc. Some are left',
  '  open deliberately — "nothing is released yet", "they are still unresolved at the end", "we',
  '  only get a glimpse of this, it pays off in the next arc". LEAVE THOSE OPEN. Do not tidy a',
  '  thread the author told you to leave hanging, and never resolve a thread that was planted as',
  '  the next arc\'s problem: one or two chapters of glimpse, no resolution.',
  '',
  'THEN WEAVE THEM — DO NOT ALTERNATE. A chapter carries one thread, or two, or three:',
  '- Most chapters are ONE thread, through several events. That is the default and it is fine.',
  '- Roughly a third carry an A-PLOT and a B-THREAD RUNNER: the chapter belongs to one storyline,',
  '  and a second one moves half a step in the margins of it — a phone call taken in a corridor, a',
  '  letter that arrives while something else is happening, a person from thread 5 seen across a',
  '  room in thread 2. The runner does not need a scene. It needs to still be alive.',
  '- A COLLISION CHAPTER carries two or three threads at full weight, because they have actually',
  '  met. These are what a braided arc is built out of. Name every thread on the Threads: line,',
  '  and pace the threads so they ARRIVE at those chapters together, instead of one finishing and',
  '  idling for fifteen chapters waiting for the other.',
  '- Never more than three. Four threads in one chapter is a summary of the arc, not a chapter.',
  '- NEVER plan thread 1 for ten chapters and then thread 2 for the next ten. That is a stack of',
  '  summaries, not an arc. Rotate.',
  '- A thread left dark for more than about four chapters reads as dropped. Come back to it, even',
  '  as a runner in the margin of somebody else\'s chapter.',
  '- The threads carrying the arc recur most often. A one-scene thread gets its one or two',
  '  chapters, placed where its anchor says it goes, and is then done.',
  '- Put a small or domestic chapter after a heavy one. The rotation IS the pacing — a braided arc',
  '  gets its rhythm from what you cut to, not from escalating every chapter.',
  '',
  'TIME IS SHARED, AND EVERY THREAD IS ON THE SAME CLOCK:',
  'You are told the arc\'s span in days and where each thread\'s clock was last left. Every chapter',
  'says what day it sits on, on its `Day:` line. Cutting from one thread to another often moves',
  'SIDEWAYS in time — the same week seen from somewhere else — and that is correct and normal:',
  'give it the same day number, or an earlier one. What is never correct is a thread\'s OWN next',
  'chapter landing on an earlier day than its last, or one thread quietly skipping three months',
  'while the thread beside it covered three days. Keep every thread\'s clock within about six',
  'weeks of the others across the batch.',
  'NEWS TRAVELS AT HUMAN SPEED. Something that happens on day 40 in one thread cannot be known in',
  'another thread\'s day-40 chapter unless a person carried it there. Either show it arriving, a',
  'day or more later, or leave the delay in.',
  '',
  'THE BATCH IS ONE STRETCH OF A STORY, not ten chapters that happen to be numbered in order.',
  'Each chapter starts from the position ITS OWN THREAD was last left in — which is usually not the',
  'previous chapter — and something a chapter sets up should be paid off by a later one rather than',
  'left hanging. Read the beats you were given as the spine: they are the author\'s intentions and',
  'they are canon. Spread them across the chapters you were asked for, keeping the threads braided',
  '— do not spend the whole batch on the first three blocks\' worth of material, and do not leave a',
  'beat for a batch that may never be planned.',
  '',
  'NEVER:',
  '- Never plan a chapter that is already written. You are told which those are.',
  '- Never resolve the arc before its last chapters, and never resolve the same thing twice.',
  '- Never plan the storylines one after another, in the order the author happened to list them.',
  '- Never resolve a thread the author said stays open, or one planted for the next arc.',
  '- Never let a thread react to something that has not happened yet in another thread.',
  '- Never contradict what the written chapters have established.',
  '- Never write prose, dialogue, or a scene. This is a plan.',
].join('\n');

export interface BlueprintRunArgs {
  apiKey: string;
  novel: Novel;
  arc: StoryArc;
  /** Chapters this arc covers that already exist, in order. */
  writtenInArc: Chapter[];
  /** The most recent accepted chapters, for voice and momentum. */
  runUp: Chapter[];
  bibleEntries: BibleEntry[];
  designs: CharacterDesign[];
  from: number;
  count: number;
  signal?: AbortSignal;
  /** Fired as each block closes, so the route can stream it out immediately. */
  onBlueprint: (bp: ChapterBlueprint) => void;
  emit?: (event: { type: 'trace'; data: string }) => void;
}

export interface BlueprintRunResult {
  blueprints: ChapterBlueprint[];
  issues: BlueprintIssue[];
  usage: Usage;
}

function buildMessages(args: BlueprintRunArgs): ChatMessage[] {
  const { novel, arc } = args;

  /*
   * Chapters of this arc that are already written are the most important
   * context there is when an author plans late: they are what the arc has
   * actually spent. Without them a plan starting at chapter 31 re-plans
   * chapters 21–30 from scratch.
   */
  const written =
    args.writtenInArc.length > 0
      ? `CHAPTERS OF THIS ARC THAT ARE ALREADY WRITTEN — this is what the arc has spent. Do not\n` +
        `plan any of it again; continue from where it leaves off:\n` +
        args.writtenInArc
          .map((c) => `${c.number}. ${c.title} — ${c.summary || '(no summary)'}`)
          .join('\n')
      : '';

  /*
   * What this arc has already planned, and — the part that matters — which of
   * it the author has since rewritten.
   *
   * A batch that ignores the author's edits re-plans against a version of the
   * story they have already rejected, so an edited chapter is labelled and the
   * prompt is told to treat it as canon.
   *
   * Bounded, because a 100-chapter arc would otherwise send 90 summaries every
   * batch: the most recent ten arrive in full because that is where continuity
   * actually lives, and everything older is a title. Author-edited chapters are
   * exempt from the trimming — dropping an edit is the specific failure this
   * block exists to prevent.
   */
  const prior = arc.blueprints.filter((b) => b.chapter < args.from);
  const recentFrom = Math.max(0, prior.length - 10);
  const planned = prior
    .map((b, i) => {
      const edited = b.source === 'author';
      const inFull = edited || i >= recentFrom;
      const mark = edited ? ' [EDITED BY THE AUTHOR]' : '';
      return inFull
        ? `${b.chapter}. ${b.title}${mark} — ${b.summary}`
        : `${b.chapter}. ${b.title}`;
    })
    .join('\n');

  const editedCount = prior.filter((b) => b.source === 'author').length;

  const beats = arc.beats.length > 0 ? arc.beats.map((b) => `- ${b.text}`).join('\n') : '';

  const context = [
    `NOVEL: ${novel.title}`,
    `PREMISE: ${novel.premise || '(none)'}`,
    novel.styleNotes ? `AUTHOR'S STYLE NOTES: ${novel.styleNotes}` : '',
    '',
    `STORY BIBLE — every name you are allowed to use:\n${formatBibleIndex(args.bibleEntries) || '(empty)'}`,
    '',
    args.designs.length > 0
      ? `CHARACTER DESIGNS (author intent — never state these on the page):\n${args.designs
          .map((d) => formatDesignIndexLine(d, null))
          .join('\n')}\n`
      : '',
    args.runUp.length > 0
      ? `THE CHAPTERS BEFORE THIS ARC:\n${args.runUp
          .map((c) => `${c.number}. ${c.title} — ${c.summary || '(no summary)'}`)
          .join('\n')}\n`
      : '',
    `THE ARC YOU ARE PLANNING — "${arc.title}", chapters ${arc.fromChapter} to ${arc.toChapter}.`,
    arc.premise
      ? "THE AUTHOR'S OWN DESCRIPTION OF THE ARC. If this reads as a list of storylines, they all\n" +
        'run in parallel across the whole arc: the numbering is the author grouping them, not the\n' +
        'order they happen and not the order to plan them in. Braid them, and keep any timing the\n' +
        'author gave a thread ("early", "by the middle", "at the end", "left unresolved"):\n' +
        arc.premise
      : '',
    /*
     * The threads structurally, so the model is not re-deriving "which
     * storylines exist" from the prose above — and the braid brief: where
     * Stage D found each thread standing after the last batch, restated as
     * instructions. Deterministic and free, and the single highest-leverage
     * block in this prompt: the planner starts every batch knowing what is
     * dark, what is behind, and what has not begun.
     */
    (arc.threads?.length ?? 0) > 1 ? '\n' + formatThreadRoster(arc.threads!, arc.timeline?.spanDays) : '',
    (arc.threads?.length ?? 0) > 1 && arc.blueprints.some((b) => b.chapter < args.from)
      ? '\n' +
        formatBraidBrief(
          validateBraid({ ...arc, blueprints: arc.blueprints.filter((b) => b.chapter < args.from) }),
          arc.threads!
        )
      : '',
    beats ? `Its beats — the author's intentions, which are canon for this arc:\n${beats}` : '',
    '',
    written,
    planned ? `\nALREADY PLANNED IN THIS ARC:\n${planned}` : '',
    editedCount > 0
      ? '\nThe author has rewritten the chapters marked EDITED BY THE AUTHOR. Their wording is ' +
        'canon: continue from what those chapters now say, not from whatever was planned before. ' +
        'If an edit changes where the arc is going, follow the edit.'
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const last = args.from + args.count - 1;
  const span = Math.max(1, arc.toChapter - arc.fromChapter);
  const through = Math.round(((args.from - arc.fromChapter) / span) * 100);

  return [
    { role: 'system', content: BLUEPRINT_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `${context}\n\n` +
        `Now plan chapters ${args.from} to ${last}. That is ${args.count} blocks. ` +
        `The arc ends at chapter ${arc.toChapter}, so pace accordingly — you are about ` +
        `${through}% of the way through it.`,
    },
  ];
}

/**
 * Plan one batch, streaming each blueprint as its block closes.
 *
 * Throws only when the model produced nothing usable at all. A batch that
 * yields some blocks and some malformed ones returns both — the good ones are
 * kept, and the caller asks again for the rest.
 */
export async function runBlueprints(args: BlueprintRunArgs): Promise<BlueprintRunResult> {
  const blueprints: ChapterBlueprint[] = [];
  const issues: BlueprintIssue[] = [];

  // Every name the world already knows, for the new-name check.
  const known = new Set<string>();
  for (const e of args.bibleEntries) {
    for (const part of [e.name, ...e.aliases].join(' ').split(/[^A-Za-z]+/)) {
      if (part.length > 2) known.add(part.toLowerCase());
    }
  }
  for (const d of args.designs) {
    for (const part of d.name.split(/[^A-Za-z]+/)) if (part.length > 2) known.add(part.toLowerCase());
  }
  for (const part of `${args.novel.title} ${args.arc.title} ${args.arc.premise}`.split(/[^A-Za-z]+/)) {
    if (part.length > 2) known.add(part.toLowerCase());
  }

  // Label → thread id, for the Threads: bookkeeping line. Resolution lives
  // here and not in the parser so arcParse stays pure and offline-testable:
  // normalised label match first, then the (n) author number the prompt asks
  // the model to include. A label that resolves to nothing is an issue, never
  // a lost blueprint.
  const threadList = args.arc.threads ?? [];
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const byNorm = new Map(threadList.map((t) => [norm(t.label), t.id]));
  const byNumber = new Map(threadList.filter((t) => t.authorNumber !== undefined).map((t) => [t.authorNumber, t.id]));
  // Shared words as a last resort, because the model paraphrases labels
  // freely — "the marketing beta" for a seed about marketing projects going
  // to beta. Two content words in common is a match; one is a coincidence.
  const wordsOf = (s: string): Set<string> => new Set(norm(s).split(' ').filter((w) => w.length > 3));
  const seedWords = threadList.map((t) => ({ id: t.id, words: wordsOf(t.label) }));
  const resolveThreads = (bp: ChapterBlueprint): ChapterBlueprint => {
    if (threadList.length === 0) return bp;
    const { threads: refs, time } = readBookkeeping(bp.futureContext ?? []);
    const ids: string[] = [];
    for (const ref of refs) {
      const key = norm(ref.label);
      const overlap = seedWords
        .map((s) => ({ id: s.id, n: [...wordsOf(ref.label)].filter((w) => s.words.has(w)).length }))
        .sort((a, b) => b.n - a.n)[0];
      const id =
        // The number is the reliable half of the bookkeeping; words second.
        (ref.number !== undefined ? byNumber.get(ref.number) : undefined) ??
        byNorm.get(key) ??
        [...byNorm.entries()].find(([k]) => k.includes(key) || key.includes(k))?.[1] ??
        (overlap && overlap.n >= 2 ? overlap.id : undefined);
      if (id && !ids.includes(id)) ids.push(id);
      else if (!id) {
        issues.push({ chapter: bp.chapter, message: `names a storyline the arc does not have: "${ref.label}"` });
      }
    }
    return {
      ...bp,
      ...(ids.length ? { threads: ids.slice(0, ARC_LIMITS.threadsPerChapter) } : {}),
      ...(time && Number.isFinite(time.day) ? { time } : {}),
    };
  };

  const stream = new BlueprintStream(
    (bp) => {
      const newNames = findNewNames(bp, known);
      const complete = resolveThreads(newNames.length > 0 ? { ...bp, newNames } : bp);
      blueprints.push(complete);
      args.onBlueprint(complete);
    },
    (issue) => issues.push(issue)
  );

  args.emit?.({ type: 'trace', data: `Planning chapters ${args.from}–${args.from + args.count - 1}…` });

  const result = await streamChat({
    apiKey: args.apiKey,
    model: PLAN_MODEL,
    messages: buildMessages(args),
    /*
     * Ten blueprints of prose, plus whatever a reasoning model spends thinking
     * before the first one — reasoning comes out of this same budget, and a
     * batch that runs out stops mid-chapter. It degrades gracefully (the closed
     * blocks are kept and the author is told to ask again for the rest) but it
     * still costs them a batch, and 4k of headroom is a fraction of a cent on
     * this model. Raised with the switch to Gemini, which thinks by default.
     */
    maxTokens: 16_000,
    // Every batch carries a different "already planned" block, so there is no
    // reusable prefix for a pin to protect.
    pinProvider: false,
    signal: args.signal,
    onToken: (t) => stream.push(t),
  });
  stream.end();

  if (blueprints.length === 0) {
    /*
     * Distinct from a malformed block, and it happens: a spike run returned a
     * batch with no headers at all and succeeded on a retry. The correction
     * path cannot help here — there is nothing to correct — so this surfaces
     * as a plain failure the caller can re-run.
     */
    throw new Error('The planner returned nothing usable for those chapters. Try again.');
  }

  args.emit?.({ type: 'trace', data: `Planned ${blueprints.length} chapters` });
  return { blueprints, issues, usage: addUsage(EMPTY_USAGE, result.usage) };
}

export { ARC_LIMITS };

// ── Refining the arc, and editing by instruction ──────────────────────────

/**
 * The refine step, which runs BEFORE any chapter is planned.
 *
 * The author writes what they want the arc to be, in whatever shape suits
 * them — four lines, a paragraph, a list. This turns that into a description
 * worth planning from and a set of beats, without taking the arc away from
 * them: what they wrote is preserved as `previousPremise`, and every beat says
 * whether it restates something they wrote or is something the model added.
 *
 * Planning is gated on this having run, because a plan built from three vague
 * lines is fifty chapters of vague.
 */
const REFINE_SYSTEM_PROMPT = [
  'You help an author sharpen a story arc before it is planned chapter by chapter.',
  '',
  'You are given what the author wrote about the arc, the story bible, their character designs,',
  'and the chapters already written. You produce two things: a tightened description of the arc,',
  'and the beats it breaks into.',
  '',
  'RESPECT WHAT THE AUTHOR WROTE. This is the whole job.',
  '- Every intention they stated must survive into your version. You may sharpen the wording,',
  '  order it, and make vague things concrete. You may not drop, replace or reverse one.',
  '- Where they were vague ("somewhere in here he has to choose"), keep the vagueness as a beat',
  '  rather than inventing the specifics. A beat saying the choice happens is useful; one that',
  '  decides it for them is taking their book away.',
  '- Where they said nothing, you may add — that is what they asked you for. Mark it honestly.',
  '',
  'STORYLINES — read this before you tighten anything.',
  'An arc description is very often a numbered list of separate threads that all run across the',
  'same stretch of time, in no particular order. The author will usually say so outright. When it',
  'is that shape, the job changes:',
  '- KEEP EVERY THREAD. Ten threads in is ten threads out. A thread you fold into another one is a',
  '  storyline the author loses, and they will not notice until the plan is fifty chapters wrong.',
  '- KEEP THEIR NUMBERING AND THEIR ORDER. It is how they hold the arc in their head, and the',
  '  chapter planner downstream reads the same list.',
  '- DO NOT COMPRESS. A twelve-thread arc gets a longer description than a one-thread arc, not the',
  '  same length with things missing. Length is not the goal, but neither is brevity: completeness',
  '  is. Every thread keeps its own short paragraph.',
  '- CARRY THE TIMING ACROSS. "early in the arc", "by the middle", "at the end", "over the eight',
  '  months", "we only get a glimpse", "still unresolved when the arc ends" are the author',
  '  scheduling their own book. Restate them; never quietly decide something different.',
  '- CARRY THE DEPENDENCIES ACROSS. Where the author says one thread only resolves because another',
  '  succeeded, say so in the beat. It is what stops the plan putting the effect before the cause.',
  '- A thread the author plants for the NEXT arc stays a seed. Give it a beat or two saying it is',
  '  glimpsed and not resolved, and do not finish it for them.',
  '',
  'YOU ARE GIVEN THE THREADS ALREADY. A structural read of what the author wrote has pulled their',
  'list apart for you, with their numbers and their own labels. Return that same list in `threads`.',
  'Adding what they left implicit is the job; changing what they wrote is not:',
  '- The label stays THEIRS. If they wrote "the outsourcing feud", that is the label — not',
  '  "corporate restructuring conflict".',
  '- Every thread comes back. A thread you leave out is a storyline the author loses, and they',
  '  will not notice until the plan is fifty chapters wrong.',
  '- `anchor` is where it lives in the arc. `specific` when the author gave a month or a week;',
  '  put their phrase in `anchorNote` verbatim.',
  '- `dependsOn` is the one thing that cannot be recovered later. When the author says one thread',
  '  only resolves BECAUSE another succeeded, say which, by its number. Putting an effect before',
  '  its cause is the worst failure a braided plan can have, and this list is what prevents it.',
  '- `endsOpen` for a thread they told you to leave hanging. Do not tidy it.',
  '',
  'BEATS:',
  '- A single-storyline arc gets between 4 and 12. A multi-storyline arc gets 2 to 4 PER',
  '  STORYLINE — a thread with one beat becomes one chapter and then vanishes from the book.',
  '- Each is one sentence naming something that HAPPENS.',
  '- When the arc has several storylines, start every beat with its thread in square brackets,',
  '  using the author\'s own label for it: "[2 · the outsourcing feud] The audit reaches the board."',
  '  Keep the beats grouped by thread in the author\'s order, and put any timing the author gave',
  '  inside the beat itself ("early in the arc", "not resolved here"). The planner braids them into',
  '  chapter order later; your job is to say what happens in each thread and when, not to',
  '  interleave them yourself.',
  '- `fromAuthor` is true ONLY when the beat restates something the author actually wrote.',
  '  Anything you inferred, filled in or added is false. Do not flatter yourself here — the',
  '  author uses this to see what is theirs, and a wrong flag makes the whole plan untrustworthy.',
  '',
  'NEVER introduce a named character, place or faction that is not already in the story bible,',
  "the character designs, or the author's own text. Unnamed roles are fine and encouraged.",
  'Never contradict the chapters already written.',
  'Never write prose or plan individual chapters. That happens later, from this.',
].join('\n');

const refineToolDefinition = {
  type: 'function' as const,
  function: {
    name: 'refine_arc',
    description: 'Return the sharpened arc description and its beats.',
    parameters: {
      type: 'object',
      properties: {
        premise: {
          type: 'string',
          description:
            'The arc description, tightened. Keeps every intention the author stated. For a single ' +
            'storyline: 2-6 sentences. For an arc written as a numbered list of storylines: the ' +
            'SAME numbered list back, in the same order, one short paragraph per storyline, none ' +
            'merged and none dropped — preceded by one line saying what span of time the arc ' +
            'covers and that the threads run concurrently. Completeness beats brevity here.',
        },
        beats: {
          type: 'array',
          minItems: 3,
          maxItems: ARC_LIMITS.beats,
          items: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                description:
                  'One sentence naming something that happens. In a multi-storyline arc, prefixed ' +
                  "with its thread in square brackets, in the author's own words for it.",
              },
              fromAuthor: {
                type: 'boolean',
                description: 'True only if this restates something the author actually wrote.',
              },
            },
            required: ['text', 'fromAuthor'],
          },
        },
        threads: {
          type: 'array',
          maxItems: ARC_LIMITS.threads,
          description:
            "The storylines this arc runs in parallel. You are GIVEN the author's own list — " +
            'return the SAME threads back, in the same order, with the same numbers and labels. ' +
            'You may not merge two, drop one, or rename one. Your job is to fill in what the ' +
            'author left implicit: when each is anchored, what it waits on, whether it ends here.',
          items: {
            type: 'object',
            properties: {
              number: { type: 'integer', description: "The author's number for it, when they gave one." },
              label: { type: 'string', description: "The author's own words for this thread." },
              anchor: {
                type: 'string',
                enum: ['early', 'mid', 'late', 'span', 'specific'],
                description: 'Where in the arc this thread lives.',
              },
              anchorNote: { type: 'string', description: "The author's timing phrase, verbatim." },
              dependsOn: {
                type: 'array',
                items: { type: 'integer' },
                description:
                  'Thread numbers that must land BEFORE this one can resolve. The one thing that ' +
                  'cannot be recovered later: it is what stops an effect being planned before ' +
                  'its cause.',
              },
              endsOpen: { type: 'boolean', description: 'The author said this stays unresolved when the arc ends.' },
              seedForNextArc: {
                type: 'boolean',
                description: 'Planted for the next arc: a glimpse here, never a resolution.',
              },
              weight: { type: 'string', enum: ['major', 'minor'], description: 'How much room it needs.' },
            },
            required: ['label', 'anchor'],
          },
        },
        timelineSpanDays: {
          type: 'integer',
          description:
            'Roughly how many days the whole arc covers. The author usually says: "over the next ' +
            'eight months" is 240. Omit if the author gave no span at all.',
        },
      },
      required: ['premise', 'beats'],
    },
  },
};

export interface RefineArgs {
  apiKey: string;
  novel: Novel;
  arc: StoryArc;
  writtenInArc: Chapter[];
  bibleEntries: BibleEntry[];
  designs: CharacterDesign[];
  /**
   * Stage A's structural read of the author's premise, already persisted.
   * The model is shown this list and asked to enrich it — never to replace
   * it; mergeThreadSeeds guarantees a seed survives whatever comes back.
   */
  threadSeeds: ArcThread[];
  /** Optional steer from the author: "make it darker", "cut the romance". */
  instructions?: string;
  signal?: AbortSignal;
}

/** Everything Stage B may write. The route merges it via mergeRefine. */
export interface RefineResult extends RefineOutput {
  usage: Usage;
}

function worldContext(
  novel: Novel,
  bibleEntries: BibleEntry[],
  designs: CharacterDesign[],
  writtenInArc: Chapter[]
): string {
  return [
    `NOVEL: ${novel.title}`,
    `PREMISE: ${novel.premise || '(none)'}`,
    novel.styleNotes ? `AUTHOR'S STYLE NOTES: ${novel.styleNotes}` : '',
    '',
    `STORY BIBLE — every name that exists:\n${formatBibleIndex(bibleEntries) || '(empty)'}`,
    designs.length > 0
      ? `\nCHARACTER DESIGNS (author intent):\n${designs.map((d) => formatDesignIndexLine(d, null)).join('\n')}`
      : '',
    writtenInArc.length > 0
      ? `\nCHAPTERS OF THIS ARC ALREADY WRITTEN:\n${writtenInArc
          .map((c) => `${c.number}. ${c.title} — ${c.summary || '(no summary)'}`)
          .join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Every name the author already owns, for judging what refine invented.
 *
 * Built from the AUTHOR'S OWN TEXT and nothing the model produced: the bible,
 * the designs, the novel's title and premise, and the arc premise as the author
 * typed it. That last one is the whole point — refine rewrites the premise, so
 * checking its output against its own output would approve anything it made up.
 */
export function authorKnownNames(args: {
  novel: Pick<Novel, 'title' | 'premise' | 'styleNotes'>;
  arcPremise: string;
  bibleEntries: readonly BibleEntry[];
  designs: readonly CharacterDesign[];
}): Set<string> {
  const known = new Set<string>();
  const add = (text: string): void => {
    for (const word of text.split(/[^A-Za-z'’]+/)) {
      if (word.length > 2) known.add(word.toLowerCase());
    }
  };
  for (const entry of args.bibleEntries) {
    add(entry.name);
    for (const alias of entry.aliases) add(alias);
  }
  for (const design of args.designs) add(design.name);
  add(`${args.novel.title} ${args.novel.premise} ${args.novel.styleNotes}`);
  add(args.arcPremise);
  return known;
}

/**
 * Did refine invent a name? Returns tool output to correct, or null.
 *
 * The prompt has forbidden this from the start and it happened anyway on the
 * first real use — which is the difference between a rule and an enforcement.
 * Every other agent in this app validates its own output and hands back a
 * correctable error; this one only asked politely, and the names it invented
 * then flowed into the beats, into the planner (which treats beats as canon),
 * and past the blueprint scan, because that scan's `known` set is built from
 * the premise refine had just rewritten.
 */
export function checkRefineNames(
  premise: string,
  beats: readonly string[],
  known: Set<string>
): string | null {
  const invented = newNamesInText([premise, ...beats].join('\n'), known);
  if (!invented.length) return null;
  const list = invented.slice(0, 6).map((n) => `"${n}"`).join(', ');
  return (
    `Error: ${list} ${invented.length === 1 ? 'names something' : 'name things'} this story does ` +
    'not have. You may not invent a character, place, faction or house here — that is the ' +
    "author's to do. Use an unnamed role instead (\"a dock clerk\", \"the assayer\", \"the woman " +
    'who keeps the ledgers\") and call refine_arc again.'
  );
}

/** One seed, as the prompt lists it: number, label, and what Stage A read. */
function formatSeed(seed: ArcThread): string {
  const notes: string[] = [`anchored ${seed.anchor}${seed.anchorNote ? ` ("${seed.anchorNote}")` : ''}`];
  if (seed.weight) notes.push(seed.weight);
  if (seed.endsOpen) notes.push('left open at the end');
  if (seed.seedForNextArc) notes.push('a seed for the next arc');
  return `${seed.authorNumber ?? '-'}. ${seed.label} — ${notes.join('; ')}`;
}

export async function runArcRefine(args: RefineArgs): Promise<RefineResult> {
  const { arc } = args;
  const known = authorKnownNames({
    novel: args.novel,
    // As the AUTHOR wrote it. After one refine `arc.premise` is model text,
    // and reading it here is how a re-refine laundered every name the first
    // refine invented. arc.test.ts holds this line.
    arcPremise: authorPremiseText(arc),
    bibleEntries: args.bibleEntries,
    designs: args.designs,
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: REFINE_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `${worldContext(args.novel, args.bibleEntries, args.designs, args.writtenInArc)}\n\n` +
        `THE ARC: "${arc.title}", chapters ${arc.fromChapter} to ${arc.toChapter} ` +
        `(${arc.toChapter - arc.fromChapter + 1} chapters).\n\n` +
        `WHAT THE AUTHOR WROTE:\n${authorPremiseText(arc)}\n\n` +
        (args.threadSeeds.length > 1
          ? `THE THREADS, as read from their words — enrich these, in this order:\n${args.threadSeeds
              .map(formatSeed)
              .join('\n')}\n\n`
          : '') +
        (args.instructions?.trim()
          ? `THE AUTHOR ALSO ASKS: ${args.instructions.trim()}`
          : 'Sharpen it and break it into beats.'),
    },
  ];

  let usage = EMPTY_USAGE;
  /** The last round that PARSED, held so running out of rounds loses nothing. */
  let best: { premise: string; beats: ArcBeat[]; threads: ArcThread[]; timeline?: ArcTimeline } | null = null;

  for (let round = 0; round < REFINE_ROUNDS; round++) {
    const result = await streamChat({
      apiKey: args.apiKey,
      model: ARC_MODEL,
      messages,
      tools: [refineToolDefinition],
      toolChoice: { type: 'function', function: { name: 'refine_arc' } },
      /*
       * Raised from 6,000 with the multi-storyline premise. A twelve-thread arc
       * returns a paragraph per thread plus up to forty labelled beats, and
       * luna's reasoning comes out of this same budget — at 6,000 the tool call
       * truncated mid-JSON, which surfaces as "returned something unreadable"
       * and costs the author the whole refine.
       */
      maxTokens: 16_000,
      pinProvider: false,
      signal: args.signal,
    });
    usage = addUsage(usage, result.usage);

    const call = result.toolCalls[0];
    if (!call) throw toolCallFailed('refiner', result.finishReason);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(call.function.arguments || '{}');
    } catch {
      throw toolCallFailed('refiner', result.finishReason);
    }

    const premise = typeof parsed.premise === 'string' ? parsed.premise.trim() : '';
    const rawBeats = Array.isArray(parsed.beats) ? parsed.beats : [];
    if (!premise || rawBeats.length === 0) {
      throw toolCallFailed('refiner', result.finishReason);
    }

    const beats: ArcBeat[] = rawBeats
      .map((b, i) => {
        const item = b as Record<string, unknown>;
        const text = typeof item.text === 'string' ? item.text.trim() : '';
        return text
          ? {
              id: `b${i}-${Math.abs(hashText(text)).toString(36)}`,
              text: text.slice(0, ARC_LIMITS.beatText),
              source: (item.fromAuthor === true ? 'author' : 'model') as ArcSource,
            }
          : null;
      })
      .filter((b): b is ArcBeat => b !== null)
      .slice(0, ARC_LIMITS.beats);

    best = {
      premise: premise.slice(0, ARC_LIMITS.premise),
      beats,
      threads: threadsFromTool(parsed.threads, args.threadSeeds),
      timeline: timelineFromTool(parsed.timelineSpanDays, arc.timeline),
    };

    const invented = checkRefineNames(premise, beats.map((b) => b.text), known);
    if (!invented) {
      return { ...best, nameFlags: [], stage: stageOk(), usage };
    }
    messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });
    messages.push({ role: 'tool', tool_call_id: call.id, content: invented });
  }

  /*
   * Out of rounds — and the refine is SAVED anyway.
   *
   * The old behaviour threw here, the route saved nothing, and an author lost
   * a premise and forty beats to a checker that once called "Monday" a
   * character. A name nobody agreed to is a review row, not a reason to
   * destroy the work: the same judgement the cast pass has always made, where
   * an unknown proper noun becomes an origin:'loose' row for the author to
   * confirm or rename. The flags ride out on the arc, the screen says what
   * happened, and the author keeps every word.
   */
  const last = best!;
  const flags: ArcNameFlag[] = [];
  const at = Date.now();
  for (const name of newNamesInText(last.premise, known)) {
    flags.push({ name, where: 'premise', at });
  }
  for (const beat of last.beats) {
    for (const name of newNamesInText(beat.text, known)) {
      if (flags.some((f) => f.name === name)) continue;
      flags.push({ name, where: 'beat', beatId: beat.id, at });
    }
  }
  const shown = flags.slice(0, 3).map((f) => f.name).join(', ');
  return {
    ...last,
    nameFlags: flags.slice(0, ARC_LIMITS.nameFlags),
    stage: stagePartial(
      flags.length
        ? `Saved — but ${shown}${flags.length > 3 ? ` and ${flags.length - 3} more` : ''} ` +
            `${flags.length === 1 ? 'is a name' : 'are names'} your story bible has never heard of. ` +
            'Keep them, or put your own description back.'
        : 'Saved, with reservations the model could not resolve.'
    ),
    usage,
  };
}

/** The tool call's `threads`, resolved against Stage A's seeds. */
function threadsFromTool(raw: unknown, seeds: ArcThread[]): ArcThread[] {
  if (!Array.isArray(raw)) return [];
  const byNumber = new Map(seeds.filter((s) => s.authorNumber !== undefined).map((s) => [s.authorNumber, s]));
  const anchors: ThreadAnchor[] = ['early', 'mid', 'late', 'span', 'specific'];

  return raw
    .map((item): ArcThread | null => {
      if (typeof item !== 'object' || item === null) return null;
      const t = item as Record<string, unknown>;
      const label = typeof t.label === 'string' ? t.label.trim().slice(0, ARC_LIMITS.threadLabel) : '';
      if (!label) return null;
      const number = typeof t.number === 'number' && Number.isFinite(t.number) ? Math.round(t.number) : undefined;
      const seed = number !== undefined ? byNumber.get(number) : undefined;
      const dependsOn = Array.isArray(t.dependsOn)
        ? t.dependsOn
            .map((d) => (typeof d === 'number' ? byNumber.get(Math.round(d))?.id : undefined))
            .filter((id): id is string => typeof id === 'string')
        : [];
      const thread: ArcThread = {
        // The seed's id when the numbers line up, so blueprints keyed to it
        // stay keyed; a content hash otherwise.
        id: seed?.id ?? `t${number ?? 'x'}-${Math.abs(hashText(label.toLowerCase())).toString(36)}`,
        label,
        anchor: anchors.includes(t.anchor as ThreadAnchor) ? (t.anchor as ThreadAnchor) : 'span',
        source: 'model',
        ...(number !== undefined ? { authorNumber: number } : {}),
      };
      const note = typeof t.anchorNote === 'string' ? t.anchorNote.trim().slice(0, ARC_LIMITS.threadLabel) : '';
      if (note) thread.anchorNote = note;
      if (dependsOn.length) thread.dependsOn = dependsOn;
      if (t.endsOpen === true) thread.endsOpen = true;
      if (t.seedForNextArc === true) {
        thread.seedForNextArc = true;
        thread.endsOpen = true;
      }
      if (t.weight === 'major' || t.weight === 'minor') thread.weight = t.weight;
      return thread;
    })
    .filter((t): t is ArcThread => t !== null)
    .slice(0, ARC_LIMITS.threads);
}

function timelineFromTool(raw: unknown, existing: ArcTimeline | undefined): ArcTimeline | undefined {
  const days = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : NaN;
  if (!Number.isFinite(days) || days < 1) return existing;
  return { ...existing, spanDays: Math.min(ARC_LIMITS.arcSpanDays, days) };
}

/** Stable ids without Date.now(), so a re-run of the same text keys the same. */
function hashText(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return h;
}

/**
 * AI edit: rewrite one thing the author points at, to their instruction.
 *
 * Deliberately narrow. It is handed exactly one piece of text — the arc
 * description or a single chapter blueprint — and returns the same shape back.
 * It cannot touch anything else, so "make chapter 34 darker" can never quietly
 * rewrite chapter 35 as well.
 */
const EDIT_SYSTEM_PROMPT = [
  "You rewrite ONE piece of an author's story plan, to their instruction.",
  '',
  'Return the same shape you were given, changed only as far as the instruction asks. Everything',
  'the instruction does not mention stays as it was — you are editing, not redrafting.',
  '',
  'Never introduce a named character, place or faction that is not already in the story bible,',
  'the character designs, or the text you were given. Never contradict the written chapters.',
  'Never write prose. This is a plan.',
].join('\n');

const editToolDefinition = {
  type: 'function' as const,
  function: {
    name: 'return_edit',
    description: 'Return the rewritten text.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The rewritten arc description. Used only when editing an arc.',
        },
        title: { type: 'string', description: 'Chapter title, 4 words or fewer.' },
        tags: { type: 'array', items: { type: 'string' } },
        opens: { type: 'string' },
        turn: { type: 'string' },
        lands: { type: 'string' },
      },
    },
  },
};

export interface EditArgs {
  apiKey: string;
  novel: Novel;
  arc: StoryArc;
  bibleEntries: BibleEntry[];
  designs: CharacterDesign[];
  instruction: string;
  /** Editing one chapter, or the arc description when absent. */
  chapter?: number;
  signal?: AbortSignal;
}

export interface EditResult {
  premise?: string;
  blueprint?: ChapterBlueprint;
  usage: Usage;
}

export async function runArcEdit(args: EditArgs): Promise<EditResult> {
  const target =
    args.chapter !== undefined
      ? args.arc.blueprints.find((b) => b.chapter === args.chapter)
      : undefined;
  if (args.chapter !== undefined && !target) {
    throw new Error(`Chapter ${args.chapter} is not planned in this arc.`);
  }

  const subject = target
    ? `THE CHAPTER YOU ARE EDITING — chapter ${target.chapter}:\n` +
      `title: ${target.title}\ntags: ${target.tags.join(', ')}\n` +
      (target.opens || target.turn || target.lands
        ? `opens: ${target.opens}\nturn: ${target.turn}\nlands: ${target.lands}`
        : `summary: ${target.summary}`) +
      '\n\nReturn title, tags, opens, turn and lands. Keep the three movements substantial — ' +
      'this has to be enough for a chapter of 500 to 2000 words.\n' +
      `Tags must come from: ${ARC_TAGS.join(', ')}`
    : `THE ARC DESCRIPTION YOU ARE EDITING:\n${args.arc.premise}\n\nReturn it in the "text" field.`;

  const result = await streamChat({
    apiKey: args.apiKey,
    model: ARC_MODEL,
    messages: [
      { role: 'system', content: EDIT_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `${worldContext(args.novel, args.bibleEntries, args.designs, [])}\n\n` +
          `${subject}\n\nTHE AUTHOR ASKS: ${args.instruction.trim()}`,
      },
    ],
    tools: [editToolDefinition],
    toolChoice: { type: 'function', function: { name: 'return_edit' } },
    maxTokens: 6_000,
    pinProvider: false,
    signal: args.signal,
  });

  const call = result.toolCalls[0];
  if (!call) throw toolCallFailed('editor', result.finishReason);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(call.function.arguments || '{}');
  } catch {
    throw toolCallFailed('editor', result.finishReason);
  }
  const usage = addUsage(EMPTY_USAGE, result.usage);

  if (!target) {
    const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
    if (!text) throw new Error('The editor returned an empty description. Try again.');
    return { premise: text.slice(0, ARC_LIMITS.premise), usage };
  }

  const pick = (k: string, fallback: string) =>
    (typeof parsed[k] === 'string' ? (parsed[k] as string).trim() : '') || fallback;
  const opens = pick('opens', target.opens).slice(0, ARC_LIMITS.blueprintPart);
  const turn = pick('turn', target.turn).slice(0, ARC_LIMITS.blueprintPart);
  const lands = pick('lands', target.lands).slice(0, ARC_LIMITS.blueprintPart);
  const summary = [opens, turn, lands].filter(Boolean).join(' ') || target.summary;

  return {
    blueprint: {
      ...target,
      title: pick('title', target.title).slice(0, ARC_LIMITS.blueprintTitle),
      tags: Array.isArray(parsed.tags) ? validateTags(parsed.tags) : target.tags,
      opens,
      turn,
      lands,
      summary: summary.slice(0, ARC_LIMITS.blueprintSummary),
      source: 'model',
      // Kept so the screen can show what the edit replaced rather than
      // swapping the author's text out from under them.
      previousSummary: target.summary,
    },
    usage,
  };
}
