/**
 * The name generator.
 *
 * The whole feature turns on this file being *deterministic code* rather than a
 * model call, for three reasons that all point the same way:
 *
 *  - Diversity has to be injected at the specification level to survive. A
 *    random seed dropped into a prompt barely reaches the output; drawing the
 *    SHAPE first — which formula, which sound world, which syllable template —
 *    and only then filling it, produces names that differ in construction and
 *    not merely in spelling. So `drawSpec` runs before a single letter is
 *    chosen, and the randomness comes from a PRNG rather than from a softmax
 *    that alignment has already sharpened onto Elara.
 *  - Byte-pair tokenization means a model cannot reliably honour phoneme-level
 *    constraints however firmly it is asked. Here they are array lookups.
 *  - Being pure code, it costs nothing and takes no time, which is what lets
 *    the chapter writer call it as a tool in the middle of a streaming
 *    generation without the author waiting or paying for it.
 *
 * Determinism is per (novel, culture, kind, brief, nonce). The nonce is what
 * makes a second call with identical arguments return a different slate —
 * without it, a model that dislikes what it was offered asks again and is
 * handed the same six names.
 */

import type { BibleEntryType } from '../../lib/types.js';
import { fnv1a, mulberry32 } from '../map/prng.js';
// prng.ts is a leaf module — three pure functions, no imports of its own — so
// reaching into engine/map for it costs nothing. Moving it would touch five map
// files for no behavioural gain.
import { preferredWords, themesFor, type Theme } from './affinity.js';
import { isSlop, normalizeName } from './blocklist.js';
import { eligibleFormulas, type Formula, type NamingPack } from './formulas.js';
import { banksFor, illegalFor, soundWorld, type SoundWorld, type WordBanks } from './lexicons.js';
import { languageLabel, personPool, type PersonPool } from './personNames.js';

export interface Candidate {
  name: string;
  /** How it was built, for the author and for the model. */
  note: string;
  formulaId: string;
  /** The invented words in it, lowercase. Feeds the palette. */
  stems?: string[];
}

export interface SlateRequest {
  novelId: string;
  /** Which culture in the charter this belongs to; part of the seed. */
  cultureId: string;
  soundWorldId: string;
  pack: NamingPack;
  type: BibleEntryType;
  /** The author's or the writer's one-line description. Part of the seed. */
  brief: string;
  count: number;
  /** Every name already used in this novel — bible, designs, map, prose. */
  taken: readonly string[];
  /** Words the author has banned in the charter. */
  banned?: readonly string[];
  /** Distinguishes repeat calls with otherwise identical arguments. */
  nonce?: number;
}

/** Draws before the strict filter is relaxed. */
const STRICT_ATTEMPTS = 400;
/** Draws after. Together these bound the work at a few hundred microseconds. */
const RELAXED_ATTEMPTS = 200;

const ARTICLES = new Set(['the', 'of', 'at', 'a', 'an', 'and']);

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

function weightedPick<T>(rng: () => number, items: readonly T[], weight: (item: T) => number): T {
  let total = 0;
  for (const item of items) total += Math.max(weight(item), 0);
  if (total <= 0) return pick(rng, items);
  let roll = rng() * total;
  for (const item of items) {
    roll -= Math.max(weight(item), 0);
    if (roll <= 0) return item;
  }
  return items[items.length - 1];
}

/** Vowel groups. Approximate, and only ever compared against itself. */
export function syllableCount(word: string): number {
  return (word.toLowerCase().match(/[aeiouy]+/g) ?? []).length || 1;
}

/**
 * The token a name is actually recognised by: longest word, articles dropped.
 * "The Salt Narrows" → "narrows", "[Frost Bolt]" → "frost". Similarity is
 * judged on this rather than on the whole string, because two names sharing a
 * bank word are not the same name, while two sharing a coined stem are.
 */
export function keyToken(name: string): string {
  const words = name
    .replace(/[[\]]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean)
    .filter((w) => !ARTICLES.has(w.toLowerCase()));
  let best = '';
  for (const w of words) if (w.length > best.length) best = w;
  return normalizeName(best || name);
}

/** Standard two-row Levenshtein. Short strings only; no need for anything cleverer. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

interface TakenName {
  flat: string;
  key: string;
  keySyllables: number;
}

function indexTaken(names: readonly string[]): TakenName[] {
  const out: TakenName[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const flat = normalizeName(raw);
    if (!flat || seen.has(flat)) continue;
    seen.add(flat);
    const key = keyToken(raw);
    out.push({ flat, key, keySyllables: syllableCount(key) });
  }
  return out;
}

/**
 * Is this too close to something the novel already has?
 *
 * The rules past exact-match exist for one specific failure: a model asked
 * repeatedly for names in one world fixates, and a cast drifts into Kael, Kaelin,
 * Kalen, Kelric — all distinct strings, all the same name to a reader. Sharing an
 * opening AND a syllable count, or an ending AND a syllable count, is what that
 * drift looks like from the outside.
 */
function tooSimilar(name: string, taken: readonly TakenName[]): boolean {
  const flat = normalizeName(name);
  if (!flat) return true;
  const key = keyToken(name);
  const syllables = syllableCount(key);

  for (const t of taken) {
    if (t.flat === flat) return true;
    // Containment: "Skarr" beside "Skarrholt" reads as a typo, not a second place.
    if (flat.length >= 4 && t.flat.length >= 4 && (flat.includes(t.flat) || t.flat.includes(flat))) {
      return true;
    }
    if (levenshtein(flat, t.flat) <= (flat.length < 6 ? 1 : 2)) return true;

    if (key && t.key) {
      if (key === t.key) return true;
      if (syllables === t.keySyllables) {
        if (key.slice(0, 2) === t.key.slice(0, 2)) return true;
        if (key.length >= 4 && t.key.length >= 4 && key.slice(-3) === t.key.slice(-3)) return true;
      }
      if (levenshtein(key, t.key) <= (key.length < 6 ? 1 : 2)) return true;
    }
  }
  return false;
}

function coinStem(rng: () => number, world: SoundWorld, maxSyllables = 0): string {
  const pool = maxSyllables
    ? world.templates.filter((t) => t.shape.length <= maxSyllables)
    : world.templates;
  const template = weightedPick(rng, pool.length ? pool : world.templates, (t) => t.weight);
  let out = '';
  for (const shape of template.shape) {
    switch (shape) {
      case 'V':
        out += pick(rng, world.nuclei);
        break;
      case 'CV':
        out += pick(rng, world.onsets) + pick(rng, world.nuclei);
        break;
      case 'VC':
        out += pick(rng, world.nuclei) + pick(rng, world.codas);
        break;
      default:
        out += pick(rng, world.onsets) + pick(rng, world.nuclei) + pick(rng, world.codas);
    }
  }
  return out;
}

interface Built {
  name: string;
  note: string;
  /** The coined stems in it, lowercase — what the legality rules are tested on. */
  stems: string[];
  /** The real words in it, so one slate does not use the same one twice. */
  words: string[];
}

/**
 * How often a themed draw takes the themed word. Not 1: a technique about
 * strength called Iron Fist Form every single time is its own kind of
 * collapse, and the whole point of this machinery is not trading one for
 * another.
 */
const THEME_PULL = 0.75;

function build(
  rng: () => number,
  formula: Formula,
  world: SoundWorld,
  banks: WordBanks,
  themes: readonly Theme[],
  /** Real personal names for this culture, or null to coin them instead. */
  pool: PersonPool | null
): Built {
  const parts: string[] = [];
  const stems: string[] = [];
  const words: string[] = [];
  let generic = '';
  let real = false;

  /*
   * A real name goes into `words`, never `stems`, and both halves of that
   * matter. `stems` is what the phonotactic rules are tested on, and holding
   * Nakamura to a made-up language's consonant rules would reject it — the
   * rules exist to keep INVENTED words sayable, and a real name has already
   * passed that test by existing. `words` is what one slate cannot spend twice,
   * which is what stops six candidates all surnamed Vogel.
   */
  const drawReal = (options: readonly string[]): void => {
    const word = pick(rng, options);
    words.push(word);
    parts.push(word);
    real = true;
  };

  for (const slot of formula.slots) {
    switch (slot.kind) {
      case 'given': {
        if (pool) drawReal(pool.given);
        else {
          const stem = coinStem(rng, world);
          stems.push(stem);
          parts.push(capitalize(stem));
        }
        break;
      }
      case 'given-second': {
        if (pool) {
          // "Anna Anna Weber" is the one way a middle name can embarrass
          // itself, and at a few thousand given names it is rare enough to be
          // invisible in testing and certain to reach an author eventually.
          const fresh = pool.given.filter((name) => !parts.includes(name));
          drawReal(fresh.length ? fresh : pool.given);
        } else {
          const stem = coinStem(rng, world);
          stems.push(stem);
          parts.push(capitalize(stem));
        }
        break;
      }
      case 'family': {
        if (pool) drawReal(pool.family);
        else {
          const stem = coinStem(rng, world, 1);
          stems.push(stem);
          parts.push(capitalize(stem));
        }
        break;
      }
      case 'coined': {
        const stem = coinStem(rng, world);
        stems.push(stem);
        parts.push(capitalize(stem));
        break;
      }
      case 'coined-short': {
        const stem = coinStem(rng, world, 1);
        stems.push(stem);
        parts.push(capitalize(stem));
        break;
      }
      case 'bank': {
        /*
         * Two slots can legitimately reach the same word. The banks overlap by
         * design — a world may override `element` with a list that shares an
         * entry with the default `color`, and `faction-element-sect` draws one
         * of each — which produced "Cinnabar Cinnabar Valley". Filtering the
         * pool rather than re-rolling keeps the draw a single call, so a name
         * that never collides is built from exactly the sequence it was before.
         */
        const pool = banks[slot.bank].filter((w) => !parts.includes(w));
        const options = pool.length ? pool : banks[slot.bank];
        const wanted = preferredWords(themes, slot.bank, options);
        const word = wanted.length && rng() < THEME_PULL ? pick(rng, wanted) : pick(rng, options);
        words.push(word);
        parts.push(word);
        break;
      }
      case 'generic': {
        const g = pick(rng, world.generics);
        generic = `“${g.text}”, ${g.gloss}`;
        // Welded on, a generic is part of the word; spaced, it is a noun.
        parts.push(formula.join === '' ? g.text.toLowerCase() : capitalize(g.text));
        break;
      }
      case 'place': {
        const stem = coinStem(rng, world);
        const g = pick(rng, world.generics);
        stems.push(stem);
        generic = `“${g.text}”, ${g.gloss}`;
        parts.push(capitalize(stem) + g.text.toLowerCase());
        break;
      }
      case 'literal':
        parts.push(pick(rng, slot.options));
        break;
    }
  }

  let name = parts.join(formula.join);
  if (formula.wrap) name = `${formula.wrap[0]}${name}${formula.wrap[1]}`;
  // The language is worth saying out loud. It is the one thing about a real
  // name an author cannot read off the name itself, and it is what tells them
  // the whole cast will sound like this rather than only this one person.
  const provenance = generic ? ` — ${generic}` : real && pool ? `, ${languageLabel(pool.language)}` : '';
  return {
    name,
    note: `${formula.gloss}${provenance}`,
    stems,
    words,
  };
}

/**
 * Does every coined stem obey this world's phonotactics, and is the finished
 * name a length a reader will accept?
 *
 * The length ceilings matter more than they look. A four-syllable stem welded
 * to a four-letter generic gives "Daibouwozekawa", which is phonotactically
 * perfect and useless — nobody can hold it, and a reader meeting it in chapter
 * three has to sound it out. Compounds get the tighter budget because both
 * halves are already carrying weight.
 */
function legal(built: Built, illegal: readonly RegExp[], compound: boolean): boolean {
  for (const stem of built.stems) {
    if (stem.length < 3 || stem.length > (compound ? 7 : 8)) return false;
    // Three syllables is the ceiling, not the middle. Past it a reader stops
    // recognising the name and starts sounding it out every time.
    if (syllableCount(stem) > 3) return false;
    for (const rule of illegal) if (rule.test(stem)) return false;
  }
  const flat = normalizeName(built.name);
  if (compound && flat.length > 13) return false;
  return flat.length >= 2 && flat.length <= 40;
}

/**
 * Re-check a name that did not come from `generateSlate` — specifically, one a
 * model returned when it was asked to choose from a slate. This is the point
 * where an LLM that ignored its candidates and answered "Elara" is caught, and
 * without it every filter upstream is advisory.
 */
export function checkName(
  name: string,
  opts: { banned?: readonly string[]; taken?: readonly string[] } = {}
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'the name is empty';
  if (trimmed.length > 60) return 'the name is too long';
  if (isSlop(trimmed)) return 'it is one of the names a language model reaches for by default';
  const flat = normalizeName(trimmed);
  if (!flat) return 'the name has no letters in it';
  for (const word of opts.banned ?? []) {
    const b = normalizeName(word);
    if (b && flat.includes(b)) return `it contains "${word}", which the author has ruled out`;
  }
  if (opts.taken?.length && tooSimilar(trimmed, indexTaken(opts.taken))) {
    return 'this novel already has a name too close to it';
  }
  // Deliberately no phonotactic check here. Those rules are written for COINED
  // stems; a name a model picked may legitimately be built from ordinary English
  // bank words ("Verdigris Shrike"), and half of those break the consonant-run
  // rules a made-up language is held to. Membership in the slate is what keeps a
  // chosen name in register, and that is checked by the caller.
  return null;
}

/**
 * The spec drawn before any letters are chosen. Returned alongside the slate
 * because the tool output quotes it: telling the writer *how* these names are
 * built is what stops it inventing a seventh in a different register.
 */
export interface NameSpec {
  world: SoundWorld;
  pack: NamingPack;
  shape: string;
  register: string;
}

/**
 * The parts the candidates were made of.
 *
 * The first design handed a model finished names and let it pick, which keeps
 * the vocabulary ours but throws away the model's one real advantage: it has
 * read the brief and knows that a technique about crushing strength wants
 * *Stone* rather than *Ochre*. Offering the parts as well lets it assemble —
 * and because every word here comes from our banks or our syllable assembler,
 * a model composing from the palette still cannot reach for Aetherium. It has
 * nothing to reach with.
 */
export interface Palette {
  /** Invented words. Safe to reuse whole, or to blend two of. */
  stems: string[];
  /** Real words the formulas draw on, already slanted towards the brief. */
  words: Array<{ bank: string; options: string[] }>;
  /** Joining and structural words the formulas use: The, of, Form, Sect. */
  structural: string[];
}

export interface Slate {
  spec: NameSpec;
  candidates: Candidate[];
  /** The nearest existing names, for the "do not reuse" line. Capped. */
  nearby: string[];
  palette: Palette;
}

const NEARBY_SHOWN = 12;

/** Existing names to restate in the tool output, so the model does not re-coin one. */
function nearest(taken: readonly string[]): string[] {
  return [...new Set(taken.map((n) => n.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, NEARBY_SHOWN);
}

export function generateSlate(req: SlateRequest): Slate {
  const world = soundWorld(req.soundWorldId);
  const banks = banksFor(world);
  const illegal = illegalFor(world);
  const formulas = eligibleFormulas(req.type, req.pack);
  const count = Math.min(Math.max(Math.round(req.count) || 6, 1), 16);
  /*
   * People only. This is the line between "a reader has to say this out loud"
   * and "this should sound like nowhere on earth", and it is drawn here rather
   * than inside the formulas so that one read of this call answers which kinds
   * of name changed. Seeded on novel and culture alone, so every character in a
   * culture comes from one language and asking twice cannot move the cast.
   */
  const pool = req.type === 'character' ? personPool(req.soundWorldId, req.novelId, req.cultureId) : null;

  const rng = mulberry32(
    fnv1a(
      `naming|${req.novelId}|${req.cultureId}|${req.soundWorldId}|${req.pack}|${req.type}|` +
        `${req.brief.trim().toLowerCase()}|${req.nonce ?? 0}`
    )
  );

  // Read once, before a single letter is chosen — the brief decides which
  // words the formulas reach for, not just which sounds are legal.
  const themes = themesFor(req.brief);
  const takenIndex = indexTaken(req.taken);
  const banned = (req.banned ?? []).map(normalizeName).filter(Boolean);
  const out: Candidate[] = [];
  const chosen: string[] = [];
  const usedFormula = new Map<string, number>();

  const exact = new Set([...takenIndex.map((t) => t.flat)]);
  // Real words already spent by this slate. Two candidates ending in "Guard",
  // or four people surnamed "Winch", are one candidate shown twice — and the
  // character-level similarity rules wave them straight through, because
  // "Gret Guard" and "Hesvem Guard" share no opening and no length.
  const spentWords = new Set<string>();

  const rejected = (built: Built, formula: Formula, strict: boolean): boolean => {
    if (!legal(built, illegal, formula.join === '' || formula.slots.some((s) => s.kind === 'place'))) {
      return true;
    }
    if (isSlop(built.name)) return true;
    const flat = normalizeName(built.name);
    for (const b of banned) if (flat.includes(b)) return true;
    if (exact.has(flat)) return true;
    // Candidates must differ from each other as hard as they differ from canon,
    // or a slate of six is three names and three near-misses.
    if (!strict) return false;
    if (built.words.some((w) => spentWords.has(w))) return true;
    return tooSimilar(built.name, [...takenIndex, ...indexTaken(chosen)]);
  };

  const draw = (strict: boolean, attempts: number): void => {
    for (let i = 0; i < attempts && out.length < count; i++) {
      // Formulas already used this slate are damped, not barred: six candidates
      // that share one construction are one candidate shown six times, which is
      // the collapse this function exists to prevent.
      const formula = weightedPick(
        rng,
        formulas,
        (f) => f.weight / (1 + 2 * (usedFormula.get(f.id) ?? 0))
      );
      const built = build(rng, formula, world, banks, themes, pool);
      if (rejected(built, formula, strict)) continue;
      usedFormula.set(formula.id, (usedFormula.get(formula.id) ?? 0) + 1);
      chosen.push(built.name);
      exact.add(normalizeName(built.name));
      for (const word of built.words) spentWords.add(word);
      out.push({ name: built.name, note: built.note, formulaId: formula.id, stems: built.stems });
    }
  };

  if (formulas.length) {
    draw(true, STRICT_ATTEMPTS);
    // A novel with four hundred names in it will exhaust the strict filter long
    // before it exhausts the sound world. Relaxing to exact-match-only keeps the
    // slate non-empty, which is a promise the tool contract depends on.
    if (out.length < count) draw(false, RELAXED_ATTEMPTS);
  }

  // Last resort: a bare coined stem, unfiltered. Unreachable in practice — it
  // exists so `candidates` is never empty and no caller needs an empty branch.
  if (!out.length) {
    out.push({
      name: capitalize(coinStem(rng, world)),
      note: 'coined stem',
      formulaId: 'fallback',
      stems: [],
    });
  }

  return {
    spec: {
      world,
      pack: req.pack,
      shape: world.shape,
      register: world.blurb,
    },
    candidates: out,
    nearby: nearest(req.taken),
    palette: buildPalette(out, formulas, banks, themes, rng, pool),
  };
}

/** Words per bank offered for recombination. Enough to choose from, few enough to read. */
const PALETTE_PER_BANK = 8;

/** Given names and surnames offered for recombination on a person slate. */
const PALETTE_PERSON = 14;

function buildPalette(
  candidates: readonly Candidate[],
  formulas: readonly Formula[],
  banks: WordBanks,
  themes: readonly Theme[],
  rng: () => number,
  pool: PersonPool | null
): Palette {
  const stems = [...new Set(candidates.flatMap((c) => c.stems ?? []))].map(capitalize);

  const usedBanks = new Set<keyof WordBanks>();
  const structural = new Set<string>(['the', 'of', 'at']);
  for (const formula of formulas) {
    for (const slot of formula.slots) {
      if (slot.kind === 'bank') usedBanks.add(slot.bank);
      if (slot.kind === 'literal') for (const option of slot.options) structural.add(option);
    }
  }

  // Typed to the Palette rather than inferred: the person rows appended below
  // are labelled by language ("German family names"), not by word bank.
  const words: Palette['words'] = [...usedBanks].map((bank) => {
    // Themed words first — they are why the model would recombine at all — then
    // a sample of the rest so it is choosing rather than being told.
    const wanted = preferredWords(themes, bank, banks[bank]);
    const rest = banks[bank].filter((w) => !wanted.includes(w));
    const filler: string[] = [];
    const pool = [...rest];
    while (filler.length < Math.max(0, PALETTE_PER_BANK - wanted.length) && pool.length) {
      filler.push(...pool.splice(Math.floor(rng() * pool.length), 1));
    }
    return { bank, options: [...wanted.slice(0, PALETTE_PER_BANK), ...filler] };
  });

  /*
   * On a person slate the palette would otherwise be nearly empty — real names
   * are not coined stems and not bank words, so neither list picks them up, and
   * the model would be left able to pick a candidate but not to build one.
   * Handing it the pool restores the thing this palette exists for: it has read
   * the brief and can tell that the quiet archivist is a Wilhelmina rather than
   * a Bree, which the generator could only guess at.
   */
  if (pool) {
    const sample = (from: readonly string[]): string[] => {
      const options: string[] = [];
      const rest = [...from];
      while (options.length < Math.min(PALETTE_PERSON, from.length) && rest.length) {
        options.push(...rest.splice(Math.floor(rng() * rest.length), 1));
      }
      return options;
    };
    words.push({ bank: `${languageLabel(pool.language)} given names`, options: sample(pool.given) });
    words.push({ bank: `${languageLabel(pool.language)} family names`, options: sample(pool.family) });
  }

  return { stems, words, structural: [...structural] };
}

/**
 * Three names that demonstrate a culture's register, stable for the life of the
 * novel. Used in the cached system prompt: showing the shape is worth more than
 * describing it, and seeding off the novel id keeps the cache prefix byte-stable
 * across every chapter.
 */
export function sampleNames(
  novelId: string,
  cultureId: string,
  soundWorldId: string,
  pack: NamingPack
): string[] {
  const { candidates } = generateSlate({
    novelId,
    cultureId,
    soundWorldId,
    pack,
    type: 'character',
    brief: 'sample',
    count: 3,
    taken: [],
  });
  return candidates.map((c) => c.name);
}
