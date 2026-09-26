import { Hono } from 'hono';
import { runCharterDerive } from '../engine/naming/charterAgent.js';
import { defaultCharter } from '../engine/naming/charter.js';
import { NAMING_PACKS, PACK_LABELS } from '../engine/naming/formulas.js';
import { listSoundWorlds } from '../engine/naming/lexicons.js';
import { loadCharter, namesInProse, namingOn, takenNames } from '../engine/naming/load.js';
import { runCoin } from '../engine/naming/nameAgent.js';
import {
  DEFAULT_RENAME_OPTIONS,
  planRename,
  type RenameDocs,
  type RenameOptions,
  type RenamePair,
} from '../engine/naming/rename.js';
import type { AuthEnv } from '../lib/authMiddleware.js';
import { NO_KEY_MESSAGE, openRouterKey } from '../lib/apiKey.js';
import {
  NamingValidationError,
  applyCharterPatch,
  normalizeCharter,
  validateCharterPatch,
} from '../lib/namingValidate.js';
import * as store from '../lib/store.js';
import { BIBLE_ENTRY_TYPES, type BibleEntryType } from '../lib/types.js';
// Hidden novels answer "not found" without an unlocked vault; a novel's naming
// rules are as private as the novel.
import { loadAccessibleNovel } from '../lib/vault.js';
import { apiError, readJson } from '../lib/validate.js';

export const namingRoutes = new Hono<AuthEnv>();

const OFF_MESSAGE =
  'Name generation is turned off for this novel. Enable it in novel settings first.';

/** Cap on the pairs one rename may carry — a name plus its aliases and family. */
const MAX_PAIRS = 12;

/**
 * The charter, the catalogs, and the mode.
 *
 * Readable with the feature off, like the designs route: the screen has to be
 * able to explain itself and offer to turn naming on, rather than 404ing at
 * someone who followed a link. `source` tells the UI whether it is showing a
 * guess or the author's own work.
 */
namingRoutes.get('/', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  return c.json({
    charter: await loadCharter(novel),
    namingMode: novel.namingMode ?? 'off',
    soundWorlds: listSoundWorlds(),
    packs: NAMING_PACKS.map((id) => ({ id, ...PACK_LABELS[id] })),
  });
});

/**
 * Edit the charter by hand.
 *
 * Transactional, because the derive agent and a second tab must not lose each
 * other's writes. The base is the STORED charter when there is one and the
 * novel's default when there is not, so an author who changes one field of a
 * charter they never wrote gets that field changed and nothing else invented.
 */
namingRoutes.patch('/charter', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);

  try {
    const patch = validateCharterPatch(await readJson<Record<string, unknown>>(c));
    const charter = await store.transactCharter(novel.id, (existing) =>
      applyCharterPatch(existing ? normalizeCharter(existing, novel) : null, novel, patch, 'author')
    );
    return c.json({ charter });
  } catch (err) {
    if (err instanceof NamingValidationError) return c.json({ error: err.message }, 400);
    return apiError(c, err);
  }
});

/** Throw the charter away and go back to what the novel's premise implies. */
namingRoutes.delete('/charter', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  await store.deleteCharter(novel.id);
  return c.json({ charter: defaultCharter(novel) });
});

/**
 * Have a model propose the charter from the novel.
 *
 * Plain JSON rather than SSE: it is one cheap call and the author is watching a
 * button, not a stream — the same call shape as chapter suggestions.
 */
namingRoutes.post('/charter/derive', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  if (!namingOn(novel)) return c.json({ error: OFF_MESSAGE }, 400);

  const apiKey = openRouterKey(c);
  if (!apiKey) return c.json({ error: NO_KEY_MESSAGE }, 400);

  try {
    const bibleEntries =
      (novel.bibleMode ?? 'accept') === 'off' ? [] : await store.listBibleEntries(novel.id);
    const taken = bibleEntries.length
      ? []
      : namesInProse(await store.getAcceptedChapters(novel.id, novel.chapterCount + 1));

    const { charter, usage } = await runCharterDerive({ apiKey, novel, bibleEntries, taken });
    const saved = await store.transactCharter(novel.id, () => charter);
    return c.json({ charter: saved, usage });
  } catch (err) {
    return apiError(c, err);
  }
});

/**
 * Coin names on demand.
 *
 * Works without a key: the generator is deterministic local code, so the author
 * gets the raw slate and only the selection, etymologies and ordering are lost.
 */
namingRoutes.post('/coin', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  if (!namingOn(novel)) return c.json({ error: OFF_MESSAGE }, 400);

  try {
    const body = await readJson<Record<string, unknown>>(c);
    const kind = String(body.kind ?? 'character').trim().toLowerCase();
    if (!(BIBLE_ENTRY_TYPES as readonly string[]).includes(kind)) {
      return c.json({ error: `kind must be one of: ${BIBLE_ENTRY_TYPES.join(', ')}` }, 400);
    }
    const brief = String(body.brief ?? '').trim().slice(0, 300);
    const culture = body.culture ? String(body.culture).trim().slice(0, 80) : undefined;
    const nonce =
      typeof body.nonce === 'number' && Number.isFinite(body.nonce)
        ? Math.abs(Math.round(body.nonce)) % 1_000_000
        : 0;

    const [charter, bibleEntries, designs, map] = await Promise.all([
      loadCharter(novel),
      store.listBibleEntries(novel.id),
      store.listDesigns(novel.id),
      (novel.mapMode ?? 'off') === 'off' ? Promise.resolve(null) : store.getMap(novel.id),
    ]);
    let taken = takenNames({ bible: bibleEntries, designs, map, novel });
    if (bibleEntries.length === 0) {
      const chapters = await store.getAcceptedChapters(novel.id, novel.chapterCount + 1);
      taken = [...new Set([...taken, ...namesInProse(chapters)])];
    }

    const result = await runCoin({
      // Optional here, unlike everywhere else that spends tokens: no key means
      // the procedural slate, not an error.
      apiKey: openRouterKey(c),
      novel,
      charter,
      kind: kind as BibleEntryType,
      brief,
      culture,
      taken,
      bibleEntries,
      nonce,
    });
    return c.json(result);
  } catch (err) {
    return apiError(c, err);
  }
});

/** Read the rename request off the wire. Shared by preview and apply. */
function renameBody(body: Record<string, unknown>): {
  pairs: RenamePair[];
  options: RenameOptions;
} {
  const raw = Array.isArray(body.pairs) ? (body.pairs as unknown[]) : [];
  const pairs = raw
    .slice(0, MAX_PAIRS)
    .map((item) => {
      const p = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
      return {
        from: String(p.from ?? '').trim().slice(0, 120),
        to: String(p.to ?? '').trim().slice(0, 120),
      };
    })
    .filter((p) => p.from && p.to);

  const opts = (typeof body.options === 'object' && body.options !== null ? body.options : {}) as Record<
    string,
    unknown
  >;
  const bool = (key: keyof RenameOptions): boolean =>
    typeof opts[key] === 'boolean' ? (opts[key] as boolean) : DEFAULT_RENAME_OPTIONS[key];

  const includeChapters = bool('includeChapters');
  return {
    pairs,
    options: {
      includeChapters,
      includeNovelText: bool('includeNovelText'),
      renameNovelTitle: bool('renameNovelTitle'),
      // The old name kept as an alias is a lie once the prose no longer uses
      // it, and the truth when it still does — so the default follows the
      // chapter switch rather than being fixed.
      keepOldAsAlias:
        typeof opts.keepOldAsAlias === 'boolean' ? opts.keepOldAsAlias : !includeChapters,
    },
  };
}

async function loadRenameDocs(novelId: string, novel: RenameDocs['novel']): Promise<RenameDocs> {
  const [bible, designs, arcs, map, chapters] = await Promise.all([
    store.listBibleEntries(novelId),
    store.listDesigns(novelId),
    store.listArcs(novelId),
    store.getMap(novelId),
    store.getAllChapters(novelId),
  ]);
  return { novel, bible, designs, arcs, map, chapters };
}

/**
 * What a rename would do, without doing it. No key, no writes, no mode gate.
 *
 * It runs the same planRename the apply does and throws the rewrites away, so
 * the counts shown here are the counts that will happen — a preview computed a
 * second way would eventually disagree with the thing it is previewing.
 */
namingRoutes.post('/rename/preview', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);

  try {
    const { pairs, options } = renameBody(await readJson<Record<string, unknown>>(c));
    if (!pairs.length) return c.json({ error: 'Give a name to replace and a name to replace it with.' }, 400);
    const docs = await loadRenameDocs(novel.id, novel);
    const { plan } = planRename(docs, pairs, options);
    return c.json({ plan });
  } catch (err) {
    return apiError(c, err);
  }
});

/**
 * Apply a rename across the whole novel.
 *
 * NOT gated on namingMode, deliberately, and against the pattern every other
 * route here follows. This is a data-integrity operation: an author forty
 * chapters into a novel whose protagonist is called Elara needs it whether or
 * not they ever open the coiner, and making them switch a feature on to fix
 * their own book would be an odd thing to insist on.
 */
namingRoutes.post('/rename', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);

  try {
    const { pairs, options } = renameBody(await readJson<Record<string, unknown>>(c));
    if (!pairs.length) return c.json({ error: 'Give a name to replace and a name to replace it with.' }, 400);

    const docs = await loadRenameDocs(novel.id, novel);
    const { plan, rewrites } = planRename(docs, pairs, options);
    const applied = await store.applyRenameWrites(novel.id, rewrites);

    console.log(
      `[rename] novel=${novel.id} pairs=${pairs.length} ` +
        `docs=${Object.values(applied).reduce((a, b) => a + b, 0)} words=${plan.wordDelta}`
    );
    return c.json({ ok: true, applied, plan });
  } catch (err) {
    return apiError(c, err);
  }
});
