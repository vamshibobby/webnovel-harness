/**
 * What is wrong with this chapter, in counted terms.
 *
 * Detection here is deterministic on purpose. A model asked to find its own
 * stylistic tics grades itself kindly and rewrites whatever it happens to
 * notice; the same model handed "14 long dashes, a chapter this length should
 * have at most 4, here are the lines" has nothing to negotiate about. It also
 * means the repair can be verified: running this again afterwards says exactly
 * which defects closed, which is what lets the loop stop on evidence rather than
 * on the model announcing it is finished.
 *
 * Only the detectors that measurably worked in `research/eval` ship here.
 * Several that seemed obvious did not survive measurement and were deliberately
 * left out:
 *
 *   broken turns    the repair pass drove these from 11.4% to 2.0% against a
 *                   human 8.1%, i.e. it made the prose less human while
 *                   "fixing" it.
 *   frame variety   generated prose reuses sentence-opening shapes far more than
 *                   human prose, but four separate rewriting attempts failed to
 *                   move it. It responds to decoding parameters (min_p), not to
 *                   editing, so it is not a repair job.
 *   scene/summary   an LLM scout for this made the difference worse, not better.
 *
 * Shipping the rules that work and omitting the ones that do not is the whole
 * value of having measured them.
 */
import {
  hasQuote,
  outsideQuotes,
  paragraphs,
  quotes,
  sentences,
  words,
} from './text.js';
import {
  BANDS,
  LENGTH_BAND,
  MIN_TURNS_FOR_DIALOGUE_BANDS,
  MIN_WORDS_TO_DIAGNOSE,
  type Band,
} from './bands.js';

export type DefectKind =
  | 'preamble'
  | 'heading'
  | 'emDash'
  | 'thematicClose'
  | 'dialogueCoda'
  | 'thinDialogue'
  | 'lowDialogue'
  | 'short';

export interface Defect {
  kind: DefectKind;
  /** What the chapter does now, in the metric's own units. */
  observed: number;
  /** The range a human writer occupies. */
  band?: Band;
  /** The instruction handed to the repair model. */
  instruction: string;
  /** Verbatim offending lines, so the model edits rather than hunts. */
  examples: string[];
}

export interface Diagnosis {
  defects: Defect[];
  words: number;
  /** Proper nouns before any rewrite, so invented names can be caught after. */
  properNouns: string[];
}

const LONG_DASH = /[–—―]|(?<!-)--(?!-)/g;

/** The product's own title contract, from routes/chapters.ts. */
const PRODUCT_TITLE = /^#*\s*chapter\s+\d+\s*[:—-]\s*(.+)$/i;
/** Tolerant: also matches the **bold** and # forms models actually emit. */
const ANY_HEADING = /^\s*(?:\*{1,3}|#{1,4}|_{1,2})?\s*chapter\s+\d+\s*[:—-]\s*(.+?)\s*(?:\*{1,3}|_{1,2})?\s*$/i;

/** Nouns with no picture in them: the material of a thematic closing line. */
const ABSTRACT =
  /\b(fate|destiny|truth|silence|darkness|light|hope|fear|doubt|memory|memories|future|past|change|beginning|end|world|life|death|power|meaning|purpose|choice|price|cost|weight|shadow|promise|secret|question|answer|understanding|knowledge)\b/i;

const FINITE = /\b(is|are|was|were|will|can|could|would|have|has|had|do|does|did|'s|'re|'ll|'ve|'d|n't)\b/i;

export interface HeadingInfo {
  /** Title the product would extract, or null if it would fall back. */
  title: string | null;
  headingLine: number;
  preambleWords: number;
  style: 'plain' | 'hash' | 'bold' | 'none';
}

export function analyseHeading(content: string): HeadingInfo {
  const lines = content.split('\n');
  const firstNonEmpty = lines.find((l) => l.trim().length > 0) ?? '';
  const productMatch = firstNonEmpty.match(PRODUCT_TITLE);

  let headingLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (ANY_HEADING.test(lines[i])) {
      headingLine = i;
      break;
    }
  }

  const preambleWords =
    headingLine > 0
      ? lines
          .slice(0, headingLine)
          .join(' ')
          .split(/\s+/)
          .filter((w) => /[A-Za-z0-9]/.test(w)).length
      : 0;

  const raw = headingLine >= 0 ? lines[headingLine].trim() : '';
  const style = headingLine < 0 ? 'none' : raw.startsWith('**') ? 'bold' : raw.startsWith('#') ? 'hash' : 'plain';

  return { title: productMatch ? productMatch[1].trim() : null, headingLine, preambleWords, style };
}

/** Quoted turns whose final sentence is a short summarising fragment. */
function codaTurns(turns: string[], limit = 6): string[] {
  const out: string[] = [];
  for (const turn of turns) {
    const ss = sentences(turn);
    if (ss.length < 2) continue;
    const last = ss[ss.length - 1];
    if (words(last).length <= 8 && !FINITE.test(last)) out.push(turn);
    if (out.length >= limit) break;
  }
  return out;
}

const pct = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
const r2 = (n: number): number => Math.round(n * 100) / 100;

export function diagnose(content: string, targetWords = 0): Diagnosis {
  const paras = paragraphs(content);
  const turns = quotes(content);
  const total = words(content).length;
  const defects: Defect[] = [];
  const heading = analyseHeading(content);

  if (total < MIN_WORDS_TO_DIAGNOSE) {
    return { defects, words: total, properNouns: [] };
  }

  // ── format ────────────────────────────────────────────────────────────────
  if (heading.preambleWords > 0) {
    defects.push({
      kind: 'preamble',
      observed: heading.preambleWords,
      instruction:
        `Delete the ${heading.preambleWords} words of commentary before the chapter heading. ` +
        `The chapter must begin with the heading line itself.`,
      examples: content.split('\n').slice(0, Math.max(heading.headingLine, 1)).filter((l) => l.trim()),
    });
  }

  if (heading.style !== 'plain' || heading.title === null) {
    defects.push({
      kind: 'heading',
      observed: 0,
      instruction:
        'The heading must be plain text on its own first line, exactly "Chapter N: Title". No ' +
        'asterisks, no #, no bold, no quotation marks, and no horizontal rule beneath it.',
      examples: heading.headingLine >= 0 ? [content.split('\n')[heading.headingLine]] : [],
    });
  }

  // ── tells, two-sided ──────────────────────────────────────────────────────
  const dashCount = (content.match(LONG_DASH) ?? []).length;
  const dashRate = (dashCount / total) * 1000;
  if (dashRate > BANDS.emDash.hi) {
    // A budget, not zero: the reference uses some, and prose with a mark
    // surgically absent reads as oddly as prose overusing it.
    const budget = Math.max(1, Math.round((BANDS.emDash.target * total) / 1000));
    defects.push({
      kind: 'emDash',
      observed: r2(dashRate),
      band: BANDS.emDash,
      instruction:
        `This chapter uses ${dashCount} long dashes, about ${r2(dashRate)} per thousand words. A ` +
        `chapter this length should use around ${budget}. Rewrite the lines below so at most ` +
        `${budget} remain, joining the clauses with a full stop, a comma or a semicolon instead. ` +
        `Keep the wording otherwise.`,
      examples: paras
        .flatMap((p) => sentences(p))
        .filter((s) => LONG_DASH.test(s))
        .slice(0, 8),
    });
    LONG_DASH.lastIndex = 0;
  }

  const lastPara = paras[paras.length - 1] ?? '';
  const lastSentences = sentences(lastPara);
  const finalSentence = lastSentences[lastSentences.length - 1] ?? '';
  if (lastSentences.length === 1 && ABSTRACT.test(finalSentence)) {
    defects.push({
      kind: 'thematicClose',
      observed: 1,
      instruction:
        'The chapter ends on a line that explains what it all meant. Cut that line. End instead on ' +
        'the last thing that actually happens: a line of speech, an action, or something noticed.',
      examples: paras.slice(-2),
    });
  }

  // ── dialogue, two-sided ───────────────────────────────────────────────────
  if (turns.length >= MIN_TURNS_FOR_DIALOGUE_BANDS) {
    const codas = codaTurns(turns);
    const codaPct = pct(codas.length, turns.length);
    if (codaPct > BANDS.dialogueCoda.hi && codas.length > 0) {
      defects.push({
        kind: 'dialogueCoda',
        observed: codaPct,
        band: BANDS.dialogueCoda,
        instruction:
          'These spoken lines make their point and then add a tidy summarising tail. Cut the tail on ' +
          'about half of them. Real speech does this occasionally, so do not remove every instance: ' +
          'when a character has made their point they usually just stop, or somebody cuts in.',
        examples: codas,
      });
    }

    const turnWords = words(turns.join(' ')).length / turns.length;
    if (turnWords < BANDS.turnWords.lo) {
      defects.push({
        kind: 'thinDialogue',
        observed: r2(turnWords),
        band: BANDS.turnWords,
        instruction:
          `Spoken turns average ${r2(turnWords)} words. In comparable published fiction they run ` +
          `nearer ${BANDS.turnWords.target}. The dialogue is clipped: people answer in fragments ` +
          `where they would speak a sentence or two. Let the important turns run longer, so a ` +
          `character finishes a thought, gives a reason, or digresses once. Keep the short ones ` +
          `short — an exchange where every turn is the same length is its own problem. Do not add ` +
          `new information or new events.`,
        examples: turns.slice(0, 6),
      });
    }

    const dialogueShare = pct(words(turns.join(' ')).length, total);
    if (dialogueShare < BANDS.dialogueShare.lo) {
      defects.push({
        kind: 'lowDialogue',
        observed: dialogueShare,
        band: BANDS.dialogueShare,
        instruction:
          `Only ${dialogueShare}% of this chapter is spoken words, against nearer ` +
          `${BANDS.dialogueShare.target}% in comparable fiction. Where characters are already in the ` +
          `room together and an exchange is reported as narration, play it as conversation instead. ` +
          `Do not invent new scenes or new characters.`,
        examples: paras.filter((p) => !hasQuote(p) && words(p).length > 40).slice(0, 3),
      });
    }
  }

  // ── length ────────────────────────────────────────────────────────────────
  if (targetWords > 0 && total < targetWords * LENGTH_BAND.lo) {
    defects.push({
      kind: 'short',
      observed: total,
      instruction:
        `The chapter runs ${total} words against a target of about ${targetWords}. Let the existing ` +
        `scenes breathe rather than adding new events: more of what people do while they talk, more ` +
        `of what the viewpoint character notices. Do not introduce new plot.`,
      examples: [],
    });
  }

  return { defects, words: total, properNouns: properNounSet(content) };
}

/**
 * Capitalised words that are not sentence-initial, with possessives stripped.
 * Used only to check the repair did not invent names, so a few misses are
 * tolerable and a false alarm is not.
 */
const NOT_A_NAME = new Set([
  'i', 'a', 'an', 'the', 'and', 'but', 'or', 'so', 'if', 'as', 'at', 'by', 'in', 'of', 'on', 'to',
  'it', 'he', 'she', 'they', 'we', 'you', 'his', 'her', 'their', 'this', 'that', 'there', 'then',
  'when', 'what', 'who', 'why', 'how', 'no', 'not', 'yes', 'oh', 'well', 'now', 'here', 'one',
]);

export function properNounSet(text: string): string[] {
  const found = new Set<string>();
  for (const sentence of sentences(text)) {
    const toks = sentence.split(/\s+/);
    let atStart = true;
    for (const rawTok of toks) {
      const tok = rawTok.replace(/^[^A-Za-z]+/, '').replace(/[^A-Za-z-]+$/, '').replace(/'s$/i, '');
      if (!tok) continue;
      if (!atStart && /^[A-Z][a-z'-]+$/.test(tok) && !NOT_A_NAME.has(tok.toLowerCase())) {
        found.add(tok.toLowerCase());
      }
      atStart = false;
    }
  }
  return [...found];
}

/** The defect list as the repair model sees it. */
export function formatDiagnosis(d: Diagnosis): string {
  return d.defects
    .map((def, i) => {
      const lines = [`${i + 1}. ${def.instruction}`];
      if (def.examples.length) {
        lines.push('   Lines to fix:');
        for (const ex of def.examples) lines.push(`   > ${ex.replace(/\s+/g, ' ').slice(0, 220)}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}
