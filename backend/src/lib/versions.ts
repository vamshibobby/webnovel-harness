import type { Chapter, ChapterVersion, VersionKind } from './types.js';

/**
 * Chapter history: every state the text passed through, kept so that no model
 * call can destroy writing that existed a moment ago.
 *
 * Until now `revisionNotes` recorded what the author ASKED for and nothing
 * recorded what they had. A revise, a humanize pass or an accepted inline edit
 * overwrote the draft outright, and the previous words were gone — which is the
 * one thing a writing tool must never do.
 *
 * **Why the snapshots live in the chapter document.** The obvious home is a
 * `versions` subcollection under the chapter, and it is wrong here: `deleteNovel`
 * walks a fixed list of the novel's own subcollections one level deep
 * (store.ts), and Firestore deletes do not cascade, so a subcollection under a
 * chapter doc would survive its own novel forever. An array in the document is
 * deleted with the document, arrives with every read the routes already do, and
 * needs no new query.
 *
 * The price is the 1 MiB document ceiling, which is why `pushVersion` is a
 * budget rather than a list append: newest entries are kept, oldest are dropped,
 * and the whole history is bounded by both count and bytes with room to spare
 * for the live chapter beside it.
 */

/** Snapshots kept per chapter. Enough to walk back a bad afternoon. */
export const MAX_VERSIONS = 8;

/**
 * Bytes of history per chapter. A 4,000-word chapter is ~25 KB, so eight of
 * them is ~200 KB; this cap holds even for chapters far longer than the
 * generator will produce, and leaves the 1 MiB document limit untouched.
 */
export const MAX_VERSION_CHARS = 400_000;

/** A version's cost against the budget, near enough for a cap. */
const size = (v: ChapterVersion): number => v.content.length + v.title.length;

/**
 * The history to store when `existing` is about to be replaced.
 *
 * Returns the list to write — callers must pass it through to `saveChapter`,
 * which sets the whole document and would otherwise drop it. A chapter with no
 * text yet (a first generate) contributes no snapshot: there is nothing to lose.
 */
export function pushVersion(
  existing: Pick<Chapter, 'title' | 'content' | 'versions'> | null | undefined,
  kind: VersionKind,
  note?: string
): ChapterVersion[] {
  const history = existing?.versions ?? [];
  if (!existing?.content?.trim()) return history;

  const next: ChapterVersion[] = [
    ...history,
    {
      title: existing.title,
      content: existing.content,
      at: Date.now(),
      kind,
      ...(note ? { note: note.slice(0, 500) } : {}),
    },
  ];

  // Drop from the front — the oldest history is the least useful — until both
  // budgets are satisfied. The newest snapshot is never dropped, even if it
  // alone exceeds the byte budget: losing the text you just replaced is the
  // exact failure this file exists to prevent.
  while (next.length > MAX_VERSIONS) next.shift();
  while (next.length > 1 && next.reduce((sum, v) => sum + size(v), 0) > MAX_VERSION_CHARS) {
    next.shift();
  }
  return next;
}

/** True when the chapter has anything to show in a history panel. */
export function hasHistory(chapter: Pick<Chapter, 'versions'>): boolean {
  return (chapter.versions?.length ?? 0) > 0;
}
