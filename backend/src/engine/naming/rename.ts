/**
 * Renaming something everywhere it appears.
 *
 * This is the most valuable thing in the naming feature and the one an author
 * needs whether or not they ever use the generator: a novel forty chapters in
 * whose protagonist is called Elara is not helped by better names for the next
 * forty. So it is deliberately NOT gated on `namingMode` — it is a data
 * integrity operation, not a feature of the coiner.
 *
 * `planRename` is pure. It takes documents already loaded and returns both the
 * report and the rewritten documents; the route loads, calls it, and writes,
 * while the preview calls the same function and throws the rewrites away. One
 * code path means the preview cannot promise something the apply does not do.
 *
 * WHAT IS NEVER REWRITTEN, and why: ids. A bible entry's id is a foreign key in
 * `CharacterDesign.linkedEntryId`, `GeoEntity.id`, `GeoEntity.bibleEntryId`,
 * `BibleEntry.relationships[].targetId`, every `GeoRelation`, and — decisively —
 * the solved map layout, whose positions and polygons are KEYED by entity id
 * and stored as an opaque JSON string. Keeping ids stable means the layout is
 * not touched at all. A slug that no longer matches its name looks like a bug
 * forever; it is the cheapest correct answer available.
 */

import { applyRename, applyRenameAll, compileRename, countRename, type RenamePair } from '../../lib/renameText.js';
import { countWords } from '../../lib/store.js';
import type { BibleEntry, Chapter, CharacterDesign, Novel, StoryArc } from '../../lib/types.js';
import type { GeoMap } from '../map/types.js';

export type { RenamePair };

export type RenameKind = 'novel' | 'bible' | 'design' | 'arc' | 'map' | 'chapter';

export interface RenameHit {
  kind: RenameKind;
  /** Doc id, or the chapter number as a string. */
  id: string;
  /** What the author calls it on screen. */
  label: string;
  field: string;
  count: number;
  samples: string[];
}

export interface RenameOptions {
  /** Rewrite already-written prose. The expensive, irreversible half. */
  includeChapters: boolean;
  /** Rewrite the premise and author's notes. On by default: both are prompted. */
  includeNovelText: boolean;
  /** Rewrite the novel's own title. Off by default — usually not what is meant. */
  renameNovelTitle: boolean;
  /** Keep the old name as an alias on the bible entry. */
  keepOldAsAlias: boolean;
}

export const DEFAULT_RENAME_OPTIONS: RenameOptions = {
  includeChapters: true,
  includeNovelText: true,
  renameNovelTitle: false,
  keepOldAsAlias: false,
};

export interface RenamePlan {
  pairs: Array<RenamePair & { hits: number }>;
  /** Capped; `totals` is authoritative for the whole novel. */
  hits: RenameHit[];
  totals: Record<RenameKind, number>;
  /** Change in the novel's word count, so the counter stays honest. */
  wordDelta: number;
  warnings: string[];
  truncated: boolean;
}

export interface RenameDocs {
  novel: Novel;
  bible: BibleEntry[];
  designs: CharacterDesign[];
  arcs: StoryArc[];
  map: GeoMap | null;
  chapters: Chapter[];
}

export interface RenameRewrites {
  novel: Partial<Pick<Novel, 'title' | 'premise' | 'styleNotes' | 'wordCount'>> | null;
  bible: BibleEntry[];
  designs: CharacterDesign[];
  arcs: StoryArc[];
  map: GeoMap | null;
  chapters: Chapter[];
}

const MAX_HITS = 200;

/**
 * Names common enough that a rename would hit ordinary prose as well as the
 * character. Not a block — the author may genuinely have a character called
 * Dawn — but the preview says so, and the chapter-to-bible hit ratio usually
 * makes it obvious.
 */
const COMMON_WORDS = new Set([
  'dawn', 'ash', 'storm', 'grace', 'hope', 'faith', 'reed', 'marsh', 'river', 'summer',
  'winter', 'autumn', 'may', 'june', 'rose', 'jade', 'sky', 'rain', 'sage', 'wren',
  'robin', 'ivy', 'holly', 'heather', 'iris', 'clay', 'flint', 'ford', 'brook', 'glen',
  'will', 'mark', 'art', 'bill', 'rich', 'frank', 'grant', 'chase', 'drew', 'guy',
  'pace', 'creek', 'stone', 'wood', 'field', 'hill', 'bell', 'king', 'knight', 'page',
]);

export function warningsFor(
  pairs: readonly RenamePair[],
  docs: Pick<RenameDocs, 'bible' | 'designs' | 'map'>,
  totals: Record<RenameKind, number>,
  perPair: ReadonlyMap<string, number>
): string[] {
  const out: string[] = [];

  for (const pair of pairs) {
    const from = pair.from.trim();
    const to = pair.to.trim();
    if (!from || !to) continue;

    // The one case where running this twice is not a no-op.
    const re = compileRename([pair]);
    if (re && countRename(to, re, [pair]).count > 0) {
      out.push(
        `"${to}" still contains "${from}". This is applied once and is safe, but if it fails ` +
          `partway through, check before running it again — a second pass would produce ` +
          `"${applyRename(to, re, [pair]).text}".`
      );
    }

    if (COMMON_WORDS.has(from.toLowerCase())) {
      out.push(
        `"${from}" is an ordinary English word as well as a name. Check the chapter matches ` +
          `below before applying — every ${from.toLowerCase()} in the prose will be renamed too.`
      );
    }

    const existing = [
      ...docs.bible.flatMap((e) => [e.name, ...e.aliases]),
      ...docs.designs.map((d) => d.name),
      ...Object.values(docs.map?.entities ?? {}).flatMap((e) => [e.name, ...(e.aliases ?? [])]),
    ];
    if (existing.some((name) => name.trim().toLowerCase() === to.toLowerCase())) {
      out.push(`"${to}" is already the name of something else in this novel.`);
    }

    if ((perPair.get(from) ?? 0) === 0) {
      out.push(`"${from}" does not appear anywhere in this novel. Nothing will change for it.`);
    }
  }

  if (totals.chapter === 0 && totals.bible + totals.design + totals.arc + totals.map === 0) {
    out.push('Nothing matched. Check the spelling of the name you are replacing.');
  }
  return out;
}

/**
 * Plan and perform the rewrite in memory.
 *
 * Every document is scanned, not only the renamed entity's: a character's name
 * lives in other characters' relationship notes, in blueprints, in map evidence
 * and in forty chapters of prose, and a rename that fixed only the entry would
 * leave the novel contradicting itself in more places than it fixed.
 */
export function planRename(
  docs: RenameDocs,
  pairs: readonly RenamePair[],
  options: RenameOptions
): { plan: RenamePlan; rewrites: RenameRewrites } {
  const re = compileRename(pairs);
  const hits: RenameHit[] = [];
  const totals: Record<RenameKind, number> = {
    novel: 0, bible: 0, design: 0, arc: 0, map: 0, chapter: 0,
  };
  const perPair = new Map<string, number>(pairs.map((p) => [p.from.trim(), 0]));

  const empty: RenameRewrites = {
    novel: null, bible: [], designs: [], arcs: [], map: null, chapters: [],
  };

  if (!re) {
    return {
      plan: {
        pairs: pairs.map((p) => ({ ...p, hits: 0 })),
        hits: [],
        totals,
        wordDelta: 0,
        warnings: ['A rename needs both a name to replace and a name to replace it with.'],
        truncated: false,
      },
      rewrites: empty,
    };
  }

  // Compiled once. Per-pair counts are what the UI shows beside each row, and
  // compiling these inside the field loop would recompile them tens of
  // thousands of times over a long novel.
  const singles = pairs
    .map((pair) => ({ pair, re: compileRename([pair]) }))
    .filter((s): s is { pair: RenamePair; re: RegExp } => s.re !== null);

  /** Rewrite one field, recording where it matched and against which pair. */
  const rw = (kind: RenameKind, id: string, label: string, field: string, value: string): string => {
    if (!value) return value;
    const { count, samples } = countRename(value, re, pairs);
    if (!count) return value;
    totals[kind] += count;
    for (const { pair, re: single } of singles) {
      const own = countRename(value, single, [pair]).count;
      if (own) perPair.set(pair.from.trim(), (perPair.get(pair.from.trim()) ?? 0) + own);
    }
    if (hits.length < MAX_HITS) hits.push({ kind, id, label, field, count, samples });
    return applyRename(value, re, pairs).text;
  };

  const rwAll = (kind: RenameKind, id: string, label: string, field: string, values: string[]): string[] => {
    const joined = values.join(' ');
    if (!joined) return values;
    const { count, samples } = countRename(joined, re, pairs);
    if (count) {
      totals[kind] += count;
      if (hits.length < MAX_HITS) hits.push({ kind, id, label, field, count, samples });
    }
    return applyRenameAll(values, re, pairs).values;
  };

  // ── The novel document ─────────────────────────────────────────────────
  // The premise rides in the cached system prompt: a rename that skipped it
  // would have the writer reintroducing the old name from chapter one.
  const novelPatch: RenameRewrites['novel'] = {};
  const { novel } = docs;
  if (options.renameNovelTitle) {
    const title = rw('novel', novel.id, novel.title, 'title', novel.title);
    if (title !== novel.title) novelPatch.title = title;
  }
  if (options.includeNovelText) {
    const premise = rw('novel', novel.id, novel.title, 'premise', novel.premise);
    if (premise !== novel.premise) novelPatch.premise = premise;
    const styleNotes = rw('novel', novel.id, novel.title, "author's notes", novel.styleNotes);
    if (styleNotes !== novel.styleNotes) novelPatch.styleNotes = styleNotes;
  }

  // ── Bible ──────────────────────────────────────────────────────────────
  const bible = docs.bible.map((entry) => {
    const next: BibleEntry = {
      ...entry,
      name: rw('bible', entry.id, entry.name, 'name', entry.name),
      aliases: rwAll('bible', entry.id, entry.name, 'aliases', entry.aliases),
      summary: rw('bible', entry.id, entry.name, 'summary', entry.summary),
      status: rw('bible', entry.id, entry.name, 'status', entry.status),
      attributes: Object.fromEntries(
        // Values only. A key is a schema word ("role", "voice") and renaming
        // one would quietly drop the attribute.
        Object.entries(entry.attributes).map(([k, v]) => [
          k,
          rw('bible', entry.id, entry.name, `attribute "${k}"`, v),
        ])
      ),
      facts: entry.facts.map((fact) => ({
        ...fact,
        text: rw('bible', entry.id, entry.name, 'a fact', fact.text),
        ...(fact.supersedes ? { supersedes: applyRename(fact.supersedes, re, pairs).text } : {}),
      })),
      relationships: entry.relationships.map((rel) => ({
        ...rel,
        nature: rw('bible', entry.id, entry.name, 'a relationship', rel.nature),
      })),
      updatedAt: Date.now(),
    };
    // The old name kept as an alias is a lie once the prose no longer uses it,
    // and the truth when it still does. Note that this inverts what a map
    // rename does, correctly: that path never touches chapters.
    if (options.keepOldAsAlias && next.name !== entry.name && !next.aliases.includes(entry.name)) {
      next.aliases = [entry.name, ...next.aliases];
    }
    return next;
  });

  // ── Designs ────────────────────────────────────────────────────────────
  const designs = docs.designs.map((design) => {
    const at = (field: string, value: string) => rw('design', design.id, design.name, field, value);
    return {
      ...design,
      name: at('name', design.name),
      essentials: {
        role: at('role', design.essentials.role),
        age: at('age', design.essentials.age),
        appearance: at('appearance', design.essentials.appearance),
        voice: at('voice', design.essentials.voice),
      },
      motivation: {
        want: at('want', design.motivation.want),
        need: at('need', design.motivation.need),
        fear: at('fear', design.motivation.fear),
        lie: at('lie', design.motivation.lie),
      },
      personality: {
        traits: rwAll('design', design.id, design.name, 'traits', design.personality.traits),
        flaws: rwAll('design', design.id, design.name, 'flaws', design.personality.flaws),
        virtues: rwAll('design', design.id, design.name, 'virtues', design.personality.virtues),
      },
      history: {
        backstory: at('backstory', design.history.backstory),
        secrets: design.history.secrets.map((s) => ({ ...s, text: at('a secret', s.text) })),
      },
      arcs: design.arcs.map((arc) => ({
        ...arc,
        summary: at('an arc', arc.summary),
        nudge: at('an arc steer', arc.nudge),
        stages: rwAll('design', design.id, design.name, 'arc stages', arc.stages),
        ...(arc.customLabel ? { customLabel: at('an arc label', arc.customLabel) } : {}),
      })),
      relationships: design.relationships.map((rel) => ({
        ...rel,
        nature: at('a relationship', rel.nature),
        intent: at('a relationship intent', rel.intent),
      })),
      notes: at('notes', design.notes),
      updatedAt: Date.now(),
    };
  });

  // ── Arcs ───────────────────────────────────────────────────────────────
  const arcs = docs.arcs.map((arc) => {
    const at = (field: string, value: string) => rw('arc', arc.id, arc.title, field, value);
    return {
      ...arc,
      title: at('title', arc.title),
      premise: at('premise', arc.premise),
      ...(arc.previousPremise ? { previousPremise: at('previous premise', arc.previousPremise) } : {}),
      beats: arc.beats.map((beat) => ({
        ...beat,
        text: at('a beat', beat.text),
        ...(beat.previousText ? { previousText: at('a previous beat', beat.previousText) } : {}),
      })),
      blueprints: arc.blueprints.map((bp) => ({
        ...bp,
        title: at(`blueprint ${bp.chapter} title`, bp.title),
        summary: at(`blueprint ${bp.chapter}`, bp.summary),
        opens: at(`blueprint ${bp.chapter} opening`, bp.opens),
        turn: at(`blueprint ${bp.chapter} turn`, bp.turn),
        lands: at(`blueprint ${bp.chapter} landing`, bp.lands),
        ...(bp.previousSummary
          ? { previousSummary: at(`blueprint ${bp.chapter} previous`, bp.previousSummary) }
          : {}),
        ...(bp.newNames
          ? { newNames: rwAll('arc', arc.id, arc.title, 'new names', bp.newNames) }
          : {}),
        // `entryId` is untouched, like every other id in this module: it is the
        // join to the bible entry, which is being renamed rather than replaced.
        // Everything else on a cast member is text the reader of the plan sees,
        // so it goes stale unless it moves with the book.
        ...(bp.cast
          ? {
              cast: bp.cast.map((member) => ({
                ...member,
                name: at(`blueprint ${bp.chapter} cast`, member.name),
                note: at(`blueprint ${bp.chapter} cast note`, member.note),
              })),
            }
          : {}),
        // Roles are mostly unnamed ("a dock clerk") and a rename passes straight
        // over those, but anyone the story bible already owns goes into the list
        // by their real name — and that is exactly the name being renamed.
        ...(bp.roles
          ? { roles: rwAll('arc', arc.id, arc.title, `blueprint ${bp.chapter} roles`, bp.roles) }
          : {}),
        ...(bp.reveals
          ? { reveals: rwAll('arc', arc.id, arc.title, `blueprint ${bp.chapter} reveals`, bp.reveals) }
          : {}),
        ...(bp.futureContext
          ? {
              futureContext: rwAll(
                'arc',
                arc.id,
                arc.title,
                `blueprint ${bp.chapter} future context`,
                bp.futureContext
              ),
            }
          : {}),
      })),
      updatedAt: Date.now(),
    };
  });

  // ── The map ────────────────────────────────────────────────────────────
  // Entity KEYS and the layout are untouched: the layout is keyed by id and
  // holds no names at all, which is the whole reason ids stay put.
  let map: GeoMap | null = null;
  if (docs.map) {
    const source = docs.map;
    map = {
      ...source,
      title: rw('map', source.id, 'the map', 'title', source.title),
      entities: Object.fromEntries(
        Object.entries(source.entities).map(([id, entity]) => [
          id,
          {
            ...entity,
            name: rw('map', id, entity.name, 'name', entity.name),
            aliases: rwAll('map', id, entity.name, 'aliases', entity.aliases ?? []),
          },
        ])
      ),
      facts: source.facts.map((fact) => ({
        ...fact,
        ...(fact.evidence
          ? { evidence: rw('map', fact.id, 'the map', 'evidence', fact.evidence) }
          : {}),
      })),
    };
  }

  // ── Chapters ───────────────────────────────────────────────────────────
  let wordDelta = 0;
  const chapters = options.includeChapters
    ? docs.chapters.map((chapter) => {
        const label = `Chapter ${chapter.number}`;
        const id = String(chapter.number);
        const content = rw('chapter', id, label, 'text', chapter.content);
        // countWords splits on whitespace, so a one-word name becoming two
        // moves the novel's counter. Summed here and applied once.
        if (content !== chapter.content) {
          wordDelta += countWords(content) - countWords(chapter.content);
        }
        return {
          ...chapter,
          title: rw('chapter', id, label, 'title', chapter.title),
          content,
          summary: rw('chapter', id, label, 'summary', chapter.summary),
          userPrompt: rw('chapter', id, label, 'instructions', chapter.userPrompt),
          revisionNotes: rwAll('chapter', id, label, 'revision notes', chapter.revisionNotes),
          // Rewritten rather than cleared: unlike a hand edit, this pass does
          // not change what happens in the chapter, so the directions it
          // produced are still good — they just use the new name.
          ...(chapter.nextSuggestions
            ? {
                nextSuggestions: chapter.nextSuggestions.map((s) => ({
                  ...s,
                  title: rw('chapter', id, label, 'a suggestion', s.title),
                  prompt: rw('chapter', id, label, 'a suggestion', s.prompt),
                  rationale: rw('chapter', id, label, 'a suggestion', s.rationale),
                })),
              }
            : {}),
          updatedAt: Date.now(),
        };
      })
    : [];

  if (wordDelta !== 0) novelPatch.wordCount = Math.max(0, docs.novel.wordCount + wordDelta);

  return {
    plan: {
      pairs: pairs.map((p) => ({ ...p, hits: perPair.get(p.from.trim()) ?? 0 })),
      hits,
      totals,
      wordDelta,
      warnings: warningsFor(pairs, docs, totals, perPair),
      truncated: hits.length >= MAX_HITS,
    },
    rewrites: {
      novel: Object.keys(novelPatch).length ? novelPatch : null,
      // Only what actually changed goes back to Firestore.
      bible: bible.filter((e, i) => changed(e, docs.bible[i])),
      designs: designs.filter((d, i) => changed(d, docs.designs[i])),
      arcs: arcs.filter((a, i) => changed(a, docs.arcs[i])),
      map: map && changed(map, docs.map) ? map : null,
      chapters: chapters.filter((ch, i) => changed(ch, docs.chapters[i])),
    },
  };
}

/**
 * Did anything but the timestamp move? Every document above is rebuilt whether
 * it matched or not, so without this a rename of one character would rewrite
 * every chapter in the novel and bump forty updatedAt fields for nothing.
 */
function changed(next: unknown, before: unknown): boolean {
  const strip = (value: unknown): string =>
    JSON.stringify(value, (key, v) => (key === 'updatedAt' ? 0 : v));
  return strip(next) !== strip(before);
}
