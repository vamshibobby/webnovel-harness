import { createHash } from 'node:crypto';
import type { BibleEntry, Chapter } from './types.js';
import { mergeBiblePatch, type BibleEntryPatch } from './bibleValidate.js';

export const revisionOf = (content: string): string => createHash('sha256').update(content).digest('hex').slice(0, 24);
export type CanonState = Pick<BibleEntry, 'type' | 'name' | 'aliases' | 'summary' | 'status' | 'attributes' | 'facts' | 'relationships' | 'knowledge'>;
export interface CanonChange {
  id: string;
  chapter: number;
  revision: string;
  origin: 'author' | 'chapter';
  patch: BibleEntryPatch;
}
export interface CanonHistory {
  baseline: CanonState;
  baselineChapter: number;
  changes: CanonChange[];
  needsReview?: boolean;
}
export interface CanonProposal {
  id: string;
  revision: string;
  changes: Array<{ entryId: string; name: string; baseHash: string; patch: BibleEntryPatch; conflicts: string[] }>;
  powerChanges?: Array<{ id: string; name: string; baseHash: string; next: import('./types.js').PowerSystem }>;
  createdAt: number;
  state: 'pending' | 'applied' | 'rejected' | 'stale';
}
export const entryHash = (entry: BibleEntry | null): string => revisionOf(JSON.stringify(entry));

function stateOf(entry: BibleEntry): CanonState {
  return { type: entry.type, name: entry.name, aliases: entry.aliases, summary: entry.summary, status: entry.status, attributes: entry.attributes, facts: entry.facts, relationships: entry.relationships, ...(entry.knowledge ? { knowledge: entry.knowledge } : {}) };
}
function emptyState(entry: BibleEntry): CanonState {
  return { type: entry.type, name: entry.name, aliases: [], summary: '', status: '', attributes: {}, facts: [], relationships: [], knowledge: [] };
}

/** Immutable source patches, rather than full snapshots, allow later state to be replayed. */
export function recordCanon(existing: BibleEntry | null, next: BibleEntry, patch: BibleEntryPatch, chapter: number, revision: string, origin: CanonChange['origin']): BibleEntry {
  const history = existing?.canon ?? {
    baseline: existing ? stateOf(existing) : emptyState(next),
    baselineChapter: existing ? Math.max(existing.firstChapter, ...existing.facts.map(f => f.chapter), 1) : 0,
    changes: [],
  };
  const id = revisionOf(JSON.stringify([next.id, chapter, revision, origin, patch]));
  const change: CanonChange = { id, chapter, revision, origin, patch };
  const changes = history.changes.some(c => c.id === id) ? history.changes : [...history.changes, change];
  if (Buffer.byteLength(JSON.stringify(changes)) > 500_000) throw new Error('Canon history is full for this entry. Export a backup before consolidating it.');
  const recorded = { ...next, canon: { ...history, changes } };
  return changes.some(c => c.chapter > chapter) ? canonAt(recorded) : recorded;
}

export function canonAt(entry: BibleEntry, chapter = Number.MAX_SAFE_INTEGER): BibleEntry {
  const h = entry.canon;
  if (!h) return entry;
  let next: BibleEntry = { ...entry, ...(h.baselineChapter <= chapter ? h.baseline : emptyState(entry)) };
  for (const c of h.changes.filter(c => c.chapter <= chapter).sort((a,b) => a.chapter - b.chapter)) {
    // An author correction may outlive its deleted source belief. It remains a
    // sourced statement, but cannot supersede an absent record during replay.
    const patch = { ...c.patch, ...(c.patch.newKnowledge ? { newKnowledge: c.patch.newKnowledge.map(k => {
      if (!k.supersedes || next.knowledge?.some(old => old.id === k.supersedes)) return k;
      const { supersedes: _removed, ...independent } = k;
      return independent;
    }) } : {}) };
    next = mergeBiblePatch(next, entry.id, patch, c.chapter);
  }
  return { ...next, canon: h };
}

/** Invalidate dependent extraction after a retcon. Author overrides survive. */
export function invalidateCanon(entry: BibleEntry, from: number): BibleEntry {
  const h = entry.canon;
  const legacy = !h || h.baselineChapter >= from;
  const baseline = legacy ? emptyState(entry) : h.baseline;
  // Legacy facts retain their known provenance, but mutable legacy state cannot be reconstructed.
  if (legacy) baseline.facts = (h?.baseline.facts ?? entry.facts).filter(f => f.chapter < from);
  const changes = (h?.changes ?? []).filter(c => c.origin === 'author' || c.chapter < from);
  return canonAt({ ...entry, canon: { baseline, baselineChapter: legacy ? 0 : h.baselineChapter, changes, ...(legacy ? { needsReview: true } : {}) } });
}

export function deleteCanonChapter(entry: BibleEntry, deleted: number): BibleEntry {
  const previous = entry.canon;
  const baseline = previous?.baseline ?? stateOf(entry);
  const legacyAffected = !previous || previous.baselineChapter >= deleted;
  const keptBaseline: CanonState = {
    ...(legacyAffected ? emptyState(entry) : baseline),
    facts: baseline.facts.filter(f => f.chapter !== deleted).map(f => ({ ...f, chapter: f.chapter > deleted ? f.chapter - 1 : f.chapter })),
  };
  const changes = (previous?.changes ?? []).filter(c => c.chapter !== deleted || c.origin === 'author').map(c => ({ ...c, chapter: c.chapter > deleted ? c.chapter - 1 : c.chapter, patch: { ...c.patch,
    ...(c.patch.newFacts ? { newFacts: c.patch.newFacts.map(f => ({ ...f, chapter: f.chapter > deleted ? f.chapter - 1 : f.chapter })) } : {}),
    ...(c.patch.newKnowledge ? { newKnowledge: c.patch.newKnowledge.map(k => ({ ...k, learnedChapter: k.learnedChapter > deleted ? k.learnedChapter - 1 : k.learnedChapter })) } : {}),
  } }));
  return { ...canonAt({ ...entry, canon: { baseline: keptBaseline, baselineChapter: legacyAffected ? 0 : Math.max(0, previous!.baselineChapter - (previous!.baselineChapter > deleted ? 1 : 0)), changes, ...(legacyAffected ? { needsReview: true } : {}) } }), firstChapter: entry.firstChapter > deleted ? entry.firstChapter - 1 : entry.firstChapter, updatedAt: Date.now() };
}

export function canonConflicts(entry: BibleEntry | null, patch: BibleEntryPatch): string[] {
  if (!entry) return [];
  const conflicts: string[] = [];
  if (patch.status && entry.status && patch.status !== entry.status) conflicts.push(`Status: ${entry.status} → ${patch.status}`);
  for (const [key, value] of Object.entries(patch.attributes ?? {})) {
    if (entry.attributes[key] && entry.attributes[key] !== value) conflicts.push(`${key}: ${entry.attributes[key]} → ${value}`);
  }
  if (patch.relationships && JSON.stringify(patch.relationships) !== JSON.stringify(entry.relationships) && entry.relationships.length) conflicts.push('Relationships change');
  if (patch.removeFacts?.length) conflicts.push('Recorded facts would be removed');
  if (patch.newFacts?.some(f => f.supersedes)) conflicts.push('Earlier facts are superseded');
  if (patch.newKnowledge?.some(k => k.supersedes)) conflicts.push('A character’s knowledge or belief changes');
  if (entry.canon?.needsReview) conflicts.push('Legacy state needs review');
  return conflicts;
}

export function sourcePatch(patch: BibleEntryPatch, chapter: Pick<Chapter, 'number' | 'content'>, sourceText: string): BibleEntryPatch {
  const revision = revisionOf(chapter.content);
  const verify = (evidence?: string) => {
    if (evidence && !sourceText.includes(evidence)) throw new Error('Evidence must be an exact passage from the supplied chapter.');
  };
  verify(patch.evidence);
  for (const fact of patch.newFacts ?? []) verify(fact.evidence);
  for (const k of patch.newKnowledge ?? []) verify(k.evidence);
  return { ...patch,
    ...(patch.newFacts ? { newFacts: patch.newFacts.map(f => ({ ...f, id: f.id || revisionOf(JSON.stringify([chapter.number, revision, f.text])), revision })) } : {}),
    ...(patch.newKnowledge ? { newKnowledge: patch.newKnowledge.map(k => ({ ...k, sourceRevision: revision })) } : {}),
  };
}
