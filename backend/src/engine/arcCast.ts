/**
 * The cast pass: turning "a dock clerk" into someone the novel knows.
 *
 * The planner is forbidden to invent names, and that rule is right — a silent
 * cast addition is the failure an author finds forty chapters late. But it
 * leaves the plan saying WHAT HAPPENS without saying TO WHOM, and the writer
 * meets "a team lead close to the MC at a company" having to invent both the
 * person and the company on the spot, knowing nothing about either. In the
 * failure this was built for, it named the company after the team lead, because
 * nothing had told it she was junior.
 *
 * So a second pass reads the finished batch and resolves its cast: everyone and
 * everything the chapters lean on, matched to the story bible where the novel
 * already has it and named where it does not. The names go into the plan text,
 * and the entities become real bible entries — which is what lets a name coined
 * while planning chapter 1 be given a meaning in chapter 30 without
 * contradicting anything.
 *
 * ── Why a second pass and not a sixth blueprint field ──
 *
 * The obvious design is to have the planner declare its own cast, and it is
 * wrong for a reason that is the bug restated: the unification is CROSS-CHAPTER
 * and the planner streams. BlueprintStream closes a block when the next header
 * arrives, so runBlueprints can never go back and revise chapter 26 once
 * chapter 29 reveals the same clerk. A declared cast would produce three
 * unrelated rows and three different names for one person. Reading the batch
 * whole is the only way to see that they are the same clerk.
 *
 * It is also the cheaper change. arcAgent runs the only non-Flash model in the
 * app and its own header records that sharpening its rules made it worse; a
 * sixth field in a format tuned against that prompt is not a change worth
 * making for a job a separate call does better. And a pass that reads finished
 * blueprints IS the backfill path, which arcs planned before this shipped need
 * anyway.
 *
 * ── What is enforced in code rather than asked for ──
 *
 * `parseCast` is the enforcement point, in the same shape as nameAgent's
 * `parseChoice` and the bible agent's upsert handler: a bad answer comes back
 * as a tool message the model can correct, never a throw. The load-bearing
 * check is that every mention must actually OCCUR in the chapter it was claimed
 * for — a phrase the model paraphrased cannot be substituted, so a paraphrase
 * has to be caught here rather than discovered as a silent no-op later.
 *
 * Names are drawn by `generateSlate`, not by the model. It is pure,
 * deterministic, free and never empty, and N model calls to name N entities
 * would turn a two-second pass into a thirty-second one. The model-judged
 * coiner is one click away in the review panel, where the author is already
 * looking.
 */

import { ARC_LIMITS } from '../lib/arcValidate.js';
import { BIBLE_LIMITS, slugifyBibleName } from '../lib/bibleValidate.js';
import { applySubstitution, compileRename, type RenamePair } from '../lib/renameText.js';
import {
  BIBLE_ENTRY_TYPES,
  type BibleEntry,
  type BibleEntryType,
  type BlueprintCastMember,
  type CharacterDesign,
  type ChapterBlueprint,
  type Novel,
  type StoryArc,
} from '../lib/types.js';
import type { AgentEvent } from './agent.js';
import { formatBibleIndex } from './bibleTools.js';
import { authorKnownNames } from './arcAgent.js';
import { newNamesInText } from './arcParse.js';
import { fnv1a } from './map/prng.js';
import { resolveCulture, type NamingCharter } from './naming/charter.js';
import { generateSlate } from './naming/generator.js';
import { streamChat, type ChatMessage, type ToolDefinition, type Usage } from './openrouter.js';

/**
 * Gemini Flash Lite rather than the DeepSeek the other background agents use.
 * This pass is verbatim extraction over a long plan — quote every phrase
 * letter-for-letter, hold one row per entity across ten chapters — and the
 * first prod run showed DeepSeek failing at exactly that: paraphrased mentions
 * burned every repair round and the author got the fallback panel. Gemini is
 * fast, cheap, and reliable at quoting its own input back.
 */
export const CAST_MODEL = 'google/gemini-3.5-flash-lite';

/** Rounds available for correcting a bad answer before giving up. */
const MAX_ROUNDS = 3;

/** Names offered per coined entity: one default, the rest as instant chips. */
const ALTERNATIVES = 6;

/** A mention shorter than this is a pronoun or an article, not a role. */
const MENTION_MIN = 4;

/** Members in one cast block. Beyond this a chapter is a crowd scene. */
const BLOCK_MEMBERS = 6;

const EMPTY_USAGE: Usage = {
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
};

// ── Types ─────────────────────────────────────────────────────────────────

/**
 * Where a row came from, which is the thing the author most needs to see.
 *
 *  - `bible`   the novel already owns this. Confirm and move on.
 *  - `unnamed` a role the planner left nameless, being named right now.
 *  - `loose`   a proper noun already in the plan that the bible has never heard
 *              of. Something invented it — refine, an author edit, an older
 *              plan — and nobody has agreed to it. This kind exists because the
 *              first version assumed upstream behaved, and it did not.
 */
export type CastOrigin = 'bible' | 'unnamed' | 'loose';

/** One entity the pass found, before the author has seen it. */
export interface CastCandidate {
  /** Content-hashed, so the same role in a re-run keys the same row. */
  id: string;
  /** What it is, in a few words: "the dock clerk who packs the crates". */
  role: string;
  kind: BibleEntryType;
  /** The bible entry this already is, or null when the novel has never had it. */
  entryId: string | null;
  /** The exact phrases the blueprints use for it. */
  mentions: string[];
  /** Which chapters of the batch it appears in. */
  chapters: number[];
  /** One line for the name generator, and the note the blueprint will carry. */
  brief: string;
  /** False when the plan brings it back once and never again. */
  recurs: boolean;
  /** The name the plan already uses, for a `loose` row. */
  currentName?: string;
}

/** A candidate with a name attached, ready for the author to accept or edit. */
export interface CastMember extends CastCandidate {
  name: string;
  /** Other names from the same slate. Free and instant; unnamed/loose rows. */
  alternatives: string[];
  origin: CastOrigin;
}

/** What a chapter is planned to disclose, and what it must hold back. */
export interface CastContext {
  chapter: number;
  reveals: string[];
  future: string[];
}

export interface CastProposal {
  from: number;
  to: number;
  members: CastMember[];
  context: CastContext[];
}

/** What the author accepted, as the accept route hands it to the substituter. */
export interface CastAssignment {
  name: string;
  /** One line about them, stored on every blueprint they appear in. */
  note: string;
  /** Only when this matched an entry the novel already has. */
  entryId?: string;
  mentions: string[];
  chapters: number[];
}

// ── Pure helpers ──────────────────────────────────────────────────────────

/**
 * Widen a mention leftwards over the article that owns it.
 *
 * "…and a dock clerk tells him…" with a mention of "dock clerk" would
 * otherwise substitute to "a Wenna Skarrow". The model is asked for the article
 * and usually gives it; this is what stops the answer depending on that. A
 * mention that already carries its article cannot widen twice, because the text
 * before it is not another determiner.
 */
const DETERMINER = /(?:\b(?:a|an|the|his|her|their|its|one|some|another)\s+)$/i;

export function expandMention(text: string, mention: string): string {
  const needle = mention.trim();
  if (!needle) return needle;
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index <= 0) return needle;
  const determiner = DETERMINER.exec(text.slice(0, index));
  if (!determiner) return needle;
  // Sliced out of the text rather than rebuilt, so the author's own spacing
  // and capitalisation come across intact.
  return text.slice(index - determiner[0].length, index + needle.length);
}

/** Everything a blueprint says, for occurrence checks and substitution. */
function blueprintText(bp: ChapterBlueprint): string {
  return [bp.opens, bp.turn, bp.lands].filter(Boolean).join(' ') || bp.summary;
}

function normalizeRole(role: string): string {
  return role
    .toLowerCase()
    .replace(/\b(a|an|the|who|that|which|of|in|at|on|for)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Read the model's answer, refusing anything that cannot be acted on.
 *
 * Returns rows, or an error string that goes back as tool output. Never
 * throws: a model that mislabelled one row should fix that row, not lose the
 * batch, and this codebase's other forced-tool agents all take the same shape.
 *
 * Two behaviours here are about round-count, because every repair round is a
 * full re-answer of the whole batch. Problems are COLLECTED and reported in
 * one refusal rather than one per round — the first prod run spent its three
 * rounds being told about one bad mention at a time. And a duplicate row is
 * MERGED rather than refused: the author asked for a deduplicated cast with
 * every phrase mapped to one entity, and code can union two rows' mentions
 * and chapters more reliably than a retry can.
 */
export function parseCast(
  raw: Record<string, unknown>,
  batch: readonly ChapterBlueprint[],
  entries: readonly BibleEntry[],
  /** Names the author already owns. Anything else in the plan must be listed. */
  authorNames?: Set<string>
): CastCandidate[] | string {
  const rows = raw.cast;
  if (!Array.isArray(rows)) return 'Error: cast must be an array. Return an empty array if these chapters need nobody new.';

  const byChapter = new Map(batch.map((bp) => [bp.chapter, blueprintText(bp).toLowerCase()]));
  const chapterList = batch.map((bp) => bp.chapter);
  const known = new Set(entries.map((e) => e.id));
  const out: CastCandidate[] = [];
  const byRole = new Map<string, CastCandidate>();
  const byEntry = new Map<string, CastCandidate>();
  const byName = new Map<string, CastCandidate>();
  const errors: string[] = [];

  for (const item of rows) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;

    const role = String(row.role ?? '').trim();
    if (!role) {
      errors.push('Error: every row needs a role — who or what this is, in a few words.');
      continue;
    }

    const kind = String(row.kind ?? '') as BibleEntryType;
    if (!BIBLE_ENTRY_TYPES.includes(kind)) {
      errors.push(`Error: "${row.kind}" is not a kind. Use one of: ${BIBLE_ENTRY_TYPES.join(', ')}.`);
      continue;
    }

    const entryId = typeof row.entryId === 'string' && row.entryId.trim() ? row.entryId.trim() : null;
    if (entryId && !known.has(entryId)) {
      errors.push(`Error: no story bible entry has the id "${entryId}". Use an id from the index exactly as it is written there, or leave entryId out to say this is new.`);
      continue;
    }

    const chapters = (Array.isArray(row.chapters) ? row.chapters : [])
      .map((c) => Math.round(Number(c)))
      .filter((c) => Number.isFinite(c));
    if (!chapters.length) {
      errors.push(`Error: "${role}" has no chapters. Say which of the chapters you were shown it appears in.`);
      continue;
    }
    const outside = chapters.find((c) => !byChapter.has(c));
    if (outside !== undefined) {
      errors.push(`Error: chapter ${outside} is not one of the chapters you were shown (${chapterList.join(', ')}).`);
      continue;
    }

    const mentions = (Array.isArray(row.mentions) ? row.mentions : [])
      .map((m) => String(m).trim())
      .filter(Boolean);
    if (!mentions.length) {
      errors.push(`Error: "${role}" has no mentions. Quote the phrases the blueprints use for it.`);
      continue;
    }
    let refused = false;
    for (const mention of mentions) {
      if (mention.length < MENTION_MIN) {
        errors.push(`Error: "${mention}" is too short to replace safely. Quote the whole phrase the blueprint uses.`);
        refused = true;
        break;
      }
      // The load-bearing check. A paraphrase substitutes into nothing, and a
      // silent no-op here is a plan that still says "a dock clerk" while the
      // bible has grown a character nobody will ever meet.
      const found = chapters.some((c) => (byChapter.get(c) ?? '').includes(mention.toLowerCase()));
      if (!found) {
        errors.push(`Error: "${mention}" does not appear in ${chapters.length === 1 ? `chapter ${chapters[0]}` : `chapters ${chapters.join(', ')}`}. Quote the phrase exactly as the blueprint writes it, letter for letter, or drop it.`);
        refused = true;
        break;
      }
    }
    if (refused) continue;

    const currentName = entryId ? '' : String(row.currentName ?? '').trim().slice(0, BIBLE_LIMITS.name);
    const flat = normalizeRole(role);
    const twin =
      byRole.get(flat) ??
      (entryId ? byEntry.get(entryId) : undefined) ??
      (currentName ? byName.get(currentName.toLowerCase()) : undefined);
    if (twin) {
      // One entity, two rows — the dedup the pass exists to provide. The union
      // keeps the phrase map complete without spending a round on it.
      twin.mentions = [...new Set([...twin.mentions, ...mentions.map((m) => m.slice(0, ARC_LIMITS.castMention))])];
      twin.chapters = [...new Set([...twin.chapters, ...chapters])].sort((a, b) => a - b);
      twin.recurs = twin.recurs || row.recurs !== false;
      if (!twin.entryId && entryId) {
        twin.entryId = entryId;
        delete twin.currentName;
        byEntry.set(entryId, twin);
      }
      if (!twin.entryId && !twin.currentName && currentName) {
        twin.currentName = currentName;
        byName.set(currentName.toLowerCase(), twin);
      }
      const brief = String(row.brief ?? '').trim();
      if (brief.length > twin.brief.length) twin.brief = brief.slice(0, BIBLE_LIMITS.summary);
      continue;
    }

    // Truncated rather than refused: the author gets the twelve that matter and
    // can run the pass again, which beats losing a good answer to its tail.
    if (out.length >= ARC_LIMITS.castPerBatch) continue;

    const candidate: CastCandidate = {
      id: `c${(fnv1a(`${flat}|${chapters[0]}`) >>> 0).toString(36)}`,
      role: role.slice(0, ARC_LIMITS.castMention),
      kind,
      entryId,
      mentions: [...new Set(mentions)].map((m) => m.slice(0, ARC_LIMITS.castMention)),
      chapters: [...new Set(chapters)].sort((a, b) => a - b),
      brief: String(row.brief ?? '').trim().slice(0, BIBLE_LIMITS.summary),
      recurs: row.recurs !== false,
      ...(currentName ? { currentName } : {}),
    };
    out.push(candidate);
    byRole.set(flat, candidate);
    if (entryId) byEntry.set(entryId, candidate);
    if (currentName) byName.set(currentName.toLowerCase(), candidate);
  }

  if (errors.length) return [...new Set(errors)].join('\n');

  /*
   * The completeness net.
   *
   * Everything above validates what the model DID say. This checks what it left
   * out, and it is the reason the panel can be trusted as a gate: the first
   * version asked the model to list every entity and believed the answer, so a
   * batch full of names invented upstream came back as "nothing needs a name".
   *
   * `authorNames` is deliberately built WITHOUT the arc premise or its beats —
   * those are exactly where a leaked name hides, and including them is what made
   * the original scan blind. A proper noun in the plan that neither the author
   * owns nor the model accounted for goes back as a correctable error.
   */
  if (authorNames && out.length < ARC_LIMITS.castPerBatch) {
    const accounted = new Set<string>();
    for (const row of out) {
      for (const word of [row.currentName ?? '', ...row.mentions].join(' ').split(/[^A-Za-z'’]+/)) {
        if (word) accounted.add(word.toLowerCase());
      }
    }
    const missing = new Map<string, number[]>();
    for (const bp of batch) {
      for (const name of newNamesInText(blueprintText(bp), authorNames)) {
        if (accounted.has(name.toLowerCase())) continue;
        const at = missing.get(name) ?? [];
        if (!at.includes(bp.chapter)) at.push(bp.chapter);
        missing.set(name, at);
      }
    }
    if (missing.size) {
      const [name, chapters] = [...missing.entries()][0];
      return (
        `Error: your list is missing "${name}", which the plan uses in ${
          chapters.length === 1 ? `chapter ${chapters[0]}` : `chapters ${chapters.join(', ')}`
        }. Every name in these chapters needs a row — set currentName to "${name}" and quote it in mentions. ` +
        'The story bible has never heard of it, so the author has to confirm or change it.'
      );
    }
  }

  return out;
}

/**
 * What each chapter is planned to reveal, and what it must hold back.
 *
 * Parsed separately from the cast because it fails separately: a model that
 * lists the cast perfectly and drafts thin context should not lose the cast.
 * Unknown chapters are dropped rather than refused for the same reason.
 */
export function parseCastContext(
  raw: Record<string, unknown>,
  batch: readonly ChapterBlueprint[]
): CastContext[] {
  const valid = new Set(batch.map((bp) => bp.chapter));
  const rows = Array.isArray(raw.context) ? raw.context : [];
  const out: CastContext[] = [];
  const lines = (value: unknown): string[] =>
    (Array.isArray(value) ? value : [])
      .map((v) => String(v).trim().slice(0, ARC_LIMITS.contextLine))
      .filter(Boolean)
      .slice(0, ARC_LIMITS.contextPerBlueprint);

  for (const item of rows) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    const chapter = Math.round(Number(row.chapter));
    if (!Number.isFinite(chapter) || !valid.has(chapter)) continue;
    if (out.some((c) => c.chapter === chapter)) continue;
    const reveals = lines(row.reveals);
    const future = lines(row.future);
    if (reveals.length || future.length) out.push({ chapter, reveals, future });
  }
  return out.sort((a, b) => a.chapter - b.chapter);
}

/**
 * Rewrite one blueprint so the plan reads with the names.
 *
 * Two rules that are not obvious. Pairs are scoped to THIS chapter, so a short
 * phrase like "the clerk" cannot leak into a chapter with a different clerk.
 * And the substitution goes into opens/turn/lands with the summary re-derived,
 * never into the summary directly — the summary IS the three joined, a
 * relationship three other files already depend on, and editing it alone is how
 * the two drift apart. The `||` fallback covers author-edited blueprints, which
 * legitimately have a summary and no parts.
 */
export function substituteCast(
  bp: ChapterBlueprint,
  assignments: readonly CastAssignment[]
): { blueprint: ChapterBlueprint; substituted: number; attempted: number } {
  const mine = assignments.filter((a) => a.chapters.includes(bp.chapter));
  if (!mine.length) return { blueprint: bp, substituted: 0, attempted: 0 };

  const text = blueprintText(bp);
  const pairs: RenamePair[] = [];
  const refs: BlueprintCastMember[] = [];
  for (const a of mine) {
    const expanded = a.mentions.map((m) => expandMention(text, m));
    for (const from of expanded) {
      if (from.toLowerCase() !== a.name.toLowerCase()) pairs.push({ from, to: a.name });
    }
    refs.push({
      name: a.name,
      note: a.note.slice(0, ARC_LIMITS.castNote),
      ...(a.entryId ? { entryId: a.entryId } : {}),
    });
  }

  const re = compileRename(pairs);
  let substituted = 0;
  const rewrite = (value: string): string => {
    if (!re || !value) return value;
    const result = applySubstitution(value, re, pairs);
    substituted += result.count;
    return result.text;
  };

  const opens = rewrite(bp.opens).slice(0, ARC_LIMITS.blueprintPart);
  const turn = rewrite(bp.turn).slice(0, ARC_LIMITS.blueprintPart);
  const lands = rewrite(bp.lands).slice(0, ARC_LIMITS.blueprintPart);
  const summary = ([opens, turn, lands].filter(Boolean).join(' ') || rewrite(bp.summary)).slice(
    0,
    ARC_LIMITS.blueprintSummary
  );

  // Cast refs are merged rather than replaced, so a second pass over a chapter
  // that already had one adds to it instead of forgetting the first.
  // Keyed by name rather than entryId, because most of the cast has no entry —
  // the plan owns them, not the bible.
  const merged = [...(bp.cast ?? [])];
  for (const ref of refs) {
    const at = merged.findIndex((m) => m.name.toLowerCase() === ref.name.toLowerCase());
    if (at === -1) merged.push(ref);
    else merged[at] = ref;
  }

  const blueprint: ChapterBlueprint = {
    ...bp,
    opens,
    turn,
    lands,
    summary,
    cast: merged.slice(0, ARC_LIMITS.castPerBlueprint),
    // Free, and it lights up the "changed" affordance the row already has, so
    // the author can see exactly what the substitution replaced.
    ...(substituted > 0 ? { previousSummary: bp.summary } : {}),
  };
  // `source` is deliberately untouched: putting a name into an author's own
  // sentence does not make the sentence the model's.
  //
  // `attempted` is reported separately from `substituted` so the caller can
  // tell "the phrase is gone, the author edited this chapter" from "there was
  // nothing to replace because the name is already in the text" — which is
  // what a second accept over the same chapter looks like, and is not a
  // problem worth telling anyone about.
  return { blueprint, substituted, attempted: pairs.length };
}

// ── The block the writer reads ────────────────────────────────────────────

function firstClause(text: string): string {
  const clause = text.split(/[.;—]/)[0]?.trim() ?? '';
  return clause.length > 4 ? clause : text.trim();
}

/** The role attribute each kind keeps under a different key. */
const ROLE_KEYS = ['role', 'region', 'controlledBy', 'leader', 'owner', 'user', 'species'];

function roleOf(entry: BibleEntry, design: CharacterDesign | undefined): string {
  const fromDesign = design?.essentials.role.trim();
  if (fromDesign) return fromDesign;
  for (const key of ROLE_KEYS) {
    const value = entry.attributes[key]?.trim();
    if (value) return value;
  }
  return entry.summary.trim() ? firstClause(entry.summary) : entry.type;
}

function clipTo(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Who this chapter's cast are, what it reveals, and what it must not.
 *
 * Built from the BLUEPRINT, which is what changed in v2: the plan carries its
 * own cast rather than the story bible carrying forecasts. Most members have no
 * bible entry at all — they do not exist yet, and their stored `note` is the
 * whole truth about them, which is correct. A member that DID match an entry is
 * enriched from that entry live, so a plan made at chapter 12 and written at
 * chapter 34 describes the character the reader actually has.
 *
 * The reveal/withhold split is formatDesignSheet's, and its doc comment says
 * why: stating plainly what may reach the page and what may not is what makes
 * it safe to tell a writer this much. Applied here to the plan itself, which is
 * the whole reason futureContext can exist — a writer told "the clerk works for
 * the Weavers" with no instruction will hint it forty chapters early.
 */
export function formatCastBlock(
  blueprint: Pick<ChapterBlueprint, 'cast' | 'roles' | 'reveals' | 'futureContext'>,
  entries: readonly BibleEntry[],
  designs: readonly CharacterDesign[],
  opts: { namingOn: boolean }
): string {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const designFor = (entry: BibleEntry): CharacterDesign | undefined =>
    designs.find((d) => d.linkedEntryId === entry.id) ??
    designs.find((d) => d.name.toLowerCase() === entry.name.toLowerCase());

  const cast = (blueprint.cast ?? []).slice(0, BLOCK_MEMBERS);
  // Roles are what the PLANNER wrote, and a named cast supersedes them —
  // see ChapterBlueprint.roles. Reading both would name someone in one line and
  // tell the writer to leave them unnamed in the next.
  const roles = cast.length ? [] : (blueprint.roles ?? []).slice(0, BLOCK_MEMBERS);
  const reveals = blueprint.reveals ?? [];
  const future = blueprint.futureContext ?? [];
  if (!cast.length && !roles.length && !reveals.length && !future.length) return '';

  const lines: string[] = [];

  /*
   * The un-named half of the same job. A chapter planned but not yet cast still
   * knows who is in it, and handing that over matters most precisely here: with
   * no names to anchor them, a writer left to infer the cast invents one, and
   * the next chapter's writer invents a different one. Naming is the author's,
   * so the instruction is to keep the wording rather than to settle it.
   */
  if (roles.length) {
    lines.push('IN THIS CHAPTER — the plan refers to them exactly like this:');
    for (const role of roles) lines.push(`- ${clipTo(role, 110)}`);
    lines.push(
      opts.namingOn
        ? 'The author has not named these yet. Keep the plan\'s wording for anyone unnamed, or coin a name with coin_name — never invent one yourself.'
        : 'The author has not named these yet. Refer to them the way the plan does — "the dock clerk", not a name you chose. Naming them is the author\'s to do.'
    );
  }

  if (cast.length) {
    lines.push('CAST — use these names exactly as written, including for anyone new here.');
    lines.push('Canon in the written chapters always wins over any of it.');

    for (const member of cast) {
      const entry = member.entryId ? byId.get(member.entryId) : undefined;
      const design = entry ? designFor(entry) : undefined;
      const role = clipTo(member.note || (entry ? roleOf(entry, design) : ''), 110);
      const since = entry
        ? `In the story since chapter ${entry.firstChapter}.`
        : 'New to the story here; nothing about them is established yet.';

      const mayUse = entry
        ? [
            entry.summary.trim(),
            ...entry.facts.slice(-2).map((f) => `${f.text.trim()} (ch ${f.chapter})`),
            design?.essentials.voice.trim() ? `speaks: ${design.essentials.voice.trim()}` : '',
            ...(design?.history.secrets ?? []).filter((s) => s.revealed).map((s) => s.text.trim()),
          ].filter(Boolean)
        : [];

      const never = [
        ...(design?.history.secrets ?? []).filter((s) => !s.revealed).map((s) => s.text.trim()),
        design?.motivation.lie.trim() ? `that ${design.motivation.lie.trim()}` : '',
        ...(design?.arcs ?? [])
          .filter((a) => a.state === 'current' && a.summary.trim())
          .map((a) => `where they end up: ${a.summary.trim()}`),
      ].filter(Boolean);

      lines.push('');
      lines.push(`${member.name}${role ? ` — ${role}` : ''}. ${since}`);
      if (mayUse.length) lines.push(`  may use: ${clipTo(mayUse.join('; '), 240)}`);
      if (never.length) lines.push(`  never state or hint: ${clipTo(never.join('; '), 200)}`);
    }
  }

  if (reveals.length) {
    lines.push('');
    lines.push('THIS CHAPTER PUTS IN FRONT OF THE READER:');
    for (const line of reveals) lines.push(`- ${clipTo(line, ARC_LIMITS.contextLine)}`);
  }

  /*
   * The prohibition is stated as a prohibition, not as background. Handed this
   * material without one, a writer treats it as material — which is the failure
   * the arc steer block in context.ts was designed around and records in its own
   * comment.
   */
  if (future.length) {
    lines.push('');
    lines.push('FUTURE CONTEXT — the author knows this; the reader does not, and must not yet.');
    lines.push('Do not state it, hint at it, foreshadow it, or let a character act as if they know it:');
    for (const line of future) lines.push(`- ${clipTo(line, ARC_LIMITS.contextLine)}`);
  }

  if (cast.length) {
    lines.push('');
    // Conditional, because the app already has a right answer for the other case
    // and a blanket ban would over-constrain a chapter that genuinely needs a
    // passing name.
    lines.push(
      opts.namingOn
        ? 'Anything else that needs a name, coin it with coin_name rather than inventing one.'
        : 'Anything else that needs a name, leave unnamed — "the woman who keeps the ledgers" — and the author will name it.'
    );
  }
  return lines.join('\n');
}

// ── The pass ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = [
  'You read a batch of planned chapters and list everyone and everything in them, so the author can name what the story has not named yet.',

  [
    'WHY THIS MATTERS:',
    'The planner is forbidden to invent names, so it writes "a dock clerk" and "the assayer". That is correct, and it leaves the writer to invent those people from nothing when the chapter is finally written — differently each time, and without knowing what the story already decided about them. Your list is what fixes that.',
  ].join('\n'),

  [
    'ONE ROW PER ENTITY, ACROSS THE WHOLE BATCH. This is the part only you can do. If chapter 26 has "a dock clerk", chapter 29 has "the clerk at the quay" and chapter 33 has "the same clerk", that is ONE person and one row, with all three phrases in mentions and all three chapters listed. Rows that split one person into three are the failure this pass exists to prevent. Mentions are the complete map of every distinct phrase the chapters use for the entity — that map is what writes the chosen name into the plan, so a phrase you leave out keeps its old wording.',
  ].join('\n'),

  [
    'COMPLETE MEANS EVERYONE. Every person, place, faction, institution and significant object these chapters lean on gets a row — the unnamed roles most of all, because naming them is the entire point of this pass. The protagonists count: if the plan says "the sister" and "the brother" in every chapter, those are two rows. Ten chapters normally yield eight to twelve rows; a list of one or two is almost always a missed cast, not a spare one.',
  ].join('\n'),

  [
    'MATCH BEFORE YOU ADD. Read the story bible index first. Anything already there gets its id in entryId and needs no name. Only what the novel has genuinely never had is new.',
  ].join('\n'),

  [
    'MENTIONS MUST BE QUOTED EXACTLY, letter for letter, as the blueprint writes them, including the article: "a dock clerk", not "dock clerk" or "the clerk". They are used to find and replace the phrase in the text, so a phrase you paraphrased finds nothing and will be refused.',
  ].join('\n'),

  [
    'A NAME ALREADY IN THE PLAN THAT THE BIBLE DOES NOT HAVE STILL NEEDS A ROW. Something put it there and nobody agreed to it. Give it a row with currentName set to that name, quote the name in mentions, and leave entryId out. Do not skip it because it already looks like a name — the author has to see it.',
  ].join('\n'),

  [
    'RECURS is the judgement call. Set it true for anyone the plan brings back — someone the reader will meet more than once, or a place, faction or object the story turns on. Set it false for a face that passes through one scene. A novel where every waiter has a name is harder to read, not richer, and the author is shown your answer either way.',
  ].join('\n'),

  [
    'CONTEXT — one entry per chapter that needs one, and this is the second half of the job.',
    '`reveals` is what the chapter puts in front of the READER: what they learn, see or are shown for the first time. Not what happens — what lands.',
    '`future` is what the WRITER needs to know and the reader must not be given yet: who someone really works for, what a later beat will turn on, why a detail matters. It is quoted to the writer as a prohibition, so put things here that would spoil the story if stated early. Read the arc description and its beats for these — that is where the payoffs live.',
    'Leave either empty when a chapter genuinely has none. An invented reveal is worse than a missing one.',
  ].join('\n'),

  'Fill the reading object first, from the plan in front of you. Then call resolve_cast once. Nothing else.',
].join('\n\n');

function castToolDefinition(chapters: readonly number[]): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: 'resolve_cast',
      description: 'Everyone and everything these chapters lean on, resolved against the story bible.',
      parameters: {
        type: 'object',
        properties: {
          reading: {
            type: 'object',
            description: 'Read the bible against the plan before you list anything.',
            properties: {
              covered: {
                type: 'string',
                description:
                  'Which of the people and places in these chapters the story bible ALREADY has, by id. Say this before listing anything new.',
              },
              recurring: {
                type: 'string',
                description:
                  'Which unnamed roles appear in more than one of these chapters. Those are the ones that most need names.',
              },
            },
            required: ['covered', 'recurring'],
          },
          cast: {
            type: 'array',
            description: `Up to ${ARC_LIMITS.castPerBatch} rows, one per entity. Empty is a valid answer.`,
            items: {
              type: 'object',
              properties: {
                role: {
                  type: 'string',
                  description: 'Who or what this is, in a few words: "the dock clerk who packs the crates".',
                },
                kind: { type: 'string', enum: [...BIBLE_ENTRY_TYPES] },
                entryId: {
                  type: 'string',
                  description:
                    'An id from the story bible index, when the novel already has this. Leave out entirely when it is new.',
                },
                mentions: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'The phrases the blueprints use for it, quoted exactly as written, including the article.',
                },
                chapters: {
                  type: 'array',
                  items: { type: 'number' },
                  description: `Which chapters it appears in. Only these exist: ${chapters.join(', ')}.`,
                },
                brief: {
                  type: 'string',
                  description:
                    'One line saying what this thing IS, for the name generator and for the story bible. Ignored when entryId is set.',
                },
                recurs: {
                  type: 'boolean',
                  description: 'True only when the plan brings it back. A face that passes through once does not need a name.',
                },
                currentName: {
                  type: 'string',
                  description:
                    'The name the plan ALREADY uses for this, when it uses one the story bible does not have. Leave out for an unnamed role.',
                },
              },
              required: ['role', 'kind', 'mentions', 'chapters', 'recurs'],
            },
          },
          context: {
            type: 'array',
            description: 'One entry per chapter that needs one. Skip chapters with nothing to say.',
            items: {
              type: 'object',
              properties: {
                chapter: { type: 'number', description: `One of: ${chapters.join(', ')}.` },
                reveals: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'What this chapter puts in front of the reader. One short line each.',
                },
                future: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'What the writer must know and the reader must not get yet. Quoted to the writer as a prohibition.',
                },
              },
              required: ['chapter'],
            },
          },
        },
        required: ['reading', 'cast', 'context'],
      },
    },
  };
}

export interface CastPassArgs {
  /** Absent resolves only the proper nouns the planner invented. */
  apiKey: string | null;
  novel: Novel;
  arc: StoryArc;
  charter: NamingCharter;
  /** The blueprints to read. Already persisted; this never writes. */
  batch: readonly ChapterBlueprint[];
  bibleEntries: readonly BibleEntry[];
  designs: readonly CharacterDesign[];
  /** Every name the novel has spent, so a coined one cannot collide. */
  taken: readonly string[];
  signal?: AbortSignal;
  emit?: (event: AgentEvent) => void;
}

export interface CastPassResult {
  proposal: CastProposal;
  usage: Usage;
}

/**
 * Attach a name to every candidate.
 *
 * Existing entities carry their own. New ones are drawn from the procedural
 * generator, with `taken` accumulating as it goes so two new entities in one
 * batch cannot draw the same name — the failure a per-row call would have,
 * because neither row would know about the other.
 */
function nameCandidates(
  candidates: readonly CastCandidate[],
  args: Pick<CastPassArgs, 'novel' | 'charter' | 'bibleEntries'> & { taken: readonly string[] }
): CastMember[] {
  const byId = new Map(args.bibleEntries.map((e) => [e.id, e]));
  const taken = [...args.taken];
  const members: CastMember[] = [];

  for (const candidate of candidates) {
    const existing = candidate.entryId ? byId.get(candidate.entryId) : undefined;
    if (existing) {
      members.push({ ...candidate, name: existing.name, alternatives: [], origin: 'bible' });
      continue;
    }
    const culture = resolveCulture(args.charter, candidate.role);
    const slate = generateSlate({
      novelId: args.novel.id,
      cultureId: culture.id,
      soundWorldId: culture.soundWorldId,
      pack: args.charter.pack,
      type: candidate.kind,
      brief: candidate.brief || candidate.role,
      count: ALTERNATIVES + 1,
      taken,
      banned: args.charter.banned,
    });
    const names = slate.candidates.map((c) => c.name);
    taken.push(...names);
    /*
     * A name the plan already carries stays put by default, and the generated
     * ones become its alternatives. The author is being asked to confirm, not
     * to accept a rename they never asked for — if they liked the name refine
     * invented, one glance and Accept keeps it.
     */
    const loose = Boolean(candidate.currentName);
    members.push({
      ...candidate,
      name: loose ? candidate.currentName! : names[0] ?? candidate.role,
      alternatives: loose ? names.slice(0, ALTERNATIVES) : names.slice(1, ALTERNATIVES + 1),
      origin: loose ? 'loose' : 'unnamed',
    });
  }
  return members;
}

/**
 * The proper nouns the planner invented, as candidates.
 *
 * The no-key path, and the one thing that can be resolved without reading for
 * meaning: `newNames` is already computed by the parser, and a capitalised word
 * the bible has never heard of is unambiguously something that needs an entry.
 */
function candidatesFromNewNames(batch: readonly ChapterBlueprint[]): CastCandidate[] {
  const byName = new Map<string, CastCandidate>();
  for (const bp of batch) {
    const text = blueprintText(bp);
    for (const name of bp.newNames ?? []) {
      if (!text.includes(name)) continue;
      const existing = byName.get(name.toLowerCase());
      if (existing) {
        if (!existing.chapters.includes(bp.chapter)) existing.chapters.push(bp.chapter);
        continue;
      }
      byName.set(name.toLowerCase(), {
        id: `c${(fnv1a(`newname|${name.toLowerCase()}`) >>> 0).toString(36)}`,
        role: name,
        kind: 'character',
        entryId: null,
        mentions: [name],
        chapters: [bp.chapter],
        brief: '',
        recurs: true,
        currentName: name,
      });
    }
  }
  return [...byName.values()].slice(0, ARC_LIMITS.castPerBatch);
}

export async function runCastPass(args: CastPassArgs): Promise<CastPassResult> {
  const emit = args.emit ?? (() => {});
  const batch = [...args.batch].sort((a, b) => a.chapter - b.chapter);
  const range = {
    from: batch[0]?.chapter ?? 0,
    to: batch[batch.length - 1]?.chapter ?? 0,
  };
  const empty: CastPassResult = { proposal: { ...range, members: [], context: [] }, usage: EMPTY_USAGE };
  if (!batch.length) return empty;

  // No key still resolves the names the planner invented — the one part of this
  // that does not need a model to read for meaning.
  if (!args.apiKey) {
    const members = nameCandidates(candidatesFromNewNames(batch), args);
    return { proposal: { ...range, members, context: [] }, usage: EMPTY_USAGE };
  }

  const context = [
    `NOVEL: ${args.novel.title}`,
    args.novel.premise.trim() ? `PREMISE:\n${args.novel.premise.trim()}` : '',
    `STORY BIBLE — everything the novel already has. Match against this before you add anything:\n${
      formatBibleIndex([...args.bibleEntries]) || '(empty)'
    }`,
    args.arc.premise.trim() ? `THE ARC: "${args.arc.title}" — ${args.arc.premise.trim().slice(0, 600)}` : '',
    // The beats are where the payoffs live, and `future` is drafted from them.
    args.arc.beats.length
      ? `ITS BEATS — what this arc is building towards:\n${args.arc.beats.map((b) => `- ${b.text}`).join('\n')}`
      : '',
    /*
     * The planner's own `who` line rides along, and it is the best evidence in
     * the prompt: it was written by whoever wrote the sentences, in the same
     * words, before anything had to be inferred back out of prose. It is a
     * starting point rather than the answer — it can miss someone, and it is
     * not checked against the text the way mentions are — so it is labelled as
     * a claim to verify, not a list to copy.
     */
    `THE CHAPTERS:\n${batch
      .map((bp) => {
        const who = bp.roles?.length ? `\nthe planner says this chapter uses: ${bp.roles.join(', ')}` : '';
        return `### CH ${bp.chapter}${bp.title ? ` — ${bp.title}` : ''}\n${blueprintText(bp)}${who}`;
      })
      .join('\n\n')}`,
    batch.some((bp) => bp.roles?.length)
      ? 'Each chapter above may carry the planner\'s own list of who is in it. Start from those — they are written in the same words the chapter uses, which is what mentions have to quote. Check each against the chapter text, and add anyone the list missed.'
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `${context}\n\nList the cast of these ${batch.length} chapters.` },
  ];

  emit({ type: 'trace', data: `Reading chapters ${range.from}–${range.to} for their cast…` });

  const chapters = batch.map((bp) => bp.chapter);
  /*
   * Built from the bible, designs and the novel — deliberately WITHOUT the arc
   * premise or its beats. Those are precisely where a leaked name hides, and
   * including them is what made the blueprint scan blind to the leak that broke
   * the first version of this feature.
   */
  const authorNames = authorKnownNames({
    novel: args.novel,
    arcPremise: '',
    bibleEntries: args.bibleEntries,
    designs: args.designs,
  });
  let total = { ...EMPTY_USAGE };
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (round > 0) emit({ type: 'trace', data: 'Correcting the list…' });
    const result = await streamChat({
      apiKey: args.apiKey,
      model: CAST_MODEL,
      messages,
      tools: [castToolDefinition(chapters)],
      // Forced: the list IS the deliverable, and there is nothing useful this
      // agent could say in prose instead.
      toolChoice: { type: 'function', function: { name: 'resolve_cast' } },
      /*
       * Twelve rows and ten chapters of reveals/future context do not fit in
       * 2000 tokens — the original budget — and a truncated tool call fails
       * JSON.parse, which sent every round of the first prod run into the same
       * deterministic refusal until the pass gave up with an all-but-empty
       * panel. The budget has to fit the worst honest answer.
       */
      maxTokens: 8000,
      // Every batch carries a different plan, so there is no cached prefix for
      // a pin to protect.
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
      messages.push({ role: 'user', content: 'Call resolve_cast now.' });
      continue;
    }

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    if (parsed === null) {
      // Broken JSON is its own failure, named as such — parsing it as an empty
      // object turns "you ran out of room" into "cast must be an array", and a
      // model told the wrong problem repeats the right mistake.
      messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content:
          result.finishReason === 'length'
            ? 'Error: the call was cut off before the JSON closed. Answer again more concisely — shorter reveals and future lines, and skip chapters with nothing to say. Keep every cast row.'
            : 'Error: the arguments were not valid JSON. Call resolve_cast again.',
      });
      continue;
    }

    const candidates = parseCast(parsed, batch, args.bibleEntries, authorNames);
    if (typeof candidates !== 'string') {
      const members = nameCandidates(candidates, args);
      const context = parseCastContext(parsed, batch);
      const fresh = members.filter((m) => m.origin !== 'bible').length;
      const loose = members.filter((m) => m.origin === 'loose').length;
      console.log(
        `[cast] novel=${args.novel.id} arc=${args.arc.id} chapters=${range.from}-${range.to} ` +
          `rows=${members.length} needing=${fresh} loose=${loose} cost=$${total.cost.toFixed(5)}`
      );
      emit({
        type: 'trace',
        data: fresh
          ? `${members.length} in the cast, ${fresh} to confirm`
          : `${members.length} in the cast, all known`,
      });
      return { proposal: { ...range, members, context }, usage: total };
    }

    messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });
    messages.push({ role: 'tool', tool_call_id: call.id, content: candidates });
  }

  // Three rounds of a model unable to quote its own input back is a model
  // problem. The blueprints are already saved, so the author loses nothing but
  // this pass, and the invented proper nouns are still worth resolving.
  console.log(`[cast] novel=${args.novel.id} arc=${args.arc.id} gave up after ${MAX_ROUNDS} rounds`);
  const fallback = nameCandidates(candidatesFromNewNames(batch), args);
  return { proposal: { ...range, members: fallback, context: [] }, usage: total };
}

/** The id a coined entity will get, so the accept route can check for twins. */
export function castEntryId(name: string): string {
  return slugifyBibleName(name);
}
