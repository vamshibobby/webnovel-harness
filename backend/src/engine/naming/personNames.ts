/**
 * Real given names and surnames, for people only.
 *
 * ── Why this exists ──
 *
 * The coiner assembles names from a sound world's syllables, and for a sect, a
 * sword or a mountain range that is exactly right — those SHOULD be invented,
 * and an invented one carries the world's register in a way a borrowed one
 * cannot. For a person it failed, and the failure was legible the moment an
 * author looked at a cast list: Grestayn the Falcon, Fler Pucloll, Beap Veff,
 * Trosh the Mantis. Phonotactically perfect, unpronounceable, and nothing a
 * reader can hold in their head for forty chapters.
 *
 * A reader meets a person and has to be able to say their name. That is a
 * different constraint from every other kind of name in this app, and it is not
 * one syllable assembly can satisfy — real names are not random draws from a
 * phoneme inventory, they are the few thousand that survived centuries of being
 * said out loud. So people get the survivors, and everything else keeps the
 * coiner. `slotsFor` in formulas.ts is where that line is drawn.
 *
 * ── Why the corpus is committed rather than fetched ──
 *
 * `generateSlate` is called as a TOOL, synchronously, in the middle of a
 * streaming chapter generation — the generator's own header calls that out as
 * the reason it is code and not a model call. A GCS read would put a network
 * round trip, a cold-start penalty and a new failure mode inside that path, in
 * exchange for the ability to change names without a deploy, which is not
 * something anyone needs to do. The file is a few hundred kilobytes, it ships
 * in the Cloud Run image, it is versioned and reviewable with the code that
 * reads it, and the offline test rule keeps working. Rebuild it with
 * `npx tsx scripts/buildNameCorpus.ts`.
 *
 * ── The coherence rule ──
 *
 * A sound world maps to a GROUP of languages, and one language is drawn per
 * novel-and-culture — never per name. Drawing per name gives a cast of Anders,
 * Nakamura, Dubois and Kowalski, which is not a book. Drawing per culture gives
 * a cast that sounds like it comes from one place, and an author who wants two
 * places has a second culture in the charter, which is what cultures are for.
 */
import { readFileSync } from 'node:fs';
import { fnv1a, mulberry32 } from '../map/prng.js';

interface Corpus {
  version: number;
  license: string;
  source: string;
  /** soundWorldId → the language codes it may draw from. */
  groups: Record<string, string[]>;
  given: Record<string, string[]>;
  family: Record<string, string[]>;
}

/*
 * Read once at module load, relative to this file rather than to the working
 * directory, so the same line works under tsx from src/ and under node from
 * dist/. Deliberately not a JSON `import`: that would make tsc type-infer a
 * megabyte of string literals on every build, and would put the file's presence
 * in dist at the mercy of whether the compiler feels like emitting it. The
 * build script copies it explicitly, beside the map vendor bundle.
 */
const DATA: Corpus = JSON.parse(
  readFileSync(new URL('./data/personNames.json', import.meta.url), 'utf8')
) as Corpus;

export interface PersonPool {
  /** ISO 639-1, for the note beside a candidate. */
  language: string;
  given: readonly string[];
  family: readonly string[];
}

/** Language codes to something an author reading a slate would recognise. */
const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English', de: 'German', nl: 'Dutch', sv: 'Swedish', no: 'Norwegian',
  da: 'Danish', is: 'Icelandic', fr: 'French', es: 'Spanish', it: 'Italian',
  pt: 'Portuguese', ca: 'Catalan', ro: 'Romanian', zh: 'Chinese', ko: 'Korean',
  ja: 'Japanese', ar: 'Arabic', fa: 'Persian', tr: 'Turkish', he: 'Hebrew',
  ur: 'Urdu', az: 'Azerbaijani', ga: 'Irish', gd: 'Scottish Gaelic',
  cy: 'Welsh', br: 'Breton',
};

export function languageLabel(code: string): string {
  return LANGUAGE_LABELS[code] ?? code;
}

/**
 * The pool this novel's culture draws people from, or null when the world has
 * none and the coiner should be used instead.
 *
 * Null is a real answer, not a failure: 'void' names machines and constructs,
 * and a war-drone called Dave is a joke. It is also what a corpus that failed
 * to build degrades to, which is why every caller has to handle it — a missing
 * data file should cost pronounceable names, never the naming feature.
 *
 * Seeded on novel + culture only. Not the entity, not the brief, not the nonce:
 * asking twice for a name must not move the whole cast to a different country.
 */
export function personPool(soundWorldId: string, novelId: string, cultureId: string): PersonPool | null {
  const languages = DATA.groups[soundWorldId];
  if (!languages?.length) return null;
  const rng = mulberry32(fnv1a(`person-language|${novelId}|${cultureId}|${soundWorldId}`));
  const language = languages[Math.floor(rng() * languages.length)] ?? languages[0];
  const given = DATA.given[language];
  const family = DATA.family[language];
  if (!given?.length || !family?.length) return null;
  return { language, given, family };
}

/** Every language the corpus actually shipped with, for the charter UI and tests. */
export function corpusLanguages(): string[] {
  return [...new Set(Object.values(DATA.groups).flat())].sort();
}

export function corpusStats(): { languages: number; given: number; family: number } {
  const languages = corpusLanguages();
  return {
    languages: languages.length,
    given: languages.reduce((n, l) => n + (DATA.given[l]?.length ?? 0), 0),
    family: languages.reduce((n, l) => n + (DATA.family[l]?.length ?? 0), 0),
  };
}
