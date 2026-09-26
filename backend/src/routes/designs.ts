import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { runDesignAssist, runDesignDrift } from '../engine/designAgent.js';
import type { AuthEnv } from '../lib/authMiddleware.js';
import { NO_KEY_MESSAGE, openRouterKey } from '../lib/apiKey.js';
import {
  DESIGN_LIMITS,
  DesignValidationError,
  applyDesignPatch,
  emptyDesign,
  slugifyDesignName,
  validateDesignPatch,
} from '../lib/designValidate.js';
import * as store from '../lib/store.js';
import type { CharacterDesign, DesignState } from '../lib/types.js';
// Hidden novels answer "not found" without an unlocked vault; a design is as
// private as the novel it belongs to.
import { loadAccessibleNovel } from '../lib/vault.js';
import { apiError } from '../lib/validate.js';

export const designRoutes = new Hono<AuthEnv>();

const OFF_MESSAGE =
  'Character designs are turned off for this novel. Enable them in novel settings first.';

/**
 * Reading is always allowed, even with the feature off, so the screen can
 * explain itself and offer to turn it on rather than 404ing at someone who
 * followed a link.
 */
designRoutes.get('/', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  return c.json({
    designs: await store.listDesigns(novel.id),
    designMode: novel.designMode ?? 'off',
  });
});

/**
 * Create a design, blank or seeded from a story bible entry. Seeding matters:
 * most designs are for characters the novel already has, and retyping their
 * role and appearance is both tedious and a chance to contradict canon.
 */
designRoutes.post('/', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  if ((novel.designMode ?? 'off') === 'off') return c.json({ error: OFF_MESSAGE }, 400);

  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const fromEntryId = typeof body.fromEntryId === 'string' ? body.fromEntryId.trim() : '';

    let name = typeof body.name === 'string' ? body.name.trim() : '';
    let seeded: CharacterDesign | null = null;

    if (fromEntryId) {
      const [entry] = await store.getBibleEntries(novel.id, [fromEntryId]);
      if (!entry) return c.json({ error: 'That story bible entry no longer exists.' }, 404);
      name = name || entry.name;
      seeded = emptyDesign(slugifyDesignName(name), name);
      seeded.linkedEntryId = entry.id;
      seeded.essentials = {
        role: entry.attributes.role ?? '',
        age: entry.attributes.age ?? '',
        appearance: entry.attributes.appearance ?? '',
        voice: entry.attributes.voice ?? '',
      };
    }

    if (!name) return c.json({ error: 'A name is required.' }, 400);

    if ((await store.countDesigns(novel.id)) >= DESIGN_LIMITS.designsPerNovel) {
      return c.json(
        { error: `This novel is at its ${DESIGN_LIMITS.designsPerNovel}-design limit.` },
        400
      );
    }

    const id = slugifyDesignName(name);
    if (await store.getDesign(novel.id, id)) {
      return c.json({ error: `A design for “${name}” already exists. Edit that one instead.` }, 409);
    }

    const design = seeded ?? emptyDesign(id, name);
    await store.transactDesign(novel.id, id, () => design);
    return c.json({ design }, 201);
  } catch (err) {
    if (err instanceof DesignValidationError) return c.json({ error: err.message }, 400);
    return apiError(c, err);
  }
});

/**
 * Field edits, plus the two things the assist agent deliberately cannot do:
 * change `state` and toggle `steer`. Activating a design is what makes it
 * visible to generation and steering is what presses it into every prompt, so
 * both stay author decisions.
 */
designRoutes.patch('/:designId', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  if ((novel.designMode ?? 'off') === 'off') return c.json({ error: OFF_MESSAGE }, 400);
  const designId = c.req.param('designId');

  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const existing = await store.getDesign(novel.id, designId);
    if (!existing) return c.json({ error: 'Design not found' }, 404);

    const { state, steer, ...fields } = body;
    let design = existing;

    if (Object.keys(fields).length > 0) {
      const patch = validateDesignPatch(fields);
      design = await store.transactDesign(novel.id, designId, (current) =>
        applyDesignPatch(current ?? existing, designId, patch)
      );
    }

    if (steer !== undefined) {
      if (typeof steer !== 'boolean') return c.json({ error: 'steer must be true or false' }, 400);
      design = await store.transactDesign(novel.id, designId, (current) => ({
        ...(current ?? design),
        steer,
        updatedAt: Date.now(),
      }));
    }

    if (state !== undefined) {
      if (state !== 'draft' && state !== 'active' && state !== 'retired') {
        return c.json({ error: 'state must be draft, active or retired' }, 400);
      }
      design =
        state === 'active'
          ? await store.activateDesign(novel.id, designId)
          : await store.transactDesign(novel.id, designId, (current) => ({
              ...(current ?? design),
              state: state as DesignState,
              updatedAt: Date.now(),
            }));
    }

    return c.json({ design });
  } catch (err) {
    if (err instanceof DesignValidationError) return c.json({ error: err.message }, 400);
    return apiError(c, err);
  }
});

designRoutes.delete('/:designId', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  await store.deleteDesign(novel.id, c.req.param('designId'));
  return c.json({ ok: true });
});

/** Fill the gaps in a design, grounded in the story bible. */
designRoutes.post('/:designId/assist', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  if ((novel.designMode ?? 'off') === 'off') return c.json({ error: OFF_MESSAGE }, 400);
  const apiKey = openRouterKey(c);
  if (!apiKey) return c.json({ error: NO_KEY_MESSAGE }, 400);

  const designId = c.req.param('designId');
  const design = await store.getDesign(novel.id, designId);
  if (!design) return c.json({ error: 'Design not found' }, 404);

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const instructions = typeof body.instructions === 'string' ? body.instructions.slice(0, 2000) : '';
  const bibleEntries = await store.listBibleEntries(novel.id);

  c.header('X-Accel-Buffering', 'no');
  c.header('Cache-Control', 'no-cache, no-transform');

  return streamSSE(c, async (stream) => {
    const controller = new AbortController();
    stream.onAbort(() => controller.abort());

    try {
      const result = await runDesignAssist({
        apiKey,
        novel,
        design,
        bibleEntries,
        instructions,
        signal: controller.signal,
        emit: (event) => {
          if (event.type === 'trace') {
            void stream.writeSSE({ event: 'trace', data: JSON.stringify(event.data) });
          }
        },
      });
      if (result.usage.promptTokens > 0) {
        await stream.writeSSE({ event: 'usage', data: JSON.stringify(result.usage) });
      }
      const updated = (await store.getDesign(novel.id, designId)) ?? design;
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ design: updated }) });
    } catch (err) {
      console.error(`[design:assist] failed novel=${novel.id} design=${designId}:`, err);
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify(err instanceof Error ? err.message : 'The design assistant failed.'),
      });
    }
  });
});

/**
 * Compare an active design against what the novel actually did.
 *
 * Only active designs: a draft has not reached generation, so there is nothing
 * it could have drifted from.
 */
designRoutes.post('/:designId/drift', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  if ((novel.designMode ?? 'off') === 'off') return c.json({ error: OFF_MESSAGE }, 400);
  const apiKey = openRouterKey(c);
  if (!apiKey) return c.json({ error: NO_KEY_MESSAGE }, 400);

  const designId = c.req.param('designId');
  const design = await store.getDesign(novel.id, designId);
  if (!design) return c.json({ error: 'Design not found' }, 404);
  if (design.state !== 'active') {
    return c.json(
      { error: 'Only an active design can drift — activate it first, or it has not reached any chapter.' },
      400
    );
  }

  const chapters = (await store.getAcceptedChapters(novel.id, Number.MAX_SAFE_INTEGER)).sort(
    (a, b) => a.number - b.number
  );
  if (chapters.length === 0) {
    return c.json({ error: 'There are no accepted chapters to compare against yet.' }, 400);
  }

  const bibleEntries = await store.listBibleEntries(novel.id);

  c.header('X-Accel-Buffering', 'no');
  c.header('Cache-Control', 'no-cache, no-transform');

  return streamSSE(c, async (stream) => {
    const controller = new AbortController();
    stream.onAbort(() => controller.abort());

    try {
      const result = await runDesignDrift({
        apiKey,
        novel,
        design,
        bibleEntries,
        chapters,
        signal: controller.signal,
        emit: (event) => {
          if (event.type === 'trace') {
            void stream.writeSSE({ event: 'trace', data: JSON.stringify(event.data) });
          }
        },
      });
      if (result.usage.promptTokens > 0) {
        await stream.writeSSE({ event: 'usage', data: JSON.stringify(result.usage) });
      }
      await stream.writeSSE({ event: 'report', data: JSON.stringify(result.report) });
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ ok: true }) });
    } catch (err) {
      console.error(`[design:drift] failed novel=${novel.id} design=${designId}:`, err);
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify(err instanceof Error ? err.message : 'The drift check failed.'),
      });
    }
  });
});
