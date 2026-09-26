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

    let n: number;
    let model: string;
    let apiKey: string;
    let existing: Chapter | null;
    let userPrompt: string;
    let currentDraft: string | undefined;
    let revisionNotes: string | undefined;
    let releaseSlot: () => void;

    try {
      n = chapterNumber(c.req.param('n'), LIMITS.chaptersPerNovel);
      // Chapters are appended, never scattered: without this an arbitrary `n`
      // creates a sparse document far beyond the end of the novel.
      assertChapterAllowed(n, novel.chapterCount, c.get('email'), c.get('emailVerified'));

      apiKey = openRouterKey(c);
      if (!apiKey) return c.json({ error: NO_KEY_MESSAGE }, 400);

      const body = await readJson<GenerateBody>(c);
      model = safeModelId(body.model, { required: false }) || novel.defaultModel;
      if (!model) return c.json({ error: 'No model selected' }, 400);

      existing = await store.getChapter(novel.id, n);
      if (existing?.status === 'accepted') {
        return c.json({ error: 'Chapter is already accepted' }, 409);
      }

      if (mode === 'generate') {
        userPrompt = boundedString(body.prompt, 'prompt', { required: true });
      } else {
        if (!existing) return c.json({ error: 'No draft to revise' }, 404);
        revisionNotes = boundedString(body.notes, 'notes', { required: true });
        userPrompt = existing.userPrompt;
        currentDraft = existing.content;
      }

      releaseSlot = acquireGenerationSlot(c.get('uid'), c.get('email'), c.get('emailVerified'));
    } catch (err) {
      return apiError(c, err);
    }

    const previous = await store.getAcceptedChapters(novel.id, n);
    // The bible grounds generation whenever it exists — even in batch mode,
    // whatever has been captured so far is better than nothing. 'off' skips
    // the read so the index tokens are not paid for a feature the user closed.
    const bibleEntries =
      (novel.bibleMode ?? 'accept') === 'off' ? [] : await store.listBibleEntries(novel.id);

    // Only ACTIVE designs reach generation: drafts are the author's workspace
    // and retired ones are history. Off means no read at all, so a novel that
    // never opted in pays nothing for the feature.
    const designs =
      (novel.designMode ?? 'off') === 'off'
        ? []
        : (await store.listDesigns(novel.id)).filter((d) => d.state === 'active');

    // Power systems have no mode flag: a novel without any pays one cheap
    // count-free query and an empty list means no block and no tool — the
    // designs contract, minus the flag, because a system only exists when the
    // author deliberately built one.
    const powerSystems = await store.listPowerSystems(novel.id);

    // The arc owning this chapter, and only when steering is on for it. Off
    // means no read at all, so a novel without arc planning pays nothing.
    const arc = (novel.arcMode ?? 'off') === 'off' ? null : await arcForChapter(novel.id, n);

    // The naming charter, on the same terms: off means no read. When it is on
    // and the author has never written one, loadCharter derives a default in
    // memory and persists nothing, so the feature works from the first chapter
    // without a model call, a key or a write.
    const charter = namingOn(novel) ? await loadCharter(novel) : null;
    // Names coin_name must avoid. The bible is the primary source; when it is
    // off or still empty, fall back to scanning the prose we already hold in
    // memory rather than reading the novel a second time.
    let taken: string[] = [];
    if (charter) {
      const map = (novel.mapMode ?? 'off') === 'off' ? null : await store.getMap(novel.id);
      taken = takenNames({ bible: bibleEntries, designs, map, novel });
      if (bibleEntries.length === 0) taken = [...new Set([...taken, ...namesInProse(previous)])];
    }

    // Defeat proxy buffering (Firebase Hosting / GFE sit in front of Cloud Run)
    // so tokens reach the browser as they are produced rather than in one blob.
    c.header('X-Accel-Buffering', 'no');
    c.header('Cache-Control', 'no-cache, no-transform');

    return streamSSE(c, async (stream) => {
      try {
        const { content: raw, usage, truncated } = await runChapterAgent({
          apiKey,
          model,
          novel,
          chapterNumber: n,
          previous,
          userPrompt,
          currentDraft,
          revisionNotes,
          bibleEntries,
          designs,
          powerSystems,
          arc,
          charter,
          takenNames: taken,
          emit: (event) => {
            // Fire-and-forget: SSE writes are queued in order.
            void stream.writeSSE({ event: event.type, data: JSON.stringify(event.data) });
          },

        });

        const { title, content } = extractTitle(raw, n);
        const now = Date.now();
        const chapter: Chapter = {
          number: n,
          title,
          content,
          status: 'draft',
          summary: existing?.summary ?? '',
          userPrompt,
          revisionNotes: revisionNotes
            ? [...(existing?.revisionNotes ?? []), revisionNotes]
            : (existing?.revisionNotes ?? []),
          // The draft this replaces. saveChapter sets the whole document, so
          // the history has to be carried across explicitly or it is deleted
          // by omission — the same way nextSuggestions is cleared here.
          versions: pushVersion(existing, mode === 'revise' ? 'revise' : 'generate', revisionNotes),
          model,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        await store.saveChapter(novel.id, chapter);
        // Word count moves by the difference against whatever this write
        // replaced — a regenerated draft must not double-count itself.
        const wordDelta =
          store.countWords(content) - store.countWords(existing?.content ?? '');
        await store.updateNovel(novel.id, {
          wordCount: Math.max(0, novel.wordCount + wordDelta),
          ...(n > novel.chapterCount ? { chapterCount: n } : {}),
        });
        await stream.writeSSE({ event: 'usage', data: JSON.stringify(usage) });
        // A chapter that stopped at the model's output limit is saved — it is
        // still the author's draft — but silently saving it is what made this a
        // bug report: it reads as a model that trails off, not one that ran out
        // of room. Sent before `done` so the client has it when the draft lands.
        if (truncated) {
          await stream.writeSSE({
            event: 'warning',
            data: JSON.stringify(
              'The model reached its output limit, so this chapter stops mid-scene. Revise with ' +
                '"continue from where it stops", shorten the target chapter length in Novel ' +
                'settings, or pick a model with more room.'
            ),
          });
        }
        await stream.writeSSE({ event: 'done', data: JSON.stringify(chapter) });
      } catch (err) {
        const message =
          err instanceof OpenRouterError
            ? err.message
            : 'Generation failed unexpectedly. Please try again.';
        console.error(`[${mode}] novel=${novel.id} ch=${n}:`, err);
        await stream.writeSSE({ event: 'error', data: JSON.stringify(message) });
      } finally {
        // Must run on every path, or an aborted stream leaks the slot forever.
        releaseSlot();
      }
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
    try {
      const result = await humanizeChapter({
        apiKey,
        model,
        content: existing.content,
        targetWords: novel.chapterLength,
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
      await store.saveChapter(novel.id, chapter);
      await store.updateNovel(novel.id, {
        wordCount: Math.max(
          0,
          novel.wordCount + store.countWords(content) - store.countWords(existing.content)
        ),
      });

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
      model?: unknown;
    }>(c);

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
    try {
      const charter = namingOn(novel) ? await loadCharter(novel) : null;
      const { replacement, usage, warning } = await runInlineEdit({
        apiKey,
        model,
        novel,
        charter,
        chapterNumber: n,
        chapterTitle: chapter.title,
        content: chapter.content,
        start,
        end,
        action,
        instruction,
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
const MAX_SELECTION_CHARS = 6_000;

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
    const d = diagnose(chapter.content, novel.chapterLength);
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

    const body = await readJson<{ title?: unknown; content?: unknown; origin?: unknown }>(c);
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

    // An accepted chapter's summary is what later chapters remember once the
    // history is compacted — after an edit it describes text that no longer
    // exists. Refresh it best-effort; a missing key keeps the old summary
    // rather than blocking the save.
    let usage: Usage | null = null;
    const apiKey = openRouterKey(c);
    if (contentChanged && chapter.status === 'accepted' && apiKey) {
      const model = chapter.model || novel.defaultModel;
      if (model) {
        try {
          const result = await streamChat({
            apiKey,
            model,
            messages: buildSummaryMessages(novel, { ...chapter, ...patch }),
            maxTokens: 500,
          });
          patch.summary = result.content.trim();
          usage = result.usage;
        } catch (err) {
          console.error(`[edit] summary refresh failed novel=${novel.id} ch=${n}:`, err);
        }
      }
    }

    // Snapshot before the write, not after — this is the last moment the
    // previous text exists anywhere.
    if (contentChanged) patch.versions = pushVersion(chapter, origin);

    await store.updateChapter(novel.id, n, patch);
    if (contentChanged) {
      if (chapter.nextSuggestions?.length) await store.clearNextSuggestions(novel.id, n);
      const delta = store.countWords(patch.content as string) - store.countWords(chapter.content);
      await store.updateNovel(novel.id, {
        wordCount: Math.max(0, novel.wordCount + delta),
      });
    }
    const updated = await store.getChapter(novel.id, n);

    // An edited accepted chapter may have changed canon; re-run the bible on
    // it, in the same best-effort spirit as the summary refresh above. Only in
    // 'accept' mode — batch users asked for zero incidental model calls.
    if (
      contentChanged &&
      chapter.status === 'accepted' &&
      apiKey &&
      (novel.bibleMode ?? 'accept') === 'accept' &&
      updated
    ) {
      try {
        const bible = await runBibleUpdate({
          apiKey,
          novel,
          chapter: updated,
          source: 'chapter',
        });
        if (usage && (bible.usage.cost > 0 || bible.usage.promptTokens > 0)) {
          usage = {
            promptTokens: usage.promptTokens + bible.usage.promptTokens,
            completionTokens: usage.completionTokens + bible.usage.completionTokens,
            cachedTokens: usage.cachedTokens + bible.usage.cachedTokens,
            cacheWriteTokens: usage.cacheWriteTokens + bible.usage.cacheWriteTokens,
            cost: usage.cost + bible.usage.cost,
          };
        } else if (!usage) {
          usage = bible.usage;
        }
      } catch (err) {
        console.error(`[bible] edit update failed novel=${novel.id} ch=${n}:`, err);
      }
    }

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

    const shifted = await store.deleteChapterAndRenumber(novel.id, n);
    // Facts sourced from the deleted chapter describe canon that no longer
    // exists; provenance above it is off by one. Same contract as the chapter
    // renumbering itself, and the map keeps the same books as the bible.
    // Unconditional, and safe to be: both number only what a chapter
    // established, so there is nothing above the last written chapter to move.
    await store.renumberBibleAfterChapterDelete(novel.id, n);
    await store.renumberMapAfterChapterDelete(novel.id, n);
    // Arcs are the exception, because a blueprint numbers a chapter that has
    // not been written. Realigning them when nothing actually moved deletes the
    // plan for the draft the author is about to rewrite and slides every later
    // plan onto the wrong chapter, so it is conditional on a measured shift.
    // Designs need no equivalent — they carry no chapter provenance at all.
    await store.renumberArcsAfterChapterDelete(novel.id, n, shifted > 0);
    if ((novel.bibleChapter ?? 0) >= n) {
      await store.updateNovel(novel.id, { bibleChapter: (novel.bibleChapter ?? 0) - 1 });
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
chapterRoutes.post('/:n/accept', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  let n: number;
  let model: string;
  try {
    n = chapterNumber(c.req.param('n'), LIMITS.chaptersPerNovel);
    const body = await c.req.json<{ model?: unknown }>().catch(() => ({}) as { model?: unknown });
    model = safeModelId(body.model, { required: false });
  } catch (err) {
    return apiError(c, err);
  }
  const chapter = await store.getChapter(novel.id, n);
  if (!chapter) return c.json({ error: 'Chapter not found' }, 404);

  const apiKey = openRouterKey(c);
  const summaryModel = model || chapter.model || novel.defaultModel;
  const alreadyAccepted = chapter.status === 'accepted';

  c.header('X-Accel-Buffering', 'no');
  c.header('Cache-Control', 'no-cache, no-transform');

  return streamSSE(c, async (stream) => {
    // Idempotent short-circuit, in the same SSE shape the client expects.
    if (alreadyAccepted) {
      await stream.writeSSE({ event: 'accepted', data: JSON.stringify({ summary: chapter.summary }) });
      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({ ok: true, summary: chapter.summary }),
      });
      return;
    }

    let summary = '';
    if (apiKey && summaryModel) {
      try {
        const result = await streamChat({
          apiKey,
          model: summaryModel,
          messages: buildSummaryMessages(novel, chapter),
          maxTokens: 500,
          onToken: (token) => {
            void stream.writeSSE({ event: 'token', data: JSON.stringify(token) });
          },
        });
        summary = result.content.trim();
        if (result.usage) {
          await stream.writeSSE({ event: 'usage', data: JSON.stringify(result.usage) });
        }
      } catch (err) {
        // Best effort: the chapter still gets accepted with no summary rather
        // than blocking the writer on a summary failure.
        console.error(`[accept] summary failed novel=${novel.id} ch=${n}:`, err);
      }
    }

    await store.updateChapter(novel.id, n, { status: 'accepted', summary });

    // The chapter is now canon, and that is the moment the writer is waiting
    // for — everything below is upkeep. Saying so as its own event lets the
    // client move them to the next chapter while the bible catches up behind
    // them, instead of holding the editor hostage to a second model call.
    await stream.writeSSE({ event: 'accepted', data: JSON.stringify({ summary }) });

    // Next-chapter directions, first among the upkeep jobs. The writer has just
    // been moved to an empty chapter N+1 and is looking at the box; the bible
    // and the map are invisible to them until they open those pages. So this
    // one goes first even though it is the newest — the ordering follows who is
    // waiting, not what was built when.
    /*
     * A chapter that is already planned needs no directions. The author will
     * be looking at a blueprint they wrote and accepted, and proposing three
     * alternatives beside it is both a wasted call and a worse screen — so the
     * agent is never invoked rather than invoked and hidden. Asking for three
     * on demand still works, for going off-plan deliberately.
     */
    const plannedNext =
      (novel.arcMode ?? 'off') === 'off' ? null : await blueprintForChapter(novel.id, n + 1);

    if ((novel.suggestMode ?? 'on') === 'on' && apiKey && !plannedNext) {
      try {
        const [previous, bibleEntries, designs] = await Promise.all([
          store.getAcceptedChapters(novel.id, n),
          (novel.bibleMode ?? 'accept') === 'off'
            ? Promise.resolve([])
            : store.listBibleEntries(novel.id),
          (novel.designMode ?? 'off') === 'off'
            ? Promise.resolve([])
            : store.listDesigns(novel.id),
        ]);
        const proposal = await runSuggestions({
          apiKey,
          novel,
          chapter: { ...chapter, status: 'accepted', summary },
          previous,
          bibleEntries,
          designs: designs.filter((d) => d.state === 'active'),
          emit: (event) => {
            if (event.type === 'trace') {
              void stream.writeSSE({ event: 'trace', data: JSON.stringify(event.data) });
            }
          },
        });
        // Stored on the chapter they were read FROM — chapter n+1 has no
        // document yet, and this way a later renumbering carries them along.
        await store.updateChapter(novel.id, n, { nextSuggestions: proposal.suggestions });
        if (proposal.usage.cost > 0 || proposal.usage.promptTokens > 0) {
          await stream.writeSSE({ event: 'usage', data: JSON.stringify(proposal.usage) });
        }
        await stream.writeSSE({
          event: 'suggestions',
          data: JSON.stringify({ forChapter: n + 1, suggestions: proposal.suggestions }),
        });
      } catch (err) {
        // Silent by design: an author who never sees the cards does not know
        // they were promised any, and "we could not think of three ideas" is
        // not news worth a line in the strip.
        console.error(`[suggest] accept failed novel=${novel.id} ch=${n}:`, err);
      }
    }

    // Story bible upkeep, mode-gated. Best-effort by contract: the chapter is
    // already accepted above, and a bible failure must never undo or delay
    // that. Usage is streamed as its own event so the client bills the turn
    // honestly.
    if ((novel.bibleMode ?? 'accept') === 'accept' && apiKey) {
      try {
        await stream.writeSSE({ event: 'trace', data: JSON.stringify('Updating story bible…') });
        const bible = await runBibleUpdate({
          apiKey,
          novel,
          chapter: { ...chapter, status: 'accepted', summary },
          source: 'chapter',
          emit: (event) => {
            if (event.type === 'trace') {
              void stream.writeSSE({ event: 'trace', data: JSON.stringify(event.data) });
            }
          },
        });
        if (bible.usage.cost > 0 || bible.usage.promptTokens > 0) {
          await stream.writeSSE({ event: 'usage', data: JSON.stringify(bible.usage) });
        }
        await stream.writeSSE({
          event: 'bible',
          data: JSON.stringify({ created: bible.created, updated: bible.updated, power: bible.power }),
        });
        // Advance the high-water mark only when contiguous. If earlier
        // chapters are unreflected (a spell in batch/off mode), jumping the
        // mark to n would skip them forever; leaving it makes the next
        // catch-up run cover the gap, and redoing this chapter there is safe
        // (facts dedup by text).
        if ((novel.bibleChapter ?? 0) === n - 1) {
          await store.updateNovel(novel.id, { bibleChapter: n });
        }
      } catch (err) {
        console.error(`[bible] accept update failed novel=${novel.id} ch=${n}:`, err);
        await stream.writeSSE({
          event: 'trace',
          data: JSON.stringify('Story bible update failed — it will catch up on the next run.'),
        });
      }
    }

    // Atlas upkeep, its own try/catch after the bible's: a bible failure must
    // not skip the map, and a map failure must not fail the accept. It runs
    // second so that a location entry the bible just created is already there
    // for the map to link to.
    if ((novel.mapMode ?? 'off') === 'accept' && apiKey) {
      try {
        await stream.writeSSE({ event: 'trace', data: JSON.stringify('Updating the map…') });
        const map = await runMapUpdate({
          apiKey,
          novel,
          chapter,
          emit: (event) => {
            if (event.type === 'trace') {
              void stream.writeSSE({ event: 'trace', data: JSON.stringify(event.data) });
            }
          },
        });
        if (map.usage.cost > 0 || map.usage.promptTokens > 0) {
          await stream.writeSSE({ event: 'usage', data: JSON.stringify(map.usage) });
        }
        await stream.writeSSE({
          event: 'map',
          data: JSON.stringify({ entitiesAdded: map.entitiesAdded, factsAdded: map.factsAdded }),
        });
        // Contiguous-advance only, same reasoning as bibleChapter above.
        if ((novel.mapChapter ?? 0) === n - 1) {
          await store.updateNovel(novel.id, { mapChapter: n });
        }
      } catch (err) {
        console.error(`[map] accept update failed novel=${novel.id} ch=${n}:`, err);
        await stream.writeSSE({
          event: 'trace',
          data: JSON.stringify('Map update failed — it will catch up on the next run.'),
        });
      }
    }

    await stream.writeSSE({ event: 'done', data: JSON.stringify({ ok: true, summary }) });
  });
});
