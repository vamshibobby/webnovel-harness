/**
 * Validation for story arcs.
 *
 * Same two-caller contract as designValidate and bibleValidate: the author's
 * PATCH turns an error into a 400, and the planning agent turns the same error
 * into tool output it can read and retry against. One set of rules, so the
 * agent can never write something the author could not have typed.
 *
 * Beats and blueprints are lists the author curates, so they replace wholesale
 * rather than merging — "delete the third beat" has to be expressible.
 */
import { BIBLE_LIMITS } from './bibleValidate.js';
import { ARC_TAGS, type ArcBeat, type ArcNameFlag, type ArcSource, type ArcStatus, type ArcThread, type ArcTimeline, type BlueprintCastMember, type ChapterBlueprint, type StoryArc, type ThreadAnchor } from './types.js';

export const ARC_LIMITS = {
  arcsPerNovel: 20,
  title: 120,
  /**
   * The author's own description of the arc, before any model sees it.
   *
   * Characters, not words — every cap in this file is. Raised from 4,000 when
   * arcs stopped being one storyline: an author planning eight months of
   * concurrent threads writes a numbered list of ten or twelve of them, each
   * with its own timing and its own ending, and 4,000 truncated that around
   * the sixth. The planner reads that shape deliberately now (see the
   * STORYLINES section of BLUEPRINT_SYSTEM_PROMPT), so the field has to hold
   * it. 10,000 is ~1,600 words and costs ~2.5k tokens on a planning batch that
   * already budgets 16k.
   */
  premise: 10000,
  beats: 40,
  beatText: 400,
  blueprintTitle: 80,
  /**
   * One movement — opens, turn or lands.
   *
   * 600, not 420. The prompt asks each movement for "2 to 4 full sentences",
   * and four sentences of a dense chapter is 500-550 characters, so 420 cut
   * the last one mid-word: a real braided run came back with turns ending
   * "…until Adrian restructures the " and "…but Cole steps in to ". The author
   * reads that as the model failing, and the writer loses the half of the beat
   * that says how it resolves.
   */
  blueprintPart: 600,
  /**
   * Must stay >= 3 * blueprintPart + 2, because a summary IS the three parts
   * joined. It was 1200 against a part cap of 420, so three full-length
   * movements produced 1262 characters that the summary rule then rejected —
   * and because a PATCH carries every blueprint, one long chapter failed the
   * whole arc's save. arc.test.ts asserts the relationship now, which is what
   * caught this needing to move again when blueprintPart went 420 -> 600.
   */
  blueprintSummary: 1900,
  tagsPerChapter: 4,
  /** One request plans this many chapters; see research/arcplan. */
  batchSize: 10,
  /** Below this, a blueprint is a label rather than something to write from. */
  summaryMin: 240,
  chaptersPerArc: 300,
  /** Named cast on one blueprint. Past this it is a scene list, not a chapter. */
  castPerBlueprint: 8,
  /** Rows one cast pass may propose across a whole batch. */
  castPerBatch: 12,
  /** "the woman who keeps the ledgers" is a long mention and a legitimate one. */
  castMention: 160,
  /** One line saying who someone is. Longer than that is a bible entry. */
  castNote: 200,
  /**
   * Planned reveals, and private context, per chapter.
   *
   * Eight rather than six because a braided arc spends the first one or two
   * lines on bookkeeping — which storyline this chapter is, and where it sits
   * in time against the one before it. At six, those two lines evicted the
   * actual withheld information, which is what the field is for.
   */
  contextPerBlueprint: 8,
  contextLine: 300,
  /** Storylines one arc can braid. Past this it is a series, not an arc. */
  threads: 16,
  threadLabel: 120,
  /** A chapter carries one thread, or a weave of at most this many. */
  threadsPerChapter: 3,
  /** Planned chapters a thread may go unseen before it reads as dropped. */
  darkGap: 4,
  /** How far two threads' clocks may drift, in days, before the braid is broken. */
  threadDriftDays: 45,
  /** Ten years. Anything past this is a saga, not an arc on one clock. */
  arcSpanDays: 3650,
  nameFlags: 24,
} as const;

export class ArcValidationError extends Error {}

/**
 * The arc premise as the AUTHOR wrote it.
 *
 * After a refine, `premise` is model text and the author's own words live in
 * `previousPremise`. Anything that treats the premise as evidence of what the
 * author chose — above all the name checker, whose whitelist must never
 * contain a model invention — has to read this, not `premise`. Reading
 * `premise` directly is how a re-refine laundered every name the first
 * refine invented.
 */
export function authorPremiseText(
  arc: Pick<StoryArc, 'premise'> & Partial<Pick<StoryArc, 'premiseSource' | 'previousPremise'>>
): string {
  if (arc.premiseSource === 'model' && arc.previousPremise?.trim()) return arc.previousPremise;
  return arc.premise;
}

function fail(message: string): never {
  throw new ArcValidationError(message);
}

function str(value: unknown, field: string, max: number, opts?: { required?: boolean }): string {
  if (value === undefined || value === null) {
    if (opts?.required) fail(`${field} is required`);
    return '';
  }
  if (typeof value !== 'string') fail(`${field} must be a string`);
  const trimmed = value.trim();
  if (opts?.required && !trimmed) fail(`${field} cannot be empty`);
  if (trimmed.length > max) fail(`${field} is too long (max ${max} characters)`);
  return trimmed;
}

function num(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) fail(`${field} must be a number`);
  return Math.round(n);
}

/** Same rules as bible entries and designs, separate namespace. */
export function slugifyArcTitle(title: string): string {
  return (
    title
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'arc'
  );
}

export function validateTags(input: unknown): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) fail('tags must be an array');
  const allowed = new Set<string>(ARC_TAGS);
  // Unknown tags are dropped rather than rejected: a vocabulary miss is not
  // worth losing an otherwise good chapter description over.
  return [...new Set(input.map((t) => String(t).trim().toLowerCase()))]
    .filter((t) => allowed.has(t))
    .slice(0, ARC_LIMITS.tagsPerChapter);
}

function validateSource(input: unknown): ArcSource {
  return input === 'model' ? 'model' : 'author';
}

export function validateBeat(input: unknown, index: number): ArcBeat {
  if (typeof input === 'string') {
    return { id: `b${index}`, text: str(input, `beats[${index}]`, ARC_LIMITS.beatText, { required: true }), source: 'author' };
  }
  if (typeof input !== 'object' || input === null) fail(`beats[${index}] must be an object or a string`);
  const b = input as Record<string, unknown>;
  const beat: ArcBeat = {
    id: str(b.id, `beats[${index}].id`, 64) || `b${index}`,
    text: str(b.text, `beats[${index}].text`, ARC_LIMITS.beatText, { required: true }),
    source: validateSource(b.source),
  };
  const previous = str(b.previousText, `beats[${index}].previousText`, ARC_LIMITS.beatText);
  if (previous) beat.previousText = previous;
  return beat;
}

export function validateBlueprint(input: unknown, index: number): ChapterBlueprint {
  if (typeof input !== 'object' || input === null) fail(`blueprints[${index}] must be an object`);
  const b = input as Record<string, unknown>;
  const chapter = num(b.chapter, `blueprints[${index}].chapter`);
  if (chapter < 1) fail(`blueprints[${index}].chapter must be 1 or more`);

  const opens = str(b.opens, `blueprints[${index}].opens`, ARC_LIMITS.blueprintPart);
  const turn = str(b.turn, `blueprints[${index}].turn`, ARC_LIMITS.blueprintPart);
  const lands = str(b.lands, `blueprints[${index}].lands`, ARC_LIMITS.blueprintPart);
  const joined = [opens, turn, lands].filter(Boolean).join(' ');
  // Clipped rather than refused: a summary is derived text, not a field the
  // author filled in, and losing the whole plan over its length is a worse
  // outcome than losing its last sentence. The parser clips for the same
  // reason.
  const rawSummary = joined || (typeof b.summary === 'string' ? b.summary.trim() : '');
  const summary = rawSummary.slice(0, ARC_LIMITS.blueprintSummary);
  if (!summary) fail(`blueprints[${index}] has no content`);

  const bp: ChapterBlueprint = {
    chapter,
    title: str(b.title, `blueprints[${index}].title`, ARC_LIMITS.blueprintTitle),
    tags: validateTags(b.tags),
    summary: summary.slice(0, ARC_LIMITS.blueprintSummary),
    opens,
    turn,
    lands,
    source: validateSource(b.source),
  };
  const previous = str(b.previousSummary, `blueprints[${index}].previousSummary`, ARC_LIMITS.blueprintSummary);
  if (previous) bp.previousSummary = previous;
  if (Array.isArray(b.newNames) && b.newNames.length > 0) {
    bp.newNames = [...new Set(b.newNames.map((n) => String(n).trim()).filter(Boolean))].slice(0, 12);
  }
  if (Array.isArray(b.cast) && b.cast.length > 0) {
    // Malformed rows drop rather than failing the patch, the contract tags and
    // the summary clip already have: one bad cast row must not cost an author
    // the whole arc's save.
    const cast = b.cast
      .map((item): BlueprintCastMember | null => {
        if (typeof item !== 'object' || item === null) return null;
        const m = item as Record<string, unknown>;
        // The name cap is the bible's, because a cast name IS a bible name and
        // two caps that can disagree is how the ends of a join drift apart.
        const name = str(m.name, `blueprints[${index}].cast.name`, BIBLE_LIMITS.name);
        if (!name) return null;
        const entryId = str(m.entryId, `blueprints[${index}].cast.entryId`, 64);
        // `mention` is read as a fallback note purely so cast written by the
        // first version of this feature survives the upgrade with something
        // in it rather than a blank line.
        const note =
          str(m.note, `blueprints[${index}].cast.note`, ARC_LIMITS.castNote) ||
          str(m.mention, `blueprints[${index}].cast.note`, ARC_LIMITS.castNote);
        return { name, note, ...(entryId ? { entryId } : {}) };
      })
      .filter((m): m is BlueprintCastMember => m !== null)
      .slice(0, ARC_LIMITS.castPerBlueprint);
    if (cast.length) bp.cast = cast;
  }

  const lines = (value: unknown, field: string): string[] | null => {
    if (!Array.isArray(value) || value.length === 0) return null;
    const out = value
      .map((v) => str(v, `blueprints[${index}].${field}`, ARC_LIMITS.contextLine))
      .filter(Boolean)
      .slice(0, ARC_LIMITS.contextPerBlueprint);
    return out.length ? out : null;
  };
  if (Array.isArray(b.roles) && b.roles.length > 0) {
    const roles = [
      ...new Set(
        b.roles
          .map((r) => str(r, `blueprints[${index}].roles`, ARC_LIMITS.castMention))
          .filter(Boolean)
      ),
    ].slice(0, ARC_LIMITS.castPerBlueprint);
    if (roles.length) bp.roles = roles;
  }

  const reveals = lines(b.reveals, 'reveals');
  if (reveals) bp.reveals = reveals;
  const future = lines(b.futureContext, 'futureContext');
  if (future) bp.futureContext = future;

  // Threads and time drop when malformed rather than failing the patch — the
  // same rule as cast rows, for the same reason: a PATCH carries every
  // blueprint, and one bad bookkeeping field must not cost the whole save.
  if (Array.isArray(b.threads) && b.threads.length > 0) {
    const threads = [
      ...new Set(b.threads.map((t) => (typeof t === 'string' ? t.trim() : '')).filter(Boolean)),
    ].slice(0, ARC_LIMITS.threadsPerChapter);
    if (threads.length) bp.threads = threads;
  }
  if (typeof b.time === 'object' && b.time !== null) {
    const t = b.time as Record<string, unknown>;
    const day = typeof t.day === 'number' ? Math.round(t.day) : Number(t.day);
    if (Number.isFinite(day)) {
      const clamped = Math.min(ARC_LIMITS.arcSpanDays, Math.max(0, day));
      const hint = typeof t.hint === 'string' ? t.hint.trim().slice(0, ARC_LIMITS.contextLine) : '';
      bp.time = hint ? { day: clamped, hint } : { day: clamped };
    }
  }

  return bp;
}

const ANCHORS: ThreadAnchor[] = ['early', 'mid', 'late', 'span', 'specific'];

export function validateThread(input: unknown, index: number): ArcThread {
  if (typeof input !== 'object' || input === null) fail(`threads[${index}] must be an object`);
  const t = input as Record<string, unknown>;
  const label = str(t.label, `threads[${index}].label`, ARC_LIMITS.threadLabel, { required: true });
  const anchor = ANCHORS.includes(t.anchor as ThreadAnchor) ? (t.anchor as ThreadAnchor) : 'span';
  const thread: ArcThread = {
    id: str(t.id, `threads[${index}].id`, 64) || `t${index}`,
    label,
    anchor,
    source: validateSource(t.source),
  };
  if (t.authorNumber !== undefined) {
    const n = num(t.authorNumber, `threads[${index}].authorNumber`);
    if (n >= 1 && n <= 99) thread.authorNumber = n;
  }
  const note = str(t.anchorNote, `threads[${index}].anchorNote`, ARC_LIMITS.threadLabel);
  if (note) thread.anchorNote = note;
  if (Array.isArray(t.dependsOn) && t.dependsOn.length > 0) {
    const deps = [
      ...new Set(t.dependsOn.map((d) => (typeof d === 'string' ? d.trim() : '')).filter(Boolean)),
    ].slice(0, ARC_LIMITS.threads);
    if (deps.length) thread.dependsOn = deps;
  }
  if (t.endsOpen === true) thread.endsOpen = true;
  if (t.seedForNextArc === true) thread.seedForNextArc = true;
  if (t.weight === 'major' || t.weight === 'minor') thread.weight = t.weight;
  return thread;
}

export function validateTimeline(input: unknown): ArcTimeline | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const t = input as Record<string, unknown>;
  const out: ArcTimeline = {};
  const days = typeof t.spanDays === 'number' ? Math.round(t.spanDays) : Number(t.spanDays);
  if (Number.isFinite(days) && days >= 1) out.spanDays = Math.min(ARC_LIMITS.arcSpanDays, days);
  const note = typeof t.note === 'string' ? t.note.trim().slice(0, ARC_LIMITS.threadLabel) : '';
  if (note) out.note = note;
  return out.spanDays || out.note ? out : undefined;
}

/** Malformed flags drop; a flag is advisory and never worth failing a save. */
export function validateNameFlag(input: unknown): ArcNameFlag | null {
  if (typeof input !== 'object' || input === null) return null;
  const f = input as Record<string, unknown>;
  const name = typeof f.name === 'string' ? f.name.trim().slice(0, BIBLE_LIMITS.name) : '';
  if (!name) return null;
  const flag: ArcNameFlag = {
    name,
    where: f.where === 'beat' ? 'beat' : 'premise',
    at: typeof f.at === 'number' && Number.isFinite(f.at) ? f.at : Date.now(),
  };
  if (typeof f.beatId === 'string' && f.beatId.trim()) flag.beatId = f.beatId.trim().slice(0, 64);
  return flag;
}

export interface ArcPatch {
  title?: string;
  premise?: string;
  premiseSource?: ArcSource;
  previousPremise?: string;
  fromChapter?: number;
  toChapter?: number;
  status?: ArcStatus;
  steer?: boolean;
  beats?: ArcBeat[];
  blueprints?: ChapterBlueprint[];
  threads?: ArcThread[];
  timeline?: ArcTimeline;
  nameFlags?: ArcNameFlag[];
}

const STATUSES: ArcStatus[] = ['planning', 'active', 'done', 'abandoned'];

export function validateArcPatch(input: Record<string, unknown>): ArcPatch {
  // `braid` and `stages` are deliberately absent: they are pipeline-owned
  // records of what actually ran, and a client that could PATCH them could
  // make the stage history a lie.
  const allowed = [
    'title', 'premise', 'premiseSource', 'previousPremise',
    'fromChapter', 'toChapter', 'status', 'steer', 'beats', 'blueprints',
    'threads', 'timeline', 'nameFlags',
  ];
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) fail(`unknown field "${key}" — allowed: ${allowed.join(', ')}`);
  }

  const patch: ArcPatch = {};
  if (input.title !== undefined) patch.title = str(input.title, 'title', ARC_LIMITS.title, { required: true });
  if (input.premise !== undefined) patch.premise = str(input.premise, 'premise', ARC_LIMITS.premise);
  if (input.premiseSource !== undefined) patch.premiseSource = validateSource(input.premiseSource);
  if (input.previousPremise !== undefined) {
    patch.previousPremise = str(input.previousPremise, 'previousPremise', ARC_LIMITS.premise);
  }
  if (input.fromChapter !== undefined) patch.fromChapter = num(input.fromChapter, 'fromChapter');
  if (input.toChapter !== undefined) patch.toChapter = num(input.toChapter, 'toChapter');
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status as ArcStatus)) fail(`status must be one of ${STATUSES.join(', ')}`);
    patch.status = input.status as ArcStatus;
  }
  if (input.steer !== undefined) {
    if (typeof input.steer !== 'boolean') fail('steer must be true or false');
    patch.steer = input.steer;
  }
  if (input.beats !== undefined) {
    if (!Array.isArray(input.beats)) fail('beats must be an array');
    if (input.beats.length > ARC_LIMITS.beats) fail(`an arc can hold at most ${ARC_LIMITS.beats} beats`);
    patch.beats = input.beats.map(validateBeat);
  }
  if (input.blueprints !== undefined) {
    if (!Array.isArray(input.blueprints)) fail('blueprints must be an array');
    if (input.blueprints.length > ARC_LIMITS.chaptersPerArc) {
      fail(`an arc can hold at most ${ARC_LIMITS.chaptersPerArc} chapter blueprints`);
    }
    patch.blueprints = input.blueprints
      .map(validateBlueprint)
      .sort((a, b) => a.chapter - b.chapter);
  }

  if (input.threads !== undefined) {
    if (!Array.isArray(input.threads)) fail('threads must be an array');
    if (input.threads.length > ARC_LIMITS.threads) {
      fail(`an arc can braid at most ${ARC_LIMITS.threads} storylines`);
    }
    patch.threads = input.threads.map(validateThread);
  }
  if (input.timeline !== undefined) {
    patch.timeline = validateTimeline(input.timeline);
  }
  if (input.nameFlags !== undefined) {
    if (!Array.isArray(input.nameFlags)) fail('nameFlags must be an array');
    patch.nameFlags = input.nameFlags
      .map(validateNameFlag)
      .filter((f): f is ArcNameFlag => f !== null)
      .slice(0, ARC_LIMITS.nameFlags);
  }

  // Checked after both are resolved, so patching only one still validates
  // against the other in applyArcPatch.
  if (patch.fromChapter !== undefined && patch.fromChapter < 1) fail('fromChapter must be 1 or more');
  return patch;
}

/** A blank arc — every field present, so callers never guard on undefined. */
export function emptyArc(id: string, title: string, number: number, fromChapter: number): StoryArc {
  const now = Date.now();
  return {
    id,
    number,
    title,
    premise: '',
    premiseSource: 'author',
    fromChapter,
    toChapter: fromChapter,
    status: 'planning',
    steer: false,
    beats: [],
    blueprints: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function applyArcPatch(existing: StoryArc, patch: ArcPatch): StoryArc {
  const next: StoryArc = {
    ...existing,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.premise !== undefined ? { premise: patch.premise } : {}),
    ...(patch.premiseSource !== undefined ? { premiseSource: patch.premiseSource } : {}),
    ...(patch.previousPremise !== undefined ? { previousPremise: patch.previousPremise } : {}),
    ...(patch.fromChapter !== undefined ? { fromChapter: patch.fromChapter } : {}),
    ...(patch.toChapter !== undefined ? { toChapter: patch.toChapter } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.steer !== undefined ? { steer: patch.steer } : {}),
    ...(patch.beats !== undefined ? { beats: patch.beats } : {}),
    ...(patch.blueprints !== undefined ? { blueprints: patch.blueprints } : {}),
    ...(patch.threads !== undefined ? { threads: patch.threads } : {}),
    ...(patch.timeline !== undefined ? { timeline: patch.timeline } : {}),
    ...(patch.nameFlags !== undefined ? { nameFlags: patch.nameFlags } : {}),
    updatedAt: Date.now(),
  };
  // An inverted range is a typo, not an intention. Clamped rather than
  // rejected so a half-finished edit in the UI cannot 400 on every keystroke.
  if (next.toChapter < next.fromChapter) next.toChapter = next.fromChapter;
  return next;
}

/**
 * Where planning actually starts.
 *
 * An arc can own chapters that are already written — an author who reaches
 * chapter 30 and only then plans will put arc 2 at "21 onwards", so ten of its
 * chapters exist before it has a single blueprint. Those are context, never
 * something to plan again.
 */
export function firstUnplannedChapter(arc: StoryArc, lastWrittenChapter: number): number {
  const planned = arc.blueprints.map((b) => b.chapter);
  const afterWritten = Math.max(arc.fromChapter, lastWrittenChapter + 1);
  const highestPlanned = planned.length > 0 ? Math.max(...planned) : 0;
  return Math.max(afterWritten, highestPlanned + 1);
}

/**
 * Realign an arc after a chapter is deleted.
 *
 * Arcs are the ONLY thing in this app that numbers chapters which do not exist
 * yet. The bible and the map number what a chapter established, so their
 * renumbering is unconditional and safe — there is nothing above the last
 * written chapter to get wrong. A blueprint is the opposite: it is the plan for
 * a chapter that has not been written, and an author twelve chapters in may
 * have twenty planned.
 *
 * That difference is the whole of this function, and getting it wrong was a
 * reported bug. Deleting chapter 12 of 12 written, with 12–16 planned, dropped
 * the plan FOR chapter 12 and slid 13→12, 14→13 and the rest down with it. The
 * author, who deleted the draft in order to rewrite it, lost the plan they were
 * rewriting from and was handed the next chapter's plan in its place — and
 * every chapter after that silently pointed at the wrong plan.
 *
 * `laterChaptersShifted` is what separates the two cases, and it has to be
 * measured rather than inferred from `n`:
 *
 *   Something moved. Chapters above n are now one lower, so the plans that
 *   describe them must follow, and the blueprint for n describes prose that no
 *   longer exists anywhere — position n now holds what used to be n+1, with
 *   its own blueprint arriving to claim it. Dropping it is not a policy choice;
 *   two blueprints cannot share a number.
 *
 *   Nothing moved. n was the last written chapter, so no content changed
 *   position and no plan should either. The author emptied a slot they are
 *   about to fill again. Touching anything here is the app throwing away work
 *   it was not asked to touch — the rule the range clamp below already follows.
 *
 * Ranges shift on the same condition. An arc left with its whole range inside
 * the deleted region keeps from === to rather than being removed: the author
 * wrote that arc, and deleting their planning because they deleted a draft is
 * exactly what this function exists to stop doing.
 */
export function shiftArcAfterChapterDelete(
  arc: StoryArc,
  n: number,
  laterChaptersShifted: boolean
): StoryArc {
  if (!laterChaptersShifted) return arc;
  const shift = (c: number): number => (c > n ? c - 1 : c);
  return {
    ...arc,
    fromChapter: Math.max(1, shift(arc.fromChapter)),
    toChapter: Math.max(1, shift(arc.toChapter)),
    blueprints: arc.blueprints
      .filter((b) => b.chapter !== n)
      .map((b) => ({ ...b, chapter: shift(b.chapter) })),
  };
}
