import { validateProseProfile } from '../lib/proseProfile.js';
import type { Novel } from '../lib/types.js';
import { validateModelRoles } from '../lib/modelPolicy.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { generateImage } from '../engine/imageGen.js';
import { OpenRouterError } from '../engine/openrouter.js';
import { DEFAULT_STYLE, isStyleKey } from '../engine/styles.js';
import {
  COVER_MODELS,
  COVER_SIZE,
  buildCoverPrompt,
  deleteCoverByUrl,
  storeCover,
  type CoverQuality,
} from '../lib/covers.js';
import { NO_KEY_MESSAGE, openRouterKey } from '../lib/apiKey.js';
import type { AuthEnv } from '../lib/authMiddleware.js';
import { assertNovelAllowed } from '../lib/limits.js';
import { normalizeCharter } from '../lib/namingValidate.js';
import * as store from '../lib/store.js';
import { assertUnlocked, loadAccessibleNovel } from '../lib/vault.js';
import {
  apiError,
  boundedString,
  chapterLength,
  readJson,
  safeModelId,
} from '../lib/validate.js';

export const novelRoutes = new Hono<AuthEnv>();

interface NovelBody {
  modelRoles?: unknown;
  proseProfile?: unknown;
  title?: unknown;
  premise?: unknown;
  styleNotes?: unknown;
  defaultModel?: unknown;
  chapterLength?: unknown;
  bibleMode?: unknown;
  designMode?: unknown;
  arcMode?: unknown;
  mapMode?: unknown;
  suggestMode?: unknown;
  namingMode?: unknown;
  style?: unknown;
  hidden?: unknown;
}

/** The dashboard shelf. Hidden novels live behind /api/vault/novels instead. */
novelRoutes.get('/', async (c) => {
  const list = await store.listNovels(c.get('uid'), 'visible');
  return c.json(list);
});

novelRoutes.post('/', async (c) => {
  try {
    const body = await readJson<NovelBody>(c);
    const title = boundedString(body.title, 'title', { required: true });

    // Creating a novel costs the caller nothing, so this is the one path that
    // genuinely needs a ceiling even under BYOK.
    assertNovelAllowed(
      await store.countNovels(c.get('uid')),
      c.get('email'),
      c.get('emailVerified')
    );

    // Starting straight into the vault, rather than creating in the open and
    // hiding afterwards — the novel is never listed on the dashboard at all.
    const hidden = body.hidden === true;
    if (hidden) await assertUnlocked(c);

    const novel = await store.createNovel(c.get('uid'), {
      title,
      premise: boundedString(body.premise, 'premise'),
      styleNotes: boundedString(body.styleNotes, 'styleNotes'),
      // Locked in here for the life of the novel — see engine/styles.ts.
      style: isStyleKey(body.style) ? body.style : DEFAULT_STYLE,
      defaultModel: safeModelId(body.defaultModel, { required: false }),
      chapterLength: chapterLength(body.chapterLength),
      hidden,
    });
    return c.json(novel, 201);
  } catch (err) {
    return apiError(c, err);
  }
});

novelRoutes.get('/:novelId', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  return c.json(novel);
});

/**
 * One novel in full — every chapter body, drafts included, plus everything
 * that hangs off it: bible entries, character designs, arcs and the map. The
 * subcollection list matches deleteNovel's for the same reason in reverse —
 * the UI promises "your writing is always yours to take", and a story bible
 * built up over a novel is the author's writing as much as the prose is.
 * Formatting is client-side.
 */
novelRoutes.get('/:novelId/export', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  const [chapters, bible, designs, arcs, map, charterDoc, power, jobs] = await Promise.all([
    store.getAllChapters(novel.id),
    store.listBibleEntries(novel.id),
    store.listDesigns(novel.id),
    store.listArcs(novel.id),
    store.getMap(novel.id),
    store.getCharterDoc(novel.id),
    store.listPowerSystems(novel.id),
    store.listJobs(novel.id),
  ]);
  // The charter is authored material like the bible: a world's naming rules are
  // something the author built, so an export that omitted them would be
  // incomplete in exactly the way the promise above rules out. Null when the
  // author never wrote one — the default is derived, not owned.
  const naming = charterDoc ? normalizeCharter(charterDoc, novel) : null;
  return c.json({ novel, chapters, bible, designs, arcs, map, naming, power, jobs });
});

novelRoutes.patch('/:novelId', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);

  try {
    const body = await readJson<NovelBody>(c);

    // The style is part of the cached system prompt shared by every chapter.
    // Changing it would invalidate that prefix and split the novel's voice in
    // two, so it is refused rather than silently ignored.
    if (body.style !== undefined && body.style !== novel.style) {
      return c.json(
        {
          error:
            "A novel's writing style is fixed when it is created and cannot be changed. Start a new novel to write in a different style.",
        },
        400
      );
    }

    const patch: Partial<Novel> = {};
    if (body.proseProfile !== undefined) patch.proseProfile = validateProseProfile(body.proseProfile);
    if (body.modelRoles !== undefined) patch.modelRoles = validateModelRoles(body.modelRoles);

    // Hiding needs the vault open just as much as unhiding does: a novel put
    // behind a PIN its owner has forgotten would be unreachable, and the unlock
    // is the proof that they still know it.
    if (body.hidden !== undefined) {
      if (typeof body.hidden !== 'boolean') {
        return c.json({ error: 'hidden must be true or false' }, 400);
      }
      if (body.hidden !== (novel.hidden === true)) {
        await assertUnlocked(c);
        patch.hidden = body.hidden;
      }
    }

    if (body.title !== undefined) patch.title = boundedString(body.title, 'title', { required: true });
    if (body.premise !== undefined) patch.premise = boundedString(body.premise, 'premise');
    if (body.styleNotes !== undefined) patch.styleNotes = boundedString(body.styleNotes, 'styleNotes');
    if (body.defaultModel !== undefined) {
      patch.defaultModel = safeModelId(body.defaultModel, { required: false });
    }
    if (body.chapterLength !== undefined) patch.chapterLength = chapterLength(body.chapterLength);
    if (body.bibleMode !== undefined) {
      if (body.bibleMode !== 'off' && body.bibleMode !== 'accept' && body.bibleMode !== 'batch') {
        return c.json({ error: "bibleMode must be 'off', 'accept' or 'batch'" }, 400);
      }
      patch.bibleMode = body.bibleMode;
    }
    if (body.designMode !== undefined) {
      if (body.designMode !== 'off' && body.designMode !== 'on') {
        return c.json({ error: "designMode must be 'off' or 'on'" }, 400);
      }
      patch.designMode = body.designMode;
    }
    if (body.arcMode !== undefined) {
      if (body.arcMode !== 'off' && body.arcMode !== 'on') {
        return c.json({ error: "arcMode must be 'off' or 'on'" }, 400);
      }
      patch.arcMode = body.arcMode;
    }
    if (body.mapMode !== undefined) {
      if (body.mapMode !== 'off' && body.mapMode !== 'manual' && body.mapMode !== 'accept') {
        return c.json({ error: "mapMode must be 'off', 'manual' or 'accept'" }, 400);
      }
      patch.mapMode = body.mapMode;
    }
    if (body.suggestMode !== undefined) {
      if (body.suggestMode !== 'off' && body.suggestMode !== 'on') {
        return c.json({ error: "suggestMode must be 'off' or 'on'" }, 400);
      }
      patch.suggestMode = body.suggestMode;
    }
    if (body.namingMode !== undefined) {
      if (body.namingMode !== 'off' && body.namingMode !== 'on') {
        return c.json({ error: "namingMode must be 'off' or 'on'" }, 400);
      }
      patch.namingMode = body.namingMode;
    }

    await store.updateNovel(novel.id, patch);
    return c.json({ ok: true });
  } catch (err) {
    return apiError(c, err);
  }
});

novelRoutes.delete('/:novelId', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  // Covers live in data/covers, outside the novel's folder.
  await deleteCoverByUrl(novel.coverUrl);
  await store.deleteNovel(novel.id);
  return c.json({ ok: true });
});

// ── Covers ──────────────────────────────────────────────────────────────

/** AI cover generation through OpenRouter's image endpoint. */
novelRoutes.post('/:novelId/cover/generate', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  const apiKey = openRouterKey(c);
  if (!apiKey) return c.json({ error: NO_KEY_MESSAGE }, 400);
  try {
    const body = await readJson<{ prompt?: unknown; quality?: unknown; theme?: unknown }>(c);
    const quality: CoverQuality = body.quality === 'best' ? 'best' : 'standard';
    const userPrompt = typeof body.prompt === 'string' ? body.prompt.slice(0, 1_000) : '';
    const theme = typeof body.theme === 'string' ? body.theme : '';
    const first = await store.getChapter(novel.id, 1);
    const prompt = buildCoverPrompt(novel, first?.summary ?? '', userPrompt, theme);

    const image = await generateImage({
      apiKey,
      model: COVER_MODELS[quality],
      prompt,
      size: COVER_SIZE,
    });
    const previous = novel.coverUrl;
    const coverUrl = await storeCover(novel.id, image.data, image.contentType);
    await store.updateNovel(novel.id, { coverUrl });
    await deleteCoverByUrl(previous);
    return c.json({ ok: true, coverUrl, cost: image.cost });
  } catch (err) {
    if (err instanceof OpenRouterError) return c.json({ error: err.message }, 502);
    return apiError(c, err);
  }
});

/**
 * Upload a cover. The client downscales to cover size and webp before
 * sending, so the 2 MB route-level cap (the sketch route's precedent) is
 * headroom, not a target.
 */
novelRoutes.post(
  '/:novelId/cover',
  bodyLimit({
    maxSize: 2 * 1024 * 1024,
    onError: (c) => c.json({ error: 'That image is too large — 2 MB after compression is the cap.' }, 413),
  }),
  async (c) => {
    const novel = await loadAccessibleNovel(c);
    if (!novel) return c.json({ error: 'Novel not found' }, 404);
    try {
      const body = await readJson<{ image?: unknown }>(c);
      const image = typeof body.image === 'string' ? body.image : '';
      const match = image.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
      if (!match) return c.json({ error: 'image must be a PNG, JPEG or WebP data URL.' }, 400);
      const data = Buffer.from(match[2], 'base64');
      if (data.length > 1_500_000) {
        return c.json({ error: 'That image is too large — 1.5 MB decoded is the cap.' }, 413);
      }
      const previous = novel.coverUrl;
      const coverUrl = await storeCover(novel.id, data, match[1]);
      await store.updateNovel(novel.id, { coverUrl });
      await deleteCoverByUrl(previous);
      return c.json({ ok: true, coverUrl });
    } catch (err) {
      return apiError(c, err);
    }
  }
);

novelRoutes.delete('/:novelId/cover', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  await deleteCoverByUrl(novel.coverUrl);
  await store.updateNovel(novel.id, { coverUrl: '' });
  return c.json({ ok: true });
});
