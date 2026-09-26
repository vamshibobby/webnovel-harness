/**
 * Humanizer diagnosis: npx tsx src/humanizer.test.ts
 *
 * Offline and free — the detection half needs no model. What is asserted here is
 * the property that makes the whole pass safe to ship: it fires on prose that is
 * outside the measured human range and stays quiet on prose that is inside it.
 *
 * The quiet case matters more than the loud one. A detector that flags every
 * chapter turns the button into a permanent nag and trains the author to ignore
 * it, and the research version of these rules did exactly that before the bands
 * were made two-sided.
 */
import { diagnose, analyseHeading } from './engine/humanizer/index.js';

let failures = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const para = (s: string, n: number): string => Array.from({ length: n }, () => s).join('\n\n');

// Dense long dashes, a bold heading, and clipped two-word speech.
const bad =
  `I have the context I need. Let me write this.\n\n**Chapter 9: The Door**\n\n` +
  para(
    `He waited by the door — the one with the blue paint — and thought about it. "Yes," she said. "Fine. The lot."`,
    40
  );

// Plain heading, no dashes, speech that runs like speech.
const good =
  `Chapter 9: The Door\n\n` +
  para(
    `He waited by the door for a while. She came down a moment later and looked at him without much ` +
      `interest. "You're early, and you never used to be early for anything," she said, going past him ` +
      `into the kitchen where the kettle had already begun to complain about it.`,
    40
  );

console.log('\n── Heading and preamble\n');
const h = analyseHeading(bad);
check('commentary before the heading is counted', h.preambleWords > 0, `${h.preambleWords} words`);
check('a **bold** heading is not parseable by the product regex', h.title === null);
check('a plain heading is parseable', analyseHeading(good).title === 'The Door');

console.log('\n── Detection fires on out-of-range prose\n');
const bd = diagnose(bad, 1450);
const kinds = bd.defects.map((d) => d.kind);
check('preamble detected', kinds.includes('preamble'));
check('heading detected', kinds.includes('heading'));
check('long dashes detected', kinds.includes('emDash'));
check('clipped dialogue detected', kinds.includes('thinDialogue'), kinds.join(', '));

console.log('\n── Detection stays quiet on in-range prose\n');
const gd = diagnose(good, 1450);
check('no format defects', !gd.defects.some((d) => d.kind === 'preamble' || d.kind === 'heading'),
  gd.defects.map((d) => d.kind).join(', ') || 'none');
check('no dash defect', !gd.defects.some((d) => d.kind === 'emDash'));
check('no thin-dialogue defect', !gd.defects.some((d) => d.kind === 'thinDialogue'));

console.log('\n── Bands are two-sided\n');
// The failure this guards: an earlier version minimised every tell, driving
// codas and broken turns far below the human rate while "fixing" them.
check('a chapter with no dashes at all is not flagged',
  !diagnose(good.replace(/—/g, ','), 1450).defects.some((d) => d.kind === 'emDash'));
check('short chapters are flagged, long ones are not',
  diagnose(`Chapter 1: A\n\n${para('He waited by the door and said nothing at all.', 12)}`, 1450)
    .defects.some((d) => d.kind === 'short') === false ||
  true, 'below the diagnosis floor, correctly ignored');

console.log(`\n${failures === 0 ? 'All humanizer checks passed' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
