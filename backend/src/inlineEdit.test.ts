/**
 * Inline editing: the prompt, the unwrapping, and the guard.
 *   npx tsx src/inlineEdit.test.ts
 *
 * Free — no network, no key. Everything asserted here is pure.
 *
 * The guard is the part worth the file. What the model returns is spliced into
 * a chapter, so the failures are quiet ones: a fenced block, an apology, the
 * passage handed back inside quotation marks it never had, the whole chapter
 * rewritten. The line the guard draws is between a reply that would MISLEAD —
 * thrown away — and one that is merely worse than hoped, which is shown with a
 * note, because the author reads every proposal before anything is written.
 */
import type { Novel } from './lib/types.js';

const {
  buildInlineEditMessages,
  cleanReplacement,
  looksLikeCommentary,
  trimEcho,
  rejectReason,
  lengthWarning,
  isEditAction,
} = await import('./engine/inlineEdit.js');

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failures.push(label);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
}

const novel: Novel = {
  id: 'n1',
  ownerUid: 'u1',
  title: 'The Salt Road',
  premise: 'A courier carries a sealed ledger.',
  styleNotes: '',
  style: 'webnovel',
  defaultModel: 'x/y',
  chapterLength: 1500,
  chapterCount: 3,
  wordCount: 4200,
  hidden: false,
  createdAt: 0,
  updatedAt: 0,
};

const before = 'B'.repeat(300) + ' The lantern guttered in the doorway. ';
const selection = 'He walked to the gate and waited.';
const after = ' The bell rang twice. ' + 'A'.repeat(300);
const content = before + selection + after;
const start = before.length;
const end = start + selection.length;

// ── The message ───────────────────────────────────────────────────────────
const messages = buildInlineEditMessages({
  novel,
  chapterNumber: 4,
  chapterTitle: 'The Weighing House',
  content,
  start,
  end,
  action: 'shorten',
});
const user = String(messages[1].content);

check('two messages: the novel’s system prompt, then the task', messages.length === 2);
check('the system prompt is the novel’s own', messages[0].role === 'system' && String(messages[0].content).includes('The Salt Road'));
check('the selection is sent verbatim', user.includes(selection));
check('the surrounding prose is sent as context', user.includes('lantern guttered') && user.includes('bell rang twice'));
check('the action’s instruction is present', user.toLowerCase().includes('tighten'));
check('the output contract is stated', /<replacement>/i.test(user));

// A selection at the very start of a chapter has no "before" window, and the
// prompt must not then ship an empty labelled section.
const atStart = String(
  buildInlineEditMessages({
    novel,
    chapterNumber: 1,
    chapterTitle: '',
    content: selection + after,
    start: 0,
    end: selection.length,
    action: 'rewrite',
  })[1].content
);
check('no empty BEFORE section at the top of a chapter', !atStart.includes('TEXT BEFORE THE SELECTION'));
check('the AFTER section still rides along', atStart.includes('TEXT AFTER THE SELECTION'));

// Custom actions carry the author's own words as the task.
const custom = String(
  buildInlineEditMessages({
    novel,
    chapterNumber: 4,
    chapterTitle: '',
    content,
    start,
    end,
    action: 'custom',
    instruction: 'make him angrier',
  })[1].content
);
check('a custom instruction becomes the task', custom.includes('make him angrier'));

// ── Unwrapping ────────────────────────────────────────────────────────────
check(
  'a fenced reply is unwrapped',
  cleanReplacement('```\nHe waited at the gate.\n```', selection) === 'He waited at the gate.'
);
check(
  'a language-tagged fence is unwrapped',
  cleanReplacement('```text\nHe waited.\n```', selection) === 'He waited.'
);
check(
  'quotation marks the model added are removed',
  cleanReplacement('"He waited at the gate."', selection) === 'He waited at the gate.'
);
check(
  'dialogue keeps its own quotation marks',
  cleanReplacement('"Wait here," he said.', '"Stay," he said.') === '"Wait here," he said.'
);
check(
  'curly quotes around a plain passage are removed',
  cleanReplacement('“He waited.”', selection) === 'He waited.'
);
check('ordinary prose is left exactly alone', cleanReplacement('He waited.', selection) === 'He waited.');

// ── Tags, and the model that thinks out loud ─────────────────────────────
// The tags exist for exactly one observed failure: a free model that answers
// with its reasoning first. Everything outside them is dropped.
check(
  'the tagged passage is taken and the thinking discarded',
  cleanReplacement(
    'We need to rewrite the selected passage with colder weather.\n<replacement>The frost had got into the seal.</replacement>',
    selection
  ) === 'The frost had got into the seal.'
);
check(
  'a reply cut off mid-passage keeps what was written',
  cleanReplacement('Okay. <replacement>The frost had got in', selection) === 'The frost had got in'
);
check(
  'an untagged reply is still accepted',
  cleanReplacement('The frost had got into the seal.', selection) === 'The frost had got into the seal.'
);
check(
  'a model narrating the task is refused',
  looksLikeCommentary('We need to rewrite the selected passage with colder weather, keeping continuity.')
);
check(
  'so is a chattier one',
  looksLikeCommentary("Sure! Here's the passage rewritten to feel tenser. The selection now reads:")
);
// The refusal must not catch prose. Dialogue opens this way constantly.
check(
  'dialogue that opens the same way is not refused',
  !looksLikeCommentary('"We need to leave," he said, and the lamp went out behind him.')
);
check(
  'ordinary prose is not refused',
  !looksLikeCommentary('The frost had got into the seal, and the sigil beneath it had gone grey.')
);

// ── Trimming what the model kept writing ─────────────────────────────────
// A small model rewrites the passage and then carries on into the next
// paragraph. What it produced is still a replacement with a tail attached, and
// an author who is told "try again" has no way forward — so the tail is cut.
const window = { before, after };
check(
  'a reply that runs on into the following prose is cut back to the passage',
  trimEcho('He waited by the gate. ' + after.trim().slice(0, 200), window) === 'He waited by the gate.'
);
check(
  'a reply that restates the preceding prose first is cut back too',
  trimEcho(before.trim().slice(-200) + ' He waited by the gate.', window) === 'He waited by the gate.'
);
check(
  'a reply that is only the replacement is untouched',
  trimEcho('He waited by the gate.', window) === 'He waited by the gate.'
);
check(
  'trimming does not fire on a chapter edge with no surrounding text',
  trimEcho('He waited.', { before: '', after: '' }) === 'He waited.'
);

// ── The guard: only what would mislead is thrown away ────────────────────
const refuse = (t: string, sel = selection, action: 'rewrite' | 'shorten' | 'expand' = 'rewrite') =>
  rejectReason(t, sel, action, window);
check('a sane replacement passes', refuse('He waited by the gate.') === null);
check('an empty reply is refused', refuse('') !== null);
// The echo trim can leave a clause behind when a model wrote one and then
// carried on into the next paragraph; "and" is not an edit of a sentence.
check('a fragment left behind by the trim is refused', refuse('and') !== null);
check(
  'a genuinely tighter line is not mistaken for a fragment',
  refuse('He waited.', 'He walked to the gate and waited.', 'shorten') === null
);
check(
  'a reply containing the preceding prose is refused',
  refuse(before.slice(-250) + ' He waited.') !== null,
  'the whole-chapter rewrite'
);
check(
  'a reply containing the following prose is refused',
  refuse('He waited.' + after.slice(0, 250)) !== null
);
// A long reply is the model over-reaching, not a reply that would mislead —
// the author reads every proposal before anything is written, so it is shown
// with a note rather than thrown away.
check(
  'a very long reply is still shown to the author',
  refuse('x'.repeat(selection.length * 20)) === null
);

// ── The length note ───────────────────────────────────────────────────────
check(
  'a proportionate reply gets no note',
  lengthWarning('He waited by the gate.', selection, 'rewrite') === null
);
check(
  'tightening that came back longer is called out',
  (lengthWarning('x'.repeat(selection.length * 3 + 500), selection, 'shorten') ?? '').includes('tighten')
);
check(
  'expanding to three times the passage is not called out',
  lengthWarning('x'.repeat(selection.length * 3), selection, 'expand') === null
);
check(
  'even expanding tenfold is called out',
  lengthWarning('x'.repeat(selection.length * 10 + 500), selection, 'expand') !== null
);
// A short selection would otherwise make every reasonable reply "too long":
// tightening four words legitimately returns three, but rewriting them can
// return a clause. The floor exists so small selections stay editable.
check(
  'a tiny selection is judged against a floor, not its own length',
  lengthWarning('He waited by the gate, saying nothing at all.', 'He waited.', 'rewrite') === null
);

// ── The action list ───────────────────────────────────────────────────────
check('known actions are accepted', isEditAction('rewrite') && isEditAction('custom'));
check('anything else is refused', !isEditAction('delete') && !isEditAction('') && !isEditAction(7));

console.log(`\n${passed}/${passed + failures.length} passed`);
if (failures.length) {
  console.error('FAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
