import { randomUUID } from 'node:crypto';
import { seedModelRuns, modelRuns, type ModelRun } from './modelPolicy.js';
import { revisionOf } from './canon.js';
import type { Chapter } from './types.js';
import * as store from './store.js';

export interface NovelJob {
  id: string;
  runId: string;
  chapter: number;
  mode: 'generate' | 'revise' | 'upkeep';
  status: 'running' | 'paused' | 'cancelled' | 'failed' | 'done';
  baseRevision: string;
  input: { prompt?: string; notes?: string; model: string };
  text: string;
  traces: string[];
  modelRuns: ModelRun[];
  stages?: Partial<Record<'summary' | 'bible' | 'map' | 'suggestions', 'pending' | 'done' | 'review' | 'failed'>>;
  error?: string;
  startedAt: number;
  updatedAt: number;
  leaseUntil: number;
}
export const jobId = (chapter: number, mode: NovelJob['mode']): string => `${mode === 'upkeep' ? 'upkeep' : 'draft'}-${chapter}`;
export const chapterRevision = (chapter: Chapter | null): string => chapter ? revisionOf(JSON.stringify([chapter.content, chapter.title, chapter.status, chapter.createdAt])) : 'new';
export const jobActive = (job: NovelJob | null): boolean => !!job && job.status === 'running' && job.leaseUntil > Date.now();

const boundedText = (text: string, bytes: number) => Buffer.from(text).subarray(0, bytes).toString('utf8');
const controllers = new Map<string, AbortController>();
export function cancelLocalJob(novelId: string, id: string): void { controllers.get(`${novelId}:${id}`)?.abort('cancelled'); }

/** The request owns execution. Disconnects checkpoint and pause; a new request supplies a fresh key. */
export async function startJob(novelId: string, chapter: number, mode: NovelJob['mode'], base: Chapter | null, input: NovelJob['input'], resume: boolean) {
  const id = jobId(chapter, mode);
  const now = Date.now();
  const job = await store.transactJob(novelId, id, previous => {
    if (jobActive(previous)) throw new Error('This chapter already has a running job. Stop it or wait for it to finish.');
    if (resume && (!previous || previous.status === 'done' || previous.baseRevision !== chapterRevision(base))) throw new Error('The chapter changed since that job started. Start a new generation instead.');
    return {
      id, runId: randomUUID(), chapter, mode,
      baseRevision: chapterRevision(base), input: resume && previous ? previous.input : input,
      text: resume ? previous?.text ?? '' : '', traces: [],
      modelRuns: resume ? previous?.modelRuns ?? [] : [],
      ...(mode === 'upkeep' ? { stages: resume && previous?.stages ? previous.stages : { summary: 'pending', bible: 'pending', map: 'pending', suggestions: 'pending' } } : {}),
      status: 'running', startedAt: resume ? previous!.startedAt : now, updatedAt: now, leaseUntil: now + 30000,
    };
  });
  seedModelRuns(job.modelRuns);
  const controller = new AbortController();
  controllers.set(`${novelId}:${id}`, controller);
  let pending = Promise.resolve();
  let stopped = false;
  let restarting = false;
  let lastCheckpoint = now;
  const checkpoint = (force = false): Promise<void> => {
    if (!force && Date.now() - lastCheckpoint < 1500) return pending;
    lastCheckpoint = Date.now();
    job.modelRuns = modelRuns();
    const snapshot = { ...job, stages: job.stages ? { ...job.stages } : undefined, traces: [...job.traces], modelRuns: [...job.modelRuns] };
    pending = pending.catch(() => {}).then(async () => {
      await store.transactJob(novelId, id, current => {
        if (!current || current.runId !== job.runId) { controller.abort('superseded'); return current!; }
        if (current.status === 'done') return current;
        if (current.status === 'cancelled') { controller.abort('cancelled'); return current; }
        return { ...snapshot, updatedAt: Date.now(), leaseUntil: snapshot.status === 'running' ? Date.now() + 30000 : 0 };
      });
    });
    return pending;
  };
  const heartbeat = setInterval(() => {
    if (!stopped) void checkpoint(true).catch(() => controller.abort('checkpoint-failed'));
  }, 3000);
  return {
    job, signal: controller.signal,
    pause: () => controller.abort('paused'),
    token: (text: string) => { if (restarting) { job.text = ''; restarting = false; } job.text = boundedText(job.text + text, 240000); void checkpoint().catch(() => controller.abort('checkpoint-failed')); },
    restart: () => { restarting = true; },
    trace: (text: string) => { job.traces = [...job.traces, boundedText(text, 2000)].slice(-30); },
    checkpoint,
    async finish(status: NovelJob['status'], error?: string) {
      stopped = true;
      clearInterval(heartbeat);
      job.status = controller.signal.reason === 'cancelled' ? 'cancelled' : status;
      if (error) job.error = error;
      try { await checkpoint(true); }
      finally { if (controllers.get(`${novelId}:${id}`) === controller) controllers.delete(`${novelId}:${id}`); }
    },
  };
}
