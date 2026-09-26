import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { runBibleUpdate } from '../engine/bibleAgent.js';
import { OpenRouterError } from '../engine/openrouter.js';
import type { AuthEnv } from '../lib/authMiddleware.js';
import { NO_KEY_MESSAGE, openRouterKey } from '../lib/apiKey.js';
import {
  BIBLE_LIMITS,
  BibleValidationError,
  applyBiblePatch,
  slugifyBibleName,
  validateBiblePatch,
} from '../lib/bibleValidate.js';
import * as store from '../lib/store.js';
// Hidden novels answer "not found" without an unlocked vault; the bible is as
// private as the novel it belongs to.
import { loadAccessibleNovel } from '../lib/vault.js';
import { apiError } from '../lib/validate.js';

export const bibleRoutes = new Hono<AuthEnv>();

bibleRoutes.get('/', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  return c.json({
    entries: await store.listBibleEntries(novel.id),
    bibleMode: novel.bibleMode ?? 'accept',
    bibleChapter: novel.bibleChapter ?? 0,
  });
});

/**
 * Create an entry by hand. The agent only records what a chapter established,
 * so an author planning ahead — a faction that exists but has not appeared, a
 * character introduced next chapter — has no other way in.
 *
 * Shares the agent's validation and slugging, so a hand-made entry is
 * indistinguishable from an extracted one afterwards.
 */
bibleRoutes.post('/', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);

  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    // Provenance is the chapter the bible has reached: this is what the author
    // knows as of now, not something a past chapter said.
    const chapter = Math.max(1, novel.bibleChapter ?? 1);
    const patch = validateBiblePatch(body, chapter);
    if (!patch.name || !patch.type) {
      return c.json({ error: 'name and type are required' }, 400);
    }

    if ((await store.countBibleEntries(novel.id)) >= BIBLE_LIMITS.entriesPerNovel) {
      return c.json(
        { error: `This novel is at its ${BIBLE_LIMITS.entriesPerNovel}-entry limit.` },
        400
      );
    }

    const id = slugifyBibleName(patch.name);
    const [clash] = await store.getBibleEntries(novel.id, [id]);
    if (clash) {
      return c.json({ error: `“${clash.name}” already exists. Edit that entry instead.` }, 409);
    }

    const entry = await store.transactBibleEntry(novel.id, id, (current) =>
      applyBiblePatch(current, id, patch, chapter)
    );
    return c.json({ entry }, 201);
  } catch (err) {
    if (err instanceof BibleValidationError) return c.json({ error: err.message }, 400);
    return apiError(c, err);
  }
});

/**
 * Author override. The agent writes through its own validated tool path; this
 * is the human's direct line — a wrong entry poisons every future chapter, so
 * the author must always be able to correct or remove one.
 */
bibleRoutes.patch('/:entryId', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  const entryId = c.req.param('entryId');

  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const [existing] = await store.getBibleEntries(novel.id, [entryId]);
    if (!existing) return c.json({ error: 'Entry not found' }, 404);

    // Author edits carry the entry's own provenance for any new facts.
    const patch = validateBiblePatch(body, existing.firstChapter);
    const next = await store.transactBibleEntry(novel.id, entryId, (current) =>
      applyBiblePatch(current ?? existing, entryId, patch, existing.firstChapter)
    );
    return c.json({ entry: next });
  } catch (err) {
    if (err instanceof BibleValidationError) return c.json({ error: err.message }, 400);
    return apiError(c, err);
  }
});

bibleRoutes.delete('/:entryId', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  const entryId = c.req.param('entryId');
  await store.deleteBibleEntry(novel.id, entryId);
  // The link is the only join between a character's canon and their design;
  // leaving it pointing at a deleted entry would silently break both. Map
  // places carry the same kind of link, with the same failure mode.
  await store.unlinkDesignsFromBibleEntry(novel.id, entryId);
  await store.unlinkMapEntitiesFromBibleEntry(novel.id, entryId);
  await store.unlinkPowerFromBibleEntry(novel.id, entryId);
  return c.json({ ok: true });
});

/**
 * The one catch-up mechanism — batch mode, backfill, and enabling the bible
 * late are all "update from bibleChapter + 1 to the last accepted chapter".
 *
 * Strictly sequential in chapter order: canon is ordered (chapter 3's update
 * may depend on entries chapter 2 created), and concurrent runs could each
 * update the same character at once. Reads chapter SUMMARIES, not full text —
 * far cheaper per chapter, and the sequential loop keeps the agent's own
 * prompt prefix warm between chapters. The high-water mark advances after
 * each chapter, so an aborted run resumes exactly where it stopped.
 */
bibleRoutes.post('/update', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  if ((novel.bibleMode ?? 'accept') === 'off') {
    return c.json({ error: 'The story bible is turned off for this novel. Enable it in novel settings first.' }, 400);
  }
  const apiKey = openRouterKey(c);
  if (!apiKey) return c.json({ error: NO_KEY_MESSAGE }, 400);

  const accepted = (await store.getAcceptedChapters(novel.id, Number.MAX_SAFE_INTEGER)).sort(
    (a, b) => a.number - b.number
  );
  const from = (novel.bibleChapter ?? 0) + 1;
  const pending = accepted.filter((ch) => ch.number >= from);

  c.header('X-Accel-Buffering', 'no');
  c.header('Cache-Control', 'no-cache, no-transform');

  return streamSSE(c, async (stream) => {
    let aborted = false;
    stream.onAbort(() => {
      aborted = true;
    });

    let done = 0;
    for (const chapter of pending) {
      if (aborted) break;
      try {
        await stream.writeSSE({
          event: 'progress',
          data: JSON.stringify({
            chapter: chapter.number,
            title: chapter.title,
            done,
            total: pending.length,
          }),
        });
        const result = await runBibleUpdate({
          apiKey,
          novel,
          chapter,
          source: 'summary',
          emit: (event) => {
            if (event.type === 'trace') {
              void stream.writeSSE({ event: 'trace', data: JSON.stringify(event.data) });
            }
          },
        });
        if (result.usage.promptTokens > 0) {
          await stream.writeSSE({ event: 'usage', data: JSON.stringify(result.usage) });
        }
        // Advance per chapter so an aborted run resumes where it stopped.
        await store.updateNovel(novel.id, { bibleChapter: chapter.number });
        done++;
      } catch (err) {
        console.error(`[bible] catch-up failed novel=${novel.id} ch=${chapter.number}:`, err);
        // Everything before this chapter is already saved and the high-water
        // mark has advanced, so the honest thing to say is what was kept and
        // where it will pick up — not just that something went wrong.
        const kept = done > 0 ? `${done} chapter${done === 1 ? '' : 's'} updated and kept. ` : '';
        const reason = err instanceof OpenRouterError && err.status === 429
          ? 'OpenRouter is rate limiting this model right now — it usually clears within a minute or two.'
          : err instanceof Error
            ? err.message
            : 'Something went wrong.';
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify(
            `${kept}Stopped at chapter ${chapter.number}: ${reason} Running it again resumes from chapter ${chapter.number}.`
          ),
        });
        return;
      }
    }

    await stream.writeSSE({
      event: 'done',
      data: JSON.stringify({ updated: done, total: pending.length }),
    });
  });
});
