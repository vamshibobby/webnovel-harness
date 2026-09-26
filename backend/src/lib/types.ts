import type { StyleKey } from '../engine/styles.js';

export interface Novel {
  id: string;
  ownerUid: string;
  title: string;
  premise: string;
  styleNotes: string;
  /**
   * Writing style dial, chosen at creation and immutable thereafter — it is
   * baked into the cached system prompt. See engine/styles.ts.
   */
  style: StyleKey;
  defaultModel: string;
  /** Target words per chapter. 0 leaves it to the model. */
  chapterLength: number;
  chapterCount: number;
  /**
   * Total words across all chapters. Maintained by delta at every content
   * write; lazily backfilled by getNovel for novels created before the field
   * existed, so it can be absent in Firestore but never in code.
   */
  wordCount: number;
  /**
   * Kept out of the dashboard and reachable only through the PIN-protected
   * vault (Settings → Access Novels). Absent on novels written before the
   * feature existed, which reads as `false`.
   */
  hidden: boolean;
  /**
   * Story bible behaviour. 'accept' updates the bible as part of every accept;
   * 'batch' defers to an explicit catch-up run; 'off' makes no bible calls at
   * all. Absent on older novels, which reads as the default ('accept').
   */
  bibleMode?: BibleMode;
  /**
   * High-water mark: the last chapter whose content is reflected in the bible.
   * What makes batch mode, backfill and enabling-the-bible-late all the same
   * operation — "update from bibleChapter + 1". Absent reads as 0.
   */
  bibleChapter?: number;
  /**
   * Character designs. Absent reads as 'off' — the opposite default from the
   * bible, and deliberately so: a design states intent for a character, and
   * intent pressed into generation is a sharper instrument than recorded canon.
   * Authors opt in.
   */
  designMode?: DesignMode;
  /**
   * The Atlas. 'accept' extracts geography from every accepted chapter;
   * 'manual' keeps the map author-driven only (dictation, sketch, explicit
   * catch-up); 'off' hides the feature. Absent reads as 'off' — maps are
   * visualization only, so they are opt-in like designs.
   */
  mapMode?: MapMode;
  /**
   * High-water mark: the last chapter whose geography is reflected in the map.
   * Same contract as bibleChapter. Absent reads as 0.
   */
  mapChapter?: number;
  /**
   * Next-chapter directions, proposed at accept time. Absent reads as 'on' —
   * unlike designs and the map this sits on the main writing loop rather than
   * beside it, and one cheap call per accept is a fair price for never facing
   * an empty box. Authors who want the box empty turn it off.
   */
  suggestMode?: SuggestMode;
  /**
   * Arc planning. Absent reads as 'off', for the same reason as designs: a plan
   * pressed into generation is a sharper instrument than recorded canon, and an
   * author who has not asked for one should never pay for it.
   */
  arcMode?: ArcMode;
  /**
   * Name generation. Absent reads as 'off'. Unlike every other mode this one
   * costs nothing to run — the writer's coin_name tool is pure local code, and
   * only the on-demand generator on the Naming page makes a model call — so the
   * reason it is opt-in is not price. It changes how the writer names things,
   * and a novel already half-written has a register the author chose.
   */
  namingMode?: NamingMode;
  /**
   * Serials — the public reading feature. All absent on an unpublished novel,
   * the `hidden` pattern. `publicSlug` is minted once at first publish and
   * never changes (links must survive renames). `publishedChapters` is a
   * high-water mark: chapters 1..N are public — serials are sequential, and a
   * mark avoids per-chapter flags that a full-doc save could clobber.
   * INVARIANT: a hidden novel is never publicly reachable, whatever
   * `published` says — enforced at the public loader, asserted in tests.
   */
  published?: boolean;
  publicSlug?: string;
  publishedChapters?: number;
  /** 'auto' publishes each chapter as it is accepted. Absent reads as 'manual'. */
  publishMode?: PublishMode;
  /** Author-declared mature content — readers see a warning gate first. */
  mature?: boolean;
  /** Public byline. Empty renders as "Anonymous"; the account is never shown. */
  penName?: string;
  publishedAt?: number;
  /** Words across the published chapters only; recomputed on publish/bump. */
  publishedWords?: number;
  /** Reader opens, counted once per session per novel. Best-effort. */
  viewCount?: number;
  /**
   * Public cover image URL (our GCS covers bucket). Uploaded or AI-generated
   * by the author; absent falls back to the deterministic letter cover the
   * dashboard already draws.
   */
  coverUrl?: string;
  createdAt: number;
  updatedAt: number;
}

export type PublishMode = 'manual' | 'auto';

export interface SerialComment {
  id: string;
  chapter: number;
  /** Typed by the reader, unauthenticated. Bounded; defaults to "Reader". */
  name: string;
  text: string;
  createdAt: number;
  /** Opaque random localStorage token for cooldowns — not an identity. */
  clientId: string;
}

export type BibleMode = 'off' | 'accept' | 'batch';

export type SuggestMode = 'off' | 'on';

export type MapMode = 'off' | 'manual' | 'accept';

export type ArcMode = 'off' | 'on';

export type NamingMode = 'off' | 'on';

/** Entity kinds the story bible tracks. One collection, one search surface. */
export type BibleEntryType =
  | 'character'
  | 'faction'
  | 'location'
  | 'item'
  | 'weapon'
  | 'creature'
  | 'technique'
  | 'concept'
  | 'event';

export const BIBLE_ENTRY_TYPES: readonly BibleEntryType[] = [
  'character',
  'faction',
  'location',
  'item',
  'weapon',
  'creature',
  'technique',
  'concept',
  'event',
] as const;

/**
 * One atomic claim about an entity, with chapter provenance so deleting or
 * renumbering chapters can keep the log honest.
 */
export interface BibleFact {
  text: string;
  chapter: number;
  /** When canon changed, the text of the fact this one replaces. */
  supersedes?: string;
}

/**
 * A story bible entry, at `novels/{id}/bible/{entryId}`.
 *
 * The shape splits mutable state (`status`, `attributes`) from an append-only
 * fact log: a character's death updates `status` AND appends a fact, so the
 * current truth is cheap to read while the history stays intact.
 */
export interface BibleEntry {
  /** Slug of the name, e.g. "kael-veyron". Doc id. */
  id: string;
  type: BibleEntryType;
  name: string;
  /** Synonyms, titles, nicknames — the search surface for dedup and retrieval. */
  aliases: string[];
  /** One or two sentences, kept current. */
  summary: string;
  /** Mutable one-word-ish state: alive, dead, destroyed, disbanded, unknown… */
  status: string;
  /** Flat per-type keys (character: role/appearance/voice…; see bibleAgent). */
  attributes: Record<string, string>;
  facts: BibleFact[];
  relationships: Array<{ targetId: string; nature: string }>;
  firstChapter: number;
  createdAt: number;
  updatedAt: number;
}

// ── Character designs ─────────────────────────────────────────────────────

export type DesignMode = 'off' | 'on';

/**
 * Only 'active' designs are visible to generation. Drafts are the author's
 * workspace — a character can be reworked across several drafts without any
 * of it reaching a chapter — and 'retired' keeps a superseded design readable
 * without deleting the thinking behind it.
 */
export type DesignState = 'draft' | 'active' | 'retired';

export type ArcState = 'potential' | 'current' | 'done' | 'dropped';

/**
 * A planned character arc. The device names the shape (see designCatalog);
 * `stages` breaks it into beats so "redemption arc" becomes something the
 * generation agent can act on — it is told where the arc stands, not just
 * where it ends.
 */
export interface DesignArc {
  /** An ARC_DEVICES id, or 'custom'. */
  device: string;
  /** Required when device is 'custom'. */
  customLabel?: string;
  summary: string;
  stages: string[];
  /** Index into stages. */
  currentStage: number;
  /** The steer note injected with the arc line — how to lean, not what to do. */
  nudge: string;
  state: ArcState;
}

/**
 * A fact about the character's past. `revealed` is the true-vs-known split:
 * an unrevealed secret shapes how the character behaves and must never be
 * narrated, which is exactly what the sheet formatter enforces.
 */
export interface DesignSecret {
  text: string;
  revealed: boolean;
}

export interface DesignRelationship {
  /** A bible entry id or another design's id, per targetKind. */
  targetId: string;
  targetKind: 'bible' | 'design';
  /** What the relationship is now. */
  nature: string;
  /** Where the author wants it to go. Author-private. */
  intent: string;
}

/**
 * A character design, at `novels/{id}/designs/{designId}`.
 *
 * The story bible's counterpart, pointed the other way: the bible records
 * what the novel has established, a design states what the author intends —
 * past AND potential future. Deliberately carries no chapter provenance,
 * which is why deleting or renumbering chapters never touches designs.
 */
export interface CharacterDesign {
  /** Slug of the name at creation time. Doc id. */
  id: string;
  name: string;
  /** The bible entry for the same character, when one exists. The only join. */
  linkedEntryId?: string;
  state: DesignState;
  /** When true and an arc is 'current', its steer line rides in every prompt. */
  steer: boolean;
  essentials: { role: string; age: string; appearance: string; voice: string };
  /** want vs need, plus the fear and the lie that hold them apart. */
  motivation: { want: string; need: string; fear: string; lie: string };
  personality: { traits: string[]; flaws: string[]; virtues: string[] };
  history: { backstory: string; secrets: DesignSecret[] };
  arcs: DesignArc[];
  relationships: DesignRelationship[];
  notes: string;
  createdAt: number;
  updatedAt: number;
}

// ── Power systems ─────────────────────────────────────────────────────────

/**
 * Who authored a power system as it currently stands. The naming charter's
 * `source` field, one level up: never shown to a model, it exists so the UI
 * can say "we designed this" versus "you wrote this" versus "both".
 */
export type PowerSource = 'model' | 'author' | 'mixed';

/**
 * One tier of a system's ladder. Array order in `PowerSystem.ranks` IS the
 * ladder, weakest first — there is no separate order field to drift.
 */
export interface PowerRank {
  /** Slug of the name, unique within the system. */
  id: string;
  /** "Foundation Establishment", "Knight-Errant", "Level 30". */
  name: string;
  /** One line: what this tier means in the world. */
  summary: string;
  /** What one CAN DO at this level — atomic claims, the writer's hard limits. */
  capabilities: string[];
  /** The typical skillset at this rank. */
  skills: string[];
  /** How one reaches THIS rank from the one below. */
  advancement: string;
  /** Population feel: "one in a thousand cultivators". */
  rarity: string;
  /** Bible entries (type character) known to stand at this rank. */
  characterIds: string[];
  note: string;
}

/**
 * A profession, class or path that practises the system. Professions branch
 * off the system's shared ladder; a profession with a genuinely separate
 * ladder is a second system, which multiple-systems-per-novel makes cheap.
 */
export interface PowerProfession {
  /** Slug of the name, unique within the system. */
  id: string;
  name: string;
  aliases: string[];
  summary: string;
  /** Combat/social function in the world: "front-line duelist", "support". */
  role: string;
  /** Only where it diverges from the shared ladder. */
  advancement: string;
  signatureSkills: string[];
  /** Bible entries (type faction) that teach or gatekeep it. */
  factionIds: string[];
  /** Bible characters practising it. */
  characterIds: string[];
  note: string;
}

/**
 * A technique, weapon or item that scales with the system — a LINK to a bible
 * entry, never a copy. The bible describes the thing; the power system owns
 * only the scaling relationship. "No second place to describe one."
 */
export interface PowerArtifact {
  /** Bible entry id, type technique | weapon | item. */
  entryId: string;
  /** How it grows: "sharpens with the wielder's core rank". */
  scaling: string;
  /** Rank at which it becomes usable or relevant, when tied to one. */
  rankId?: string;
  note: string;
}

/** The general power level of a country or region, as rank references. */
export interface RegionalPowerLevel {
  /** Display name, free text: "the Western Marches". */
  region: string;
  /** Bible entry (type location) when the novel has one. */
  locationEntryId?: string;
  /** The common ceiling there. */
  typicalRankId: string;
  /** Strongest known presence, when it differs from the typical. */
  apexRankId?: string;
  /** "the sect wars drained its experts". */
  note: string;
}

/**
 * A power system, at `novels/{id}/power/{systemId}`.
 *
 * The bible's counterpart for scaling: bible entries describe entities, a
 * power system owns the LADDER — ranks, what each permits, how one climbs,
 * and how techniques, professions and regions hang off it. Like a
 * CharacterDesign it is a document the author owns, not a fact log, and it
 * deliberately carries no chapter provenance — deleting or renumbering
 * chapters never touches it.
 */
export interface PowerSystem {
  /** Slug of the name. Doc id. */
  id: string;
  name: string;
  summary: string;
  source: PowerSource;
  /** The resource: qi / mana / aether / grace. '' when the system has none. */
  energyName: string;
  /** System-wide price of power: taboos, backlash, hard limits. */
  costsAndLimits: string;
  /** Overall population distribution across the ranks. */
  rarityNote: string;
  /** Comparability against the novel's other systems. '' for a lone system. */
  crossSystemNote: string;
  /** The ladder, weakest first. */
  ranks: PowerRank[];
  professions: PowerProfession[];
  artifacts: PowerArtifact[];
  regions: RegionalPowerLevel[];
  /** Undecided things — a generator names gaps here rather than inventing. */
  openQuestions: string[];
  createdAt: number;
  updatedAt: number;
}

// ── Story arcs ────────────────────────────────────────────────────────────

/**
 * What a chapter is made of, as a closed vocabulary.
 *
 * Flat on purpose — a structural axis was considered and dropped. A closed
 * list is what makes tags worth having: free text drifts into synonyms
 * ("fight", "combat", "battle") and stops being scannable across fifty
 * chapters. A tag outside the list is dropped rather than rejected, because a
 * vocabulary miss is not worth losing a good chapter description over.
 */
export const ARC_TAGS = [
  'action', 'battle', 'training', 'tournament', 'romance', 'emotional', 'comedy',
  'drama', 'tragedy', 'horror', 'mystery', 'investigation', 'revelation', 'betrayal',
  'political', 'intrigue', 'business', 'negotiation', 'worldbuilding', 'lore', 'travel',
  'slice-of-life', 'downtime', 'flashback', 'timeskip', 'introduction', 'reunion',
  'chase', 'heist', 'siege', 'ritual', 'crafting', 'trial', 'cliffhanger', 'r18',
] as const;

export type ArcTag = (typeof ARC_TAGS)[number];

/** Who wrote a given beat or blueprint. The merge indicator, stored. */
export type ArcSource = 'author' | 'model';

export type ArcStatus = 'planning' | 'active' | 'done' | 'abandoned';

/**
 * One intention in an arc. `previousText` is set only when the model rewrote
 * something the author had already written, so the UI can show what changed
 * instead of silently replacing it.
 */
export interface ArcBeat {
  id: string;
  text: string;
  source: ArcSource;
  previousText?: string;
}

/**
 * Someone or something a planned chapter needs, by name.
 *
 * The plan carries its own cast rather than the story bible carrying it. An
 * earlier version wrote these into the bible as "planned" entries, and that was
 * wrong twice over: the bible is a record of what reached the page, so filling
 * it with forecasts corrupts the thing every other agent reads as canon, and
 * the marker went stale the moment the bible agent declined to record a minor
 * character. The bible is now written only after a chapter is generated, as it
 * always was, and the plan is self-sufficient.
 *
 * `entryId` is set ONLY when this matched an entry the novel already has, and
 * is what lets the import block enrich a known character with their current
 * facts. For someone the plan invented it is absent, and `note` is all there is
 * — which is correct, because there is nothing else true about them yet.
 */
export interface BlueprintCastMember {
  name: string;
  /** Who or what this is, one line: "a dock clerk at the Salt Quay". */
  note: string;
  /** The story bible entry this is, when the novel already has one. */
  entryId?: string;
}

/**
 * A planned chapter.
 *
 * opens/turn/lands rather than one summary, because a single free-text field
 * reliably produces one beat dressed as a chapter — see the spike findings in
 * research/arcplan. `summary` is the three joined, and is what the composer
 * imports.
 */
export interface ChapterBlueprint {
  chapter: number;
  title: string;
  tags: string[];
  summary: string;
  opens: string;
  turn: string;
  lands: string;
  source: ArcSource;
  /**
   * Ids of the ArcThreads this chapter carries. One for most chapters, two or
   * three when storylines weave. Absent on single-storyline and legacy plans.
   */
  threads?: string[];
  /**
   * Where the chapter sits on the arc's clock. `day` counts from the arc
   * opening; `hint` is the phrase a reader would feel ("a week after ch 34").
   * The integer is what the braid validator checks — prose proves nothing.
   */
  time?: { day: number; hint?: string };
  previousSummary?: string;
  /**
   * Proper nouns this blueprint uses that the story bible has never heard of.
   * The planner is told not to invent names and the chosen model does not, but
   * a silent cast addition is the one failure an author would not notice until
   * forty chapters later, so it is surfaced rather than trusted.
   */
  newNames?: string[];
  /**
   * The named cast of this chapter, once the author has accepted a cast pass
   * for it. Absent until then, which is exactly what the button reads.
   */
  cast?: BlueprintCastMember[];
  /**
   * Who and what the chapter uses, as the PLANNER wrote them: "the sister",
   * "a bully at school", "the workshop". Unnamed roles, except where the story
   * bible already owns the name.
   *
   * Deliberately not merged into `cast`. A cast member's `name` is a settled
   * name — the import block tells the writer to use it exactly as written, and
   * the cast pass substitutes it into the plan text. "A dock clerk" is neither
   * of those things, and putting it there would tell the writer to name someone
   * "a dock clerk" and leave a stale row behind after the rename.
   *
   * The rule that keeps the two honest, applied by every reader: `roles` is
   * read ONLY when `cast` is empty. Naming the cast supersedes it.
   */
  roles?: string[];
  /**
   * What this chapter is planned to put in front of the reader.
   *
   * Separate from opens/turn/lands because "what happens" and "what the reader
   * learns" are different questions, and a writer given only the first will
   * either withhold the revelation or spend it twice.
   */
  reveals?: string[];
  /**
   * What the writer needs to know and the reader must not be given yet.
   *
   * The reason this exists at all: a plan that tells the writer the clerk works
   * for the Weavers gets a chapter that hints the clerk works for the Weavers,
   * forty chapters early. Marked as author-private and stated as a prohibition
   * in the import block — the same split formatDesignSheet already makes for a
   * character's unrevealed secrets, applied to the plan.
   */
  futureContext?: string[];
}

/**
 * A story arc, at `novels/{id}/arcs/{arcId}`.
 *
 * Owns a chapter RANGE, always. The range is elastic: writing past `toChapter`
 * is allowed and simply surfaced, because a plan that blocks writing is worse
 * than a plan that is out of date. It may also start behind the story — an
 * author who reaches chapter 30 and only then plans will say "arc 1 was 1–20,
 * arc 2 starts at 21", so an arc can own written chapters it never planned.
 */
export type ThreadAnchor = 'early' | 'mid' | 'late' | 'span' | 'specific';

/**
 * One storyline of a braided arc.
 *
 * The author's numbered list, made structural. Everything downstream that
 * used to re-derive "which storyline is this" from prose reads this instead:
 * the planner is handed the list, the braid validator checks the plan against
 * it, and the screen shows it back as chips.
 */
export interface ArcThread {
  /** Content-hashed from the label, so a re-refine keys the same thread. */
  id: string;
  /** The author's own words for it. Never the model's paraphrase. */
  label: string;
  /** Its number in the author's list, when they wrote one. */
  authorNumber?: number;
  /** Where in the arc this thread lives. */
  anchor: ThreadAnchor;
  /** The author's own timing phrase: "in the eighth month". */
  anchorNote?: string;
  /** Thread ids this one cannot resolve before. Effect-before-cause is checked against it. */
  dependsOn?: string[];
  /** The author said this is unresolved when the arc ends. */
  endsOpen?: boolean;
  /** Planted for the next arc: one or two chapters of glimpse, never a resolution. */
  seedForNextArc?: boolean;
  /** How much room it needs. Drives the rotation expectation, not a hard cap. */
  weight?: 'major' | 'minor';
  source: ArcSource;
}

/** The arc's clock. Relative days from the arc opening; no calendar, ever. */
export interface ArcTimeline {
  spanDays?: number;
  /** The author's phrase: "over the next eight months". */
  note?: string;
}

/**
 * A proper noun in the refined plan that nobody has agreed to. Never fatal:
 * the refine saves and the flag rides along for the author to keep or revert,
 * and the cast pass offers to make a kept one real.
 */
export interface ArcNameFlag {
  name: string;
  where: 'premise' | 'beat';
  beatId?: string;
  at: number;
}

export type ArcStageName = 'threads' | 'refine' | 'plan' | 'braid';

/** What the last run of one pipeline stage did, shown next to its button. */
export interface ArcStageRecord {
  status: 'ok' | 'partial' | 'failed';
  at: number;
  message?: string;
  issues?: string[];
}

export type ArcStageState = Partial<Record<ArcStageName, ArcStageRecord>>;

// ── The braid report: what Stage D found ──────────────────────────────────

export type BraidFindingKind =
  | 'thread-never-planned'
  | 'thread-dark'
  | 'blocked-run'
  | 'effect-before-cause'
  | 'clock-backwards'
  | 'clock-drift'
  | 'resolved-open-thread'
  | 'anchor-missed';

export interface BraidFinding {
  kind: BraidFindingKind;
  /** What the author reads. Also what the next batch's prompt is told. */
  message: string;
  chapters: number[];
  threads: string[];
  severity: 'break' | 'warn';
}

/** Where every thread stands after a batch. Deterministic; never a model's opinion. */
export interface BraidReport {
  at: number;
  /** Chapter range the report describes. */
  from: number;
  to: number;
  clocks: Array<{
    id: string;
    lastChapter: number | null;
    lastDay: number | null;
    count: number;
    /** Planned chapters since this thread last appeared. */
    darkFor: number;
  }>;
  findings: BraidFinding[];
  /** Chapters carrying 2+ threads, over chapters placed. */
  weaveRate: number;
  /** Longest unbroken run of chapters on one thread. */
  longestRun: number;
  /** Blueprints with no resolvable thread. A count, never a failure. */
  unplaced: number;
}

export interface StoryArc {
  /** Slug of the title at creation. Doc id. */
  id: string;
  /** Display order, and what the author calls it: "arc 2". */
  number: number;
  title: string;
  /** The arc's description. Author-written until a refine or an AI edit. */
  premise: string;
  /**
   * Who wrote the description as it currently stands, and what it replaced.
   *
   * The author's own words are never overwritten silently: a refine keeps the
   * previous text so the screen can show what changed and the author can put
   * it back. Same contract as ArcBeat.previousText, one level up.
   */
  premiseSource?: ArcSource;
  previousPremise?: string;
  fromChapter: number;
  toChapter: number;
  status: ArcStatus;
  /** When true, a few restrained lines of arc context ride in every prompt. */
  steer: boolean;
  beats: ArcBeat[];
  blueprints: ChapterBlueprint[];
  /**
   * The storylines running through this arc. Absent on single-storyline and
   * legacy arcs — every reader must treat "no threads" as "nothing to check",
   * never as broken.
   */
  threads?: ArcThread[];
  timeline?: ArcTimeline;
  /** Names the refine used that nobody agreed to. Author clears or reverts. */
  nameFlags?: ArcNameFlag[];
  /** Stage D's report on the plan as it stands. Pipeline-owned. */
  braid?: BraidReport;
  /** What each pipeline stage last did. Pipeline-owned; not PATCHable. */
  stages?: ArcStageState;
  createdAt: number;
  updatedAt: number;
}

/**
 * Per-account vault state, at `users/{uid}`. Only ever written by the vault
 * routes; the PIN itself is never stored, only its scrypt hash.
 */
export interface VaultProfile {
  pinHash: string;
  pinSalt: string;
  /**
   * HMAC key for unlock tokens. Rotated whenever the PIN changes, which is what
   * makes outstanding tokens die with the old PIN.
   */
  tokenSecret: string;
  /** Consecutive wrong PINs; reset by a correct one. */
  failedAttempts: number;
  /** Epoch ms before which unlock attempts are refused. 0 when not locked. */
  lockedUntil: number;
  updatedAt: number;
}

export type ChapterStatus = 'draft' | 'accepted';

/**
 * How far a proposed direction departs from where the story is pointing.
 *
 * Three, and in this order, because the choice an author actually faces at the
 * end of a chapter is not "which idea is best" but "how hard do I turn the
 * wheel". Offering three variations of the same intensity is the failure mode
 * this dial exists to prevent.
 */
export type SuggestionMove = 'follow' | 'complicate' | 'swerve';

export const SUGGESTION_MOVES: readonly SuggestionMove[] = [
  'follow',
  'complicate',
  'swerve',
] as const;

/** One proposed direction for the chapter that has not been written yet. */
export interface ChapterSuggestion {
  move: SuggestionMove;
  /** A handle, three to six words. Shown on the card. */
  title: string;
  /**
   * The instruction itself — what lands in the composer when the author picks
   * this one. Written the way an author writes to the model, not as prose.
   */
  prompt: string;
  /** One line on what this buys the story. Shown, but never sent to the model. */
  rationale: string;
}

export interface Chapter {
  number: number;
  title: string;
  content: string;
  status: ChapterStatus;
  summary: string;
  userPrompt: string;
  revisionNotes: string[];
  model: string;
  /**
   * Three directions for the chapter AFTER this one, proposed when this one was
   * accepted. They live on the chapter they were read from rather than the one
   * they are for, because that chapter has no document yet — and because
   * renumbering after a delete then carries them along automatically.
   *
   * Dropped whenever this chapter's text is edited: they describe an ending
   * that no longer exists.
   */
  nextSuggestions?: ChapterSuggestion[];
  /**
   * Earlier states of this chapter's text, newest last. Each entry is the text
   * as it stood BEFORE the change named by its `kind` — so restoring one undoes
   * everything after it. See lib/versions.ts for why they live in this document
   * rather than a subcollection.
   */
  versions?: ChapterVersion[];
  createdAt: number;
  updatedAt: number;
}

/** What replaced a snapshot. Named for the change, not for the snapshot. */
export type VersionKind = 'generate' | 'revise' | 'humanize' | 'edit' | 'inline' | 'restore';

export interface ChapterVersion {
  title: string;
  content: string;
  /** When the snapshot was displaced. */
  at: number;
  kind: VersionKind;
  /** The revision note or inline instruction that replaced it, when there was one. */
  note?: string;
}

export interface ChapterMeta {
  number: number;
  title: string;
  status: ChapterStatus;
  /** Computed from content at read time — never stored. */
  wordCount: number;
  updatedAt: number;
}
