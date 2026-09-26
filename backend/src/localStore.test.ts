// Offline checks for the local JSON store: npx tsx src/localStore.test.ts
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DATA_DIR is read when localdb loads, so it is set before a dynamic import.
const dir = mkdtempSync(join(tmpdir(), 'novel-harness-'));
process.env.DATA_DIR = dir;
const store = await import('./lib/store.js');
const { storeCover, deleteCoverByUrl } = await import('./lib/covers.js');

let passed = 0;
let failed = 0;
function check(condition: unknown, label: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.log(`  FAIL  ${label}`);
  }
}

try {
  const novel = await store.createNovel('local', {
    title: 'The Salt Road',
    premise: 'A courier crosses a desert that remembers.',
    styleNotes: '',
    style: 'balanced' as never,
    defaultModel: 'deepseek/deepseek-chat',
  });
  check(existsSync(join(dir, 'novels', novel.id, 'novel.json')), 'a novel is a file on disk');
  check((await store.listNovels('local')).length === 1, 'listNovels finds it');
  check((await store.listNovels('someone-else')).length === 0, 'another owner does not');
  check((await store.getNovel('someone-else', novel.id)) === null, 'getNovel is owner-scoped');

  await store.updateNovel(novel.id, { title: 'Salt Road', premise: undefined });
  const renamed = await store.getNovel('local', novel.id);
  check(renamed?.title === 'Salt Road', 'updateNovel applies the patch');
  check(renamed?.premise === novel.premise, 'an undefined patch field leaves the value alone');

  const chapter = (n: number, status: 'draft' | 'accepted' = 'accepted') => ({
    number: n,
    title: `Chapter ${n}`,
    content: `words for chapter ${n}`,
    status,
    model: 'm',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  for (const n of [1, 2, 3, 4]) await store.saveChapter(novel.id, chapter(n, n === 4 ? 'draft' : 'accepted') as never);
  check((await store.listChapters(novel.id)).map((c) => c.number).join() === '1,2,3,4', 'chapters list in order');
  check((await store.getAcceptedChapters(novel.id, 4)).length === 3, 'getAcceptedChapters skips drafts and later chapters');

  const shifted = await store.deleteChapterAndRenumber(novel.id, 2);
  check(shifted === 2, 'deleting chapter 2 of 4 shifts two chapters');
  const after = await store.getAllChapters(novel.id);
  check(after.map((c) => c.number).join() === '1,2,3', 'numbering stays contiguous');
  check(after[1].content === 'words for chapter 3', 'old chapter 3 is now chapter 2');
  check((await store.deleteChapterAndRenumber(novel.id, 3)) === 0, 'deleting the last chapter shifts nothing');

  await store.updateChapter(novel.id, 1, { nextSuggestions: [{ title: 'x' }] } as never);
  await store.clearNextSuggestions(novel.id, 1);
  check(!('nextSuggestions' in ((await store.getChapter(novel.id, 1)) ?? {})), 'clearNextSuggestions removes the field');

  const entry = await store.transactBibleEntry(novel.id, 'kael', (existing) => ({
    id: 'kael', type: 'character', name: 'Kael', aliases: [], summary: '', firstChapter: 3,
    facts: [{ text: 'a', chapter: 2 }, { text: 'b', chapter: 3 }], updatedAt: 0,
    ...(existing ?? {}),
  }) as never);
  check(entry.id === 'kael', 'transactBibleEntry writes');
  await store.renumberBibleAfterChapterDelete(novel.id, 2);
  const [kael] = await store.getBibleEntries(novel.id, ['kael']);
  check(kael.facts.length === 1 && kael.facts[0].chapter === 2, 'bible facts follow a chapter delete');
  check(kael.firstChapter === 2, 'firstChapter shifts down too');

  check((await store.getNovel('local', '../../etc')) === null, 'a path-walking novel id is refused');
  check((await store.getBibleEntries(novel.id, ['../novel'])).length === 0, 'a path-walking doc id is refused');

  const url = await storeCover(novel.id, Buffer.from('png'), 'image/png');
  check(url.startsWith('/files/covers/') && existsSync(join(dir, 'covers', url.split('/').pop()!)), 'covers land in data/covers');
  await deleteCoverByUrl(url);
  check(!existsSync(join(dir, 'covers', url.split('/').pop()!)), 'deleteCoverByUrl removes the file');

  await store.deleteNovel(novel.id);
  check(!existsSync(join(dir, 'novels', novel.id)), 'deleteNovel removes the whole folder');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
