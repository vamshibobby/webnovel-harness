import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { runPowerGenerate, runPowerRefine } from '../engine/powerAgent.js';
import type { AuthEnv } from '../lib/authMiddleware.js';
import { NO_KEY_MESSAGE, openRouterKey } from '../lib/apiKey.js';
import {
  POWER_LIMITS,
  PowerValidationError,
  applyPowerSystemPatch,
  slugifyPowerName,
  validatePowerSystemPatch,
} from '../lib/powerValidate.js';
import * as store from '../lib/store.js';
// Hidden novels answer "not found" without an unlocked vault; a power system
// is as private as the novel it belongs to.
import { loadAccessibleNovel } from '../lib/vault.js';
import { apiError } from '../lib/validate.js';

export const powerRoutes = new Hono<AuthEnv>();

/** Readable whatever else is configured — the view must explain itself. */
powerRoutes.get('/', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  return c.json({ systems: await store.listPowerSystems(novel.id) });
});

/**
 * Manual create — the structured-form half of the feature. Shares the agent
 * path's validation and slugging, so a hand-built system is indistinguishable
 * from a generated one afterwards; only `source` remembers.
 */
powerRoutes.post('/', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);

  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const entries = await store.listBibleEntries(novel.id);
    const patch = validatePowerSystemPatch(body, { entries, existing: null });
    if (!patch.name) return c.json({ error: 'name is required' }, 400);

    if ((await store.countPowerSystems(novel.id)) >= POWER_LIMITS.systemsPerNovel) {
      return c.json(
        { error: `This novel is at its ${POWER_LIMITS.systemsPerNovel}-system limit.` },
        400
      );
    }

    const id = slugifyPowerName(patch.name);
    const clash = await store.getPowerSystem(novel.id, id);
    if (clash) {
      return c.json({ error: `“${clash.name}” already exists. Edit that system instead.` }, 409);
    }

    const system = await store.transactPowerSystem(novel.id, id, (current) =>
      applyPowerSystemPatch(current, id, patch, 'author')
    );
    return c.json({ system }, 201);
  } catch (err) {
    if (err instanceof PowerValidationError) return c.json({ error: err.message }, 400);
    return apiError(c, err);
  }
});

/**
 * Author structured edit. The same granular merge ops the agents use, applied
 * with 'author' provenance — which is what flips a generated system to
 * 'mixed' the first time the author touches it.
 */
powerRoutes.patch('/:systemId', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  const systemId = c.req.param('systemId');

  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const [existing, entries] = await Promise.all([
      store.getPowerSystem(novel.id, systemId),
      store.listBibleEntries(novel.id),
    ]);
    if (!existing) return c.json({ error: 'Power system not found' }, 404);

    const patch = validatePowerSystemPatch(body, { entries, existing });
    const system = await store.transactPowerSystem(novel.id, systemId, (current) =>
      applyPowerSystemPatch(current ?? existing, systemId, patch, 'author')
    );
    return c.json({ system });
  } catch (err) {
    if (err instanceof PowerValidationError) return c.json({ error: err.message }, 400);
    return apiError(c, err);
  }
});

/**
 * Plain delete — no supersession log, unlike facts-shaped features. A power
 * system is a design document, and a design document is the author's to
 * discard.
 */
powerRoutes.delete('/:systemId', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  await store.deletePowerSystem(novel.id, c.req.param('systemId'));
  return c.json({ ok: true });
});

/**
 * The LLM half of the hybrid: design a system from the questionnaire answers
 * plus the author's own suggestions. SSE because the design call takes tens
 * of seconds and the wizard shows the agent thinking; the result is saved
 * before `done`, so an author who navigates away still has their system.
 */
powerRoutes.post('/generate', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  const apiKey = openRouterKey(c);
  if (!apiKey) return c.json({ error: NO_KEY_MESSAGE }, 400);

  if ((await store.countPowerSystems(novel.id)) >= POWER_LIMITS.systemsPerNovel) {
    return c.json(
      { error: `This novel is at its ${POWER_LIMITS.systemsPerNovel}-system limit.` },
      400
    );
  }

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const answers = Array.isArray(body.answers)
    ? (body.answers as Array<Record<string, unknown>>)
        .map((a) => ({ id: String(a.id ?? ''), answer: String(a.answer ?? '').slice(0, 500) }))
        .filter((a) => a.id && a.answer.trim())
    : [];
  const suggestions = String(body.suggestions ?? '').slice(0, 2000);

  const [entries, systems] = await Promise.all([
    store.listBibleEntries(novel.id),
    store.listPowerSystems(novel.id),
  ]);

  c.header('X-Accel-Buffering', 'no');
  c.header('Cache-Control', 'no-cache, no-transform');

  return streamSSE(c, async (stream) => {
    const controller = new AbortController();
    stream.onAbort(() => controller.abort());

    try {
      const result = await runPowerGenerate({
        apiKey,
        novel,
        entries,
        systems,
        answers,
        suggestions,
        signal: controller.signal,
        emit: (event) => {
          if (event.type === 'trace') {
            void stream.writeSSE({ event: 'trace', data: JSON.stringify(event.data) });
          }
        },
      });

      // The model names the system; a name the novel already uses gets a
      // numbered id rather than a 409 after the author paid for the call.
      let id = result.system.id;
      for (let n = 2; systems.some((s) => s.id === id); n++) id = `${result.system.id}-${n}`;
      const saved = await store.transactPowerSystem(novel.id, id, () => ({
        ...result.system,
        id,
      }));

      if (result.usage.promptTokens > 0) {
        await stream.writeSSE({ event: 'usage', data: JSON.stringify(result.usage) });
      }
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ system: saved }) });
    } catch (err) {
      console.error(`[power:generate] failed novel=${novel.id}:`, err);
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify(err instanceof Error ? err.message : 'The designer failed.'),
      });
    }
  });
});

/**
 * Refine an existing system with free-text instructions — the other direction
 * of the hybrid: hand-built systems get the model's help without losing what
 * the author wrote. Applied with 'model' provenance, so an author system
 * lands on 'mixed'.
 */
powerRoutes.post('/:systemId/refine', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  const apiKey = openRouterKey(c);
  if (!apiKey) return c.json({ error: NO_KEY_MESSAGE }, 400);

  const systemId = c.req.param('systemId');
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const instructions = String(body.instructions ?? '').slice(0, 2000).trim();
  if (!instructions) return c.json({ error: 'instructions are required' }, 400);

  const [system, entries] = await Promise.all([
    store.getPowerSystem(novel.id, systemId),
    store.listBibleEntries(novel.id),
  ]);
  if (!system) return c.json({ error: 'Power system not found' }, 404);

  c.header('X-Accel-Buffering', 'no');
  c.header('Cache-Control', 'no-cache, no-transform');

  return streamSSE(c, async (stream) => {
    const controller = new AbortController();
    stream.onAbort(() => controller.abort());

    try {
      const result = await runPowerRefine({
        apiKey,
        novel,
        entries,
        system,
        instructions,
        signal: controller.signal,
        emit: (event) => {
          if (event.type === 'trace') {
            void stream.writeSSE({ event: 'trace', data: JSON.stringify(event.data) });
          }
        },
      });

      const saved = await store.transactPowerSystem(novel.id, systemId, () => result.system);

      if (result.usage.promptTokens > 0) {
        await stream.writeSSE({ event: 'usage', data: JSON.stringify(result.usage) });
      }
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ system: saved }) });
    } catch (err) {
      console.error(`[power:refine] failed novel=${novel.id} system=${systemId}:`, err);
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify(err instanceof Error ? err.message : 'The refiner failed.'),
      });
    }
  });
});
