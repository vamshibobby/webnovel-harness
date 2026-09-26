import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { applyBorderEdit, applyPinEdit } from '../engine/map/authorEdits.js';
import { runMapDictation, runMapSketch, runMapUpdate, type SketchShape } from '../engine/map/mapAgent.js';
import { deriveShapes } from '../engine/map/regions.js';
import { renderMap } from '../engine/map/render.js';
import { solveMap } from '../engine/map/solver.js';
import { MAP_LIMITS } from '../engine/map/tools.js';
import { OpenRouterError } from '../engine/openrouter.js';
import type { AuthEnv } from '../lib/authMiddleware.js';
import { NO_KEY_MESSAGE, openRouterKey } from '../lib/apiKey.js';
import * as store from '../lib/store.js';
import { loadAccessibleNovel } from '../lib/vault.js';
import { apiError } from '../lib/validate.js';

export const mapRoutes = new Hono<AuthEnv>();

const OFF_MESSAGE = 'The map is turned off for this novel. Enable it in novel settings first.';

/**
 * The current map plus its rendered SVG. Rendering happens here, on demand:
 * the SVG is a pure function of the stored facts, colours are `var(--wn-*)`
 * references that resolve in whichever theme the client injects them into,
 * and `?theme=light|dark` swaps in literal hex for downloads. Reads are
 * allowed whatever the mode, so the Atlas view can explain itself when off.
 */
mapRoutes.get('/', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  const map = await store.getMap(novel.id);
  const theme = c.req.query('theme');
  const svg = map
    ? renderMap(map, theme === 'light' || theme === 'dark' ? { resolveTokens: theme } : {})
    : null;
  return c.json({
    map,
    svg,
    mapMode: novel.mapMode ?? 'off',
    mapChapter: novel.mapChapter ?? 0,
  });
});

/**
 * Catch-up: extract geography from every accepted chapter the map has not
 * seen. The bible's update loop, with one deliberate difference — the FULL
 * chapter text every time, never summaries, because geography is exactly the
 * kind of detail a summary drops.
 */
mapRoutes.post('/update', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  if ((novel.mapMode ?? 'off') === 'off') return c.json({ error: OFF_MESSAGE }, 400);
  const apiKey = openRouterKey(c);
  if (!apiKey) return c.json({ error: NO_KEY_MESSAGE }, 400);

  const accepted = (await store.getAcceptedChapters(novel.id, Number.MAX_SAFE_INTEGER)).sort(
    (a, b) => a.number - b.number
  );
  const from = (novel.mapChapter ?? 0) + 1;
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
        const result = await runMapUpdate({
          apiKey,
          novel,
          chapter,
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
        await store.updateNovel(novel.id, { mapChapter: chapter.number });
        done++;
      } catch (err) {
        console.error(`[map] catch-up failed novel=${novel.id} ch=${chapter.number}:`, err);
        const kept = done > 0 ? `${done} chapter${done === 1 ? '' : 's'} mapped and kept. ` : '';
        const reason =
          err instanceof OpenRouterError && err.status === 429
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

    const map = await store.getMap(novel.id);
    await stream.writeSSE({
      event: 'done',
      data: JSON.stringify({
        updated: done,
        total: pending.length,
        map,
        svg: map ? renderMap(map) : null,
      }),
    });
  });
});

/**
 * Dictation: the author types their geography, the agent records it as author
 * canon. Foreground action the author is watching, so failures surface —
 * the designs assist-route contract.
 */
mapRoutes.post('/dictate', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  if ((novel.mapMode ?? 'off') === 'off') return c.json({ error: OFF_MESSAGE }, 400);
  const apiKey = openRouterKey(c);
  if (!apiKey) return c.json({ error: NO_KEY_MESSAGE }, 400);

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, MAP_LIMITS.dictationChars) : '';
  if (!text) return c.json({ error: 'Describe your geography in `text` first.' }, 400);

  c.header('X-Accel-Buffering', 'no');
  c.header('Cache-Control', 'no-cache, no-transform');

  return streamSSE(c, async (stream) => {
    const controller = new AbortController();
    stream.onAbort(() => controller.abort());

    try {
      const result = await runMapDictation({
        apiKey,
        novel,
        text,
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
      const map = await store.getMap(novel.id);
      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({ map, svg: map ? renderMap(map) : null, summary: result.summary }),
      });
    } catch (err) {
      console.error(`[map:dictate] failed novel=${novel.id}:`, err);
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify(err instanceof Error ? err.message : 'The map assistant failed.'),
      });
    }
  });
});

/**
 * Sketch: a downscaled PNG of the author's drawing plus the structured shape
 * list the canvas already knows. The one route whose body can legitimately
 * exceed the app-wide 256 KB limit — a data-URL image — so it alone carries a
 * bigger cap.
 */
mapRoutes.post(
  '/sketch',
  bodyLimit({
    maxSize: 2 * 1024 * 1024,
    onError: (c) => c.json({ error: 'The sketch image is too large. Try a simpler drawing.' }, 413),
  }),
  async (c) => {
    const novel = await loadAccessibleNovel(c);
    if (!novel) return c.json({ error: 'Novel not found' }, 404);
    if ((novel.mapMode ?? 'off') === 'off') return c.json({ error: OFF_MESSAGE }, 400);
    const apiKey = openRouterKey(c);
    if (!apiKey) return c.json({ error: NO_KEY_MESSAGE }, 400);

    try {
      const body = await c.req.json<Record<string, unknown>>();
      const image = typeof body.image === 'string' ? body.image : '';
      if (!image.startsWith('data:image/png;base64,')) {
        return c.json({ error: 'image must be a PNG data URL.' }, 400);
      }
      if (image.length > MAP_LIMITS.sketchImageBytes) {
        return c.json({ error: 'The sketch image is too large. Try a simpler drawing.' }, 413);
      }
      const rawShapes = Array.isArray(body.shapes) ? body.shapes : [];
      if (rawShapes.length === 0) {
        return c.json({ error: 'Label at least one shape before sending the sketch.' }, 400);
      }
      if (rawShapes.length > MAP_LIMITS.sketchShapes) {
        return c.json({ error: `At most ${MAP_LIMITS.sketchShapes} shapes per sketch.` }, 400);
      }
      const shapes: SketchShape[] = [];
      for (const raw of rawShapes) {
        const s = raw as Record<string, unknown>;
        const kind = s.kind === 'region' || s.kind === 'settlement' || s.kind === 'water' ? s.kind : null;
        const label = typeof s.label === 'string' ? s.label.trim().slice(0, 80) : '';
        const x = typeof s.x === 'number' && Number.isFinite(s.x) ? s.x : NaN;
        const y = typeof s.y === 'number' && Number.isFinite(s.y) ? s.y : NaN;
        if (!kind || !label || Number.isNaN(x) || Number.isNaN(y)) {
          return c.json({ error: 'Every shape needs a kind, a label and a position.' }, 400);
        }
        const shape: SketchShape = {
          kind,
          label,
          x: Math.min(1000, Math.max(0, x)),
          y: Math.min(1000, Math.max(0, y)),
        };
        if (typeof s.area === 'number' && Number.isFinite(s.area)) {
          shape.area = Math.min(1, Math.max(0, s.area));
        }
        shapes.push(shape);
      }

      c.header('X-Accel-Buffering', 'no');
      c.header('Cache-Control', 'no-cache, no-transform');

      return streamSSE(c, async (stream) => {
        const controller = new AbortController();
        stream.onAbort(() => controller.abort());

        try {
          const result = await runMapSketch({
            apiKey,
            novel,
            imageDataUrl: image,
            shapes,
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
          const map = await store.getMap(novel.id);
          await stream.writeSSE({
            event: 'done',
            data: JSON.stringify({ map, svg: map ? renderMap(map) : null, summary: result.summary }),
          });
        } catch (err) {
          console.error(`[map:sketch] failed novel=${novel.id}:`, err);
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify(err instanceof Error ? err.message : 'The sketch reader failed.'),
          });
        }
      });
    } catch (err) {
      return apiError(c, err);
    }
  }
);

/**
 * Direct edits: drag a place (a pin), reshape a region's border, or rename.
 * No LLM involved — like reset, this is the author's hand on their own map,
 * so it works whatever the mapMode and needs no API key. A pin is the sketch
 * contract reused: the entity sits exactly where the author dropped it and no
 * later extraction may move it; a border is the same contract for a region's
 * shape. Both touch ONLY what the author touched — re-deriving everything
 * here is what used to reshuffle every border when one town moved. A rename
 * keeps the id (and so the bible link) and retires the old name into aliases
 * so chapter extraction still recognises the place.
 */
mapRoutes.patch('/entities/:entityId', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  const entityId = c.req.param('entityId');

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : undefined;
  const finitePoint = (raw: unknown): { x: number; y: number } | null => {
    const p = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
    return p && typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y)
      ? { x: p.x, y: p.y }
      : null;
  };
  const pin = finitePoint(body.pin);
  let border: Array<{ x: number; y: number }> | null = null;
  if (body.border !== undefined) {
    if (!Array.isArray(body.border) || body.border.length < 3 || body.border.length > MAP_LIMITS.borderPoints) {
      return c.json({ error: `border must be 3–${MAP_LIMITS.borderPoints} {x, y} points.` }, 400);
    }
    border = [];
    for (const raw of body.border) {
      const p = finitePoint(raw);
      if (!p) return c.json({ error: 'Every border point needs finite x and y.' }, 400);
      border.push(p);
    }
  }
  if (name === undefined && !pin && !border) {
    return c.json({ error: 'Send a new `name`, a `pin` position, a `border`, or a combination.' }, 400);
  }
  if (name !== undefined && !name) return c.json({ error: 'A place cannot have an empty name.' }, 400);

  const existing = await store.getMap(novel.id);
  if (!existing?.entities[entityId]) return c.json({ error: 'No such place on the map.' }, 404);
  if (border && existing.entities[entityId].kind !== 'region') {
    return c.json({ error: 'Only a region has a border to reshape.' }, 400);
  }
  if (border && !existing.layout) {
    return c.json({ error: 'The map has no layout yet — add a place first.' }, 400);
  }

  try {
    const map = await store.transactMap(novel.id, (current) => {
      if (!current?.entities[entityId]) throw new Error('No such place on the map.');
      const entity = current.entities[entityId];
      if (name !== undefined && name !== entity.name) {
        if (!entity.aliases.includes(entity.name)) {
          entity.aliases = [entity.name, ...entity.aliases].slice(0, MAP_LIMITS.aliasesPerEntity);
        }
        entity.name = name;
      }
      if (pin && !applyPinEdit(current, entityId, pin)) {
        // No prior layout to translate within — a first placement really is a
        // solve, and with no new facts there is nothing to contradict.
        entity.pin = {
          x: Math.min(1000, Math.max(0, Math.round(pin.x * 100) / 100)),
          y: Math.min(1000, Math.max(0, Math.round(pin.y * 100) / 100)),
        };
        const result = solveMap(current, []);
        if (result.ok) {
          deriveShapes(current, result.layout);
          current.layout = result.layout;
        }
      }
      if (border) {
        const problem = applyBorderEdit(current, entityId, border);
        if (problem) throw new Error(problem);
      }
      return current;
    });
    return c.json({ map, svg: renderMap(map) });
  } catch (err) {
    // The pre-checks above make these mid-edit races, not caller mistakes —
    // but they still deserve their message back, not a 500.
    if (err instanceof Error && err.message === 'No such place on the map.') {
      return c.json({ error: err.message }, 404);
    }
    if (err instanceof Error && /border|layout/.test(err.message)) {
      return c.json({ error: err.message }, 400);
    }
    return apiError(c, err);
  }
});

/**
 * The escape hatch: wipe the map and its high-water mark. When extraction has
 * gone wrong enough that superseding fact-by-fact is not worth it, the author
 * starts clean — usually straight into dictation or a sketch.
 */
mapRoutes.delete('/', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  await store.deleteMap(novel.id);
  await store.updateNovel(novel.id, { mapChapter: 0 });
  return c.json({ ok: true });
});
