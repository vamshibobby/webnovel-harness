import { canonAt, revisionOf } from '../lib/canon.js';
import { modelRuns } from '../lib/modelPolicy.js';
import { startJob, jobActive, cancelLocalJob, chapterRevision } from '../lib/jobs.js';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { runChapterAgent } from '../engine/agent.js';
import { runBibleUpdate } from '../engine/bibleAgent.js';
import { runMapUpdate } from '../engine/map/mapAgent.js';
import { runSuggestions } from '../engine/suggestAgent.js';
import { loadCharter, namesInProse, namingOn, takenNames } from '../engine/naming/load.js';
import { diagnose, humanizeChapter } from '../engine/humanizer/index.js';
import { buildSummaryMessages } from '../engine/context.js';
import { isPlanningLine } from '../engine/planning.js';
import { InlineEditError, isEditAction, runInlineEdit } from '../engine/inlineEdit.js';
import { OpenRouterError, streamChat, type Usage } from '../engine/openrouter.js';
import type { AuthEnv } from '../lib/authMiddleware.js';
import { NO_KEY_MESSAGE, openRouterKey } from '../lib/apiKey.js';
import { acquireGenerationSlot, assertChapterAllowed, LIMITS } from '../lib/limits.js';
import * as store from '../lib/store.js';
import { pushVersion } from '../lib/versions.js';
import { arcForChapter, blueprintForChapter } from './arcs.js';
import type { Chapter, VersionKind } from '../lib/types.js';
// Hidden novels answer "not found" without an unlocked vault, which closes off
// every chapter route below along with the novel itself. See lib/vault.ts.
import { loadAccessibleNovel } from '../lib/vault.js';
import {
  apiError,
  boundedString,
  chapterNumber,
  readJson,
  safeModelId,
  ValidationError,
} from '../lib/validate.js';

export const chapterRoutes = new Hono<AuthEnv>();

/**
 * "Chapter 3: The Long Road" → { title, content without that line }.
 *
 * Two things models actually do, both measured over real generations in
 * research/eval and both silently damaging before this was widened:
 *
 * 1. They decorate the heading. Of six sampled chapters the heading arrived as
 *    `**Chapter 9: ...**` four times, `#` once and plain never. The old pattern
 *    allowed `#` but not `*`, so five of six chapters lost their title and were
 *    saved as "Chapter N".
 * 2. They introduce themselves first ("I have the context I need. Let me write
 *    this."), sometimes with a `---` rule after it. The agent's not-a-chapter
 *    guard does not catch this, because it only fires on a SHORT reply naming a
 *    tool, and commentary followed by a real chapter is neither. So the
 *    commentary was kept and became the chapter's opening paragraph.
 *
 * The search is limited to the first few non-empty lines on purpose. A chapter
 * is free to mention a chapter heading in its own prose, and scanning further
 * would let that swallow everything before it.
 */
// Decoration stacks: `## **Chapter 9: ...**` is a real thing models emit, so
// the prefix repeats rather than being a single alternation.
const HEADING_LINE =
  /^\s*(?:[*_#]{1,4}\s*){0,3}chapter\s+\d+\s*[:：—–-]\s*(.+?)\s*$/i;

/**
 * Lines of throat-clearing tolerated before the heading.
 *
 * Small on purpose, and the group at the bottom of chapterTitle.test.ts is what
 * keeps it small: a heading deep inside real prose must not cause everything
 * above it to be thrown away as preamble. Five is roughly where that stops
 * being safe.
 */
const MAX_PREAMBLE_LINES = 5;

/**
 * Hard stop on the search, so a pathological reply cannot be walked forever.
 * Only reachable via lines that are positively identifiable as planning.
 */
const MAX_SCANNED_LINES = 60;

function extractTitle(raw: string, chapterNumber: number): { title: string; content: string } {
  const lines = raw.trim().split('\n');

  let seen = 0;
  for (let i = 0; i < lines.length && seen < MAX_PREAMBLE_LINES && i < MAX_SCANNED_LINES; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // A line recognisable as part of a plan does not spend the budget. The
    // budget bounds how far into PROSE the heading may be found, and a bulleted
    // beat sheet is not prose — measured: a twelve-line plan pushed the heading
    // past a five-line cap, so no title was found and the plan itself was saved
    // as the chapter's opening paragraphs. Raising the cap instead would have
    // broken the guard the cap exists for.
    if (!isPlanningLine(line)) seen++;

    const match = line.match(HEADING_LINE);
    if (!match) continue;

    // Strip trailing decoration from the captured title (`**Title**` closes
    // after the capture group), and drop a horizontal rule directly beneath the
    // heading, which models pair with a bold one.
    const title = match[1].replace(/[*_#]+$/g, '').trim();
    const rest = lines.slice(i + 1);
    while (rest.length && (!rest[0].trim() || /^\s*[-*_]{3,}\s*$/.test(rest[0]))) rest.shift();

    return { title: title || `Chapter ${chapterNumber}`, content: rest.join('\n').trim() };
  }

  return { title: `Chapter ${chapterNumber}`, content: raw.trim() };
}

/** Exposed for src/chapterTitle.test.ts; not part of the route surface. */
export const extractTitleForTest = extractTitle;

chapterRoutes.get('/', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  return c.json(await store.listChapters(novel.id));
});

chapterRoutes.get('/jobs', async c => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  return c.json((await store.listJobs(novel.id, true)).map(j => j.status === 'running' && !jobActive(j) ? { ...j, status: 'paused' } : j));
});
chapterRoutes.post('/jobs/:jobId/cancel', async c => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  const id = c.req.param('jobId');
  if (!/^(draft|upkeep)-[1-9][0-9]*$/.test(id)) return c.json({ error: 'Invalid job' }, 400);
  try {
    await store.transactJob(novel.id, id, job => {
      if (!job) throw new Error('Job not found');
      return job.status === 'done' ? job : { ...job, status: 'cancelled', leaseUntil: 0, updatedAt: Date.now() };
    });
    cancelLocalJob(novel.id, id);
    return c.json({ ok: true });
  } catch (err) { return c.json({ error: err instanceof Error ? err.message : 'Could not stop job' }, 404); }
});

chapterRoutes.post('/:n/canon/preview', async c => {
  let release = () => {};
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  const apiKey = openRouterKey(c);
  if (!apiKey) return c.json({ error: NO_KEY_MESSAGE }, 400);
  try {
    const n = chapterNumber(c.req.param('n'), LIMITS.chaptersPerNovel);
    const chapter = await store.getChapter(novel.id, n);
    if (!chapter) return c.json({ error: 'Chapter not found' }, 404);
    release = acquireGenerationSlot(c.get('uid'), c.get('email'), c.get('emailVerified'));
    const result = await runBibleUpdate({ apiKey, novel, chapter, source: 'chapter', preview: true, signal: c.req.raw.signal });
    return c.json({ ...result, chapter: await store.getChapter(novel.id, n) });
  } catch (err) { return c.json({ error: err instanceof Error ? err.message : 'Extraction failed' }, 409); } finally { release(); }
});
chapterRoutes.post('/:n/canon/review', async c => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  try {
    const n = chapterNumber(c.req.param('n'), LIMITS.chaptersPerNovel);
    const body = await readJson<{ proposalId?: unknown; revision?: unknown; accept?: unknown }>(c);
    if (typeof body.proposalId !== 'string' || typeof body.revision !== 'string' || typeof body.accept !== 'boolean') return c.json({ error: 'proposalId, revision and accept are required' }, 400);
    const chapter = await store.getChapter(novel.id, n);
    if (chapter?.status !== 'accepted' && body.accept) return c.json({ error: 'Accept the chapter before adding its changes to canon.' }, 409);
    await store.resolveCanonProposal(novel.id, n, body.revision, body.accept, body.proposalId);
    if ((novel.bibleChapter ?? 0) === n - 1) await store.updateNovel(novel.id, { bibleChapter: n });
    return c.json({ chapter: await store.getChapter(novel.id, n) });
  } catch (err) { return c.json({ error: err instanceof Error ? err.message : 'Review failed' }, 409); }
});

chapterRoutes.get('/:n', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  let n: number;
  try {
    n = chapterNumber(c.req.param('n'), LIMITS.chaptersPerNovel);
  } catch (err) {
    return apiError(c, err);
  }
  const chapter = await store.getChapter(novel.id, n);
  if (!chapter) return c.json({ error: 'Chapter not found' }, 404);
  return c.json(chapter);
});

/**
 * Directions for a chapter that has not been written yet.
 *
 * Addressed by the chapter they are FOR, which is not where they are stored:
 * chapter n's directions were read out of chapter n-1 and live on its document.
 * The indirection is worth hiding — the client asks about the chapter it is
 * looking at.
 */
chapterRoutes.get('/:n/suggestions', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  let n: number;
  try {
    n = chapterNumber(c.req.param('n'), LIMITS.chaptersPerNovel);
  } catch (err) {
    return apiError(c, err);
  }
  if (n < 2) return c.json({ suggestions: [], fromChapter: 0 });
  const source = await store.getChapter(novel.id, n - 1);
  return c.json({
    suggestions: source?.nextSuggestions ?? [],
    fromChapter: n - 1,
  });
});

/**
 * Propose directions on demand — after a failure at accept time, for a novel
 * whose suggestions were off when the chapter was accepted, or simply because
 * the author wants three fresh ones. Plain JSON rather than SSE: it is a single
 * call and the author is watching a button, not a stream.
 */
chapterRoutes.post('/:n/suggestions', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  let n: number;
  try {
    n = chapterNumber(c.req.param('n'), LIMITS.chaptersPerNovel);
  } catch (err) {
    return apiError(c, err);
  }
  if ((novel.suggestMode ?? 'on') === 'off') {
    return c.json({ error: 'Chapter suggestions are turned off for this novel.' }, 400);
  }
  const apiKey = openRouterKey(c);
  if (!apiKey) return c.json({ error: NO_KEY_MESSAGE }, 400);
  if (n < 2) {
    return c.json({ error: 'There is no earlier chapter to read for directions.' }, 400);
  }

  const source = await store.getChapter(novel.id, n - 1);
  if (!source) return c.json({ error: 'Chapter not found' }, 404);
  if (source.status !== 'accepted') {
    return c.json({ error: `Accept chapter ${n - 1} first.` }, 409);
  }

  try {
    const [previous, bibleEntries, designs] = await Promise.all([
      store.getAcceptedChapters(novel.id, n - 1),
      (novel.bibleMode ?? 'accept') === 'off' ? [] : store.listBibleEntries(novel.id),
      (novel.designMode ?? 'off') === 'off' ? [] : store.listDesigns(novel.id),
    ]);
    const proposal = await runSuggestions({
      apiKey,
      novel,
      chapter: source,
      previous,
      bibleEntries,
      designs: designs.filter((d) => d.state === 'active'),
    });
    await store.updateChapter(novel.id, n - 1, { nextSuggestions: proposal.suggestions });
    return c.json({ suggestions: proposal.suggestions, usage: proposal.usage });
  } catch (err) {
    console.error(`[suggest] on-demand failed novel=${novel.id} ch=${n}:`, err);
    const message =
      err instanceof OpenRouterError
        ? err.message
        : 'Could not think of three directions just now. Try again.';
    return c.json({ error: message }, 502);
  }
});

interface GenerateBody {
  prompt?: string;
  notes?: string;
  model?: string;
}

/**
 * Shared SSE handler for generate + revise. Streams `token`/`tool` events,
 * then a final `done` event with the saved chapter, or an `error` event.
 */
function handleGeneration(mode: 'generate' | 'revise') {
  return async (c: Context<AuthEnv>) => {
    const novel = await loadAccessibleNovel(c);
    if (!novel) return c.json({ error: 'Novel not found' }, 404);
    let releaseSlot = () => {};
    let task: Awaited<ReturnType<typeof startJob>>;
    let existing: Chapter | null;
    let n: number;
    let apiKey: string;
    try {
      n = chapterNumber(c.req.param('n'), LIMITS.chaptersPerNovel);
      assertChapterAllowed(n, novel.chapterCount, c.get('email'), c.get('emailVerified'));
      apiKey = openRouterKey(c) || '';
      if (!apiKey) return c.json({ error: NO_KEY_MESSAGE }, 400);
      const body = await readJson<GenerateBody & { resume?: boolean }>(c);
      existing = await store.getChapter(novel.id, n);
      if (existing?.status === 'accepted') return c.json({ error: 'Chapter is already accepted' }, 409);
      if (mode === 'revise' && !existing) return c.json({ error: 'No draft to revise' }, 404);
      const model = (safeModelId(body.model, { required: false }) || novel.modelRoles?.writer?.model || novel.defaultModel);
      if (!model) return c.json({ error: 'No model selected' }, 400);
      const prompt = mode === 'generate' ? boundedString(body.prompt, 'prompt', { required: !body.resume }) : existing!.userPrompt;
      const notes = mode === 'revise' ? boundedString(body.notes, 'notes', { required: !body.resume }) : '';
      releaseSlot = acquireGenerationSlot(c.get('uid'), c.get('email'), c.get('emailVerified'));
      task = await startJob(novel.id, n, mode, existing, { prompt, notes, model }, body.resume === true);
    } catch (err) {
      releaseSlot();
      return c.json({ error: err instanceof Error ? err.message : 'Could not start this job' }, 409);
    }
    c.header('X-Accel-Buffering', 'no');
    c.header('Cache-Control', 'no-cache, no-transform');
    return streamSSE(c, async stream => {
      stream.onAbort(task.pause);
      try {
        await stream.writeSSE({ event: 'job', data: JSON.stringify({ id: task.job.id, runId: task.job.runId }) });
        const [previous, allEntries, allDesigns, powerSystems, arc, charter] = await Promise.all([
          store.getAcceptedChapters(novel.id, n),
          (novel.bibleMode ?? 'accept') === 'off' ? [] : store.listBibleEntries(novel.id),
          (novel.designMode ?? 'off') === 'off' ? [] : store.listDesigns(novel.id),
          store.listPowerSystems(novel.id),
          (novel.arcMode ?? 'off') === 'off' ? null : arcForChapter(novel.id, n),
          namingOn(novel) ? loadCharter(novel) : null,
        ]);
        task.signal.throwIfAborted();
        const bibleEntries = allEntries.filter(e => e.firstChapter <= n).map(e => canonAt(e, n));
        const designs = allDesigns.filter(d => d.state === 'active');
        const map = charter && (novel.mapMode ?? 'off') !== 'off' ? await store.getMap(novel.id) : null;
        let taken = charter ? takenNames({ bible: bibleEntries, designs, map, novel }) : [];
        if (charter && !bibleEntries.length) taken = [...new Set([...taken, ...namesInProse(previous)])];
        const partial = task.job.text;
        task.restart();
        const currentDraft = partial || (mode === 'revise' ? existing!.content : undefined);
        const revisionNotes = partial
          ? `Recover this interrupted draft. Preserve its completed scenes and finish the chapter according to the original direction. Return the COMPLETE chapter. ${task.job.input.notes ?? ''}`
          : task.job.input.notes;
        const result = await runChapterAgent({
          apiKey, model: task.job.input.model, novel, chapterNumber: n, previous,
          userPrompt: task.job.input.prompt || '', currentDraft, revisionNotes,
          bibleEntries, designs, powerSystems: powerSystems.filter(s => !s.canonNeedsReview), arc, charter, takenNames: taken, signal: task.signal,
          emit: event => {
            if (event.type === 'token') task.token(event.data);
            if (event.type === 'restart') task.restart();
            if (event.type === 'trace' || event.type === 'tool') task.trace(event.data);
            void stream.writeSSE({ event: event.type, data: JSON.stringify(event.data) });
          },
        });
        task.signal.throwIfAborted();
        const parsed = extractTitle(result.content, n);
        const now = Date.now();
        const chapter: Chapter = {
          number: n, ...parsed, status: 'draft', summary: '', userPrompt: task.job.input.prompt || '',
          revisionNotes: task.job.input.notes ? [...(existing?.revisionNotes ?? []), task.job.input.notes] : existing?.revisionNotes ?? [],
          versions: pushVersion(existing, mode, task.job.input.notes), model: task.job.input.model,
          modelRuns: modelRuns(), createdAt: existing?.createdAt ?? now, updatedAt: now,
        };
        task.job.text = result.content;
        task.job.modelRuns = chapter.modelRuns!;
        await task.checkpoint(true);
        task.signal.throwIfAborted();
        await store.saveGeneratedChapter(novel.id, chapter, task.job);
        await task.finish('done');
        await stream.writeSSE({ event: 'usage', data: JSON.stringify(result.usage) });
        if (result.truncated) await stream.writeSSE({ event: 'warning', data: JSON.stringify('The output limit was reached. The incomplete draft is saved; revise to continue the scene.') });
        await stream.writeSSE({ event: 'done', data: JSON.stringify(chapter) });
      } catch (err) {
        task.job.modelRuns = modelRuns();
        const message = err instanceof Error ? err.message : 'Generation failed';
        await task.finish(task.signal.aborted ? 'paused' : 'failed', message);
        if (!task.signal.aborted) await stream.writeSSE({ event: 'error', data: JSON.stringify(message) });
      } finally { releaseSlot(); }
    });
  };
}

chapterRoutes.post('/:n/generate', handleGeneration('generate'));
chapterRoutes.post('/:n/revise', handleGeneration('revise'));

/**
 * Humanize: a second model pass that repairs measured defects in a draft.
 *
 * Unlike generate and revise this takes no instructions from the author. What
 * to fix is decided by counting things in the draft and comparing them against
 * ranges measured from published fiction (engine/humanizer/bands.ts), so the
 * author's only decision is whether to run it.
 *
 * It writes a draft back exactly as revise does, which means it is undoable the
 * same way and cannot touch an accepted chapter. The repair is discarded rather
 * than saved if it invents a name or deletes a quarter of the text; a run that
 * changes nothing is a success, not an error.
 */
chapterRoutes.post('/:n/humanize', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);

  let n: number;
  let model: string;
  let apiKey: string;
  let existing: Chapter;
  let releaseSlot: () => void;

  try {
    n = chapterNumber(c.req.param('n'), LIMITS.chaptersPerNovel);
    apiKey = openRouterKey(c);
    if (!apiKey) return c.json({ error: NO_KEY_MESSAGE }, 400);

    const body = await readJson<{ model?: string }>(c);
    model = safeModelId(body.model, { required: false }) || novel.defaultModel;
    if (!model) return c.json({ error: 'No model selected' }, 400);

    const chapter = await store.getChapter(novel.id, n);
    if (!chapter) return c.json({ error: 'No draft to humanize' }, 404);
    if (chapter.status === 'accepted') {
      return c.json({ error: 'Chapter is already accepted' }, 409);
    }
    existing = chapter;

    releaseSlot = acquireGenerationSlot(c.get('uid'), c.get('email'), c.get('emailVerified'));
  } catch (err) {
    return apiError(c, err);
  }

  c.header('Cache-Control', 'no-cache, no-transform');

  return streamSSE(c, async (stream) => {
    const controller = new AbortController();
    stream.onAbort(() => controller.abort());
    try {
      const result = await humanizeChapter({
        apiKey,
        signal: controller.signal,
        model,
        content: existing.content,
        targetWords: novel.chapterLength,
        disabledMetrics: novel.proseProfile?.disabledMetrics,
        emit: (event) => {
          void stream.writeSSE({ event: event.type, data: JSON.stringify(event.data) });
        },
      });

      if (!result.changed) {
        // Nothing was safely fixable. Reported as a normal outcome so the UI can
        // say so, rather than as an error the author has to interpret.
        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({ chapter: existing, resolved: [], remaining: result.remaining }),
        });
        return;
      }

      const { title, content } = extractTitle(result.content, n);
      const chapter: Chapter = {
        ...existing,
        title,
        content,
        // The repair invalidates any next-chapter directions read off the old
        // ending, exactly as an edit does.
        nextSuggestions: undefined,
        versions: pushVersion(existing, 'humanize'),
        updatedAt: Date.now(),
      };
      controller.signal.throwIfAborted();
      await store.updateChapterChecked(novel.id, n, chapter, chapterRevision(existing));

      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({ chapter, resolved: result.resolved, remaining: result.remaining }),
      });
    } catch (err) {
      const message =
        err instanceof OpenRouterError ? err.message : 'Humanizing failed. Please try again.';
      console.error(`[humanize] novel=${novel.id} ch=${n}:`, err);
      await stream.writeSSE({ event: 'error', data: JSON.stringify(message) });
    } finally {
      releaseSlot();
    }
  });
});

/**
 * Edit one selected passage.
 *
 * Deliberately READ-ONLY: it streams a proposed replacement and saves nothing.
 * The author accepts it, and the acceptance goes through PATCH like any other
 * edit — so there is one write path, one place history is recorded, and no way
 * for a model call to change accepted prose on its own.
 *
 * The selection is sent as offsets AND as the text those offsets covered. If
 * the two disagree the chapter moved underneath the author (another tab, a
 * humanize pass) and the edit is refused rather than applied to whatever now
 * sits at those offsets — the one failure here that could quietly corrupt a
 * chapter.
 */
chapterRoutes.post('/:n/edit', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);

  let n: number;
  let model: string;
  let apiKey: string;
  let chapter: Chapter;
  let start: number;
  let end: number;
  let action: ReturnType<typeof asEditAction>;
  let instruction: string;
  let protectedFacts: string;
  let releaseSlot: () => void;

  try {
    n = chapterNumber(c.req.param('n'), LIMITS.chaptersPerNovel);
    apiKey = openRouterKey(c);
    if (!apiKey) return c.json({ error: NO_KEY_MESSAGE }, 400);

    const body = await readJson<{
      action?: unknown;
      start?: unknown;
      end?: unknown;
      text?: unknown;
      instruction?: unknown;
      protectedFacts?: unknown;
      model?: unknown;
    }>(c);

    protectedFacts = boundedString(body.protectedFacts, 'notes');
    if (protectedFacts.length > 2000) throw new ValidationError('Protected facts must be at most 2000 characters');
    action = asEditAction(body.action);
    instruction = boundedString(body.instruction, 'notes', {
      required: action === 'custom',
    });

    model = safeModelId(body.model, { required: false }) || novel.defaultModel;
    if (!model) return c.json({ error: 'No model selected' }, 400);

    const found = await store.getChapter(novel.id, n);
    if (!found) return c.json({ error: 'Chapter not found' }, 404);
    chapter = found;

    start = asOffset(body.start, 'start');
    end = asOffset(body.end, 'end');
    const selected = typeof body.text === 'string' ? body.text : '';
    if (end <= start) return c.json({ error: 'Select some text to edit first' }, 400);
    if (end - start > MAX_SELECTION_CHARS) {
      return c.json(
        { error: 'That selection is too large for an inline edit — revise the chapter instead' },
        400
      );
    }
    if (chapter.content.slice(start, end) !== selected) {
      return c.json(
        {
          error:
            'This chapter changed since you selected that passage. Reload the chapter and select it again.',
        },
        409
      );
    }

    releaseSlot = acquireGenerationSlot(c.get('uid'), c.get('email'), c.get('emailVerified'));
  } catch (err) {
    return apiError(c, err);
  }

  c.header('X-Accel-Buffering', 'no');
  c.header('Cache-Control', 'no-cache, no-transform');

  return streamSSE(c, async (stream) => {
    const controller = new AbortController();
    stream.onAbort(() => controller.abort());
    try {
      const charter = namingOn(novel) ? await loadCharter(novel) : null;
      const { replacement, usage, warning } = await runInlineEdit({
        apiKey,
        signal: controller.signal,
        model,
        novel,
        charter,
        chapterNumber: n,
        chapterTitle: chapter.title,
        content: chapter.content,
        start,
        end,
        action,
        instruction, protectedFacts,
        onToken: (token) => {
          void stream.writeSSE({ event: 'token', data: JSON.stringify(token) });
        },
      });

      if (usage) await stream.writeSSE({ event: 'usage', data: JSON.stringify(usage) });
      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({ replacement, start, end, ...(warning ? { warning } : {}) }),
      });
    } catch (err) {
      const message =
        err instanceof InlineEditError || err instanceof OpenRouterError
          ? err.message
          : 'That edit failed unexpectedly. Please try again.';
      console.error(`[edit] novel=${novel.id} ch=${n}:`, err);
      await stream.writeSSE({ event: 'error', data: JSON.stringify(message) });
    } finally {
      releaseSlot();
    }
  });
});

/** Above this an inline edit is really a revise, and should be priced like one. */
const MAX_SELECTION_CHARS = 20_000;

function asEditAction(value: unknown) {
  if (!isEditAction(value)) throw new ValidationError('Unknown edit action');
  return value;
}

function asOffset(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${field} must be a position in the chapter`);
  }
  return value;
}

/**
 * What the humanizer would change, without spending a model call. Lets the UI
 * show the button only when there is something to do, and say what it found.
 */
chapterRoutes.get('/:n/humanize/preview', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  try {
    const n = chapterNumber(c.req.param('n'), LIMITS.chaptersPerNovel);
    const chapter = await store.getChapter(novel.id, n);
    if (!chapter) return c.json({ error: 'No draft' }, 404);
    const d = diagnose(chapter.content, novel.chapterLength, novel.proseProfile?.disabledMetrics);
    return c.json({
      defects: d.defects.map((x) => ({ kind: x.kind, observed: x.observed, band: x.band ?? null })),
      words: d.words,
    });
  } catch (err) {
    return apiError(c, err);
  }
});

/**
 * Hand-edit a chapter's title or text. Works on drafts and accepted chapters
 * alike — fixing a typo must never require asking the model.
 *
 * Every text change through here is also the commit point for the two writes
 * that are not hand edits: an accepted inline edit and a restore from history
 * both arrive as ordinary content patches, distinguished only by `origin` so
 * the history reads truthfully. Keeping them on one route means there is
 * exactly one place a chapter's text can be replaced by the author.
 */
chapterRoutes.patch('/:n', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);

  try {
    const n = chapterNumber(c.req.param('n'), LIMITS.chaptersPerNovel);
    const chapter = await store.getChapter(novel.id, n);
    if (!chapter) return c.json({ error: 'Chapter not found' }, 404);

    const body = await readJson<{ title?: unknown; content?: unknown; origin?: unknown; expectedUpdatedAt?: unknown }>(c);
    const origin: VersionKind =
      body.origin === 'inline' || body.origin === 'restore' ? body.origin : 'edit';
    const patch: Partial<Chapter> = {};
    if (body.title !== undefined) {
      patch.title = boundedString(body.title, 'title', { required: true });
    }
    const contentChanged =
      body.content !== undefined &&
      (patch.content = boundedString(body.content, 'content', { required: true })) !==
        chapter.content;

    if (patch.title === undefined && body.content === undefined) {
      return c.json({ error: 'Nothing to update' }, 400);
    }

    if (body.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== chapter.updatedAt) return c.json({ error: 'This chapter changed in another tab. Reload and compare your saved draft.' }, 409);
    const usage = null;
    if (contentChanged) {
      patch.summary = '';
      patch.summaryStale = chapter.status === 'accepted';
      patch.nextSuggestions = [];
      if (chapter.canonProposal) patch.canonProposal = { ...chapter.canonProposal, state: 'stale' };
    }

    // Snapshot before the write, not after — this is the last moment the
    // previous text exists anywhere.
    if (contentChanged) patch.versions = pushVersion(chapter, origin);

    const updated = await store.updateChapterChecked(novel.id, n, patch, chapterRevision(chapter));
    if (contentChanged && chapter.status === 'accepted') await store.invalidateBibleFrom(novel.id, n);

    return c.json({ chapter: updated, usage });
  } catch (err) {
    return apiError(c, err);
  }
});

/**
 * Delete a chapter. Later chapters shift down so numbering stays contiguous —
 * the client must refuse this while a generation is running for the novel,
 * since running jobs are keyed by chapter number.
 */
chapterRoutes.delete('/:n', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);

  try {
    const n = chapterNumber(c.req.param('n'), LIMITS.chaptersPerNovel);
    const chapter = await store.getChapter(novel.id, n);
    if (!chapter) return c.json({ error: 'Chapter not found' }, 404);

    if ((await store.listJobs(novel.id, true)).some(jobActive)) return c.json({ error: 'Stop the running jobs before deleting a chapter.' }, 409);
    const shifted = await store.deleteChapterAndRenumber(novel.id, n);
    // Facts sourced from the deleted chapter describe canon that no longer
    // exists; provenance above it is off by one. Same contract as the chapter
    // renumbering itself, and the map keeps the same books as the bible.
    // Unconditional, and safe to be: both number only what a chapter
    // established, so there is nothing above the last written chapter to move.
    await store.renumberBibleAfterChapterDelete(novel.id, n);
    await store.renumberMapAfterChapterDelete(novel.id, n);
    await store.invalidateBibleFrom(novel.id, n);
    await store.removeJobsFrom(novel.id, n);
    // Arcs are the exception, because a blueprint numbers a chapter that has
    // not been written. Realigning them when nothing actually moved deletes the
    // plan for the draft the author is about to rewrite and slides every later
    // plan onto the wrong chapter, so it is conditional on a measured shift.
    // Designs need no equivalent — they carry no chapter provenance at all.
    await store.renumberArcsAfterChapterDelete(novel.id, n, shifted > 0);
    if ((novel.bibleChapter ?? 0) >= n) {
      await store.updateNovel(novel.id, { bibleChapter: Math.max(0, n - 1), continuityDirtyFrom: n });
    }
    if ((novel.mapChapter ?? 0) >= n) {
      await store.updateNovel(novel.id, { mapChapter: (novel.mapChapter ?? 0) - 1 });
    }
    // chapterCount is a high-water mark that gates "what may be written next";
    // leaving it stale would let sparse chapters back in (or block writing).
    await store.updateNovel(novel.id, {
      wordCount: Math.max(0, novel.wordCount - store.countWords(chapter.content)),
      ...(novel.chapterCount > 0 ? { chapterCount: novel.chapterCount - 1 } : {}),
    });

    return c.json({ ok: true, chapters: await store.listChapters(novel.id) });
  } catch (err) {
    return apiError(c, err);
  }
});

/**
 * Accept a chapter. Streams the summary as it is written (SSE `token` events,
 * then `usage` and `done`) so the client can show real progress instead of a
 * timer-driven guess. The summary is what later chapters remember once the
 * history is compacted; its cost goes back to the client so the running spend
 * counter stays honest.
 */
chapterRoutes.post('/:n/accept', async c => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  let release = () => {};
  try {
    const n = chapterNumber(c.req.param('n'), LIMITS.chaptersPerNovel);
    const body = await readJson<{ model?: unknown; resume?: boolean }>(c);
    let chapter = await store.getChapter(novel.id, n);
    if (!chapter) return c.json({ error: 'Chapter not found' }, 404);
    const apiKey = openRouterKey(c);
    const model = (safeModelId(body.model, { required: false }) || chapter.model || novel.defaultModel);
    if (chapter.status !== 'accepted') chapter = await store.updateChapterChecked(novel.id, n, { status: 'accepted', summaryStale: !chapter.summary }, chapterRevision(chapter));
    const accepted = chapter;
    let task: Awaited<ReturnType<typeof startJob>> | undefined;
    if (apiKey && model) {
      release = acquireGenerationSlot(c.get('uid'), c.get('email'), c.get('emailVerified'));
      const previous = await store.getJob(novel.id, `upkeep-${n}`);
      if (previous?.status === 'done' && previous.baseRevision === chapterRevision(accepted) && !accepted.summaryStale) {
        release(); release = () => {};
        return streamSSE(c, async stream => { await stream.writeSSE({ event: 'accepted', data: JSON.stringify({ summary: accepted.summary }) }); await stream.writeSSE({ event: 'done', data: JSON.stringify({ ok: true, summary: accepted.summary }) }); });
      }
      task = await startJob(novel.id, n, 'upkeep', accepted, { model }, !!previous && previous.status !== 'done' && !accepted.summaryStale && previous.baseRevision === chapterRevision(accepted));
      if (accepted.summary && !accepted.summaryStale) task.job.stages!.summary = 'done';
      if (accepted.canonProposal?.revision === revisionOf(accepted.content) && ['applied', 'rejected'].includes(accepted.canonProposal.state)) task.job.stages!.bible = 'done';
    }
    c.header('X-Accel-Buffering', 'no');
    c.header('Cache-Control', 'no-cache, no-transform');
    return streamSSE(c, async stream => {
      if (task) stream.onAbort(task.pause);
      let currentStage: 'summary' | 'suggestions' | 'bible' | 'map' = 'summary';
      let summary = accepted.summary;
      const usage = async (value: Usage | null) => { if (value) await stream.writeSSE({ event: 'usage', data: JSON.stringify(value) }); };
      const trace = (message: string) => { task?.trace(message); void stream.writeSSE({ event: 'trace', data: JSON.stringify(message) }); };
      try {
        await stream.writeSSE({ event: 'accepted', data: JSON.stringify({ summary }) });
        if (!task || !apiKey) { await stream.writeSSE({ event: 'done', data: JSON.stringify({ ok: true, summary, maintenancePending: true }) }); return; }
        await stream.writeSSE({ event: 'job', data: JSON.stringify({ id: task.job.id, runId: task.job.runId }) });
        const stages = task.job.stages!;
        if (stages.summary !== 'done') {
          trace('Refreshing chapter summary…');
          const result = await streamChat({ role: 'summarizer', apiKey, model, messages: buildSummaryMessages(novel, accepted), maxTokens: 500, signal: task.signal, onToken: token => { void stream.writeSSE({ event: 'token', data: JSON.stringify(token) }); } });
          summary = result.content.trim();
          if (!summary) throw new Error('The summary was empty. Retry memory refresh.');
          await store.updateChapterChecked(novel.id, n, { summary, summaryStale: false }, chapterRevision(accepted));
          await usage(result.usage); stages.summary = 'done'; await task.checkpoint(true);
        }
        currentStage = 'suggestions';
        if (stages.suggestions !== 'done') {
          const planned = (novel.arcMode ?? 'off') === 'off' ? null : await blueprintForChapter(novel.id, n + 1);
          if ((novel.suggestMode ?? 'on') === 'on' && !planned) {
            trace('Preparing next-chapter directions…');
            const [previous, bibleEntries, designs] = await Promise.all([store.getAcceptedChapters(novel.id, n), store.listBibleEntries(novel.id), store.listDesigns(novel.id)]);
            const result = await runSuggestions({ apiKey, novel, chapter: { ...accepted, summary }, previous, bibleEntries, designs: designs.filter(d => d.state === 'active'), signal: task.signal });
            await store.updateChapterChecked(novel.id, n, { nextSuggestions: result.suggestions }, chapterRevision(accepted));
            await usage(result.usage);
            await stream.writeSSE({ event: 'suggestions', data: JSON.stringify({ forChapter: n + 1, suggestions: result.suggestions }) });
          }
          stages.suggestions = 'done'; await task.checkpoint(true);
        }
        currentStage = 'bible';
        if (stages.bible !== 'done') {
          if ((novel.bibleMode ?? 'accept') === 'accept') {
            const current = await store.getChapter(novel.id, n);
            if (current?.canonProposal?.state === 'pending' && current.canonProposal.revision === revisionOf(accepted.content)) {
              stages.bible = 'review';
            } else {
              trace('Updating story bible…');
              const result = await runBibleUpdate({ apiKey, novel, chapter: { ...accepted, summary }, source: 'chapter', signal: task.signal, emit: e => { if (e.type === 'trace') trace(e.data); } });
              await usage(result.usage);
              stages.bible = result.pendingReview ? 'review' : 'done';
              await stream.writeSSE({ event: 'bible', data: JSON.stringify(result) });
              if (!result.pendingReview && (novel.bibleChapter ?? 0) === n - 1) await store.updateNovel(novel.id, { bibleChapter: n });
            }
          } else stages.bible = 'done';
          await task.checkpoint(true);
          if (stages.bible === 'review') {
            trace('Review this chapter’s canon changes before continuing memory upkeep.');
            task.job.modelRuns = modelRuns();
            await task.finish('paused');
            await stream.writeSSE({ event: 'done', data: JSON.stringify({ ok: true, summary, pendingReview: true }) });
            return;
          }
        }
        currentStage = 'map';
        if (stages.map !== 'done') {
          if ((novel.mapMode ?? 'off') === 'accept') {
            trace('Updating the map…');
            const result = await runMapUpdate({ apiKey, novel, chapter: accepted, signal: task.signal, emit: e => { if (e.type === 'trace') trace(e.data); } });
            await usage(result.usage);
            await stream.writeSSE({ event: 'map', data: JSON.stringify(result) });
            if ((novel.mapChapter ?? 0) === n - 1) await store.updateNovel(novel.id, { mapChapter: n });
          }
          stages.map = 'done';
        }
        task.job.modelRuns = modelRuns();
        await task.finish('done');
        await stream.writeSSE({ event: 'done', data: JSON.stringify({ ok: true, summary }) });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Memory upkeep failed';
        if (task) {
          task.job.stages![currentStage] = 'failed';
          task.job.modelRuns = modelRuns();
          await task.finish(task.signal.aborted ? 'paused' : 'failed', message);
        }
        await stream.writeSSE({ event: 'error', data: JSON.stringify(message) });
      } finally { release(); }
    });
  } catch (err) {
    release();
    return c.json({ error: err instanceof Error ? err.message : 'Could not accept chapter' }, 409);
  }
});
