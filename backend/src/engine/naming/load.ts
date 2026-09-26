/**
 * Loading the charter, and gathering the names a novel has already used.
 *
 * Both of these are wanted by three callers — the generate path, the on-demand
 * coiner and the rename preview — and getting either subtly different in one of
 * them is how a feature starts contradicting itself.
 */

import { normalizeCharter } from '../../lib/namingValidate.js';
import * as store from '../../lib/store.js';
import type { BibleEntry, Chapter, CharacterDesign, Novel } from '../../lib/types.js';
import type { GeoMap } from '../map/types.js';
import { defaultCharter, type NamingCharter } from './charter.js';

/**
 * The novel's charter, or the derived default when it has never had one.
 *
 * Never writes. A default persisted on read would freeze a guess the author
 * never made and then show it back to them as their own choice — the opposite
 * of what the wordCount backfill in getNovel does, and deliberately so: that
 * one heals a field the author cannot see, this one would invent a preference.
 */
export async function loadCharter(novel: Novel): Promise<NamingCharter> {
  const raw = await store.getCharterDoc(novel.id);
  return raw ? normalizeCharter(raw, novel) : defaultCharter(novel);
}

/** True when this novel has the naming feature on. Absent reads as off. */
export function namingOn(novel: Novel): boolean {
  return (novel.namingMode ?? 'off') === 'on';
}

/**
 * Every proper noun the novel has spent, as a flat list.
 *
 * The bible is the primary source — it is the ledger of names that actually
 * survived into prose — with designs and map entities added because a novel can
 * have those with the bible switched off. Chapter text is NOT scanned here;
 * that fallback belongs at the call site that has the chapters in memory
 * already, and doing it eagerly would read the whole novel to answer a question
 * about six names.
 */
export function takenNames(args: {
  bible?: readonly BibleEntry[];
  designs?: readonly CharacterDesign[];
  map?: GeoMap | null;
  novel?: Novel | null;
}): string[] {
  const out = new Set<string>();
  const add = (value: string | undefined | null): void => {
    const trimmed = (value ?? '').trim();
    if (trimmed) out.add(trimmed);
  };

  for (const entry of args.bible ?? []) {
    add(entry.name);
    for (const alias of entry.aliases) add(alias);
  }
  for (const design of args.designs ?? []) add(design.name);
  for (const entity of Object.values(args.map?.entities ?? {})) {
    add(entity.name);
    for (const alias of entity.aliases ?? []) add(alias);
  }
  // The novel's own title is a proper noun the reader already knows; a
  // character sharing it is a collision even though nothing in the bible says so.
  if (args.novel) add(args.novel.title);

  return [...out];
}

/**
 * The proper nouns in already-written prose.
 *
 * Only wanted when the bible is off or empty — otherwise it is a slow way of
 * recomputing something already indexed. Capitalised words that are not
 * sentence-initial, which is the same heuristic arcParse and the humanizer use,
 * kept separate from both because those two answer a different question (is
 * this name NEW?) and would drag their own context in with them.
 */
export function namesInProse(chapters: readonly Chapter[]): string[] {
  const found = new Set<string>();
  for (const chapter of chapters) {
    // Sentence-initial words are dropped: every sentence starts capitalised, so
    // keeping them would put half the dictionary in the taken list.
    const words = chapter.content.match(/[^.!?\n]+/g) ?? [];
    for (const sentence of words) {
      const tokens = sentence.trim().split(/\s+/).slice(1);
      for (const token of tokens) {
        const clean = token.replace(/^[^A-Za-z]+|[^A-Za-z']+$/g, '');
        if (clean.length > 2 && /^[A-Z][a-z']+$/.test(clean)) found.add(clean);
      }
    }
  }
  return [...found];
}
