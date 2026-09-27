import type { NovelJob } from './jobs.js';
import { chapterRevision } from './jobs.js';
import { deleteCanonChapter, invalidateCanon, revisionOf, entryHash, type CanonProposal } from './canon.js';
import { applyBiblePatch } from './bibleValidate.js';
import { deriveShapes } from '../engine/map/regions.js';
import { solveMap } from '../engine/map/solver.js';
import { activeFacts, relationEntityIds, type GeoMap } from '../engine/map/types.js';
import type { StyleKey } from '../engine/styles.js';
import {
  dataPath,
  defined,
  isSafeId,
  listDirs,
  listDocs,
  newId,
  readDoc,
  removeDoc,
  removeTree,
  writeDoc,
  writeDocuments,
} from './localdb.js';
import { shiftArcAfterChapterDelete } from './arcValidate.js';
import { unlinkEntryFromSystem } from './powerValidate.js';
import type {
  BibleEntry,
  Chapter,
  ChapterMeta,
  CharacterDesign,
  Novel,
  PowerSystem,
  StoryArc,
  VaultProfile,
} from './types.js';

/*
 * Local storage. Every function keeps the signature the routes and agents
 * already call, so nothing above this file knows where the data lives. See
 * localdb.ts for the on-disk layout and why every call is synchronous.
 */

type Collection = 'chapters' | 'bible' | 'designs' | 'maps' | 'arcs' | 'naming' | 'power' | 'jobs';

const novelDir = (novelId: string) => dataPath('novels', novelId);
const novelFile = (novelId: string) => dataPath('novels', novelId, 'novel.json');
const collectionDir = (novelId: string, name: Collection) => dataPath('novels', novelId, name);
const docFile = (novelId: string, name: Collection, id: string) =>
  dataPath('novels', novelId, name, `${id}.json`);
const userFile = (uid: string) => dataPath('users', `${uid}.json`);

/** Read one sub-document, treating an unsafe id as "not there". */
function getDoc<T>(novelId: string, name: Collection, id: string): T | null {
  if (!isSafeId(novelId) || !isSafeId(id)) return null;
  return readDoc<T>(docFile(novelId, name, id));
}

function setDoc(novelId: string, name: Collection, id: string, data: unknown): void {
  if (!isSafeId(novelId) || !isSafeId(id)) throw new Error(`unsafe id: ${novelId}/${name}/${id}`);
  writeDoc(docFile(novelId, name, id), data);
}

function listCollection<T>(novelId: string, name: Collection): T[] {
  if (!isSafeId(novelId)) return [];
  return listDocs<T>(collectionDir(novelId, name));
}

/**
 * Read-modify-write one document. `merge` is synchronous, so nothing else can
 * run between the read and the write — this is the transaction.
 */
function transact<T>(
  novelId: string,
  name: Collection,
  id: string,
  merge: (existing: T | null) => T
): T {
  const next = merge(getDoc<T>(novelId, name, id));
  setDoc(novelId, name, id, next);
  return next;
}

function chapterId(n: number): string {
  return String(n).padStart(4, '0');
}

/** One definition of "a word" everywhere word counts appear. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Which slice of the shelf to return. `visible` is what the dashboard shows,
 * `hidden` is the vault, and `all` is for operations (export, delete) that
 * must not silently skip anything.
 */
export type NovelScope = 'visible' | 'hidden' | 'all';

function readNovel(novelId: string): Novel | null {
  if (!isSafeId(novelId)) return null;
  const data = readDoc<Omit<Novel, 'id'>>(novelFile(novelId));
  return data ? ({ ...data, id: novelId } as Novel) : null;
}

export async function listNovels(uid: string, scope: NovelScope = 'all'): Promise<Novel[]> {
  return listDirs(dataPath('novels'))
    .map(readNovel)
    .filter((n): n is Novel => !!n && n.ownerUid === uid)
    .filter((n) => scope === 'all' || (scope === 'hidden') === (n.hidden === true))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function countNovels(uid: string): Promise<number> {
  return (await listNovels(uid, 'all')).length;
}

export async function createNovel(
  uid: string,
  data: {
    title: string;
    premise: string;
    styleNotes: string;
    style: StyleKey;
    defaultModel: string;
    chapterLength?: number;
    hidden?: boolean;
  }
): Promise<Novel> {
  const now = Date.now();
  const novel: Omit<Novel, 'id'> = {
    ownerUid: uid,
    title: data.title,
    premise: data.premise,
    styleNotes: data.styleNotes,
    style: data.style,
    defaultModel: data.defaultModel,
    chapterLength: data.chapterLength ?? 0,
    chapterCount: 0,
    wordCount: 0,
    hidden: data.hidden === true,
    createdAt: now,
    updatedAt: now,
  };
  const id = newId();
  writeDoc(novelFile(id), novel);
  return { ...novel, id };
}

/** Returns the novel if it exists and is owned by uid, else null. */
export async function getNovel(uid: string, novelId: string): Promise<Novel | null> {
  const novel = readNovel(novelId);
  if (!novel || novel.ownerUid !== uid) return null;
  if (novel.wordCount === undefined) {
    const chapters = await getAllChapters(novelId);
    novel.wordCount = chapters.reduce((sum, ch) => sum + countWords(ch.content), 0);
    await updateNovel(novelId, { wordCount: novel.wordCount });
  }
  return novel;
}

export async function updateNovel(
  novelId: string,
  patch: Partial<
    Pick<
      Novel,
      | 'title'
      | 'premise'
      | 'styleNotes'
      | 'defaultModel'
      | 'modelRoles'
      | 'proseProfile'
      | 'continuityDirtyFrom'
      | 'chapterLength'
      | 'chapterCount'
      | 'wordCount'
      | 'hidden'
      | 'bibleMode'
      | 'bibleChapter'
      | 'designMode'
      | 'mapMode'
      | 'mapChapter'
      | 'suggestMode'
      | 'arcMode'
      | 'namingMode'
      | 'coverUrl'
    >
  >
): Promise<void> {
  const current = readNovel(novelId);
  if (!current) throw new Error(`novel ${novelId} not found`);
  const { id: _id, ...rest } = current;
  writeDoc(novelFile(novelId), { ...rest, ...defined(patch), updatedAt: Date.now() });
}

export async function deleteNovel(novelId: string): Promise<void> {
  if (!isSafeId(novelId)) return;
  removeTree(novelDir(novelId));
}

const byNumber = (a: Chapter, b: Chapter) => a.number - b.number;

export async function listChapters(novelId: string): Promise<ChapterMeta[]> {
  return listCollection<Chapter>(novelId, 'chapters')
    .sort(byNumber)
    .map((c) => ({
      number: c.number,
      title: c.title,
      status: c.status,
      wordCount: countWords(c.content),
      updatedAt: c.updatedAt,
    }));
}

/** Every chapter in full, drafts included. */
export async function getAllChapters(novelId: string): Promise<Chapter[]> {
  return listCollection<Chapter>(novelId, 'chapters').sort(byNumber);
}

export async function getChapter(novelId: string, n: number): Promise<Chapter | null> {
  return getDoc<Chapter>(novelId, 'chapters', chapterId(n));
}

export async function getAcceptedChapters(novelId: string, before: number): Promise<Chapter[]> {
  return (await getAllChapters(novelId)).filter((c) => c.number < before && c.status === 'accepted');
}

/**
 * Delete chapter n and shift every later chapter down by one so numbering
 * stays contiguous. Returns how many later chapters moved — zero means n was
 * the last chapter, which callers need in order to leave forward-looking plans
 * alone.
 */
export async function deleteChapterAndRenumber(novelId: string, n: number): Promise<number> {
  if (!isSafeId(novelId)) return 0;
  removeDoc(docFile(novelId, 'chapters', chapterId(n)));
  const later = (await getAllChapters(novelId)).filter((c) => c.number > n);
  for (const data of later) {
    setDoc(novelId, 'chapters', chapterId(data.number - 1), {
      ...data,
      number: data.number - 1,
      updatedAt: Date.now(),
    });
    removeDoc(docFile(novelId, 'chapters', chapterId(data.number)));
  }
  return later.length;
}

export async function saveChapter(novelId: string, chapter: Chapter): Promise<void> {
  setDoc(novelId, 'chapters', chapterId(chapter.number), chapter);
}

export async function updateChapter(
  novelId: string,
  n: number,
  patch: Partial<Chapter>
): Promise<void> {
  const current = await getChapter(novelId, n);
  if (!current) throw new Error(`chapter ${n} not found`);
  setDoc(novelId, 'chapters', chapterId(n), { ...current, ...defined(patch), updatedAt: Date.now() });
}

/**
 * Forget the directions proposed off this chapter. Called when its text
 * changes: a stale suggestion is worse than none.
 */
export async function clearNextSuggestions(novelId: string, n: number): Promise<void> {
  const current = await getChapter(novelId, n);
  if (!current) return;
  const { nextSuggestions: _gone, ...rest } = current;
  setDoc(novelId, 'chapters', chapterId(n), { ...rest, updatedAt: Date.now() });
}

/** Unhide every hidden novel. Used when the PIN is removed. */
export async function unhideAllNovels(uid: string): Promise<number> {
  const hidden = await listNovels(uid, 'hidden');
  await Promise.all(hidden.map((n) => updateNovel(n.id, { hidden: false })));
  return hidden.length;
}

export async function getVaultProfile(uid: string): Promise<VaultProfile | null> {
  return isSafeId(uid) ? readDoc<VaultProfile>(userFile(uid)) : null;
}

export async function saveVaultProfile(uid: string, profile: VaultProfile): Promise<void> {
  writeDoc(userFile(uid), profile);
}

/** Only the attempt counters — a wrong PIN must not touch the hash or secret. */
export async function updateVaultAttempts(
  uid: string,
  patch: Pick<VaultProfile, 'failedAttempts' | 'lockedUntil'>
): Promise<void> {
  const current = await getVaultProfile(uid);
  if (!current) throw new Error('no vault profile');
  writeDoc(userFile(uid), { ...current, ...patch });
}

export async function deleteVaultProfile(uid: string): Promise<void> {
  if (isSafeId(uid)) removeDoc(userFile(uid));
}

// ── Story bible ───────────────────────────────────────────────────────────

export async function listBibleEntries(novelId: string): Promise<BibleEntry[]> {
  return listCollection<BibleEntry>(novelId, 'bible').sort(
    (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)
  );
}

export async function getBibleEntries(novelId: string, ids: string[]): Promise<BibleEntry[]> {
  return ids
    .map((id) => getDoc<BibleEntry>(novelId, 'bible', id))
    .filter((e): e is BibleEntry => !!e);
}

export async function countBibleEntries(novelId: string): Promise<number> {
  return listCollection(novelId, 'bible').length;
}

/**
 * Write an entry as a read-merge-write: the accept-time agent and an author
 * edit in another tab must not lose each other's changes.
 */
export async function transactBibleEntry(
  novelId: string,
  id: string,
  merge: (existing: BibleEntry | null) => BibleEntry
): Promise<BibleEntry> {
  return transact(novelId, 'bible', id, merge);
}

export async function deleteBibleEntry(novelId: string, id: string): Promise<void> {
  if (isSafeId(novelId) && isSafeId(id)) removeDoc(docFile(novelId, 'bible', id));
}

/**
 * Keep the bible honest after a chapter is deleted and later chapters shift
 * down: facts sourced from the deleted chapter describe canon that no longer
 * exists (drop them), and provenance above it is off by one (decrement).
 */
export async function renumberBibleAfterChapterDelete(novelId: string, n: number): Promise<void> {
  for (const entry of listCollection<BibleEntry>(novelId, 'bible')) setDoc(novelId, 'bible', entry.id, deleteCanonChapter(entry, n));
}

export async function invalidateBibleFrom(novelId: string, n: number): Promise<void> {
  const novel = readNovel(novelId)!;
  const writes: Array<{file: string; data: unknown}> = [];
  for (const entry of listCollection<BibleEntry>(novelId, 'bible')) writes.push({ file: docFile(novelId, 'bible', entry.id), data: invalidateCanon(entry, n) });
  for (const ch of listCollection<Chapter>(novelId, 'chapters')) if (ch.number >= n) writes.push({ file: docFile(novelId, 'chapters', chapterId(ch.number)), data: { ...ch, summary: '', summaryStale: ch.status === 'accepted', nextSuggestions: [], ...(ch.canonProposal ? { canonProposal: { ...ch.canonProposal, state: 'stale' } } : {}) } });
  for (const system of listCollection<PowerSystem>(novelId, 'power')) if ((system.canonChapter ?? 0) >= n) writes.push({ file: docFile(novelId, 'power', system.id), data: { ...system, canonNeedsReview: true } });
  writes.push({ file: novelFile(novelId), data: { ...novel, bibleChapter: Math.min(novel.bibleChapter ?? 0, Math.max(0, n - 1)), continuityDirtyFrom: Math.min(novel.continuityDirtyFrom ?? n, n) } });
  writeDocuments(writes);
}

export async function saveCanonProposal(novelId: string, n: number, proposal: CanonProposal): Promise<void> {
  transact<Chapter>(novelId, 'chapters', chapterId(n), chapter => {
    if (!chapter || revisionOf(chapter.content) !== proposal.revision) throw new Error('Chapter changed during extraction. Run the canon update again.');
    return { ...chapter, canonProposal: proposal };
  });
}

export async function resolveCanonProposal(novelId: string, n: number, revision: string, accept: boolean, proposalId: string): Promise<void> {
  const chapter = getDoc<Chapter>(novelId, 'chapters', chapterId(n));
  const proposal = chapter?.canonProposal;
  if (!chapter || !proposal || proposal.id !== proposalId || proposal.revision !== revision || revisionOf(chapter.content) !== revision) throw new Error('Chapter changed. Extract canon again before reviewing it.');
  if (proposal.state !== 'pending') return;
  const writes: Array<{ file: string; data: unknown }> = [];
  if (accept) {
    const originals = new Map([...new Set(proposal.changes.map(c => c.entryId))].map(id => [id, getDoc<BibleEntry>(novelId, 'bible', id)]));
    for (const change of proposal.powerChanges ?? []) {
      if (revisionOf(JSON.stringify(getDoc<PowerSystem>(novelId, 'power', change.id))) !== change.baseHash) throw new Error('Power system changed. Extract canon again.');
    }
    const next = new Map(originals);
    for (const c of proposal.changes) {
      if (entryHash(originals.get(c.entryId) ?? null) !== c.baseHash) throw new Error('Canon changed in another operation. Extract again to compare against the latest entries.');
      const updated = applyBiblePatch(next.get(c.entryId) ?? null, c.entryId, c.patch, n, { revision, origin: 'chapter' });
      if (updated.canon) updated.canon.needsReview = false;
      next.set(c.entryId, updated);
    }
    for (const [id, entry] of next) writes.push({ file: docFile(novelId, 'bible', id), data: entry });
    for (const change of proposal.powerChanges ?? []) writes.push({ file: docFile(novelId, 'power', change.id), data: change.next });
  }
  writes.push({ file: docFile(novelId, 'chapters', chapterId(n)), data: { ...chapter, canonProposal: { ...proposal, state: accept ? 'applied' : 'rejected' } } });
  writeDocuments(writes);
}

// ── Character designs ─────────────────────────────────────────────────────

const DESIGN_STATE_ORDER = { active: 0, draft: 1, retired: 2 } as const;

export async function listDesigns(novelId: string): Promise<CharacterDesign[]> {
  return listCollection<CharacterDesign>(novelId, 'designs').sort(
    (a, b) => DESIGN_STATE_ORDER[a.state] - DESIGN_STATE_ORDER[b.state] || a.name.localeCompare(b.name)
  );
}

export async function getDesign(novelId: string, id: string): Promise<CharacterDesign | null> {
  return getDoc<CharacterDesign>(novelId, 'designs', id);
}

export async function countDesigns(novelId: string): Promise<number> {
  return listCollection(novelId, 'designs').length;
}

export async function transactDesign(
  novelId: string,
  id: string,
  merge: (existing: CharacterDesign | null) => CharacterDesign
): Promise<CharacterDesign> {
  return transact(novelId, 'designs', id, merge);
}

export async function deleteDesign(novelId: string, id: string): Promise<void> {
  if (isSafeId(novelId) && isSafeId(id)) removeDoc(docFile(novelId, 'designs', id));
}

/**
 * Promote a design to 'active', demoting any rival that describes the same
 * character back to a draft — generation must never see two contradictory
 * active sheets for one person.
 */
export async function activateDesign(novelId: string, id: string): Promise<CharacterDesign> {
  const all = listCollection<CharacterDesign>(novelId, 'designs');
  const target = all.find((d) => d.id === id);
  if (!target) throw new Error(`design ${id} not found`);

  const now = Date.now();
  const sameCharacter = (d: CharacterDesign) =>
    target.linkedEntryId && d.linkedEntryId
      ? d.linkedEntryId === target.linkedEntryId
      : d.name.trim().toLowerCase() === target.name.trim().toLowerCase();

  for (const rival of all) {
    if (rival.id === id || rival.state !== 'active' || !sameCharacter(rival)) continue;
    setDoc(novelId, 'designs', rival.id, { ...rival, state: 'draft', updatedAt: now });
  }

  const next: CharacterDesign = { ...target, state: 'active', updatedAt: now };
  setDoc(novelId, 'designs', id, next);
  return next;
}

/** Called when a bible entry is deleted, so no design links to nothing. */
export async function unlinkDesignsFromBibleEntry(novelId: string, entryId: string): Promise<void> {
  for (const design of listCollection<CharacterDesign>(novelId, 'designs')) {
    if (design.linkedEntryId !== entryId) continue;
    const { linkedEntryId: _gone, ...rest } = design;
    setDoc(novelId, 'designs', design.id, { ...rest, updatedAt: Date.now() });
  }
}

// ── The Atlas ─────────────────────────────────────────────────────────────

/** One world map per novel, at a fixed doc id — the map's own id must agree. */
const MAP_DOC_ID = 'world';

export async function getMap(novelId: string): Promise<GeoMap | null> {
  return getDoc<GeoMap>(novelId, 'maps', MAP_DOC_ID);
}

export async function transactMap(
  novelId: string,
  merge: (existing: GeoMap | null) => GeoMap
): Promise<GeoMap> {
  return transact(novelId, 'maps', MAP_DOC_ID, merge);
}

export async function deleteMap(novelId: string): Promise<void> {
  if (isSafeId(novelId)) removeDoc(docFile(novelId, 'maps', MAP_DOC_ID));
}

/**
 * Keep the map honest after a chapter delete, mirroring the bible: facts
 * sourced from the deleted chapter are dropped, provenance above it shifts
 * down by one. Author facts (dictation/sketch) survive.
 */
export async function renumberMapAfterChapterDelete(novelId: string, n: number): Promise<void> {
  const map = await getMap(novelId);
  if (!map) return;

  const shift = (ch: number) => (ch > n ? ch - 1 : ch);
  map.facts = map.facts
    .filter((f) => f.chapter !== n || f.confidence === 'author')
    .map((f) => ({ ...f, chapter: shift(f.chapter) }));
  map.createdChapter = shift(map.createdChapter);
  map.updatedChapter = shift(map.updatedChapter);

  for (const id of Object.keys(map.entities)) {
    const e = map.entities[id];
    const involved = activeFacts(map).some((f) => relationEntityIds(f.relation).includes(id));
    if (e.firstChapter === n && !involved && !e.pin) {
      delete map.entities[id];
      if (map.layout) {
        delete map.layout.positions[id];
        delete map.layout.regionPolygons[id];
        delete map.layout.waterPolygons[id];
      }
      continue;
    }
    e.firstChapter = shift(e.firstChapter);
  }
  if (map.layout) {
    for (const p of Object.values(map.layout.positions)) {
      p.solvedAtChapter = shift(p.solvedAtChapter);
    }
  }

  // Re-solve so unsatisfied/shape state reflects the surviving facts.
  const result = solveMap(map, []);
  if (result.ok) {
    deriveShapes(map, result.layout);
    map.layout = result.layout;
  }
  setDoc(novelId, 'maps', MAP_DOC_ID, map);
}

/** Called when a bible entry is deleted: a place must not click through to nothing. */
export async function unlinkMapEntitiesFromBibleEntry(
  novelId: string,
  entryId: string
): Promise<void> {
  const map = await getMap(novelId);
  if (!map) return;
  if (!Object.values(map.entities).some((e) => e.bibleEntryId === entryId)) return;
  await transactMap(novelId, (existing) => {
    const next = existing ?? map;
    for (const e of Object.values(next.entities)) {
      if (e.bibleEntryId === entryId) e.bibleEntryId = null;
    }
    return next;
  });
}

// ── Story arcs ────────────────────────────────────────────────────────────

/** Ordered the way the author reads them: by where they start. */
export async function listArcs(novelId: string): Promise<StoryArc[]> {
  return listCollection<StoryArc>(novelId, 'arcs').sort(
    (a, b) => a.fromChapter - b.fromChapter || a.number - b.number
  );
}

export async function getArc(novelId: string, id: string): Promise<StoryArc | null> {
  return getDoc<StoryArc>(novelId, 'arcs', id);
}

export async function countArcs(novelId: string): Promise<number> {
  return listCollection(novelId, 'arcs').length;
}

export async function transactArc(
  novelId: string,
  id: string,
  merge: (existing: StoryArc | null) => StoryArc
): Promise<StoryArc> {
  return transact(novelId, 'arcs', id, merge);
}

export async function deleteArc(novelId: string, id: string): Promise<void> {
  if (isSafeId(novelId) && isSafeId(id)) removeDoc(docFile(novelId, 'arcs', id));
}

/**
 * Keep the plan aligned with the novel after a chapter is deleted. See
 * shiftArcAfterChapterDelete for why `laterChaptersShifted` decides everything.
 */
export async function renumberArcsAfterChapterDelete(
  novelId: string,
  n: number,
  laterChaptersShifted: boolean
): Promise<void> {
  if (!laterChaptersShifted) return;
  for (const arc of await listArcs(novelId)) {
    await transactArc(novelId, arc.id, (current) => ({
      ...shiftArcAfterChapterDelete(current ?? arc, n, laterChaptersShifted),
      updatedAt: Date.now(),
    }));
  }
}

// ── The naming charter ────────────────────────────────────────────────────

/** One charter per novel, at a fixed doc id. */
const CHARTER_DOC_ID = 'charter';

/** Raw, unnormalized. Callers pass it through normalizeCharter with the novel. */
export async function getCharterDoc(novelId: string): Promise<unknown | null> {
  return getDoc<unknown>(novelId, 'naming', CHARTER_DOC_ID);
}

export async function transactCharter<T>(
  novelId: string,
  merge: (existing: unknown | null) => T
): Promise<T> {
  return transact<unknown>(novelId, 'naming', CHARTER_DOC_ID, merge) as T;
}

/**
 * Write a rename cascade: novel, then the small documents, then the prose.
 * Re-running the same rename over partly-renamed prose is a no-op for
 * everything already done, so a crash mid-way is recoverable by retrying.
 */
export async function applyRenameWrites(
  novelId: string,
  rewrites: {
    novel: Partial<Novel> | null;
    bible: BibleEntry[];
    designs: CharacterDesign[];
    arcs: StoryArc[];
    map: GeoMap | null;
    chapters: Chapter[];
  }
): Promise<Record<string, number>> {
  const applied: Record<string, number> = {
    novel: 0, bible: 0, design: 0, arc: 0, map: 0, chapter: 0,
  };

  if (rewrites.novel) {
    await updateNovel(novelId, rewrites.novel);
    applied.novel = 1;
  }
  for (const doc of rewrites.bible) setDoc(novelId, 'bible', doc.id, doc);
  applied.bible = rewrites.bible.length;
  for (const doc of rewrites.designs) setDoc(novelId, 'designs', doc.id, doc);
  applied.design = rewrites.designs.length;
  for (const doc of rewrites.arcs) setDoc(novelId, 'arcs', doc.id, doc);
  applied.arc = rewrites.arcs.length;
  if (rewrites.map) {
    setDoc(novelId, 'maps', MAP_DOC_ID, rewrites.map);
    applied.map = 1;
  }
  for (const chapter of rewrites.chapters) setDoc(novelId, 'chapters', chapterId(chapter.number), chapter);
  applied.chapter = rewrites.chapters.length;
  return applied;
}

/** Discard the charter, so the novel falls back to its derived default. */
export async function deleteCharter(novelId: string): Promise<void> {
  if (isSafeId(novelId)) removeDoc(docFile(novelId, 'naming', CHARTER_DOC_ID));
}

// ── Power systems ─────────────────────────────────────────────────────────

export async function listPowerSystems(novelId: string): Promise<PowerSystem[]> {
  return listCollection<PowerSystem>(novelId, 'power').sort((a, b) => a.name.localeCompare(b.name));
}

export async function getPowerSystem(novelId: string, id: string): Promise<PowerSystem | null> {
  return getDoc<PowerSystem>(novelId, 'power', id);
}

export async function countPowerSystems(novelId: string): Promise<number> {
  return listCollection(novelId, 'power').length;
}

export async function transactPowerSystem(
  novelId: string,
  id: string,
  merge: (existing: PowerSystem | null) => PowerSystem
): Promise<PowerSystem> {
  return transact(novelId, 'power', id, merge);
}

export async function deletePowerSystem(novelId: string, id: string): Promise<void> {
  if (isSafeId(novelId) && isSafeId(id)) removeDoc(docFile(novelId, 'power', id));
}

/** Called when a bible entry is deleted: strip it from every power system that names it. */
export async function unlinkPowerFromBibleEntry(novelId: string, entryId: string): Promise<void> {
  for (const system of await listPowerSystems(novelId)) {
    if (!unlinkEntryFromSystem(system, entryId)) continue;
    await transactPowerSystem(novelId, system.id, (existing) => {
      const current = existing ?? system;
      return unlinkEntryFromSystem(current, entryId) ?? current;
    });
  }
}

export async function listJobs(novelId: string, unfinishedOnly = false): Promise<NovelJob[]> { return listCollection<NovelJob>(novelId, 'jobs').filter(j => !unfinishedOnly || j.status !== 'done'); }
export async function getJob(novelId: string, id: string): Promise<NovelJob | null> { return getDoc(novelId, 'jobs', id); }
export async function transactJob(novelId: string, id: string, merge: (job: NovelJob | null) => NovelJob): Promise<NovelJob> {
  return transact(novelId, 'jobs', id, current => { const next = merge(current as NovelJob | null); if (!next) throw new Error('Job no longer exists'); return next; });
}
export async function saveGeneratedChapter(novelId: string, chapter: Chapter, job: NovelJob): Promise<void> {
  const previous = getDoc<Chapter>(novelId, 'chapters', chapterId(chapter.number));
  const currentJob = getDoc<NovelJob>(novelId, 'jobs', job.id);
  const novel = readNovel(novelId);
  if (!novel || chapterRevision(previous) !== job.baseRevision || currentJob?.runId !== job.runId || currentJob.status !== 'running') throw new Error('Chapter or job changed. Your generated text is kept in the job for recovery.');
  writeDocuments([
    { file: docFile(novelId, 'chapters', chapterId(chapter.number)), data: chapter },
    { file: novelFile(novelId), data: { ...novel, wordCount: Math.max(0, novel.wordCount + countWords(chapter.content) - countWords(previous?.content ?? '')), chapterCount: Math.max(novel.chapterCount, chapter.number), updatedAt: Date.now() } },
    { file: docFile(novelId, 'jobs', job.id), data: { ...job, status: 'done', leaseUntil: 0, updatedAt: Date.now() } },
  ]);
}

export async function updateChapterChecked(novelId: string, n: number, patch: Partial<Chapter>, expectedRevision: string): Promise<Chapter> {
  const previous = getDoc<Chapter>(novelId, 'chapters', chapterId(n));
  if (!previous || chapterRevision(previous) !== expectedRevision) throw new Error('The chapter changed in another tab. Your text is kept locally; reload and compare before saving.');
  const next = { ...previous, ...patch, updatedAt: Date.now() };
  const writes: Array<{file: string; data: unknown}> = [{ file: docFile(novelId, 'chapters', chapterId(n)), data: next }];
  if (patch.content !== undefined) {
    const novel = readNovel(novelId)!;
    writes.push({ file: novelFile(novelId), data: { ...novel, wordCount: Math.max(0, novel.wordCount + countWords(next.content) - countWords(previous.content)), updatedAt: Date.now() } });
  }
  writeDocuments(writes);
  return next;
}

export async function removeJobsFrom(novelId: string, n: number): Promise<void> {
  for (const job of await listJobs(novelId)) if (job.chapter >= n) removeDoc(docFile(novelId, 'jobs', job.id));
}
