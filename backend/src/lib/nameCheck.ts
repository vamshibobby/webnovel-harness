/**
 * Is this capitalised word an invented proper noun, or just English?
 *
 * The question sounds small and it destroyed real work. The first checker
 * flagged every non-sentence-initial `[A-Z][a-z]+` the author did not own, so
 * "the audit lands on Monday" invented a character called Monday, and after
 * three rounds of a model failing to write English without capital letters,
 * runArcRefine threw away a finished premise and forty beats.
 *
 * The asymmetry that decides every rule in this file: a false NEGATIVE costs
 * one review row in the cast pass, where the author confirms or renames it in
 * a click; a false POSITIVE cost the author an entire refine. So the checker
 * is generous by design, and anything it is unsure about is not a name.
 *
 * Four filters, applied to each candidate word:
 *   1. the known set — every token the author owns (bible, designs, title,
 *      their own premise text);
 *   2. a stopword floor — weekdays, months, holidays, honorifics, and the
 *      generic capitalised nouns of business and place;
 *   3. morphology — "Meridian" is not an invention when the author wrote
 *      "meridia"; stems are matched both ways;
 *   4. the author's own casing — a word the author wrote lowercase anywhere
 *      ("retail and advice divisions") is English when the model capitalises
 *      it ("the Retail Division"). Built from the AUTHOR'S text only, never
 *      model output, so a refine cannot launder its own inventions into the
 *      whitelist.
 */
import type { BibleEntry, CharacterDesign, Novel } from './types.js';

/** Capitalised words that name nothing the author would have to invent. */
export const NAME_STOPWORDS: ReadonlySet<string> = new Set([
  // Weekdays and months. "The audit lands on Monday" is scheduling, not casting.
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december',
  // Holidays and season markers that arrive capitalised.
  'christmas', 'easter', 'eve', 'new', 'year', 'thanksgiving', 'midsummer', 'solstice',
  // Honorifics: "Mr Refsdal" flags Refsdal, never Mr.
  'mr', 'mrs', 'ms', 'dr', 'sir', 'madam', 'lord', 'lady', 'saint', 'st',
  // The generic nouns of an org chart. "the Retail Division" names no one.
  'division', 'department', 'board', 'team', 'group', 'section', 'company',
  'council', 'office', 'committee', 'bank', 'court', 'house', 'guild',
  'ministry', 'bureau', 'agency', 'firm', 'union',
  // Rank words that get capitalised next to a name or alone.
  'head', 'manager', 'director', 'chief', 'officer', 'president', 'chairman',
  'captain', 'general', 'sergeant', 'professor', 'doctor', 'master', 'elder',
  // Places-in-general and compass points.
  'north', 'south', 'east', 'west', 'street', 'avenue', 'road', 'square',
  'city', 'town', 'district', 'quarter', 'harbour', 'harbor', 'port',
  // Sentence furniture that survives the sentence-initial exemption when the
  // model writes headers, colons or bracketed tags mid-line. No English
  // function word is ever the name of a character.
  'the', 'a', 'an', 'and', 'but', 'or', 'chapter', 'day', 'act', 'part', 'book',
  'in', 'at', 'on', 'by', 'of', 'to', 'for', 'as', 'it', 'he', 'she', 'they',
  'we', 'his', 'her', 'its', 'their', 'this', 'that', 'these', 'those', 'there',
  'here', 'then', 'now', 'once', 'while', 'during', 'after', 'before', 'over',
  'under', 'when', 'where', 'with', 'from', 'until', 'meanwhile', 'later',
]);

export interface KnownNames {
  /** Every token the author owns, lowercased. */
  tokens: Set<string>;
  /** Stems of those tokens, for morphology matching. */
  stems: Set<string>;
  /** Every word of the AUTHOR'S own text, lowercased, any original casing. */
  authorWords: Set<string>;
}

/**
 * Every crude stem of a word: the word itself, plus each demonym-ish suffix
 * stripped when what remains is still word-sized. ALL candidates, not the
 * first match — "Meridian" minus "-n" is "meridia" but minus "-ian" is
 * "merid", and which one meets the author's "meridia" depends on the word, so
 * both sides offer everything and any overlap is a match. Crude is the point:
 * a stemmer that knows English would miss invented geography, which is most
 * of what novels have.
 */
export function stemsOf(word: string): string[] {
  const w = word.toLowerCase();
  const out = [w];
  for (const suffix of ['ians', 'ian', 'ese', 'ish', 'ans', 'an', 'ic', 'en', 'n', 'a', 's']) {
    if (w.length - suffix.length >= 5 && w.endsWith(suffix)) out.push(w.slice(0, -suffix.length));
  }
  return out;
}

function addTokens(into: Set<string>, text: string): void {
  for (const word of text.split(/[^A-Za-z'’]+/)) {
    if (word.length > 2) into.add(word.toLowerCase());
  }
}

export function buildKnownNames(sources: {
  bibleEntries: readonly BibleEntry[];
  designs: readonly CharacterDesign[];
  novel: Pick<Novel, 'title' | 'premise' | 'styleNotes'>;
  /**
   * The author's words only — their arc premise as THEY wrote it, never a
   * premise a model has rewritten. This set powers the casing heuristic, so
   * feeding it model text would let a refine approve its own inventions.
   */
  authorText?: string;
}): KnownNames {
  const tokens = new Set<string>();
  for (const entry of sources.bibleEntries) {
    addTokens(tokens, entry.name);
    for (const alias of entry.aliases) addTokens(tokens, alias);
  }
  for (const design of sources.designs) addTokens(tokens, design.name);
  addTokens(tokens, `${sources.novel.title} ${sources.novel.premise} ${sources.novel.styleNotes}`);
  if (sources.authorText) addTokens(tokens, sources.authorText);

  const stems = new Set<string>();
  for (const t of tokens) for (const s of stemsOf(t)) stems.add(s);

  const authorWords = new Set<string>();
  const authorText = `${sources.novel.premise} ${sources.novel.styleNotes} ${sources.authorText ?? ''}`;
  for (const word of authorText.split(/[^A-Za-z'’]+/)) {
    if (word.length > 2) authorWords.add(word.toLowerCase());
  }
  return { tokens, stems, authorWords };
}

/** The compatibility shape: a bare token set, no author text, no casing rule. */
export function knownFromTokens(tokens: Set<string>): KnownNames {
  const stems = new Set<string>();
  for (const t of tokens) for (const s of stemsOf(t)) stems.add(s);
  return { tokens, stems, authorWords: new Set() };
}

/** True when `word` is plainly not an invented proper noun. */
export function isKnownOrOrdinary(word: string, known: KnownNames): boolean {
  const w = word.toLowerCase();
  if (known.tokens.has(w)) return true;
  if (NAME_STOPWORDS.has(w)) return true;
  if (stemsOf(w).some((s) => known.stems.has(s))) return true;
  if (known.authorWords.has(w)) return true;
  return false;
}

/**
 * The capitalised words of `text` that look like inventions.
 *
 * The mechanical rules are inherited from the first version and are still
 * right: the first word of a sentence is capitalised by grammar and exempt,
 * possessives are stripped, and hyphen-attached capitals ("Six-year-old") are
 * grammar too. What is new is everything `isKnownOrOrdinary` clears.
 */
export function newNamesInText(text: string, known: KnownNames): string[] {
  const found = new Set<string>();
  for (const raw of text.split(/(?<=[.!?])\s+/)) {
    // A beat opens with its thread tag — "[7 · Mira] At preschool…" — and the
    // tag broke the sentence-initial exemption: "first word" computed as "[7"
    // left "At" looking mid-sentence, and a real refine was flagged for the
    // names "In" and "At". The sentence starts after the bracket.
    const sentence = raw.replace(/^\s*\[[^\]]*\]\s*/, '');
    const first = sentence.trim().split(/\s+/)[0]?.replace(/[^A-Za-z'’]/g, '');
    for (const raw of sentence.match(/(?<!-)\b[A-Z][a-z]+(?:['’]s)?\b(?!-)/g) ?? []) {
      if (raw === first) continue;
      const bare = raw.replace(/['’]s$/, '');
      if (isKnownOrOrdinary(bare, known)) continue;
      found.add(bare);
    }
  }
  return [...found];
}
