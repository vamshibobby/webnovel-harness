/**
 * Chapter history: what is kept, what is dropped, and what is never dropped.
 *   npx tsx src/versions.test.ts
 *
 * Free — no network. `pushVersion` is the only thing standing between a revise
 * and permanently destroyed writing, so the cases that matter are the edges:
 * the budgets must bound the document (Firestore refuses at 1 MiB, and a
 * chapter that cannot be written is a chapter that cannot be edited), and the
 * snapshot just taken must survive both budgets regardless.
 */
import type { Chapter } from './lib/types.js';

const { pushVersion, hasHistory, MAX_VERSIONS, MAX_VERSION_CHARS } = await import(
  './lib/versions.js'
);

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failures.push(label);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
}

const chapter = (content: string, versions: Chapter['versions'] = []): Chapter =>
  ({ title: 'The Weighing House', content, versions }) as Chapter;

// ── The first snapshot ────────────────────────────────────────────────────
const first = pushVersion(chapter('The courier waited.'), 'revise', 'make him angrier');
check('the displaced text is kept', first.length === 1 && first[0].content === 'The courier waited.');
check('its title travels with it', first[0].title === 'The Weighing House');
check('the change that displaced it is named', first[0].kind === 'revise');
check('the instruction is recorded beside it', first[0].note === 'make him angrier');
check('it is stamped', typeof first[0].at === 'number' && first[0].at > 0);

// ── Nothing to lose ───────────────────────────────────────────────────────
check('a chapter with no text yet contributes no snapshot', pushVersion(chapter(''), 'generate').length === 0);
check('whitespace is not writing', pushVersion(chapter('   \n  '), 'generate').length === 0);
check('a missing chapter is not an error', pushVersion(null, 'generate').length === 0);
check(
  'existing history survives a no-op snapshot',
  pushVersion(chapter('', first), 'generate').length === 1
);

// ── The count budget ──────────────────────────────────────────────────────
let history: Chapter['versions'] = [];
for (let i = 0; i < MAX_VERSIONS + 4; i++) {
  history = pushVersion(chapter(`draft ${i}`, history), 'revise');
}
check(`no more than ${MAX_VERSIONS} snapshots are kept`, history.length === MAX_VERSIONS);
check(
  'the newest survives and the oldest are dropped',
  history[history.length - 1].content === `draft ${MAX_VERSIONS + 3}` && history[0].content === `draft 4`
);

// ── The byte budget ───────────────────────────────────────────────────────
const fat = 'x'.repeat(Math.floor(MAX_VERSION_CHARS / 3));
let heavy: Chapter['versions'] = [];
for (let i = 0; i < 6; i++) heavy = pushVersion(chapter(fat + i, heavy), 'revise');
const bytes = heavy.reduce((sum, v) => sum + v.content.length + v.title.length, 0);
check('the byte budget bounds the document', bytes <= MAX_VERSION_CHARS, `${bytes} chars`);
check('the byte budget bites before the count budget here', heavy.length < MAX_VERSIONS);
check(
  'the newest snapshot is still the one just displaced',
  heavy[heavy.length - 1].content === fat + '5'
);

// A single chapter larger than the whole budget must still be kept: losing the
// text you just replaced is the exact failure this module exists to prevent.
const enormous = pushVersion(chapter('y'.repeat(MAX_VERSION_CHARS * 2), []), 'revise');
check('a snapshot over budget on its own is kept anyway', enormous.length === 1);

// ── hasHistory ────────────────────────────────────────────────────────────
check('a chapter with snapshots has history', hasHistory({ versions: first } as Chapter));
check('a chapter without them does not', !hasHistory({} as Chapter));
check('an empty list is not history', !hasHistory({ versions: [] } as unknown as Chapter));

console.log(`\n${passed}/${passed + failures.length} passed`);
if (failures.length) {
  console.error('FAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
