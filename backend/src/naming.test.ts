// Offline checks: npx tsx src/naming.test.ts (no network, no API key)
//
// The generator is the part of the naming feature that has to be right without
// a model in the loop, so almost everything worth asserting is assertable here:
// determinism, phonotactics, the slop filter, and the anti-fixation rules that
// stop a cast drifting into Kael / Kaelin / Kalen.
import { isSlop, normalizeName, SLOP_NAMES } from './engine/naming/blocklist.js';
import {
  charterWorlds,
  defaultCharter,
  detectPack,
  resolveCulture,
  type NamingCharter,
} from './engine/naming/charter.js';
import { preferredWords, themesFor } from './engine/naming/affinity.js';
import { namesInProse, takenNames } from './engine/naming/load.js';
import {
  applyCharterPatch,
  NamingValidationError,
  normalizeCharter,
  validateCharterPatch,
} from './lib/namingValidate.js';
import {
  checkName,
  generateSlate,
  keyToken,
  levenshtein,
  sampleNames,
  syllableCount,
} from './engine/naming/generator.js';
import { eligibleFormulas, FORMULAS, NAMING_PACKS } from './engine/naming/formulas.js';
import { corpusStats, languageLabel, personPool } from './engine/naming/personNames.js';
import {
  banksFor,
  DEFAULT_BANKS,
  illegalFor,
  isSoundWorldId,
  listSoundWorlds,
  soundWorld,
  SOUND_WORLDS,
} from './engine/naming/lexicons.js';
import { BIBLE_ENTRY_TYPES } from './lib/types.js';

let passed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
  } else {
    failures.push(detail ? `${label} — ${detail}` : label);
  }
}

const base = {
  novelId: 'n-test',
  cultureId: 'default',
  soundWorldId: 'northern',
  pack: 'western' as const,
  type: 'location' as const,
  brief: 'a mountain pass the northern clans use for winter trade',
  count: 6,
  taken: [] as string[],
};

// ── Determinism ────────────────────────────────────────────────────────────

{
  const a = generateSlate(base).candidates.map((c) => c.name);
  const b = generateSlate(base).candidates.map((c) => c.name);
  check('same request → identical slate', a.join('|') === b.join('|'), `${a} vs ${b}`);

  const c = generateSlate({ ...base, nonce: 1 }).candidates.map((n) => n.name);
  check(
    'a different nonce → a different slate',
    c.join('|') !== a.join('|'),
    'a model that dislikes its slate would be handed the same six names'
  );

  const d = generateSlate({ ...base, novelId: 'n-other' }).candidates.map((n) => n.name);
  check('a different novel → a different slate', d.join('|') !== a.join('|'));

  const e = generateSlate({ ...base, brief: 'a drowned harbour town' }).candidates.map((n) => n.name);
  check('a different brief → a different slate', e.join('|') !== a.join('|'));
}

// ── Slate shape ────────────────────────────────────────────────────────────

{
  const slate = generateSlate(base);
  check('asks for six, gets six', slate.candidates.length === 6, `${slate.candidates.length}`);
  check(
    'candidates are distinct',
    new Set(slate.candidates.map((c) => normalizeName(c.name))).size === slate.candidates.length
  );
  check('every candidate has a note', slate.candidates.every((c) => c.note.trim().length > 0));
  check('the spec carries the register', slate.spec.shape.length > 20 && slate.spec.register.length > 10);
  check(
    'more than one formula is used',
    new Set(slate.candidates.map((c) => c.formulaId)).size > 1,
    'six candidates from one construction is one candidate shown six times'
  );

  const big = generateSlate({ ...base, count: 99 });
  check('count is clamped', big.candidates.length <= 16, `${big.candidates.length}`);
  const small = generateSlate({ ...base, count: 0 });
  check('a zero count still returns names', small.candidates.length >= 1);
}

// ── Every world × every type produces something ────────────────────────────

{
  let empty = 0;
  let illegalHits = 0;
  let slopHits = 0;
  for (const world of SOUND_WORLDS) {
    const rules = illegalFor(world);
    for (const pack of NAMING_PACKS) {
      for (const type of BIBLE_ENTRY_TYPES) {
        const slate = generateSlate({
          ...base,
          soundWorldId: world.id,
          pack,
          type,
          count: 4,
          brief: `a ${type} that matters`,
        });
        if (!slate.candidates.length) empty++;
        for (const c of slate.candidates) {
          if (isSlop(c.name)) slopHits++;
          // Phonotactics are enforced on coined stems; bank words are real
          // English and exempt. The whole name must at least be sane.
          if (c.name.length < 2 || c.name.length > 60) illegalHits++;
          if (rules.some((r) => r.test(normalizeName(c.name).slice(0, 12)) && /^[a-z]+$/.test(c.name))) {
            illegalHits++;
          }
        }
      }
    }
  }
  check('no world/pack/type combination comes back empty', empty === 0, `${empty} empty`);
  check('nothing generated is on the slop list', slopHits === 0, `${slopHits} hits`);
  check('nothing generated is malformed', illegalHits === 0, `${illegalHits} hits`);
}

{
  // Every entry type must have at least three `any` formulas, which is what
  // lets generateSlate promise a non-empty slate for any pack.
  const thin = BIBLE_ENTRY_TYPES.filter(
    (t) => FORMULAS.filter((f) => f.types.includes(t) && f.pack === 'any').length < 3
  );
  check('every type has at least three pack-independent formulas', thin.length === 0, thin.join(', '));

  const unreachable = BIBLE_ENTRY_TYPES.filter((t) =>
    NAMING_PACKS.some((p) => eligibleFormulas(t, p).length === 0)
  );
  check('no type/pack pair has an empty formula set', unreachable.length === 0, unreachable.join(', '));
}

// ── Diversity: the anti-collapse assertion ─────────────────────────────────

{
  const names = new Set<string>();
  for (let i = 0; i < 40; i++) {
    for (const c of generateSlate({ ...base, count: 5, nonce: i }).candidates) {
      names.add(normalizeName(c.name));
    }
  }
  check(
    '200 draws give at least 150 distinct names',
    names.size >= 150,
    `${names.size} distinct — this is the mode-collapse assertion`
  );
}

// ── Similarity: the anti-fixation rules ────────────────────────────────────

{
  const taken = ['Kellrand', 'Skarn', 'Vennes', 'Holtmere'];
  const slate = generateSlate({ ...base, taken, count: 8 });
  const bad: string[] = [];
  for (const c of slate.candidates) {
    for (const t of taken) {
      const a = keyToken(c.name);
      const b = keyToken(t);
      if (levenshtein(a, b) <= 2) bad.push(`${c.name} ~ ${t}`);
      if (normalizeName(c.name) === normalizeName(t)) bad.push(`${c.name} = ${t}`);
    }
  }
  check('nothing lands within edit distance 2 of an existing name', bad.length === 0, bad.join(', '));
  check('existing names are echoed back for the prompt', slate.nearby.length === 4);
}

{
  // A crowded novel must still get a slate: the strict filter relaxes rather
  // than starving.
  const crowded = Array.from({ length: 400 }, (_, i) => `Name${i}holt`);
  const slate = generateSlate({ ...base, taken: crowded, count: 6 });
  check('400 names taken still yields a slate', slate.candidates.length > 0, `${slate.candidates.length}`);
  check(
    'the relaxed pass still refuses an exact collision',
    !slate.candidates.some((c) => crowded.some((t) => normalizeName(t) === normalizeName(c.name)))
  );
}

{
  const banned = ['Skarr', 'Venn'];
  const slate = generateSlate({ ...base, banned, count: 8 });
  const hit = slate.candidates.filter((c) =>
    banned.some((b) => normalizeName(c.name).includes(normalizeName(b)))
  );
  check('the author’s banned words are honoured', hit.length === 0, hit.map((c) => c.name).join(', '));
}

// ── The slop filter ────────────────────────────────────────────────────────

{
  check('Elara is slop', isSlop('Elara'));
  check('Kaelen is slop', isSlop('Kaelen'));
  check('Aris Thorne is slop', isSlop('Aris Thorne'));
  check('The Aetherium is slop', isSlop('The Aetherium'));
  check('a suffix tell is caught', isSlop('Miriel'), 'the -iel ending');
  check('a title tell is caught', isSlop('The Shattered Crown'));
  check('an of-abstract title is caught', isSlop('Order of Whispers'));
  check('a stem tell is caught', isSlop('Nightshade Company'));

  check('an ordinary coined name is not slop', !isSlop('Skarrholt'));
  check('a plain English compound is not slop', !isSlop('Ironmarch'));
  check('a real toponym generic survives', !isSlop('Draumfell'), '-fell is a real generic');
  check('a normal person name survives', !isSlop('Renna Hask'));
  check('an empty name is slop', isSlop('   '));
}

// ── checkName, the gate on model-chosen names ──────────────────────────────

{
  check('checkName rejects slop', checkName('Elara') !== null);
  check('checkName rejects an empty name', checkName('') !== null);
  check('checkName rejects an overlong name', checkName('x'.repeat(80)) !== null);
  check('checkName accepts a sane name', checkName('Skarrholt') === null, String(checkName('Skarrholt')));
  check(
    'checkName accepts a bank-word compound whose consonants a conlang would refuse',
    checkName('Verdigris Shrike') === null,
    String(checkName('Verdigris Shrike'))
  );
  check(
    'checkName honours banned words',
    checkName('Vennskard', { banned: ['venn'] }) !== null
  );
  check(
    'checkName honours taken names',
    checkName('Kellrand', { taken: ['Kellrand'] }) !== null
  );
  check(
    'checkName lets an unrelated name through against a taken list',
    checkName('Draumgap', { taken: ['Kellrand', 'Skarn'] }) === null,
    String(checkName('Draumgap', { taken: ['Kellrand', 'Skarn'] }))
  );
}

// ── Small pure helpers ─────────────────────────────────────────────────────

{
  check('normalizeName folds punctuation', normalizeName("Al-Rashid") === 'alrashid');
  check('normalizeName folds accents', normalizeName('Rénka') === 'renka');
  check('keyToken drops articles', keyToken('The Salt Narrows') === 'narrows');
  check('keyToken unwraps brackets', keyToken('[Frost Bolt]') === 'frost');
  check('syllableCount counts vowel groups', syllableCount('skarrholt') === 2, String(syllableCount('skarrholt')));
  check('syllableCount never returns zero', syllableCount('brr') === 1);
  check('levenshtein is zero for equals', levenshtein('kael', 'kael') === 0);
  check('levenshtein counts one edit', levenshtein('kael', 'kaal') === 1);
}

// ── The catalog itself ─────────────────────────────────────────────────────

{
  const ids = SOUND_WORLDS.map((w) => w.id);
  check('sound world ids are unique', new Set(ids).size === ids.length);
  check('there are at least eight sound worlds', SOUND_WORLDS.length >= 8, `${SOUND_WORLDS.length}`);
  check('listSoundWorlds leaks no inventories', listSoundWorlds().every((w) => Object.keys(w).length === 3));
  check('a known id resolves', soundWorld('northern').id === 'northern');
  check(
    'an unknown id falls back rather than throwing',
    soundWorld('a-world-removed-two-deploys-ago').id === 'northern'
  );
  check('isSoundWorldId is honest', isSoundWorldId('northern') && !isSoundWorldId('nope'));

  const formulaIds = FORMULAS.map((f) => f.id);
  check('formula ids are unique', new Set(formulaIds).size === formulaIds.length);

  for (const world of SOUND_WORLDS) {
    const banks = banksFor(world);
    const emptyBank = Object.entries(banks).find(([, v]) => v.length === 0);
    check(`${world.id}: no empty word bank`, !emptyBank, emptyBank?.[0] ?? '');
    check(`${world.id}: has generics`, world.generics.length >= 5);
    check(`${world.id}: codas allow an open syllable`, world.codas.includes(''));
  }

  const slop = [...SLOP_NAMES].filter((n) => n !== normalizeName(n));
  check('the slop list is stored normalized', slop.length === 0, slop.join(', '));

  // The two files contradicting each other is a live bug, not a tidiness
  // point: the generator would offer a word its own filter rejects, and every
  // draw of it is silently wasted. Ember, Sable and Vale were all on both.
  const ownVocabulary = new Set(
    SOUND_WORLDS.flatMap((w) => [
      ...Object.values(banksFor(w)).flat(),
      ...w.generics.map((g) => g.text),
    ]).map(normalizeName)
  );
  const contradictions = [...SLOP_NAMES].filter((n) => ownVocabulary.has(n));
  check(
    'nothing on the slop list is a word we ourselves use',
    contradictions.length === 0,
    contradictions.join(', ')
  );
}

{
  const a = sampleNames('n1', 'default', 'northern', 'western');
  const b = sampleNames('n1', 'default', 'northern', 'western');
  check('sample names are stable for a novel', a.join('|') === b.join('|'), `${a} vs ${b}`);
  check('sample names give three', a.length === 3);
  check(
    'a different novel gets different samples',
    sampleNames('n2', 'default', 'northern', 'western').join('|') !== a.join('|')
  );
}

// ── The charter ────────────────────────────────────────────────────────────

{
  const plain = { id: 'n1', title: 'The Drowned Ledger', premise: 'A clerk in a salt port.', styleNotes: '' };
  const a = defaultCharter(plain);
  const b = defaultCharter(plain);
  check('defaultCharter is deterministic per novel', a.cultures[0].soundWorldId === b.cultures[0].soundWorldId);
  check('defaultCharter needs no persistence', a.source === 'default' && a.updatedAt === 0);
  check('defaultCharter has exactly one culture', a.cultures.length === 1);

  check(
    'a cultivation premise detects the xianxia pack',
    detectPack({ title: 'Nine Peaks', premise: 'A sect disciple gathers qi to reach core formation.', styleNotes: '' }) === 'xianxia'
  );
  check(
    'a system premise detects litrpg',
    detectPack({ title: 'Delve', premise: 'The status screen said Level 1. The dungeon did not care.', styleNotes: '' }) === 'litrpg'
  );
  check(
    'litrpg beats cultivation when both are present',
    detectPack({ title: 'x', premise: 'A cultivation sect with a status screen and a skill tree.', styleNotes: '' }) === 'litrpg'
  );
  check('a plain premise falls back to western', detectPack(plain) === 'western');
  check(
    'the drawn sound world suits the pack',
    defaultCharter({ ...plain, premise: 'A sect disciple gathers qi.' }).cultures[0].soundWorldId === 'cloudsea' ||
      defaultCharter({ ...plain, premise: 'A sect disciple gathers qi.' }).cultures[0].soundWorldId === 'island-court'
  );

  const twoCultures: NamingCharter = {
    ...a,
    cultures: [
      { id: 'imperial', label: 'The Meridian court', soundWorldId: 'meridian', appliesTo: 'the capital, House Arrego' },
      { id: 'clans', label: 'The northern clans', soundWorldId: 'northern', appliesTo: 'the winter roads and the fells' },
    ],
  };
  check('resolveCulture falls back to the first', resolveCulture(twoCultures, '').id === 'imperial');
  check('resolveCulture matches an id', resolveCulture(twoCultures, 'clans').id === 'clans');
  check('resolveCulture matches a label', resolveCulture(twoCultures, 'The northern clans').id === 'clans');
  check('resolveCulture matches loosely on scope', resolveCulture(twoCultures, 'a family of the winter roads').id === 'clans');
  check('resolveCulture ignores short words', resolveCulture(twoCultures, 'the a of').id === 'imperial');
  check('charterWorlds dedupes', charterWorlds(twoCultures).length === 2);
}

{
  const novel = { id: 'n1', title: 'T', premise: '', styleNotes: '' };

  const patch = validateCharterPatch({
    cultures: [{ label: 'The northern clans', soundWorldId: 'northern', appliesTo: 'the fells' }],
    pack: 'western',
    banned: ['Skarr'],
    notes: 'Sect names always end in a mountain.',
  });
  check('a good patch validates', patch.cultures?.[0].id === 'the-northern-clans');

  const bad = (raw: unknown): boolean => {
    try {
      validateCharterPatch(raw);
      return false;
    } catch (err) {
      return err instanceof NamingValidationError;
    }
  };
  check('an empty culture list is refused', bad({ cultures: [] }));
  check('too many cultures are refused', bad({ cultures: Array.from({ length: 7 }, (_, i) => ({ label: `C${i}` })) }));
  check('a nameless culture is refused', bad({ cultures: [{ label: '   ' }] }));
  check('duplicate cultures are refused', bad({ cultures: [{ label: 'North' }, { label: 'north' }] }));
  check('an unknown pack is refused', bad({ pack: 'grimdark' }));
  check('too many banned words are refused', bad({ banned: Array.from({ length: 41 }, (_, i) => `w${i}`) }));
  check('overlong notes are refused', bad({ notes: 'x'.repeat(601) }));

  const corrected = validateCharterPatch({ cultures: [{ label: 'A', soundWorldId: 'a-world-that-was-removed' }] });
  check(
    'an unknown sound world is corrected, not refused',
    corrected.cultures?.[0].soundWorldId === 'northern',
    'an author cannot escape a rejected save over a value they never typed'
  );

  const applied = applyCharterPatch(null, novel, { notes: 'only this' });
  check('applyCharterPatch fills the rest from the default', applied.cultures.length === 1 && applied.notes === 'only this');
  check('applyCharterPatch stamps the source', applied.source === 'author' && applied.updatedAt > 0);

  const junk = normalizeCharter({ cultures: 'not an array', pack: 'nope', banned: [1, 'ok'] }, novel);
  check('normalizeCharter repairs junk rather than throwing', junk.cultures.length === 1 && junk.pack === 'western');
  check('normalizeCharter drops non-string banned words', junk.banned.join(',') === 'ok');
  check('normalizeCharter survives null', normalizeCharter(null, novel).source === 'default');
  check(
    'normalizeCharter falls back on a removed sound world',
    normalizeCharter({ cultures: [{ label: 'A', soundWorldId: 'gone' }] }, novel).cultures[0].soundWorldId ===
      defaultCharter(novel).cultures[0].soundWorldId
  );
}

// ── The sound world follows the premise ────────────────────────────────────

{
  // The worst bug this feature had: the sound world was a die roll over the
  // genre's pool, so a novel about a frozen northern harbour spoke with the
  // vowels of a Mediterranean republic and a desert caliphate got elves.
  const world = (premise: string, title = 'A Novel'): string =>
    defaultCharter({ id: 'n', title, premise, styleNotes: '' }).cultures[0].soundWorldId;

  check('a frozen harbour sounds northern', world('A carter on the frozen northern coast, salt and herring.') === 'northern', world('A carter on the frozen northern coast, salt and herring.'));
  check('a desert caliphate sounds like the sand-sea', world('A desert caliphate of dunes, caravans and water debts.') === 'sandsea');
  check('a cultivation sect sounds like the cloud-sea', world('A sect disciple gathers qi to reach core formation.') === 'cloudsea');
  check('a deep forest sounds sylvan', world('A druid of the old greenwood, among groves and briar.') === 'sylvan');
  check('a factory town sounds like the foundry', world('A mill clerk in a coal and railway town, all smog and ledgers.') === 'foundry');
  check('a starship sounds like the void', world('A frigate crew running cargo between orbital stations.') === 'void');
  check('a shogunate sounds like the island court', world('A ronin between shrine and daimyo, bamboo and blossom.') === 'island-court');
  check('a sunlit republic sounds meridian', world('A duellist of the canal republic, marble and vineyards.') === 'meridian');

  check(
    'the setting beats the genre',
    world('A cultivation sect in the deep desert, dunes and caravans and qi.') === 'sandsea',
    'the pack decides the SHAPE of a name and the setting decides its SOUND'
  );
  check(
    'a premise that says nothing still gets a world',
    isSoundWorldId(world('Two people talk.')),
  );
  check(
    'and the same silent premise is stable',
    world('Two people talk.') === world('Two people talk.')
  );
}

// ── Names mean what the thing is ───────────────────────────────────────────

{
  const namesFor = (brief: string, type: 'technique' | 'location' = 'technique'): string =>
    generateSlate({ ...base, type, brief, count: 10, soundWorldId: 'northern', pack: 'western' })
      .candidates.map((c) => c.name)
      .join(' ');

  const strength = namesFor('a technique of overwhelming, crushing strength');
  check(
    'a strength technique reaches for strength words',
    /Iron|Stone|Granite|Thunder|Fist|Shoulder|Grip|Shattering|Breaking|Crushing|Toppling|Hammer|Anvil|Bear|Ox|Bull|Ram|Boar|Weight|Wrath/.test(strength),
    strength
  );
  const cold = namesFor('a technique that freezes the blood and stills the heart');
  check(
    'a cold technique reaches for cold words',
    /Frost|Rime|Sleet|Stilling|Quenching|Silencing|Breath|Marrow|Pale|Bone|Severing|Cleaving|Piercing|Carmine/.test(cold),
    cold
  );
  check(
    'and they are not the same names',
    strength !== cold,
    'the brief has to move the vocabulary, not just the seed'
  );

  const themes = themesFor('a technique of overwhelming, crushing strength');
  check('the brief matches a theme', themes.some((t) => t.id === 'force'), themes.map((t) => t.id).join(','));
  check('an empty brief matches nothing', themesFor('').length === 0);
  check('a neutral brief matches nothing', themesFor('a thing that exists').length === 0);
  check(
    'a preference naming a word the bank lacks is dropped',
    preferredWords(themes, 'element', ['Iron', 'Nonsense']).join(',') === 'Iron'
  );
  check(
    'an unmatched brief still produces names',
    generateSlate({ ...base, brief: 'a thing that exists', count: 6 }).candidates.length === 6,
    'a theme that does not match must cost nothing'
  );
}

// ── The palette the model composes from ────────────────────────────────────

{
  const slate = generateSlate({ ...base, type: 'technique', brief: 'crushing strength', count: 8 });
  check('the palette offers invented words', slate.palette.stems.length > 0);
  check('the palette offers real words by bank', slate.palette.words.length > 0);
  check('every bank in the palette has options', slate.palette.words.every((w) => w.options.length > 0));
  check('the palette carries the joining words', slate.palette.structural.includes('the'));
  check(
    'themed words lead the palette',
    slate.palette.words.some((w) => w.options.some((o) => /Iron|Stone|Fist|Shattering|Breaking|Crushing/.test(o))),
    JSON.stringify(slate.palette.words)
  );
  check(
    'nothing on the palette is slop',
    !slate.palette.words.flatMap((w) => w.options).some(isSlop) && !slate.palette.stems.some(isSlop)
  );
}

// ── Names stay simple ──────────────────────────────────────────────────────

{
  let longest = '';
  let overlong = 0;
  for (const world of SOUND_WORLDS) {
    for (let i = 0; i < 20; i++) {
      for (const c of generateSlate({ ...base, soundWorldId: world.id, type: 'character', count: 5, nonce: i }).candidates) {
        for (const word of c.name.split(/\s+/)) {
          if (word.length > longest.length) longest = word;
          // A single word past this is the "Dhaqyuutaym" problem — legal,
          // in-register, and unusable.
          if (word.length > 13) overlong++;
        }
      }
    }
  }
  check('no single word runs long', overlong === 0, `${overlong} over, longest "${longest}"`);
  check('the longest word is still readable', longest.length <= 13, longest);

  /*
   * The syllable ceiling is asserted on COINED names, and this used to run on
   * characters. It stopped being the right question there once people started
   * drawing from the real-name corpus: Apollonia, Wilhelmina and Bartholomew
   * are four and five syllables and are perfectly sayable, because a real name
   * has already passed the test this rule approximates — the rule exists to
   * keep INVENTED words pronounceable, and nothing invented is left in a
   * person's name. The length ceiling above still covers people, and the corpus
   * caps every entry at ten characters.
   */
  const stems: string[] = [];
  for (const world of SOUND_WORLDS) {
    for (const type of ['character', 'location', 'faction', 'technique'] as const) {
      for (let i = 0; i < 5; i++) {
        for (const c of generateSlate({ ...base, soundWorldId: world.id, type, count: 6, nonce: i }).candidates) {
          stems.push(...(c.stems ?? []));
        }
      }
    }
  }
  // On the STEMS, not on every word: "Sanctuary" and "Ceremony" are four
  // syllables, come from the word banks, and are exactly as readable as they
  // look. The rule is about what the syllable assembler is allowed to build.
  const wordy = stems.filter((s) => syllableCount(s) > 3);
  check(
    'no coined stem runs past three syllables',
    wordy.length === 0,
    `${stems.length} stems, worst: ${wordy.slice(0, 4).join(', ') || 'none'}`
  );
}

// ── People get real names; everything else keeps the coiner ────────────────
//
// The change this guards is a product decision as much as a technical one: a
// reader has to be able to say a character's name out loud for forty chapters,
// and syllable assembly could not do that (Fler Pucloll, Grestayn the Falcon).
// A sect or a sword has no such constraint and SHOULD sound invented, so the
// boundary between the two is the thing worth asserting.

{
  const stats = corpusStats();
  check('the corpus shipped', stats.given > 2000 && stats.family > 2000, JSON.stringify(stats));
  check('across many languages', stats.languages >= 10, `${stats.languages}`);

  const person = (nonce?: number) =>
    generateSlate({ ...base, type: 'character', count: 6, nonce }).candidates.map((c) => c.name);

  // Real names are the ones people actually have, so every word in one is
  // pronounceable by construction. The property that IS checkable offline is
  // that they come from the corpus rather than from the syllable assembler.
  const pool = personPool('northern', base.novelId, base.cultureId)!;
  check('northern draws a real pool', pool !== null && pool.given.length > 0);
  const known = new Set([...pool.given, ...pool.family].map((n) => n.toLowerCase()));
  const names = person();
  const heads = names.map((n) => n.split(/\s+/)[0].toLowerCase());
  check(
    'every character name starts with a real given name',
    heads.every((h) => known.has(h)),
    names.join(' | ')
  );
  check('and they are still six distinct names', new Set(names).size === names.length, names.join(' | '));

  /*
   * The failure that started this: one entity, six candidates, four of them
   * "<name> the <animal>". Cutting the formula's weight was not enough — at one
   * in ten it still put two epithets in a slate of eight, and an author reading
   * a cast list does not average over draws. So the formula is gone, and this
   * asserts the absence across enough slates to catch a reintroduction.
   *
   * Scoped to the default pack. `person-designation` and `person-daohao` are
   * genre conventions of litrpg and xianxia, are gated behind those packs, and
   * are deliberately still here.
   */
  const manyNames = Array.from({ length: 40 }, (_, i) => person(i)).flat();
  const epithets = manyNames.filter((n) => / the /i.test(n));
  check(
    'no character is named "<name> the <animal>"',
    epithets.length === 0,
    epithets.slice(0, 5).join(' | ')
  );

  // What the author asked for in its place: first + middle + last, first +
  // last, or a single given name where having no surname is the point.
  const shapes = new Set(manyNames.map((n) => n.trim().split(/\s+/).length));
  check('single given names are still offered', shapes.has(1), [...shapes].join(','));
  check('first + last is offered', shapes.has(2));
  check('first + middle + last is offered', shapes.has(3));
  check('and nothing runs longer than three parts', Math.max(...shapes) === 3, [...shapes].join(','));

  // "Anna Anna Weber" is the one way a middle name embarrasses itself.
  const repeated = manyNames.filter((n) => {
    const parts = n.split(/\s+/);
    return new Set(parts).size !== parts.length;
  });
  check('no name repeats one of its own parts', repeated.length === 0, repeated.slice(0, 3).join(' | '));

  /*
   * Dead vocabulary: a bank word that the blocklist rejects on sight.
   *
   * The suffix tells are matched against the WHOLE assembled candidate, so a
   * bank word ending in one makes every name built from it unbuildable — the
   * generator offers it, its own filter throws it away, and the slot is spent
   * for nothing. `Consortium` sat in the void title bank doing this until this
   * check was written. Silent by construction, which is why it needs a test
   * rather than an eye.
   */
  const dead: string[] = [];
  for (const [label, banks] of [
    ['default', DEFAULT_BANKS as unknown as Record<string, string[]>],
    ...SOUND_WORLDS.filter((w) => w.banks).map(
      (w) => [w.id, w.banks as Record<string, string[]>] as const
    ),
  ] as Array<readonly [string, Record<string, string[]>]>) {
    for (const [bank, entries] of Object.entries(banks)) {
      for (const word of entries) if (isSlop(`Venn ${word}`)) dead.push(`${label}.${bank}: ${word}`);
    }
  }
  check('no bank word is one the blocklist would reject', dead.length === 0, dead.join(' | '));

  // A repeat inside a bank is a silent weighting: the word comes up twice as
  // often as its neighbours for no stated reason.
  const dupes: string[] = [];
  for (const [bank, entries] of Object.entries(DEFAULT_BANKS)) {
    const seen = new Set<string>();
    for (const word of entries) {
      if (seen.has(word)) dupes.push(`${bank}: ${word}`);
      seen.add(word);
    }
  }
  check('no bank repeats a word', dupes.length === 0, dupes.join(' | '));

  // The banks were tripled because a small bank does not produce bad names, it
  // produces the SAME good name three chapters later. This is the floor that
  // keeps them from being trimmed back without the trade-off being considered.
  const thin = Object.entries(DEFAULT_BANKS).filter(([, e]) => e.length < 39);
  check(
    'every bank is deep enough not to repeat itself across a novel',
    thin.length === 0,
    thin.map(([b, e]) => `${b}=${e.length}`).join(' ')
  );
  const shallowGenerics = SOUND_WORLDS.filter((w) => w.generics.length < 18);
  check(
    'and every world has enough place generics',
    shallowGenerics.length === 0,
    shallowGenerics.map((w) => `${w.id}=${w.generics.length}`).join(' ')
  );

  /*
   * Reported: an author asked for a school name and got eight candidates —
   * House, Guild, Chapter, Covenant, Bureau — not one containing the word
   * school or academy. It read as the generator refusing anything plain on
   * principle. It was simpler than that: those words were not in the title
   * bank, so no formula could reach them.
   *
   * The assertion is a MIX, in both directions. All-plain would be as wrong as
   * all-invented; what an author asking for a school wants to see is both what
   * it would plainly be called and what else it could be.
   */
  const schools = Array.from({ length: 6 }, (_, i) =>
    generateSlate({
      ...base,
      type: 'faction',
      brief: 'a school where young fighters are trained',
      count: 8,
      nonce: i,
    }).candidates.map((c) => c.name)
  ).flat();
  const TEACHING = /\b(School|Academy|College|Institute|Conservatory|Seminary)\b/;
  const plain = schools.filter((n) => TEACHING.test(n));
  check(
    'a brief that says school can produce a school',
    plain.length > 0,
    plain.slice(0, 4).join(' | ')
  );
  check(
    'and does so often enough to reach one slate',
    plain.length >= schools.length / 8,
    `${plain.length} of ${schools.length}`
  );
  check(
    'without the plain word taking the whole slate',
    plain.length < schools.length,
    `${plain.length} of ${schools.length}`
  );
  // The vocabulary must not leak into briefs that never asked for it: a
  // mercenary company called The Iron Seminary is the opposite failure.
  const mercenaries = Array.from({ length: 6 }, (_, i) =>
    generateSlate({
      ...base,
      type: 'faction',
      brief: 'a mercenary company that takes coastal contracts',
      count: 8,
      nonce: i,
    }).candidates.map((c) => c.name)
  ).flat();
  const strays = mercenaries.filter((n) => TEACHING.test(n));
  check(
    'a brief that never mentions teaching rarely gets a school',
    strays.length <= mercenaries.length / 5,
    `${strays.length} of ${mercenaries.length}: ${strays.slice(0, 4).join(' | ')}`
  );

  check(
    'a factionsect is still invented, not borrowed',
    generateSlate({ ...base, type: 'faction', count: 4 }).candidates.every(
      (c) => !c.name.split(/\s+/).some((w) => known.has(w.toLowerCase()))
    ),
    generateSlate({ ...base, type: 'faction', count: 4 }).candidates.map((c) => c.name).join(' | ')
  );

  // One language per novel-and-culture. A cast of Anders, Nakamura, Dubois and
  // Kowalski is not a book, and this is the rule that prevents it.
  const languages = new Set(
    Array.from({ length: 12 }, () => personPool('northern', base.novelId, base.cultureId)?.language)
  );
  check('the language is stable for a novel and culture', languages.size === 1, [...languages].join());
  check(
    'a different novel may draw a different one',
    new Set(Array.from({ length: 40 }, (_, i) => personPool('northern', `n${i}`, 'default')?.language)).size > 1
  );
  check(
    'and asking again never moves the cast',
    person(7).every((n) => known.has(n.split(/\s+/)[0].toLowerCase())),
    person(7).join(' | ')
  );

  // 'void' names machines. A war-drone called Dave is a joke, so it keeps the
  // coiner — and every caller has to survive that null.
  check('the machine world has no people pool', personPool('void', base.novelId, base.cultureId) === null);
  check(
    'and still produces characters',
    generateSlate({ ...base, soundWorldId: 'void', type: 'character', count: 4 }).candidates.length === 4
  );

  // Every world that HAS a pool must produce usable people from it, or the
  // corpus has a language whose two halves did not both arrive.
  for (const world of SOUND_WORLDS) {
    const p = personPool(world.id, base.novelId, base.cultureId);
    if (!p) continue;
    const got = generateSlate({ ...base, soundWorldId: world.id, type: 'character', count: 5 }).candidates;
    check(`${world.id} names people`, got.length === 5, got.map((c) => c.name).join(' | '));
    check(
      `${world.id} says which language they are`,
      got.some((c) => c.note.includes(languageLabel(p.language))),
      got[0]?.note
    );
  }
}

// ── Gathering the names a novel has spent ──────────────────────────────────

{
  const entry = (name: string, aliases: string[] = []) =>
    ({
      id: name.toLowerCase(),
      type: 'character' as const,
      name,
      aliases,
      summary: '',
      status: '',
      attributes: {},
      facts: [],
      relationships: [],
      firstChapter: 1,
      createdAt: 0,
      updatedAt: 0,
    });

  const taken = takenNames({
    bible: [entry('Kael Veyron', ['the young master']), entry('Skarrholt')],
    designs: [{ name: 'Mirin Hask' } as never],
    map: { entities: { vennes: { name: 'Vennes', aliases: ['the Cut'] } } } as never,
    novel: { title: 'The Drowned Ledger' } as never,
  });
  check('takenNames gathers names and aliases', taken.includes('Kael Veyron') && taken.includes('the young master'));
  check('takenNames includes designs and map entities', taken.includes('Mirin Hask') && taken.includes('the Cut'));
  check('takenNames includes the novel title', taken.includes('The Drowned Ledger'));
  check('takenNames dedupes', new Set(taken).size === taken.length);
  check('takenNames tolerates everything being absent', takenNames({}).length === 0);
}

{
  const prose = [
    { content: 'The rain had not stopped. He found Vennes waiting at Skarrholt with the ledger.' },
  ] as never[];
  const names = namesInProse(prose);
  check('namesInProse finds mid-sentence proper nouns', names.includes('Vennes') && names.includes('Skarrholt'));
  check(
    'namesInProse drops sentence-initial words',
    !names.includes('The') && !names.includes('He'),
    'every sentence starts capitalised, so the first word tells us nothing'
  );
  check('namesInProse ignores ordinary words', !names.includes('ledger'));
}

console.log(`\n${passed}/${passed + failures.length} passed`);
if (failures.length) {
  for (const f of failures) console.error(`FAIL  ${f}`);
  process.exit(1);
}
