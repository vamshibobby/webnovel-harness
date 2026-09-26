/**
 * Title and preamble extraction: npx tsx src/chapterTitle.test.ts
 *
 * Offline and free. These are regressions for two defects measured over real
 * generations in research/eval, both of which corrupted saved chapters silently:
 * a decorated heading cost the chapter its title, and self-introducing
 * commentary became the chapter's first paragraph.
 *
 * The last group matters as much as the first two. Widening the search is how
 * this fix could go wrong -- a chapter that mentions a chapter heading in its
 * own prose must not have everything before it thrown away.
 */
import { extractTitleForTest as extractTitle } from './routes/chapters.js';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

console.log('\n── Headings, however the model decorates them\n');
for (const [style, line] of [
  ['plain', 'Chapter 9: The Same City'],
  ['bold', '**Chapter 9: The Same City**'],
  ['hash', '# Chapter 9: The Same City'],
  ['hash + bold', '## **Chapter 9: The Same City**'],
  ['underscore', '__Chapter 9: The Same City__'],
  ['em dash separator', 'Chapter 9 — The Same City'],
] as const) {
  const r = extractTitle(`${line}\n\nHe went down to the water.`, 9);
  check(`${style} heading parses`, r.title === 'The Same City', `got "${r.title}"`);
  check(`${style} heading is removed from the prose`, !r.content.includes('Chapter 9'));
}

console.log('\n── Commentary before the heading is discarded\n');
const withPreamble =
  'I have all the context I need. Let me now write Chapter 9.\n\n---\n\n' +
  '**Chapter 9: The Same City**\n\nHe went down to the water.';
const p = extractTitle(withPreamble, 9);
check('title survives commentary', p.title === 'The Same City', `got "${p.title}"`);
check('commentary is dropped', !p.content.includes('context I need'), p.content.slice(0, 40));
check('the rule under the heading is dropped', !p.content.startsWith('---'));
check('the prose is intact', p.content.startsWith('He went down to the water.'));

console.log('\n── A chapter that never says "Chapter N" keeps all of itself\n');
const noHeading = 'He went down to the water.\n\nThe boat was gone.';
const nh = extractTitle(noHeading, 9);
check('falls back to a generic title', nh.title === 'Chapter 9');
check('keeps every word', nh.content === noHeading, `${nh.content.length} vs ${noHeading.length} chars`);

console.log('\n── A plan longer than the preamble budget still yields the heading\n');
// Reported from a real generation. Twelve lines of beat sheet put the heading
// past MAX_PREAMBLE_LINES, so no title was found and the plan was saved as the
// chapter's opening paragraphs. The budget bounds prose, and a beat sheet is
// not prose, so planning lines no longer spend it.
const planned = [
  'Good. Now I have full context. Let me write Chapter 7.',
  '',
  'Key points:',
  '- Beap visits the apartment with supplies, checks on Fler\'s training',
  '- Kuw follows and harasses Grey with familiar touch she tolerates',
  '- Fler notices and objects; Grey stops him',
  '- Beap learns what happened and reprimands Kuw privately',
  '- Beap offers Grey continued protection',
  '- Grey recommits to staying for Beap\'s sake',
  '- Fler begins to distrust the Veff family',
  '',
  'Let me write this now.',
  '',
  'Chapter 7: What the Father Owes',
  '',
  'The stairwell smelled of rain and old cooking oil.',
].join('\n');
const pl = extractTitle(planned, 7);
check('the title is found past the plan', pl.title === 'What the Father Owes', `got "${pl.title}"`);
check('no bullet survives into the chapter', !pl.content.includes('- Beap visits'), pl.content.slice(0, 40));
check('the announcement is dropped', !pl.content.includes('full context'));
check('the prose is intact', pl.content === 'The stairwell smelled of rain and old cooking oil.');

console.log('\n── Prose is never eaten by a heading mentioned later\n');
// The failure mode of widening the search: a heading deep in real prose must
// not cause everything above it to be discarded as preamble.
const deep =
  ['He went down to the water.', 'The boat was gone.', 'She had left a note.',
   'It was folded twice.', 'He read it in the rain.', 'Chapter 9: The Same City',
   'That was the title she had given it.'].join('\n\n');
const d = extractTitle(deep, 9);
check('the real opening survives', d.content.startsWith('He went down to the water.'),
  d.content.slice(0, 40));
check('no title is claimed from deep prose', d.title === 'Chapter 9', `got "${d.title}"`);

console.log(`\n${failures === 0 ? 'All title checks passed' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
