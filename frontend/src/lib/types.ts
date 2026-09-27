import type { ModelRoles, ProseProfile, CanonProposal, Knowledge, ModelRun } from './harnessTypes';
/* The slices of the server's shapes this UI actually reads. Loose on purpose. */

export interface Novel {
  modelRoles?: ModelRoles;
  proseProfile?: ProseProfile;
  continuityDirtyFrom?: number;
  id: string;
  title: string;
  premise: string;
  styleNotes: string;
  style: string;
  defaultModel: string;
  chapterLength: number;
  chapterCount: number;
  wordCount: number;
  hidden: boolean;
  bibleMode?: 'off' | 'accept' | 'batch';
  bibleChapter?: number;
  designMode?: 'off' | 'on';
  mapMode?: 'off' | 'manual' | 'accept';
  mapChapter?: number;
  suggestMode?: 'off' | 'on';
  arcMode?: 'off' | 'on';
  namingMode?: 'off' | 'on';
  coverUrl?: string;
  createdAt: number;
  updatedAt: number;
}

export interface StyleInfo {
  key: string;
  label: string;
  blurb: string;
  examples?: string[];
}

export interface ChapterMeta {
  number: number;
  title: string;
  status: 'draft' | 'accepted';
  wordCount: number;
  updatedAt: number;
}

export interface ChapterSuggestion {
  move: string;
  title: string;
  prompt: string;
  rationale: string;
}

export interface ChapterVersion {
  title: string;
  content: string;
  at: number;
  kind: string;
  note?: string;
}

export interface Chapter {
  canonProposal?: CanonProposal;
  summaryStale?: boolean;
  modelRuns?: ModelRun[];
  number: number;
  title: string;
  content: string;
  status: 'draft' | 'accepted';
  summary: string;
  userPrompt: string;
  revisionNotes: string[];
  model: string;
  nextSuggestions?: ChapterSuggestion[];
  versions?: ChapterVersion[];
  createdAt: number;
  updatedAt: number;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

export interface BibleEntry {
  knowledge?: Knowledge[];
  canon?: { needsReview?: boolean };
  id: string;
  type: string;
  name: string;
  aliases: string[];
  summary: string;
  status: string;
  attributes: Record<string, string>;
  facts: Array<{ text: string; chapter: number; supersedes?: string }>;
  relationships: Array<{ targetId: string; nature: string }>;
  firstChapter: number;
}

export const BIBLE_TYPES = [
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

export interface Design {
  id: string;
  name: string;
  linkedEntryId?: string;
  state: 'draft' | 'active' | 'retired';
  steer: boolean;
  essentials: Record<string, string>;
  motivation: Record<string, string>;
  personality: Record<string, string[]>;
  history: { backstory: string; secrets: Array<{ text: string; revealed: boolean }> };
  arcs: unknown[];
  relationships: unknown[];
  notes: string;
}

export interface ArcBeat {
  id: string;
  text: string;
  source: string;
  previousText?: string;
}

export interface Blueprint {
  chapter: number;
  title: string;
  tags: string[];
  summary: string;
  opens: string;
  turn: string;
  lands: string;
  source: string;
  cast?: Array<{ name: string; note: string; entryId?: string }>;
  roles?: string[];
  reveals?: string[];
  futureContext?: string[];
  newNames?: string[];
}

export interface StoryArc {
  id: string;
  number: number;
  title: string;
  premise: string;
  previousPremise?: string;
  fromChapter: number;
  toChapter: number;
  status: 'planning' | 'active' | 'done' | 'abandoned';
  steer: boolean;
  beats: ArcBeat[];
  blueprints: Blueprint[];
  threads?: Array<{ id: string; label: string; anchor: string }>;
  nameFlags?: Array<{ name: string; where: string }>;
  braid?: { findings: Array<{ message: string; severity: string }>; weaveRate: number; longestRun: number };
  stages?: Record<string, { status: string; at: number; message?: string }>;
}

export interface CastMember {
  id: string;
  name: string;
  role: string;
  kind: string;
  entryId: string | null;
  mentions: string[];
  chapters: number[];
  brief: string;
  alternatives: string[];
}

export interface CastProposal {
  from: number;
  to: number;
  members: CastMember[];
  context: Array<{ chapter: number; reveals: string[]; future: string[] }>;
}

export interface PowerSystem {
  canonNeedsReview?: boolean;
  id: string;
  name: string;
  summary: string;
  source: string;
  energyName: string;
  ranks: Array<{ id: string; name: string; summary: string }>;
  professions: Array<{ id: string; name: string }>;
  openQuestions: string[];
  [key: string]: unknown;
}
