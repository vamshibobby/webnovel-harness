/**
 * The naming charter — one document per novel, at `novels/{id}/naming/charter`.
 *
 * It holds AUTHOR INTENT and nothing else: which peoples the world has, what
 * each of them sounds like, which genre the naming conventions follow, and any
 * words the author has ruled out. It never holds names.
 *
 * That last point was a design decision worth writing down, because a ledger of
 * coined names is the obvious thing to build and it is wrong. The generator
 * offers six candidates; the writer uses at most one, may alter its spelling,
 * may drop the entity entirely, and the author may regenerate the chapter. A
 * ledger written at coin time is a record of things that never happened, and it
 * would then have to be repaired on every chapter delete, regeneration and hand
 * edit. The story bible already records exactly the names that survived into
 * prose, transactionally, at accept time. **The bible is the ledger.**
 *
 * What is stored is a `soundWorldId`, never the inventory behind it — the
 * inventories carry RegExps, which Firestore cannot store, and they are code.
 * The same relationship `DesignArc.device` has with `ARC_DEVICES`.
 */

import type { Novel } from '../../lib/types.js';
import { fnv1a, mulberry32 } from '../map/prng.js';
import { isNamingPack, type NamingPack } from './formulas.js';
import { DEFAULT_SOUND_WORLD_ID, isSoundWorldId, SOUND_WORLDS } from './lexicons.js';

/**
 * One people, region or institution whose names share a sound. A novel with a
 * single culture is the normal case; a novel that spans an empire and the
 * steppe it is fighting wants two, and the difference is audible on the page.
 */
export interface NamingCulture {
  /** Slug, stable. Also part of the generator's seed. */
  id: string;
  /** What the author calls them: "the northern clans", "House Rhene". */
  label: string;
  soundWorldId: string;
  /**
   * Free text the author writes and the writer reads: which factions, regions
   * or families belong to this culture. Matched loosely against the `culture`
   * argument of coin_name.
   */
  appliesTo: string;
}

export type CharterSource = 'default' | 'model' | 'author';

export interface NamingCharter {
  /** 1 to 6. The first is the default when nothing else matches. */
  cultures: NamingCulture[];
  pack: NamingPack;
  /** Words that must not appear in a generated name. Author's veto. */
  banned: string[];
  /** Anything else the author wants the writer to know about names. */
  notes: string;
  /**
   * Where this charter came from. Never shown to a model; it exists so the UI
   * can say "we guessed this" versus "you wrote this".
   */
  source: CharterSource;
  updatedAt: number;
}

/**
 * Genre markers. Crude on purpose — this decides a default the author can
 * change in one click, so a false positive costs a click and a false negative
 * costs nothing. Ordered by specificity: a LitRPG cultivation story is a
 * LitRPG story, because the bracket convention is the louder one.
 */
const GENRE_MARKERS: Array<{ pack: NamingPack; pattern: RegExp }> = [
  { pack: 'litrpg', pattern: /\b(litrpg|system|status screen|skill tree|levell?ing|dungeon|stat block|xp|respawn|quest log)\b/i },
  { pack: 'xianxia', pattern: /\b(xianxia|wuxia|cultivat\w*|sect|dao|qi|jianghu|immortal|spirit stone|core formation|martial peak)\b/i },
  { pack: 'modern', pattern: /\b(corporate|corporation|office|detective|precinct|newspaper|startup|factory|union|contemporary|modern[- ]day|noir)\b/i },
];

/** Sound worlds that suit each pack, in preference order. */
const PACK_WORLDS: Record<NamingPack, string[]> = {
  western: ['northern', 'sylvan', 'meridian', 'sandsea'],
  xianxia: ['cloudsea', 'island-court'],
  litrpg: ['void', 'foundry', 'northern'],
  modern: ['foundry', 'meridian', 'northern'],
};

export function detectPack(novel: Pick<Novel, 'premise' | 'styleNotes' | 'title'>): NamingPack {
  const text = `${novel.title} ${novel.premise} ${novel.styleNotes}`;
  for (const { pack, pattern } of GENRE_MARKERS) if (pattern.test(text)) return pack;
  return 'western';
}

/**
 * Which sound world this novel actually wants.
 *
 * This used to be a die roll over the pack's pool, and it was the single worst
 * thing in the feature: a novel about a frozen northern harbour came back
 * speaking a Mediterranean register, and a desert caliphate got elves. A
 * premise nearly always says where it is set — "salt", "fjord", "caravan",
 * "orbit" — so the words are there for the reading.
 *
 * Scored across every world rather than only the pack's own pool, because the
 * pack decides the SHAPE of a name and the setting decides its SOUND, and those
 * are genuinely independent: a cultivation novel set in a desert should have
 * sects with desert names. The pool is only a tie-break, for a premise that
 * gives nothing away.
 */
export function pickSoundWorld(
  novel: Pick<Novel, 'id' | 'premise' | 'styleNotes' | 'title'>,
  pack: NamingPack
): string {
  const text = `${novel.title} ${novel.premise} ${novel.styleNotes}`;

  let best = '';
  let bestScore = 0;
  for (const world of SOUND_WORLDS) {
    // Setting counts double, genre counts single. Both matter — a premise that
    // only says "cultivation sect" should still get the right sound — but a
    // premise that says where it is set has told us something more specific.
    const hits =
      2 * (text.match(new RegExp(world.cues.source, 'gi'))?.length ?? 0) +
      (world.genreCues ? (text.match(new RegExp(world.genreCues.source, 'gi'))?.length ?? 0) : 0);
    // Ties go to the earlier world in the catalog, which keeps this a pure
    // function of the text — a second novel with the same premise must not get
    // a different world.
    if (hits > bestScore) {
      bestScore = hits;
      best = world.id;
    }
  }
  if (best) return best;

  // The premise said nothing about where it is. Fall back to what the genre
  // usually sounds like, and only then to the novel id for variety across a
  // shelf of otherwise identical blank premises.
  const pool = PACK_WORLDS[pack].filter(isSoundWorldId);
  if (!pool.length) return DEFAULT_SOUND_WORLD_ID;
  return pool[Math.floor(mulberry32(fnv1a(`charter|${novel.id}`))() * pool.length)];
}

/**
 * A working charter for a novel that has never had one written.
 *
 * Pure, and deliberately never persisted. Turning naming on therefore costs no
 * model call, no key and no write — the feature works on the first chapter and
 * gets better if the author invests in it. Persisting this on read would freeze
 * a guess the author never made and then present it back to them as a choice.
 */
export function defaultCharter(novel: Pick<Novel, 'id' | 'premise' | 'styleNotes' | 'title'>): NamingCharter {
  const pack = detectPack(novel);
  const soundWorldId = pickSoundWorld(novel, pack);

  return {
    cultures: [
      {
        id: 'default',
        label: 'This world',
        soundWorldId,
        appliesTo: 'Everything, until the author says otherwise.',
      },
    ],
    pack,
    banned: [],
    notes: '',
    source: 'default',
    updatedAt: 0,
  };
}

/**
 * Which culture a request belongs to.
 *
 * The hint is free text from a model or an author — "the northern clans", "Ash
 * Compact", "sylvan". Matched against label and appliesTo, loosely, and falling
 * back to the first culture, which is why the first is documented as the
 * default rather than merely being first.
 */
export function resolveCulture(charter: NamingCharter, hint?: string | null): NamingCulture {
  const first = charter.cultures[0] ?? defaultCharter({ id: 'x', premise: '', styleNotes: '', title: '' }).cultures[0];
  const needle = (hint ?? '').trim().toLowerCase();
  if (!needle) return first;

  for (const culture of charter.cultures) {
    if (culture.id.toLowerCase() === needle || culture.label.toLowerCase() === needle) return culture;
  }
  // Then any culture whose label or scope contains a word of the hint, longest
  // word first so "the northern clans" matches on "northern" and not on "the".
  const words = needle.split(/[^a-z0-9]+/).filter((w) => w.length > 3).sort((a, b) => b.length - a.length);
  for (const word of words) {
    for (const culture of charter.cultures) {
      const hay = `${culture.label} ${culture.appliesTo} ${culture.id}`.toLowerCase();
      if (hay.includes(word)) return culture;
    }
  }
  return first;
}

/** Every sound world in play, for the prompt block. */
export function charterWorlds(charter: NamingCharter): string[] {
  return [...new Set(charter.cultures.map((c) => c.soundWorldId))];
}

export function isCharterPack(value: unknown): value is NamingPack {
  return isNamingPack(value);
}

/** Ids the UI offers. Re-exported so the routes need only one naming import. */
export const SOUND_WORLD_IDS: readonly string[] = SOUND_WORLDS.map((w) => w.id);
