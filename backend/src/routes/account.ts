import { Hono } from 'hono';
import type { AuthEnv } from '../lib/authMiddleware.js';
import * as store from '../lib/store.js';
import { isUnlocked } from '../lib/vault.js';

export const accountRoutes = new Hono<AuthEnv>();

/**
 * Everything the account owns, in one machine-readable file. Distinct from the
 * per-novel Markdown export: this one has to be complete, so it includes
 * drafts, prompts, revision notes and summaries.
 *
 * Hidden novels are included only while the vault is unlocked. A download that
 * carried them out regardless would be the way around the PIN, so the export
 * says which of the two files it is rather than quietly omitting them.
 */
accountRoutes.get('/export', async (c) => {
  const uid = c.get('uid');
  const unlocked = await isUnlocked(c);
  const novels = await store.listNovels(uid, unlocked ? 'all' : 'visible');

  // Everything a novel owns, matching deleteNovel's subcollection list — an
  // export that leaves the bible and designs behind is missing the author's
  // planning, which is their writing as much as the chapters are.
  const complete = await Promise.all(
    novels.map(async (novel) => {
      const [chapters, bible, designs, arcs, map, power, naming, jobs] = await Promise.all([
        store.getAllChapters(novel.id),
        store.listBibleEntries(novel.id),
        store.listDesigns(novel.id),
        store.listArcs(novel.id),
        store.getMap(novel.id),
        store.listPowerSystems(novel.id), store.getCharterDoc(novel.id), store.listJobs(novel.id),
      ]);
      return { ...novel, chapters, bible, designs, arcs, map, power, naming, jobs };
    })
  );

  return c.json({
    exportedAt: new Date().toISOString(),
    includesHiddenNovels: unlocked,
    novels: complete,
  });
});
