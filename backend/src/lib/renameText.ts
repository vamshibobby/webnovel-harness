/**
 * Case-preserving, whole-word, multi-pair text replacement.
 *
 * Pure, and imports nothing — this is the only genuinely delicate code in the
 * naming feature and every one of its rules came out of a way the obvious
 * version gets a novel wrong.
 *
 * A rename is never one string. Renaming "Kael Veyron" to "Ryn Ashgrove" also
 * means "Kael" → "Ryn" wherever he is addressed, and usually "Veyron" →
 * "Ashgrove" for the family. So the caller passes pairs, they are compiled into
 * ONE alternation ordered longest-first, and applied in a SINGLE pass. Two
 * passes would let the first one's output feed the second's input: "Kael
 * Veyron" becomes "Ryn Ashgrove", and then the "Kael"→"Ryn" pass has nothing to
 * do — but reverse the order and "Kael Veyron" becomes "Ryn Veyron" and then
 * "Ryn Ashgrove" only by luck. One pass makes the order irrelevant.
 */

export interface RenamePair {
  from: string;
  to: string;
}

/**
 * Word boundaries by lookaround rather than `\b`.
 *
 * `\b` is defined against ASCII word characters, so it breaks in exactly the
 * places invented names live: `Zh'ar`, `Al-Rashid`, `Rénka`. Unicode property
 * escapes get all three right. Note what is deliberately NOT in the class: an
 * apostrophe is neither a letter nor a number, so a trailing possessive
 * satisfies the right-hand boundary and "Kael's" renames to "Ryn's" untouched.
 */
const LEFT = '(?<![\\p{L}\\p{N}])';
const RIGHT = '(?![\\p{L}\\p{N}])';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A pattern for one name, relaxed in two places a novel actually needs:
 * whitespace, because a two-word name is regularly broken across a line break
 * in stored prose; and the apostrophe, because authors and models disagree
 * about which one they type.
 */
function patternFor(from: string): string {
  return escapeRegExp(from.trim())
    .replace(/\s+/g, '\\s+')
    .replace(/['‘’]/g, "['‘’]");
}

/**
 * One alternation for every pair, longest first.
 *
 * Longest-first is what makes "Kael Veyron" win over "Kael" at the same
 * starting position — the regex alternation is ordered, so the first branch
 * that matches is the one taken.
 */
export function compileRename(pairs: readonly RenamePair[]): RegExp | null {
  const usable = pairs.filter((p) => p.from.trim() && p.to.trim());
  if (!usable.length) return null;
  const ordered = [...usable].sort((a, b) => b.from.trim().length - a.from.trim().length);
  const body = ordered.map((p) => `(?:${patternFor(p.from)})`).join('|');
  return new RegExp(`${LEFT}(?:${body})${RIGHT}`, 'giu');
}

/**
 * Which replacement a matched string wants. Built once per apply, because the
 * alternation cannot tell the replacer which branch fired.
 */
function replacementFor(matched: string, pairs: readonly RenamePair[]): string | null {
  const flat = matched.replace(/\s+/g, ' ').toLowerCase();
  for (const pair of pairs) {
    const from = pair.from.trim().replace(/\s+/g, ' ');
    if (from.toLowerCase() === flat) return pair.to.trim();
    // The apostrophe relaxation above means the matched text can differ from
    // the pair by which quote character it used.
    if (from.replace(/['‘’]/g, "'").toLowerCase() === flat.replace(/['‘’]/g, "'")) {
      return pair.to.trim();
    }
  }
  return null;
}

/**
 * Carry the author's capitalisation across.
 *
 * All-lowercase matters because a name is often used generically — "the
 * aetherium hummed". All-caps matters because dialogue shouts — "KAEL!".
 * Everything else, including Title Case and anything mixed, takes the
 * replacement exactly as the author typed it: trying to be clever about
 * internal capitals turns "Ashgrove" into "AshGrove" the first time someone
 * renames "McKay".
 */
export function matchCase(matched: string, replacement: string): string {
  if (matched === matched.toLowerCase()) return replacement.toLowerCase();
  if (matched.length > 1 && matched === matched.toUpperCase()) return replacement.toUpperCase();
  return replacement;
}

export interface RenameResult {
  text: string;
  count: number;
}

/**
 * The single pass, with the casing rule left open.
 *
 * Everything delicate about this file lives above — the ordered alternation,
 * the Unicode boundaries, the whitespace and apostrophe relaxation — and it is
 * shared rather than copied, because two copies of a regex this fiddly is how
 * they drift apart. Casing is the only axis on which the two callers differ.
 */
function replaceEach(
  text: string,
  re: RegExp,
  pairs: readonly RenamePair[],
  cased: (matched: string, replacement: string) => string
): RenameResult {
  let count = 0;
  const out = text.replace(new RegExp(re.source, re.flags), (matched) => {
    const replacement = replacementFor(matched, pairs);
    if (replacement === null) return matched;
    count++;
    return cased(matched, replacement);
  });
  return { text: out, count };
}

/** Rewrite one string. `re` must come from compileRename over the same pairs. */
export function applyRename(
  text: string,
  re: RegExp,
  pairs: readonly RenamePair[]
): RenameResult {
  return replaceEach(text, re, pairs, matchCase);
}

/**
 * Substitute a PHRASE for a name, without carrying the phrase's case across.
 *
 * The sibling of applyRename, and the difference is the whole reason it
 * exists. A rename swaps a proper noun for a proper noun, so "the aetherium
 * hummed" has to stay lowercase. This swaps a common-noun phrase for a proper
 * noun — "a dock clerk" for "Wenna Skarrow" — and a role phrase is lowercase
 * by nature, so carrying its case would lowercase every name the arc cast pass
 * writes into a plan.
 */
export function applySubstitution(
  text: string,
  re: RegExp,
  pairs: readonly RenamePair[]
): RenameResult {
  return replaceEach(text, re, pairs, (_matched, replacement) => replacement);
}

export interface RenameCount {
  count: number;
  /** A little context around the first few matches, for the preview. */
  samples: string[];
}

const CONTEXT = 60;
const MAX_SAMPLES = 3;

/** Count without rewriting. Same regex, so a preview cannot disagree with an apply. */
export function countRename(text: string, re: RegExp, pairs: readonly RenamePair[]): RenameCount {
  const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const samples: string[] = [];
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = scan.exec(text)) !== null) {
    if (match[0] === '') {
      scan.lastIndex++;
      continue;
    }
    if (replacementFor(match[0], pairs) === null) continue;
    count++;
    if (samples.length < MAX_SAMPLES) {
      const start = Math.max(0, match.index - CONTEXT);
      const end = Math.min(text.length, match.index + match[0].length + CONTEXT);
      samples.push(
        `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`
      );
    }
  }
  return { count, samples };
}

/** Rewrite every string in an array, reporting the total. */
export function applyRenameAll(
  values: readonly string[],
  re: RegExp,
  pairs: readonly RenamePair[]
): { values: string[]; count: number } {
  let count = 0;
  const out = values.map((value) => {
    const result = applyRename(value, re, pairs);
    count += result.count;
    return result.text;
  });
  return { values: out, count };
}
