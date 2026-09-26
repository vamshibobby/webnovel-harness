/**
 * Build the person-name corpus: npx tsx scripts/buildNameCorpus.ts
 *
 * Run by hand, rarely. The output is committed, and the committed file is what
 * ships — nothing fetches at runtime. See the note in personNames.ts for why.
 *
 * ── Where the names come from ──
 *
 * Wikidata, over its public SPARQL endpoint. Its name items are **CC0** — no
 * attribution required, no share-alike, usable commercially — which is the
 * reason it was chosen over the obvious alternatives. The scrapeable
 * name-frequency datasets floating around github are mostly lifted from social
 * networks with no licence at all, and a novel-writing product cannot ship a
 * corpus it has no right to.
 *
 * The label taken is always the ENGLISH one, which is what makes Japanese,
 * Korean, Chinese, Arabic and Hebrew names usable here at all: Wikidata's en
 * label for 佐藤 is "Satō". The transliteration is done, by people, and we
 * inherit it rather than attempting our own.
 *
 * ── The two halves are fetched differently, and that is not an accident ──
 *
 * GIVEN names come from the name items themselves: P31/P279* → Q202444, tagged
 * with P407 (language of work or name). One query returns ~50k rows across every
 * language at once.
 *
 * FAMILY names cannot be fetched that way, and the first version of this script
 * shipped believing they could. Surname items on Wikidata are barely tagged —
 * P407 on Q101352 returns 3.3k rows of which 3k are Turkish, and the native-label
 * fallback is 5.6k rows tagged "mul". The language simply is not on the item.
 *
 * So surnames are derived from PEOPLE instead: humans (Q5) with a country of
 * citizenship (P27) and a family name (P734). That reads the language off
 * something Wikidata does record exhaustively, and it has a property no
 * name-list has — the surnames that come back are the ones borne by people
 * notable enough to be written about, which is a rough frequency filter for
 * free. Japan alone yields 7.6k: Yoshida, Inoue, Suzuki, Kobayashi.
 *
 * ── What is thrown away, and why ──
 *
 * Diacritics are folded to ASCII. This is not cosmetic. Four separate things in
 * this app find and rewrite names with `[A-Za-z]` character classes —
 * `newNamesInText`, the cast pass's completeness net, `compileRename`, and the
 * bible's name matching — and a name outside that class is invisible to all of
 * them. "José" would be planned, never detected, and never renameable. "Jose"
 * works everywhere.
 *
 * Multi-word entries ("Marie-José", "John Paul") go too: the formulas compose
 * given + family themselves, and a two-word given name inside a two-slot
 * formula produces a four-word person.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSlop } from '../src/engine/naming/blocklist.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'src', 'engine', 'naming', 'data', 'personNames.json');

/**
 * Raw responses are cached on disk, keyed by the query text.
 *
 * Not an optimisation — a working condition. A full fetch is tens of minutes
 * against a free endpoint, and every time the filters were tightened (the ASCII
 * fold, the two-character floor for Chinese and Korean surnames) the whole
 * thing had to run again to change one regex. With the cache, re-running after
 * a filter change costs seconds. Delete the directory to force a real refetch.
 */
const CACHE = join(tmpdir(), 'webnovel-harness-name-corpus-cache');

const ENDPOINT = 'https://query.wikidata.org/sparql';
/** Wikidata asks for a real one, and rate-limits harder without it. */
const AGENT = 'webnovel-harness-name-corpus/1.0 (https://github.com/vamshibobby/webnovel-harness)';

/**
 * The languages we take, grouped the way the sound worlds are.
 *
 * A group is a naming REGISTER, not a nation: what matters is that two names
 * drawn from the same group sit beside each other without one of them looking
 * like a mistake. "Anders Vogel" reads; "Anders Nakamura" reads as a different
 * book. Each novel-and-culture then draws from ONE of its group's languages —
 * see pickLanguage in personNames.ts — so a cast is coherent rather than a
 * United Nations delegation.
 */
const GROUPS: Record<string, string[]> = {
  // Germanic and Nordic. The default world, and the one most western fantasy
  // already sounds like.
  northern: ['en', 'de', 'nl', 'sv', 'no', 'da', 'is'],
  // Romance.
  meridian: ['fr', 'es', 'it', 'pt', 'ca', 'ro'],
  // Chinese, plus Korean: both are family-name-first registers with short
  // syllables, and they sit together far better than either sits with Japanese.
  cloudsea: ['zh', 'ko'],
  // Japanese on its own, for the same reason.
  'island-court': ['ja'],
  // West and Central Asian.
  sandsea: ['ar', 'fa', 'tr', 'he', 'ur', 'az'],
  // Celtic. The softest real register there is, which is what Sylvan wants —
  // and the closest thing to elvish that actual people are actually called.
  sylvan: ['ga', 'gd', 'cy', 'br'],
  // Industrial. English and German surnames are where trade names live
  // (Fletcher, Wagner, Schumacher), so it shares northern's languages.
  foundry: ['en', 'de'],
  // 'void' is deliberately absent. It names machines and constructs, and a
  // machine called Dave is a joke rather than a name. It keeps the coiner.
};

const LANGUAGES = [...new Set(Object.values(GROUPS).flat())].sort();

/**
 * Where each language's surnames are read from: countries of citizenship.
 *
 * A proxy, and a deliberate one — see the header. Several languages take more
 * than one country because one country is not the language: Spanish surnames
 * live in Mexico and Argentina as much as in Spain, and Arabic is spread across
 * every country that speaks it. Where a language has no state of its own the
 * nearest constituent country is used, which is why Welsh and Scottish Gaelic
 * point at Wales and Scotland rather than at the UK.
 */
const SURNAME_COUNTRIES: Record<string, string[]> = {
  /*
   * Six countries, and the small ones are not padding. Britain and the United
   * States are the two largest human sets on Wikidata and the two most likely
   * to answer a 504 — Ireland, New Zealand, Australia and Canada return in
   * seconds and carry the same surnames, so English survives its big countries
   * failing. Ireland is fetched for Irish anyway, so it is free here.
   */
  en: ['Q145', 'Q30', 'Q408', 'Q16', 'Q27', 'Q664'],
  de: ['Q183', 'Q40', 'Q39'],               // Germany, Austria, Switzerland
  nl: ['Q55', 'Q31'],                       // Netherlands, Belgium
  sv: ['Q34'],
  no: ['Q20'],
  da: ['Q35'],
  is: ['Q189'],
  fr: ['Q142'],
  es: ['Q29', 'Q96', 'Q414', 'Q298'],       // Spain, Mexico, Argentina, Chile
  it: ['Q38'],
  pt: ['Q45', 'Q155'],                      // Portugal, Brazil
  ca: ['Q29'],
  ro: ['Q218'],
  zh: ['Q148', 'Q865'],                     // China, Taiwan
  ko: ['Q884'],
  ja: ['Q17'],
  ar: ['Q79', 'Q851', 'Q822', 'Q1028'],     // Egypt, Saudi Arabia, Lebanon, Morocco
  fa: ['Q794'],
  tr: ['Q43'],
  he: ['Q801'],
  ur: ['Q843'],
  az: ['Q227'],
  ga: ['Q27'],
  gd: ['Q22'],
  cy: ['Q25'],
  br: ['Q142'],
};

/**
 * Rows as `[first column, rest of line]`.
 *
 * Split on the FIRST comma only. The left column is always a language code or a
 * label, never something containing a comma, and a label that does contain one
 * arrives quoted — it is multi-word and dropped downstream either way, but
 * splitting on every comma would misalign the row rather than discard it.
 */
function parseCsv(text: string): string[][] {
  return text
    .split('\n')
    .slice(1)
    .map((line) => {
      const trimmed = line.trim();
      const at = trimmed.indexOf(',');
      return at === -1 ? [trimmed] : [trimmed.slice(0, at), trimmed.slice(at + 1)];
    })
    .filter((row) => row[0]);
}

async function fetchCsv(queryText: string): Promise<string> {
  const key = join(CACHE, `${createHash('sha1').update(queryText).digest('hex')}.csv`);
  if (existsSync(key)) return readFileSync(key, 'utf8');

  /*
   * Wikidata's public endpoint enforces a 60-second query timeout of its own,
   * so a request that is going to fail fails quickly and a longer client
   * timeout only delays the retry. Two minutes is generous headroom for
   * transfer of a fifty-thousand-row result, not for the query.
   */
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${ENDPOINT}?query=${encodeURIComponent(queryText)}`, {
        headers: { Accept: 'text/csv', 'User-Agent': AGENT },
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      /*
       * An empty result is never cached. Wikidata answers a query it could not
       * finish with a 200 and a header row and nothing else, which is
       * indistinguishable from "no such names" at this layer — and caching that
       * would make the emptiness permanent across every future rebuild. Some
       * really are empty (Denmark has no humans carrying both a citizenship and
       * a family name), and those cost one wasted request per rebuild, which is
       * the right way round for the trade.
       */
      if (text.split('\n').filter((l) => l.trim()).length > 1) {
        mkdirSync(CACHE, { recursive: true });
        writeFileSync(key, text);
      }
      return text;
    } catch (err) {
      lastError = err;
      if (attempt < 3) {
        process.stdout.write(`retry(${(err as Error).message}) `);
        await new Promise((r) => setTimeout(r, attempt * 10_000));
      }
    }
  }
  throw lastError;
}

const sparql = async (queryText: string): Promise<string[][]> => parseCsv(await fetchCsv(queryText));

/** "Ōtsuka" → "Otsuka", "Zoë" → "Zoe". See the header for why this is required. */
function toAscii(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ØøÐðÞþŁłÆæŒœß]/g, (c) =>
      ({ Ø: 'O', ø: 'o', Ð: 'D', ð: 'd', Þ: 'Th', þ: 'th', Ł: 'L', ł: 'l', Æ: 'Ae', æ: 'ae', Œ: 'Oe', œ: 'oe', ß: 'ss' })[c] ?? c
    );
}

/**
 * The floors differ by kind, and the difference is load-bearing both ways.
 *
 * Surnames go down to two characters because Li, Wu, Xu, Ye, Ma and He are
 * among the commonest on earth and a three-character floor quietly deletes the
 * Chinese half of the corpus. Given names do not, because two-character given
 * names are mostly not names at all — they are the individual syllables that
 * Wikidata carries as items in their own right, and they arrive looking like
 * Ap, Ge, Eul, Do.
 *
 * Ten is the ceiling for both: past it a reader stops recognising a name and
 * starts sounding it out, which is the same reason coined stems are capped at
 * eight.
 */
const CLEAN = { given: /^[A-Za-z]{3,10}$/, family: /^[A-Za-z]{2,10}$/ };

function usable(raw: string, kind: 'given' | 'family'): string | null {
  const name = toAscii(raw.trim());
  // A parenthesised label is a disambiguation ("Lee (Korean name)"), and an
  // uppercase-only one is an abbreviation.
  if (!CLEAN[kind].test(name)) return null;
  if (name === name.toUpperCase()) return null;
  const cased = name[0].toUpperCase() + name.slice(1).toLowerCase();
  // The blocklist is the same one the coiner is held to: an author who does not
  // want to meet another Elara does not want to meet one from Wikidata either.
  if (isSlop(cased)) return null;
  return cased;
}

/**
 * Every given name in every language, in one request.
 *
 * The subclass walk is required: the real items are male/female/unisex given
 * name, which sit under Q202444 rather than being instances of it. Fetching all
 * languages together rather than one per language is not just faster — the
 * first version issued 52 separate queries and spent twenty minutes without
 * finishing one, because each pays the same subclass-walk cost.
 */
const GIVEN_QUERY = `SELECT ?code ?label WHERE {
  ?n wdt:P31/wdt:P279* wd:Q202444 .
  ?n wdt:P407 ?lang . ?lang wdt:P218 ?code .
  ?n rdfs:label ?label . FILTER(lang(?label) = "en")
}`;

/**
 * Languages whose given names are taken as the INTERSECTION of two sources
 * rather than from the name items alone.
 *
 * Korean is the case that forced this, and it is worth recording because both
 * sources look fine until you read them. The name items tagged Korean are
 * heavily polluted with individual hangul syllables carried as items in their
 * own right — Ppeum, Ccheo, Kkot, Deop — which nobody is called. Going to
 * people instead swaps one contamination for another: humans with South Korean
 * citizenship include the diaspora and the naturalised, so that list comes back
 * holding Lucy, Alberto, Bruce and Gary.
 *
 * Neither is usable alone. The overlap is: tagged Korean AND borne by someone
 * Korean, which drops the unborne syllables and the imported Erikas together
 * and leaves Hyeon, Seok, Yeon, Ryul, Seul, Gwang, Cheolhong. Applied only
 * where it is needed — Chinese and Japanese name items are clean, and
 * intersecting those would throw away good names for nothing.
 */
const GIVEN_FROM_BOTH: Record<string, string> = { ko: 'Q884' };

/** Distinct names taken from any one country. See surnameQuery for why it exists. */
const PEOPLE_LIMIT = 20_000;

function givenByPeopleQuery(country: string): string {
  return `SELECT DISTINCT ?label WHERE {
  ?h wdt:P27 wd:${country} ; wdt:P735 ?g .
  ?g rdfs:label ?label . FILTER(lang(?label) = "en")
} LIMIT ${PEOPLE_LIMIT}`;
}

/**
 * Surnames borne by people of ONE country. See the header for the why.
 *
 * One country per request, deliberately. Batching four into a `VALUES` clause
 * is the obvious economy and it is what made the previous version unusable:
 * Britain, the United States, Australia and Canada in one query is millions of
 * humans, the endpoint's own 60-second limit kills it, and the retry loop then
 * spends ten minutes failing the same way.
 *
 * Two more things had to go for the big countries to answer at all. `?h wdt:P31
 * wd:Q5` looks like it belongs and is pure cost — a thing with a country of
 * citizenship and a family name is a person, so the human triple only adds a
 * join over millions of rows. And the LIMIT caps the work: Germany failed three
 * times with 504s and 502s without it, and returns twelve thousand surnames in
 * a minute with it. Twenty thousand distinct surnames from one country is far
 * more variety than a novel can use.
 */
function surnameQuery(country: string): string {
  return `SELECT DISTINCT ?label WHERE {
  ?h wdt:P27 wd:${country} ; wdt:P734 ?fam .
  ?fam rdfs:label ?label . FILTER(lang(?label) = "en")
} LIMIT ${PEOPLE_LIMIT}`;
}

const dedupe = (names: (string | null)[]): string[] =>
  [...new Set(names.filter((n): n is string => n !== null))].sort();

async function main(): Promise<void> {
  const given: Record<string, string[]> = {};
  const family: Record<string, string[]> = {};

  console.log('given names (all languages, one query)…');
  const wanted = new Set(LANGUAGES);
  const byLang = new Map<string, (string | null)[]>();
  for (const [code, label] of await sparql(GIVEN_QUERY)) {
    if (!wanted.has(code)) continue;
    if (!byLang.has(code)) byLang.set(code, []);
    byLang.get(code)!.push(usable(label ?? '', 'given'));
  }
  for (const [code, names] of byLang) given[code] = dedupe(names);
  console.log(`  ${Object.values(given).reduce((a, b) => a + b.length, 0)} across ${byLang.size} languages`);

  for (const [lang, country] of Object.entries(GIVEN_FROM_BOTH)) {
    process.stdout.write(`  ${lang}: intersecting with names borne by people… `);
    try {
      const rows = await sparql(givenByPeopleQuery(country));
      const borne = new Set(dedupe(rows.map((r) => usable(r[0], 'given'))));
      const before = given[lang]?.length ?? 0;
      given[lang] = (given[lang] ?? []).filter((n) => borne.has(n));
      console.log(`${before} → ${given[lang].length}`);
    } catch (err) {
      console.log(`FAILED (${(err as Error).message}) — keeping the unfiltered list`);
    }
  }

  console.log('surnames (one query per country, from people)…');
  for (const lang of LANGUAGES) {
    const countries = SURNAME_COUNTRIES[lang];
    if (!countries) continue;
    const collected: (string | null)[] = [];
    for (const country of countries) {
      process.stdout.write(`  ${lang}/${country}… `);
      try {
        const rows = await sparql(surnameQuery(country));
        collected.push(...rows.map((r) => usable(r[0], 'family')));
        console.log(`${rows.length} rows`);
      } catch (err) {
        // One country failing costs that country, never the language: Spanish
        // surnames survive on Mexico alone if Spain times out.
        console.log(`FAILED (${(err as Error).message})`);
      }
      // Courtesy to a free public endpoint that owes us nothing.
      await new Promise((r) => setTimeout(r, 2000));
    }
    family[lang] = dedupe(collected);
    console.log(`  ${lang}: ${family[lang].length} surnames`);
  }

  /*
   * Strip Western surnames out of the non-Latin-script pools.
   *
   * Deriving surnames from citizenship has one visible failure: a country's
   * notable people include its foreign nationals and its diaspora returnees, so
   * China contributes Jordan, Cola and Kennedy alongside Xie, Mi and Zhang. Six
   * candidates then come back containing "Pai Cola", which is exactly the kind
   * of name this whole change exists to stop shipping.
   *
   * Anything already in the English pool is dropped from these. The signal is
   * only unambiguous where the scripts do not share a surname stock at all —
   * applying it to German would delete real German surnames that English also
   * has. It costs a handful of genuine overlaps (Lee is both English and
   * Korean) to remove a far larger number of names that are simply out of
   * place, and a slate has thousands of others to draw on.
   */
  const CROSS_SCRIPT = ['zh', 'ko', 'ja', 'ar', 'fa', 'az'];
  const english = new Set(family.en ?? []);
  if (english.size) {
    for (const lang of CROSS_SCRIPT) {
      if (!family[lang]?.length) continue;
      const before = family[lang].length;
      family[lang] = family[lang].filter((n) => !english.has(n));
      if (before !== family[lang].length) {
        console.log(`  ${lang}: ${before} → ${family[lang].length} surnames after dropping English ones`);
      }
    }
  }

  /*
   * A language with too few names of either kind is dropped from its group
   * rather than shipped thin: six candidates drawn from a pool of nine repeat
   * inside one slate, which looks worse than a coined name would.
   */
  const MIN = 40;
  const groups: Record<string, string[]> = {};
  for (const [world, langs] of Object.entries(GROUPS)) {
    const kept = langs.filter((l) => (given[l]?.length ?? 0) >= MIN && (family[l]?.length ?? 0) >= MIN);
    const thin = langs.filter((l) => !kept.includes(l));
    if (thin.length) console.log(`  ${world}: dropped ${thin.join(', ')} (under ${MIN} of one kind)`);
    if (kept.length) groups[world] = kept;
  }

  const used = new Set(Object.values(groups).flat());
  const corpus = {
    version: 1,
    license: 'CC0-1.0',
    source:
      'Wikidata (query.wikidata.org), English labels. Given names: P31/P279* Q202444 tagged with ' +
      'P407. Surnames: P734 of humans by P27 country of citizenship. Built by ' +
      'backend/scripts/buildNameCorpus.ts.',
    groups,
    given: Object.fromEntries(Object.entries(given).filter(([l]) => used.has(l))),
    family: Object.fromEntries(Object.entries(family).filter(([l]) => used.has(l))),
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(corpus)}\n`);

  const totalGiven = Object.values(corpus.given).reduce((a, b) => a + b.length, 0);
  const totalFamily = Object.values(corpus.family).reduce((a, b) => a + b.length, 0);
  console.log(
    `\n${totalGiven} given + ${totalFamily} family names across ${used.size} languages ` +
      `→ ${OUT} (${(JSON.stringify(corpus).length / 1024).toFixed(0)} KB)`
  );
  for (const [world, langs] of Object.entries(groups)) console.log(`  ${world}: ${langs.join(', ')}`);
}

void main();
