/**
 * Braid validator checks: npx tsx src/arcBraid.test.ts
 *
 * Offline and free. Stage D is what turns "the storylines should be juggled
 * properly" from a hope in a prompt into something the app can actually say
 * is true or false — so every failure mode it exists to catch is staged here
 * as a concrete plan, and the legacy shapes (no threads, unplaced chapters)
 * are asserted CLEAN, because an old arc reading as broken would be a bug in
 * itself.
 */
import { formatBraidBrief, formatThreadRoster, validateBraid } from './engine/arcBraid.js';
import { readBookkeeping } from './engine/arcParse.js';
import type { ArcThread, ChapterBlueprint } from './lib/types.js';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failures.push(label);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
}

const thread = (id: string, label: string, extra?: Partial<ArcThread>): ArcThread => ({
  id,
  label,
  anchor: 'span',
  source: 'author',
  ...extra,
});

const bp = (chapter: number, threads: string[], day?: number): ChapterBlueprint => ({
  chapter,
  title: `Ch ${chapter}`,
  tags: [],
  summary: `Chapter ${chapter} moves its thread along without resolving anything.`,
  opens: 'o',
  turn: 't',
  lands: 'l',
  source: 'model',
  ...(threads.length ? { threads } : {}),
  ...(day !== undefined ? { time: { day } } : {}),
});

const THREADS = [thread('t1', 'the feud', { authorNumber: 1 }), thread('t2', 'the audit', { authorNumber: 2 })];
const arcOf = (blueprints: ChapterBlueprint[], threads = THREADS, span = { fromChapter: 21, toChapter: 40 }) => ({
  threads,
  blueprints,
  timeline: { spanDays: 240 },
  ...span,
});

// ── a healthy braid is clean ──────────────────────────────────────────────
{
  const report = validateBraid(
    arcOf([bp(21, ['t1'], 2), bp(22, ['t2'], 2), bp(23, ['t1'], 9), bp(24, ['t1', 't2'], 12)])
  );
  check('a rotating, forward-moving braid has no findings', report.findings.length === 0, report.findings.map((f) => f.kind).join());
  check('the weave rate counts multi-thread chapters', report.weaveRate === 0.25, `${report.weaveRate}`);
  check('clocks track each thread', report.clocks.find((c) => c.id === 't1')?.lastDay === 12);
}

// ── the failure modes, one by one ─────────────────────────────────────────
{
  const blocked = validateBraid(
    arcOf([bp(21, ['t1']), bp(22, ['t1']), bp(23, ['t1']), bp(24, ['t1']), bp(25, ['t2'])])
  );
  check(
    'four consecutive single-thread chapters is a blocked run',
    blocked.findings.some((f) => f.kind === 'blocked-run' && f.severity === 'break'),
    blocked.findings.map((f) => f.kind).join()
  );
  check('and the longest run is measured', blocked.longestRun === 4, `${blocked.longestRun}`);

  const woven = validateBraid(
    arcOf([bp(21, ['t1']), bp(22, ['t1']), bp(23, ['t1', 't2']), bp(24, ['t1']), bp(25, ['t1'])])
  );
  check('a weave chapter breaks a run', !woven.findings.some((f) => f.kind === 'blocked-run'), `${woven.longestRun}`);
}

{
  const backwards = validateBraid(arcOf([bp(21, ['t1'], 30), bp(22, ['t2'], 10), bp(23, ['t1'], 12)]));
  check(
    'a thread landing earlier than its own last day is clock-backwards',
    backwards.findings.some((f) => f.kind === 'clock-backwards' && f.threads.includes('t1')),
    backwards.findings.map((f) => f.kind).join()
  );
  const sideways = validateBraid(arcOf([bp(21, ['t1'], 30), bp(22, ['t2'], 10), bp(23, ['t2'], 30)]));
  check('a DIFFERENT thread on an earlier day is a sideways cut, not an error', !sideways.findings.some((f) => f.kind === 'clock-backwards'));
}

{
  const threads = [
    thread('t1', 'the feud', { authorNumber: 1 }),
    thread('t2', 'the audit', { authorNumber: 2, dependsOn: ['t1'] }),
  ];
  const inverted = validateBraid(arcOf([bp(21, ['t2'], 5), bp(22, ['t1'], 9)], threads));
  check(
    'an effect planned before its cause is a break',
    inverted.findings.some((f) => f.kind === 'effect-before-cause' && f.severity === 'break'),
    inverted.findings.map((f) => f.kind).join()
  );
  const ordered = validateBraid(arcOf([bp(21, ['t1'], 5), bp(22, ['t2'], 9)], threads));
  check('cause before effect is fine', !ordered.findings.some((f) => f.kind === 'effect-before-cause'));
}

{
  const threads = [thread('t1', 'the feud'), thread('t2', 'the audit', { weight: 'major' })];
  const dark = validateBraid(
    arcOf([bp(21, ['t2']), bp(22, ['t1']), bp(23, ['t1']), bp(24, ['t1']), bp(25, ['t1']), bp(26, ['t1']), bp(27, ['t1', 't2'])], threads)
  );
  check('a thread dark past the gap is flagged', dark.findings.some((f) => f.kind === 'thread-dark' && f.threads.includes('t2')));
  const minor = [thread('t1', 'the feud'), thread('t2', 'the beach house', { weight: 'minor' })];
  const done = validateBraid(
    arcOf([bp(21, ['t2']), bp(22, ['t1']), bp(23, ['t1']), bp(24, ['t1']), bp(25, ['t1']), bp(26, ['t1']), bp(27, ['t1'])], minor)
  );
  check('a finished MINOR thread may stay finished', !done.findings.some((f) => f.kind === 'thread-dark' && f.threads.includes('t2')), done.findings.filter((f) => f.kind === 'thread-dark').map((f) => f.threads.join()).join('|'));
}

{
  const threads = [thread('t1', 'the feud'), thread('t2', 'sanna', { endsOpen: true })];
  const resolved = validateBraid(
    arcOf(
      [
        bp(21, ['t1'], 5),
        {
          ...bp(39, ['t2'], 230),
          summary: 'They finally settle everything between them and the question is resolved for good.',
        },
      ],
      threads
    )
  );
  check(
    'an open thread that reads resolved near the end is flagged',
    resolved.findings.some((f) => f.kind === 'resolved-open-thread'),
    resolved.findings.map((f) => f.kind).join()
  );
}

{
  // Eleven threads cannot all appear every four chapters. The gap limit
  // scales, or a real braided run drowns its one true finding in eight
  // mathematical inevitabilities — which is exactly what the first live run
  // of this validator did.
  const eleven = Array.from({ length: 11 }, (_, i) => thread(`t${i + 1}`, `thread ${i + 1}`));
  const rotation = Array.from({ length: 11 }, (_, i) => bp(21 + i, [`t${(i % 11) + 1}`]));
  const fair = validateBraid(arcOf(rotation, eleven, { fromChapter: 21, toChapter: 120 }));
  check(
    'a fair rotation of eleven threads is not "dark"',
    !fair.findings.some((f) => f.kind === 'thread-dark'),
    fair.findings.filter((f) => f.kind === 'thread-dark').length + ' dark findings'
  );

  // A thread that visibly concluded may stay concluded — an investigation
  // dismissed at 60% of the arc is a success, not a dropped storyline.
  const threads = [thread('t1', 'the feud'), thread('t2', 'the investigation')];
  const closedAt = {
    ...bp(22, ['t2'], 20),
    summary: 'The chief executive orders the file closed and the investigation is dismissed for good.',
  };
  const concluded = validateBraid(
    arcOf([bp(21, ['t1'], 5), closedAt, bp(23, ['t1']), bp(24, ['t1']), bp(25, ['t1']), bp(26, ['t1']), bp(27, ['t1'])], threads)
  );
  check(
    'a concluded thread is not dark in its silence',
    !concluded.findings.some((f) => f.kind === 'thread-dark' && f.threads.includes('t2')),
    concluded.findings.map((f) => f.kind).join()
  );
}

{
  // "B waits on A" must not demand A has FINISHED — an ongoing cause is the
  // normal case (an investigation closes because a beta is going well, and
  // the beta runs on for months). Only a cause that has not STARTED is an
  // inversion.
  const threads = [
    thread('t1', 'the beta', { authorNumber: 1 }),
    thread('t2', 'the investigation', { authorNumber: 2, dependsOn: ['t1'] }),
  ];
  const ongoing = validateBraid(
    arcOf([bp(21, ['t1'], 2), bp(22, ['t2'], 9), bp(23, ['t1'], 20), bp(24, ['t1'], 30)], threads)
  );
  check(
    'a cause that started early and runs on is not an inversion',
    !ongoing.findings.some((f) => f.kind === 'effect-before-cause'),
    ongoing.findings.map((f) => f.kind).join()
  );
}

{
  const drift = validateBraid(
    arcOf([bp(21, ['t1'], 10), bp(22, ['t2'], 100), bp(23, ['t1'], 12), bp(24, ['t2'], 110)])
  );
  check('two live threads fifty days apart is drift', drift.findings.some((f) => f.kind === 'clock-drift'));
}

{
  const threads = [thread('t1', 'the feud', { anchor: 'early' }), thread('t2', 'the dinner', { anchor: 'late' })];
  const late = validateBraid(arcOf([bp(35, ['t1']), bp(36, ['t2'])], threads));
  check('an early thread starting at 75% misses its anchor', late.findings.some((f) => f.kind === 'anchor-missed' && f.threads.includes('t1')));
  const early = validateBraid(arcOf([bp(21, ['t2'])], threads));
  check('a late thread starting at 0% misses its anchor', early.findings.some((f) => f.kind === 'anchor-missed' && f.threads.includes('t2')));
}

{
  const covered = validateBraid(arcOf([bp(21, ['t1']), bp(36, ['t1'])]));
  check(
    'a thread never planned by 80% of the arc is a break',
    covered.findings.some((f) => f.kind === 'thread-never-planned' && f.threads.includes('t2')),
    covered.findings.map((f) => f.kind).join()
  );
}

// ── legacy arcs are CLEAN, not broken ─────────────────────────────────────
{
  const noThreads = validateBraid({ threads: [], blueprints: [bp(21, [])], timeline: undefined, fromChapter: 21, toChapter: 40 });
  check('an arc with no threads has no findings', noThreads.findings.length === 0);
  check('and its chapters count as unplaced, quietly', noThreads.unplaced === 1);

  const oldPlan = validateBraid(arcOf([bp(21, []), bp(22, [])]));
  check('blueprints with no thread ids are unplaced, never findings', oldPlan.findings.length === 0 && oldPlan.unplaced === 2);
}

// ── the bookkeeping reader ────────────────────────────────────────────────
{
  const read = readBookkeeping([
    'Threads: the Refsdal feud (2), the audit (5).',
    'Day: 47 — the same fortnight as ch 34, seen from the audit side.',
    'The kickbacks are already in the file.',
  ]);
  check(
    'Threads: reads every label',
    read.threads.map((t) => t.label).join('|') === 'the Refsdal feud|the audit',
    read.threads.map((t) => t.label).join('|')
  );
  check(
    'and keeps the numbers — the reliable half when a label is paraphrased',
    read.threads.map((t) => t.number).join() === '2,5'
  );
  check('Day: reads the integer', read.time?.day === 47);
  check('and keeps the human hint', read.time?.hint?.includes('fortnight') === true, read.time?.hint);
}
{
  const legacy = readBookkeeping(['Thread: the feud (2).', 'Time: a week after ch 34.']);
  check('the old singular Thread: still reads', legacy.threads.map((t) => t.label).join() === 'the feud');
  check('a Time: line with no day yields no time', legacy.time === undefined);
  const dotless = readBookkeeping(['Threads: 2 · the feud', 'Day: 12']);
  check('a number-first label sheds its number', dotless.threads[0]?.label === 'the feud', dotless.threads[0]?.label);
  check('but the number is kept beside it', dotless.threads[0]?.number === 2);
  check('a bare Day: number reads with no hint', dotless.time?.day === 12 && dotless.time?.hint === undefined);
}

// ── the prompt-facing formats ─────────────────────────────────────────────
{
  const threads = [
    thread('t1', 'the feud', { authorNumber: 1, anchor: 'early', weight: 'major' }),
    thread('t2', 'the villain seed', { authorNumber: 2, seedForNextArc: true, endsOpen: true, dependsOn: ['t1'] }),
  ];
  const roster = formatThreadRoster(threads, 240);
  check('the roster names the span', roster.includes('240 days'));
  check('the roster names dependencies by label', roster.includes('resolves only AFTER: the feud'));
  check('a seed thread says glimpse, never resolution', roster.includes('never a resolution'));

  const report = validateBraid(arcOf([bp(21, ['t1'], 4)], threads));
  const brief = formatBraidBrief(report, threads);
  check('the brief places a planned thread', brief.includes('the feud: last seen ch 21, day 4'), brief);
  check('the brief names an unstarted thread', brief.includes('the villain seed: not yet started'));
}

console.log(`\n${passed}/${passed + failures.length} passed`);
if (failures.length) {
  console.log('failed:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
