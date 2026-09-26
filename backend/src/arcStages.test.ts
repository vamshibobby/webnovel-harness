/**
 * Stage isolation checks: npx tsx src/arcStages.test.ts
 *
 * Offline and free. The property under test is the one that makes the staged
 * pipeline safe: each merge writes its own fields and NOTHING else, so a
 * stage that fails — or a merge written wrong next year — can never cost the
 * author another stage's work. Every merge runs against a fully-populated
 * arc, and everything outside the merge's declared field set must come
 * through deep-equal.
 */
import {
  mergeBatch,
  mergeBraid,
  mergeRefine,
  mergeThreads,
  mergeThreadSeeds,
  markStage,
  stageFailed,
  stageOk,
  stagePartial,
} from './lib/arcStages.js';
import { validateArcPatch, ArcValidationError } from './lib/arcValidate.js';
import type { ArcThread, BraidReport, ChapterBlueprint, StoryArc } from './lib/types.js';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failures.push(label);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
}

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ── a fully-populated arc, so an over-reaching merge has something to break ──

const thread = (id: string, label: string, n?: number): ArcThread => ({
  id,
  label,
  ...(n !== undefined ? { authorNumber: n } : {}),
  anchor: 'span',
  source: 'author',
});

const bp = (chapter: number, extra?: Partial<ChapterBlueprint>): ChapterBlueprint => ({
  chapter,
  title: `Ch ${chapter}`,
  tags: ['drama'],
  summary: `Chapter ${chapter} happens at length and in detail.`,
  opens: 'It opens.',
  turn: 'It turns.',
  lands: 'It lands.',
  source: 'model',
  ...extra,
});

const report: BraidReport = {
  at: 1,
  from: 21,
  to: 30,
  clocks: [{ id: 't1', lastChapter: 30, lastDay: 40, count: 5, darkFor: 0 }],
  findings: [],
  weaveRate: 0.3,
  longestRun: 2,
  unplaced: 0,
};

function fullArc(): StoryArc {
  return {
    id: 'the-braid',
    number: 1,
    title: 'The Braid',
    premise: 'The author premise, in the author words.',
    premiseSource: 'author',
    previousPremise: '',
    fromChapter: 21,
    toChapter: 70,
    status: 'planning',
    steer: true,
    beats: [{ id: 'b0', text: 'The debt is called in.', source: 'author' }],
    blueprints: [bp(21, { source: 'author' }), bp(22)],
    threads: [thread('t1', 'the feud', 1), thread('t2', 'the audit', 2)],
    timeline: { spanDays: 240, note: 'over eight months' },
    nameFlags: [{ name: 'Marren', where: 'premise', at: 1 }],
    braid: report,
    stages: { threads: { status: 'ok', at: 1 } },
    createdAt: 1,
    updatedAt: 1,
  };
}

/** Every field outside `own` must survive a merge byte-identical. */
function assertOnly(label: string, base: StoryArc, next: StoryArc, own: readonly (keyof StoryArc)[]): void {
  const touched: string[] = [];
  for (const key of Object.keys(base) as (keyof StoryArc)[]) {
    if (own.includes(key) || key === 'updatedAt') continue;
    if (!eq(base[key], next[key])) touched.push(key);
  }
  check(label, touched.length === 0, touched.length ? `also wrote: ${touched.join(', ')}` : '');
}

// ── each merge touches only its own fields ────────────────────────────────

{
  const base = fullArc();
  const next = mergeThreads(base, [thread('t9', 'the sister')], { spanDays: 90 });
  assertOnly('mergeThreads writes threads and timeline only', base, next, ['threads', 'timeline']);
  check('and it did write them', next.threads?.[0]?.id === 't9' && next.timeline?.spanDays === 90);
}

{
  const base = fullArc();
  const next = mergeRefine(base, {
    premise: 'A tightened premise.',
    beats: [{ id: 'b1', text: 'New beat.', source: 'model' }],
    threads: [thread('t1', 'the feud', 1)],
    nameFlags: [],
    stage: stagePartial('one name could not be checked'),
  });
  assertOnly('mergeRefine never touches the blueprints or the braid', base, next, [
    'premise', 'premiseSource', 'previousPremise', 'beats', 'threads', 'timeline', 'nameFlags', 'stages',
  ]);
  check('the author premise becomes previousPremise', next.previousPremise === base.premise);
  check('the stage record landed', next.stages?.refine?.status === 'partial');
}

{
  // Refining twice must not bury the author's words under the first rewrite.
  const base = { ...fullArc(), premiseSource: 'model' as const, previousPremise: 'What the author typed.' };
  const next = mergeRefine(base, {
    premise: 'A second rewrite.',
    beats: [],
    threads: [],
    nameFlags: [],
    stage: stageOk(),
  });
  check('a re-refine keeps the AUTHOR premise as previousPremise', next.previousPremise === 'What the author typed.');
}

{
  const base = fullArc();
  const next = mergeBatch(base, [bp(21), bp(23)]);
  assertOnly('mergeBatch writes blueprints only', base, next, ['blueprints']);
  check('a batch merges by chapter', next.blueprints.map((b) => b.chapter).join() === '21,22,23');
  check(
    'replacing an author-edited chapter keeps what it replaced',
    next.blueprints[0].previousSummary === base.blueprints[0].summary
  );
}

{
  const base = fullArc();
  const next = mergeBraid(base, { ...report, findings: [] });
  assertOnly('mergeBraid writes the report and its stage only', base, next, ['braid', 'stages']);
  check('a clean report is stage ok', next.stages?.braid?.status === 'ok');
  const broken = mergeBraid(base, {
    ...report,
    findings: [{ kind: 'blocked-run', message: 'x', chapters: [1], threads: ['t1'], severity: 'break' }],
  });
  check('a report with a break is stage partial', broken.stages?.braid?.status === 'partial');
}

{
  const base = fullArc();
  const next = markStage(base, 'refine', stageFailed('the provider 502d'));
  assertOnly('markStage writes stages only', base, next, ['stages']);
  check('and keeps the other stages', next.stages?.threads?.status === 'ok');
}

// ── a legacy arc survives every merge ─────────────────────────────────────
{
  const legacy: StoryArc = { ...fullArc() };
  delete legacy.threads;
  delete legacy.timeline;
  delete legacy.nameFlags;
  delete legacy.braid;
  delete legacy.stages;
  const afterBatch = mergeBatch(legacy, [bp(23)]);
  check(
    'a legacy arc gains nothing it did not have from a batch',
    !('threads' in afterBatch) && !('braid' in afterBatch),
    Object.keys(afterBatch).join()
  );
}

// ── mergeThreadSeeds: the model can never delete a storyline ──────────────
{
  const seeds = [thread('t1', 'the outsourcing feud', 1), thread('t2', 'the audit', 2), thread('t3', 'the sister', 3)];
  const merged = mergeThreadSeeds(seeds, [
    { ...thread('x', 'corporate restructuring conflict', 1), anchor: 'early', weight: 'major' },
    // The model dropped t2 and t3 entirely, and invented one of its own.
    { ...thread('y', 'the villain seed'), anchor: 'late', seedForNextArc: true, source: 'model' },
  ]);
  check('no seed is ever dropped', merged.filter((t) => ['t1', 't2', 't3'].includes(t.id)).length === 3);
  check('a matched seed keeps the AUTHOR label', merged[0].label === 'the outsourcing feud');
  check('and gains what the model worked out', merged[0].anchor === 'early' && merged[0].weight === 'major');
  check('an unmatched seed survives untouched', merged[1].label === 'the audit' && merged[1].anchor === 'span');
  check(
    'a model-only thread is appended as the model’s',
    merged.at(-1)?.label === 'the villain seed' && merged.at(-1)?.source === 'model'
  );
  check('ids are stable through the merge', merged[0].id === 't1');
}

{
  // Label matching, when the model kept the words but not the number.
  const seeds = [thread('t1', 'the sister arrives')];
  const merged = mergeThreadSeeds(seeds, [{ ...thread('z', 'the sister'), anchor: 'mid' }]);
  check('a partial label match enriches rather than duplicates', merged.length === 1 && merged[0].anchor === 'mid');
}

// ── the PATCH surface cannot reach pipeline-owned fields ──────────────────
{
  let refused = '';
  try {
    validateArcPatch({ braid: report });
  } catch (e) {
    refused = e instanceof ArcValidationError ? e.message : '';
  }
  check('a client cannot PATCH the braid report', refused.includes('braid'), refused);

  let refusedStages = '';
  try {
    validateArcPatch({ stages: {} });
  } catch (e) {
    refusedStages = e instanceof ArcValidationError ? e.message : '';
  }
  check('a client cannot PATCH the stage records', refusedStages.includes('stages'), refusedStages);

  const ok = validateArcPatch({
    threads: [{ id: 't1', label: 'the feud', anchor: 'early', source: 'author' }],
    timeline: { spanDays: 240 },
    nameFlags: [{ name: 'Marren', where: 'premise', at: 5 }],
  });
  check('threads, timeline and flags ARE patchable', (ok.threads?.length ?? 0) === 1 && ok.timeline?.spanDays === 240);
  check('a malformed flag drops instead of failing the save', validateArcPatch({ nameFlags: [{}] }).nameFlags?.length === 0);
}

console.log(`\n${passed}/${passed + failures.length} passed`);
if (failures.length) {
  console.log('failed:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
