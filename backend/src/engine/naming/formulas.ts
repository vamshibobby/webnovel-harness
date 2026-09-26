/**
 * Naming formulas — the shapes a name can take once its sounds are settled.
 *
 * A sound world says what a coined stem may sound like. A formula says what the
 * finished name is made of: a coined stem alone, a stem plus a place generic, a
 * colour plus a trade object, a numeral plus an element plus a body part. This
 * is the layer that makes "Nine Flames Palm" a cultivation technique and
 * "[Enhanced Sinew]" a LitRPG skill out of the same machinery.
 *
 * ONE taxonomy, not two: a formula declares both the entity types it serves and
 * the genre pack it belongs to, and selection is a filter over the array. The
 * author only ever picks the pack.
 *
 * Formulas are also where the specification-level diversity actually lives. The
 * generator draws a formula BEFORE it draws any sounds, so two calls for the
 * same location can come back with "Skarrholt" and "The Salt Narrows" — names
 * that differ in construction, not just in spelling. Randomness applied after
 * the shape is fixed only ever produces variants of one idea, which is the
 * failure this whole feature exists to avoid.
 */

import type { BibleEntryType } from '../../lib/types.js';
import type { WordBanks } from './lexicons.js';

/**
 * Genre packs. `any` formulas are always in play; the rest join only when the
 * charter names their pack, so a cultivation novel never gets offered a LitRPG
 * bracket skill.
 */
export type NamingPack = 'western' | 'xianxia' | 'litrpg' | 'modern';

export type Slot =
  /** A generated non-word from the culture's sound world. Always capitalised. */
  | { kind: 'coined' }
  /** A one-syllable coined root — family names, sect roots. */
  | { kind: 'coined-short' }
  /**
   * A REAL given name or surname, from the corpus in personNames.ts, in the
   * language this novel's culture draws people from.
   *
   * Only ever on person formulas, and that boundary is the whole point: a
   * reader has to be able to say a character's name out loud forty chapters
   * running, which is a constraint syllable assembly cannot meet — it produced
   * Fler Pucloll and Grestayn the Falcon. A sect, a sword or a mountain has no
   * such constraint and keeps the coiner, because an invented name is what
   * carries the world's register.
   *
   * Both fall back to a coined stem when the world has no pool ('void' names
   * machines) so a formula is never unbuildable.
   */
  | { kind: 'given' }
  /**
   * A second given name, drawn so it cannot repeat one already in this name.
   * Its own kind rather than a flag on `given` so that no existing formula's
   * draw sequence moves — these names are seeded and reproducible, and a
   * shared code path would have renamed casts in novels already written.
   */
  | { kind: 'given-second' }
  | { kind: 'family' }
  | { kind: 'bank'; bank: keyof WordBanks }
  /** A place generic from the sound world: "holt", "wadi", "Yard". */
  | { kind: 'generic' }
  /**
   * A whole compound place name in one slot — coined stem welded to a generic,
   * "Skarrholt". Exists so a formula that spaces its parts can still contain a
   * place name that does not fall apart into two words.
   */
  | { kind: 'place' }
  | { kind: 'literal'; options: string[] };

export interface Formula {
  id: string;
  types: readonly BibleEntryType[];
  pack: NamingPack | 'any';
  slots: readonly Slot[];
  /** '' compounds the pieces into one word; ' ' spaces them. */
  join: '' | ' ';
  /** Relative likelihood within the eligible set. */
  weight: number;
  /** How it was built, in three or four words. Shown beside the candidate. */
  gloss: string;
  /** Wraps the finished name. LitRPG system output is bracketed. */
  wrap?: readonly [string, string];
}

const PERSON: readonly BibleEntryType[] = ['character'];
const PLACE: readonly BibleEntryType[] = ['location'];
const GROUP: readonly BibleEntryType[] = ['faction'];
const THING: readonly BibleEntryType[] = ['item', 'weapon'];
const BEAST: readonly BibleEntryType[] = ['creature'];
const ART: readonly BibleEntryType[] = ['technique'];
const IDEA: readonly BibleEntryType[] = ['concept'];
const HAPPENING: readonly BibleEntryType[] = ['event'];

const NUMERALS = ['Three', 'Five', 'Seven', 'Nine', 'Twelve', 'Thirty-Six', 'Eighty-One'];

export const FORMULAS: readonly Formula[] = [
  // ── People ──────────────────────────────────────────────────────────────
  { id: 'person-given', types: PERSON, pack: 'any', slots: [{ kind: 'given' }], join: '', weight: 3, gloss: 'given name alone' },
  {
    id: 'person-full',
    types: PERSON,
    pack: 'any',
    // The workhorse, and weighted to say so. A cast is mostly people with a
    // first and a last name; the epithets below are seasoning.
    slots: [{ kind: 'given' }, { kind: 'family' }],
    join: ' ',
    weight: 9,
    gloss: 'given name + family name',
  },
  /*
   * `person-epithet` — given name + "the" + an animal — used to live here.
   *
   * It was cut to weight 1 after a slate came back four-sixths bestiary, and
   * removed outright when it kept surfacing anyway: at one in ten it still put
   * "Nicanor the Falcon" and "Gema the Wolf" in the same slate of eight, and an
   * author reading a cast list does not average over draws. A person's name is
   * the one kind here that has to survive being said in dialogue and attached
   * to a speech tag for forty chapters, and "X the Mantis" is a label a story
   * earns for someone, not a name they are given.
   *
   * Nothing replaces it. An epithet a character has actually earned is a fine
   * thing for a chapter to invent in prose; it is not something to hand an
   * author as a candidate before the character exists.
   *
   * The pack-gated forms below are deliberately kept. `person-designation` is
   * how a LitRPG system addresses people and `person-daohao` is a cultivation
   * title — both are conventions of the genre their pack names, not this
   * failure wearing a different hat, and both are off unless that pack is on.
   */
  {
    id: 'person-full-middle',
    types: PERSON,
    pack: 'any',
    // Two given names and a family name. Weighted below the plain full name
    // because most people in most books are introduced with two, and a cast
    // where everyone has a middle name reads as a register of births.
    slots: [{ kind: 'given' }, { kind: 'given-second' }, { kind: 'family' }],
    join: ' ',
    weight: 3,
    gloss: 'given + middle + family name',
  },
  {
    id: 'person-trade',
    types: PERSON,
    pack: 'modern',
    slots: [{ kind: 'given' }, { kind: 'bank', bank: 'trade' }],
    join: ' ',
    weight: 2,
    gloss: 'given name + trade surname',
  },
  {
    id: 'person-clan-given',
    types: PERSON,
    pack: 'xianxia',
    // Family first, which is the register: Wei Ying, not Ying Wei. The cloudsea
    // pool is Chinese and Korean precisely because both work this way round.
    slots: [{ kind: 'family' }, { kind: 'given' }],
    join: ' ',
    weight: 5,
    gloss: 'family name + given name',
  },
  {
    id: 'person-daohao',
    types: PERSON,
    pack: 'xianxia',
    slots: [
      { kind: 'bank', bank: 'element' },
      { kind: 'literal', options: ['Sovereign', 'Monarch', 'Venerable', 'Ancestor', 'Patriarch', 'Matriarch'] },
      { kind: 'literal', options: ['of'] },
      { kind: 'bank', bank: 'celestial' },
    ],
    join: ' ',
    weight: 2,
    gloss: 'cultivation title, earned at a realm',
  },
  {
    id: 'person-designation',
    types: PERSON,
    pack: 'litrpg',
    slots: [{ kind: 'given' }, { kind: 'literal', options: ['the'] }, { kind: 'bank', bank: 'trade' }],
    join: ' ',
    weight: 2,
    gloss: 'name + the handle the system knows them by',
  },

  // ── Places ──────────────────────────────────────────────────────────────
  {
    id: 'place-stem-generic',
    types: PLACE,
    pack: 'any',
    slots: [{ kind: 'coined' }, { kind: 'generic' }],
    join: '',
    weight: 6,
    gloss: 'coined stem + place generic',
  },
  {
    id: 'place-element-generic',
    types: PLACE,
    pack: 'any',
    slots: [{ kind: 'bank', bank: 'element' }, { kind: 'generic' }],
    join: '',
    weight: 3,
    gloss: 'plain-word compound',
  },
  {
    id: 'place-the-element-terrain',
    types: PLACE,
    pack: 'any',
    slots: [{ kind: 'literal', options: ['The'] }, { kind: 'bank', bank: 'element' }, { kind: 'bank', bank: 'terrain' }],
    join: ' ',
    weight: 3,
    gloss: 'the + quality + landform',
  },
  {
    id: 'place-stem-terrain',
    types: PLACE,
    pack: 'any',
    slots: [{ kind: 'coined' }, { kind: 'bank', bank: 'terrain' }],
    join: ' ',
    weight: 3,
    gloss: 'coined stem + landform',
  },
  {
    id: 'place-stem-spaced-generic',
    types: PLACE,
    pack: 'any',
    slots: [{ kind: 'coined' }, { kind: 'generic' }],
    join: ' ',
    weight: 2,
    gloss: 'coined stem + named generic',
  },
  {
    id: 'place-element-terrain-cn',
    types: PLACE,
    pack: 'xianxia',
    slots: [{ kind: 'bank', bank: 'element' }, { kind: 'generic' }],
    join: ' ',
    weight: 4,
    gloss: 'element + the sect ground it names',
  },

  // ── Factions ────────────────────────────────────────────────────────────
  {
    id: 'faction-title-stem',
    types: GROUP,
    pack: 'any',
    // A literal short list rather than the title bank: "House Venn" reads, and
    // "Concord Venn" does not. Only a handful of these words work in front.
    slots: [
      { kind: 'literal', options: ['House', 'Clan', 'Order', 'Company', 'Bank', 'Court'] },
      { kind: 'coined' },
    ],
    join: ' ',
    weight: 4,
    gloss: 'title + family or founder name',
  },
  {
    id: 'faction-the-element-title',
    types: GROUP,
    pack: 'any',
    slots: [{ kind: 'literal', options: ['The'] }, { kind: 'bank', bank: 'element' }, { kind: 'bank', bank: 'title' }],
    join: ' ',
    weight: 4,
    gloss: 'the + quality + kind of body',
  },
  {
    id: 'faction-stem-title',
    types: GROUP,
    pack: 'any',
    slots: [{ kind: 'coined' }, { kind: 'bank', bank: 'title' }],
    join: ' ',
    weight: 3,
    gloss: 'place or founder + kind of body',
  },
  {
    id: 'faction-craft-title',
    types: GROUP,
    pack: 'modern',
    // A guild is named for the trade, not the tool: the Coopers' Company.
    slots: [{ kind: 'bank', bank: 'trade' }, { kind: 'bank', bank: 'title' }],
    join: ' ',
    weight: 2,
    gloss: 'what they handle + kind of body',
  },
  {
    id: 'faction-element-sect',
    types: GROUP,
    pack: 'xianxia',
    slots: [{ kind: 'bank', bank: 'color' }, { kind: 'bank', bank: 'element' }, { kind: 'bank', bank: 'title' }],
    join: ' ',
    weight: 4,
    gloss: 'colour + element + sect',
  },

  // ── Weapons and items ───────────────────────────────────────────────────
  {
    id: 'thing-the-color-craft',
    types: THING,
    pack: 'any',
    slots: [{ kind: 'literal', options: ['The'] }, { kind: 'bank', bank: 'color' }, { kind: 'bank', bank: 'craft' }],
    join: ' ',
    weight: 3,
    gloss: 'the + colour + object',
  },
  {
    id: 'thing-element-craft',
    types: THING,
    pack: 'any',
    slots: [{ kind: 'bank', bank: 'element' }, { kind: 'bank', bank: 'craft' }],
    join: ' ',
    weight: 3,
    gloss: 'material or quality + object',
  },
  {
    id: 'thing-stem-craft',
    types: THING,
    pack: 'any',
    slots: [{ kind: 'coined' }, { kind: 'bank', bank: 'craft' }],
    join: ' ',
    weight: 3,
    gloss: 'maker or owner + object',
  },
  {
    id: 'thing-cn-artefact',
    types: THING,
    pack: 'xianxia',
    slots: [
      { kind: 'bank', bank: 'color' },
      { kind: 'bank', bank: 'element' },
      { kind: 'literal', options: ['Sword', 'Blade', 'Fan', 'Bell', 'Spear', 'Chain', 'Seal', 'Mirror', 'Cauldron'] },
    ],
    join: ' ',
    weight: 4,
    gloss: 'colour + element + object',
  },
  {
    id: 'thing-litrpg',
    types: THING,
    pack: 'litrpg',
    slots: [
      { kind: 'literal', options: ['Greater', 'Lesser', 'Reinforced', 'Attuned', 'Cracked', 'Unbound'] },
      { kind: 'bank', bank: 'craft' },
    ],
    join: ' ',
    weight: 3,
    gloss: 'system tier + object',
    wrap: ['[', ']'],
  },

  // ── Creatures ───────────────────────────────────────────────────────────
  {
    id: 'beast-color-animal',
    types: BEAST,
    pack: 'any',
    slots: [{ kind: 'bank', bank: 'color' }, { kind: 'bank', bank: 'animal' }],
    join: ' ',
    weight: 4,
    gloss: 'colour + the beast it resembles',
  },
  {
    id: 'beast-terrain-animal',
    types: BEAST,
    pack: 'any',
    slots: [{ kind: 'bank', bank: 'terrain' }, { kind: 'bank', bank: 'animal' }],
    join: ' ',
    weight: 3,
    gloss: 'where it lives + what it is like',
  },
  {
    id: 'beast-stem-animal',
    types: BEAST,
    pack: 'any',
    slots: [{ kind: 'coined' }, { kind: 'bank', bank: 'animal' }],
    join: ' ',
    weight: 3,
    gloss: 'local word + the beast it resembles',
  },

  // ── Techniques ──────────────────────────────────────────────────────────
  {
    id: 'art-the-color-action',
    types: ART,
    pack: 'any',
    slots: [{ kind: 'literal', options: ['The'] }, { kind: 'bank', bank: 'color' }, { kind: 'bank', bank: 'action' }],
    join: ' ',
    weight: 3,
    gloss: 'the + colour + what it does',
  },
  {
    id: 'art-element-body',
    types: ART,
    pack: 'any',
    slots: [
      { kind: 'bank', bank: 'element' },
      { kind: 'bank', bank: 'body' },
      { kind: 'literal', options: ['Form', 'Art', 'Method', 'Guard', 'Stance'] },
    ],
    join: ' ',
    weight: 3,
    gloss: 'element + body + kind of art',
  },
  {
    id: 'art-stem-form',
    types: ART,
    pack: 'any',
    slots: [
      { kind: 'coined' },
      { kind: 'literal', options: ['Form', 'Guard', 'Stance', 'Grip', 'Line', 'Opening'] },
    ],
    join: ' ',
    weight: 4,
    gloss: 'who devised it + kind of form',
  },
  {
    id: 'art-animal-action',
    types: ART,
    pack: 'any',
    slots: [{ kind: 'bank', bank: 'animal' }, { kind: 'bank', bank: 'action' }],
    join: ' ',
    weight: 2,
    gloss: 'the creature it copies + what it does',
  },
  {
    id: 'art-cn-numbered',
    types: ART,
    pack: 'xianxia',
    slots: [
      { kind: 'literal', options: NUMERALS },
      { kind: 'bank', bank: 'element' },
      { kind: 'bank', bank: 'action' },
    ],
    join: ' ',
    weight: 4,
    gloss: 'sacred number + element + action',
  },
  {
    id: 'art-cn-sutra',
    types: ART,
    pack: 'xianxia',
    slots: [
      { kind: 'bank', bank: 'element' },
      { kind: 'bank', bank: 'body' },
      { kind: 'literal', options: ['Sutra', 'Scripture', 'Canon', 'Path', 'Art'] },
    ],
    join: ' ',
    weight: 4,
    gloss: 'element + body + scripture',
  },
  {
    id: 'art-cn-animal',
    types: ART,
    pack: 'xianxia',
    slots: [{ kind: 'bank', bank: 'animal' }, { kind: 'bank', bank: 'body' }],
    join: ' ',
    weight: 3,
    gloss: 'creature + the part that moves',
  },
  {
    id: 'art-litrpg-skill',
    types: ART,
    pack: 'litrpg',
    slots: [{ kind: 'bank', bank: 'element' }, { kind: 'literal', options: ['Strike', 'Ward', 'Sense', 'Step', 'Bolt', 'Shield', 'Mark', 'Surge', 'Lash'] }],
    join: ' ',
    weight: 5,
    gloss: 'system skill, bracketed as the interface prints it',
    wrap: ['[', ']'],
  },
  {
    id: 'art-litrpg-enhanced',
    types: ART,
    pack: 'litrpg',
    slots: [
      { kind: 'literal', options: ['Enhanced', 'Adaptive', 'Reflexive', 'Passive', 'Latent', 'Overclocked'] },
      { kind: 'bank', bank: 'body' },
    ],
    join: ' ',
    weight: 3,
    gloss: 'system modifier + what it acts on',
    wrap: ['[', ']'],
  },

  // ── Concepts ────────────────────────────────────────────────────────────
  {
    id: 'idea-element-virtue',
    types: IDEA,
    pack: 'any',
    slots: [{ kind: 'bank', bank: 'element' }, { kind: 'bank', bank: 'virtue' }],
    join: ' ',
    weight: 3,
    gloss: 'the thing it is made of + what it demands',
  },
  {
    id: 'idea-the-craft-virtue',
    types: IDEA,
    pack: 'any',
    slots: [{ kind: 'literal', options: ['The'] }, { kind: 'bank', bank: 'craft' }, { kind: 'bank', bank: 'virtue' }],
    join: ' ',
    weight: 3,
    gloss: 'the + object it turns on + what it demands',
  },
  {
    id: 'idea-stem-law',
    types: IDEA,
    pack: 'any',
    slots: [
      { kind: 'coined' },
      { kind: 'literal', options: ['Law', 'Rite', 'Accord', 'Doctrine', 'Tithe', 'Custom'] },
    ],
    join: ' ',
    weight: 4,
    gloss: 'where it was written + kind of rule',
  },

  // ── Events ──────────────────────────────────────────────────────────────
  {
    id: 'event-the-color-action',
    types: HAPPENING,
    pack: 'any',
    slots: [{ kind: 'literal', options: ['The'] }, { kind: 'bank', bank: 'color' }, { kind: 'bank', bank: 'action' }],
    join: ' ',
    weight: 3,
    gloss: 'the + colour it is remembered by + what happened',
  },
  {
    id: 'event-celestial-action',
    types: HAPPENING,
    pack: 'any',
    slots: [{ kind: 'bank', bank: 'celestial' }, { kind: 'bank', bank: 'action' }],
    join: ' ',
    weight: 3,
    gloss: 'when it happened + what happened',
  },
  {
    id: 'event-action-at-place',
    types: HAPPENING,
    pack: 'any',
    slots: [
      { kind: 'literal', options: ['The'] },
      { kind: 'bank', bank: 'action' },
      { kind: 'literal', options: ['at'] },
      { kind: 'place' },
    ],
    join: ' ',
    weight: 3,
    gloss: 'what happened + where',
  },
];

/**
 * The formulas in play for one request. `any` always; the charter's pack on top.
 * Never returns empty for a valid type — every type has at least three `any`
 * formulas, which is what lets the generator promise a non-empty slate.
 */
export function eligibleFormulas(type: BibleEntryType, pack: NamingPack): Formula[] {
  return FORMULAS.filter((f) => f.types.includes(type) && (f.pack === 'any' || f.pack === pack));
}

export const NAMING_PACKS: readonly NamingPack[] = ['western', 'xianxia', 'litrpg', 'modern'];

/** Author-facing labels for the pack picker. */
export const PACK_LABELS: Record<NamingPack, { label: string; blurb: string }> = {
  western: {
    label: 'Western fantasy',
    blurb: 'Coined stems, place generics, houses and orders. The default.',
  },
  xianxia: {
    label: 'Cultivation',
    blurb: 'Sects, dao titles, numbered techniques, colour-and-element artefacts.',
  },
  litrpg: {
    label: 'LitRPG / System',
    blurb: 'Bracketed skills in title case, tiered items, system handles.',
  },
  modern: {
    label: 'Modern / industrial',
    blurb: 'Trade surnames, plain compounds, companies and bureaus.',
  },
};

export function isNamingPack(value: unknown): value is NamingPack {
  return typeof value === 'string' && (NAMING_PACKS as readonly string[]).includes(value);
}
