/**
 * Stage A checks: npx tsx src/arcThreads.test.ts
 *
 * Offline and free. The extractor reads the author's premise BEFORE any model
 * does, and what it banks can only be enriched afterwards — so what it banks
 * has to be right on the shapes real authors actually write: a flowing
 * paragraph with inline numbering, typos, timing phrases buried mid-thread,
 * and instructions like "not resolved here" that a tidy-minded model would
 * love to ignore.
 */
import { extractThreadSeeds } from './engine/arcThreads.js';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failures.push(label);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
}

/*
 * The shape of the premise that motivated all of this: one paragraph, inline
 * numbers, concurrent threads, explicit "not in this order", timing phrases
 * inside the threads. (A fictional analogue — the real one is an author's
 * unpublished novel.)
 */
const BRAIDED =
  'Lot of things happening in parallel in the next 8 months and it doesnt happen in order. ' +
  '1. Rennick finally reads the ledger and the customs case builds slowly across the months. ' +
  '2. the feud with the harbour master is ended when the audit lands. as a result of the customs case going well he wins standing. ' +
  '3. in the 8 months, the salt trade grows more than expected and reaches the northern ports. ' +
  '4. the print shop scaled to ten hands and a small office. no product is released. they are just improving it. ' +
  '5. the investigation of him starts in the early time of the arc and is closed by the end. ' +
  '6. his sister arrives in the mid of the 8 months and settles in. ' +
  '7. villain for the next arc is made as the broker himself which we dont go into depth in this arc only but we get a glimpse.';

{
  const { threads, timeline } = extractThreadSeeds(BRAIDED);
  check('every numbered storyline is found', threads.length === 7, `${threads.length}`);
  check('the author numbering survives', threads.map((t) => t.authorNumber).join() === '1,2,3,4,5,6,7');
  check('labels are the author words', threads[0].label.startsWith('Rennick finally reads the ledger'), threads[0].label);
  check(
    'a leading time clause is not a label',
    threads[2].label.startsWith('the salt trade grows'),
    threads[2].label
  );
  check('the arc span is read: 8 months is 240 days', timeline?.spanDays === 240, `${timeline?.spanDays}`);
  check('"early time of the arc" anchors early', threads[4].anchor === 'early');
  check('"in the mid of the 8 months" anchors mid', threads[5].anchor === 'mid');
  check('"no product is released" stays open', threads[3].endsOpen === true);
  check(
    'a next-arc villain is a seed, not a plot to resolve',
    threads[6].endsOpen === true && threads[6].seedForNextArc === true
  );
  check('a one-line thread is minor', threads[3].weight === 'minor');
  check(
    '"as a result of the customs case" is a dependency on thread 1',
    threads[1].dependsOn?.includes(threads[0].id) === true,
    threads[1].dependsOn?.join()
  );
  check(
    'ids are stable across runs',
    extractThreadSeeds(BRAIDED).threads[0].id === threads[0].id
  );
}

// ── the shapes that must NOT become braids ────────────────────────────────
{
  const single = extractThreadSeeds(
    'Rennick finally reads the ledger. The Salt Court summons him to testify, and somewhere in here he chooses.'
  );
  check('a plain premise is one thread', single.threads.length === 1);
  check('and that thread spans the arc', single.threads[0].anchor === 'span');
  check('a plain premise has no timeline', single.timeline === undefined);
}

{
  const twoDashes = extractThreadSeeds('The ledger matters.\n- it was sealed\n- it was carried north');
  check('two bullets are prose, not a plan', twoDashes.threads.length === 1, `${twoDashes.threads.length}`);
}

{
  const bulleted = extractThreadSeeds(
    'Three things run at once over the next two months.\n' +
      '- the ledger is read and the case is built\n' +
      '- the sister arrives and will not say why she came\n' +
      '- the print shop grows and hires the wrong man'
  );
  check('three bullets are a plan', bulleted.threads.length === 3, `${bulleted.threads.length}`);
  check('bulleted threads have no author number', bulleted.threads.every((t) => t.authorNumber === undefined));
  check('"next two months" is 60 days', bulleted.timeline?.spanDays === 60);
}

// "early rendition" is a product description, not a schedule.
{
  const { threads } = extractThreadSeeds(
    '1. he sells the engine to the northern firm along with an early rendition of the ledger system and they love it. ' +
      '2. the sister arrives and the house changes around her shape entirely.'
  );
  check('"an early rendition" does not anchor a thread early', threads[0].anchor === 'span', threads[0].anchor);
}

console.log(`\n${passed}/${passed + failures.length} passed`);
if (failures.length) {
  console.log('failed:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
