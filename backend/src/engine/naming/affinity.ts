/**
 * Making a name mean the thing it is attached to.
 *
 * The generator's first version drew its semantic halves — element, body,
 * action — uniformly at random, which is correct for diversity and useless for
 * fiction. A technique described as "overwhelming, crushing strength" came back
 * as *Marrow Heel Art* and *The Ochre Rending*: phonotactically sound, in
 * register, and about nothing. A reader meeting that name learns nothing, and
 * the author has to rename it, which is the work this feature was supposed to
 * remove.
 *
 * So the brief is read for what the thing IS, and matching themes bias which
 * words the formulas draw from. "Crushing strength" reaches for Stone, Iron,
 * Fist and Breaking rather than Ochre and Marrow.
 *
 * Two things this deliberately is NOT:
 *
 * It is not a synonym lookup. The point is a *slant*, not a translation — a
 * technique about strength named *Iron Fist Form* every single time is its own
 * kind of failure, so matching words are preferred rather than required and a
 * quarter of draws still come from the whole bank.
 *
 * It is not exhaustive, and does not need to be. A brief that matches nothing
 * falls back to the uniform draw the generator started with, which is exactly
 * as good as it was before — so an unmatched theme costs nothing, and adding
 * one later is additive.
 */

import type { WordBanks } from './lexicons.js';

export interface Theme {
  id: string;
  /** Words in a brief that mean this theme is in play. */
  cues: RegExp;
  /** Words this theme reaches for, per bank. Need not exist — filtered on use. */
  prefer: Partial<Record<keyof WordBanks, string[]>>;
}

export const THEMES: readonly Theme[] = [
  {
    id: 'force',
    cues: /\b(strength|strong|crush\w*|overwhelm\w*|power\w*|might\w*|brute|heavy|weight|smash\w*|break\w*|shatter\w*|unstoppable|irresistible|titan\w*|colossal|hammer\w*|pulveris\w*|pulveriz\w*)/i,
    prefer: {
      element: ['Iron', 'Stone', 'Granite', 'Thunder', 'Storm', 'Lodestone'],
      body: ['Fist', 'Shoulder', 'Spine', 'Grip', 'Tread', 'Knuckle'],
      action: ['Shattering', 'Breaking', 'Crushing', 'Toppling', 'Rending', 'Unmaking'],
      craft: ['Hammer', 'Anvil', 'Millstone', 'Wedge', 'Forge', 'Vice'],
      animal: ['Bear', 'Ox', 'Bull', 'Ram', 'Boar', 'Auroch'],
      virtue: ['Weight', 'Wrath', 'Certainty'],
      color: ['Umber', 'Bone', 'Dun'],
    },
  },
  {
    id: 'speed',
    cues: /\b(speed|swift\w*|fast|quick\w*|sudden\w*|blink|dash\w*|flicker\w*|dart\w*|instant\w*|lightning|nimble|agil\w*|evasi\w*|reflex\w*)/i,
    prefer: {
      element: ['Gale', 'Storm', 'Thunder', 'Steam'],
      body: ['Step', 'Heel', 'Tread', 'Wrist', 'Breath'],
      action: ['Racing', 'Parting', 'Vanishing', 'Piercing', 'Turning'],
      animal: ['Swift', 'Hare', 'Kite', 'Falcon', 'Shrike', 'Wren'],
      craft: ['Needle', 'Awl', 'Bit'],
      color: ['Grey', 'Pale'],
    },
  },
  {
    id: 'cold',
    cues: /\b(cold|ice|icy|frost\w*|freez\w*|frozen|winter|snow\w*|chill\w*|glacial|numb\w*|sleet|hoar)/i,
    prefer: {
      element: ['Frost', 'Rime', 'Sleet', 'Glass', 'Quartz', 'Chalk'],
      action: ['Stilling', 'Quenching', 'Silencing', 'Weathering'],
      body: ['Breath', 'Lung', 'Marrow'],
      color: ['Pale', 'Bone', 'Indigo', 'Grey'],
      virtue: ['Stillness', 'Patience', 'Restraint'],
      celestial: ['Deepwinter', 'Longnight', 'Waning Moon'],
    },
  },
  {
    id: 'fire',
    cues: /\b(fire|flame\w*|burn\w*|blaz\w*|scorch\w*|ember\w*|inferno|heat|molten|forge\w*|ash|smoulder\w*|smolder\w*|pyre)/i,
    prefer: {
      element: ['Ember', 'Cinder', 'Ash', 'Smoke', 'Steam', 'Tar', 'Pitch'],
      action: ['Kindling', 'Devouring', 'Unmaking', 'Hollowing'],
      craft: ['Forge', 'Kiln', 'Crucible', 'Bellows', 'Lantern'],
      color: ['Vermilion', 'Carmine', 'Russet', 'Ochre'],
      virtue: ['Wrath', 'Hunger', 'Appetite'],
    },
  },
  {
    id: 'water',
    cues: /\b(water|sea|ocean|tide\w*|wave\w*|river|flood\w*|drown\w*|rain|current|harbour|harbor|salt|brine|ship\w*|sail\w*|deep)/i,
    prefer: {
      element: ['Tide', 'Brine', 'Salt', 'Storm', 'Rime'],
      terrain: ['Shoal', 'Strand', 'Narrows', 'Fen', 'Basin'],
      action: ['Drowning', 'Smothering', 'Folding', 'Bearing'],
      animal: ['Carp', 'Eel', 'Heron', 'Lamprey'],
      craft: ['Sluice', 'Winch', 'Cask'],
    },
  },
  {
    id: 'earth',
    cues: /\b(earth|stone|rock|mountain|ground|root\w*|soil|cave|deep earth|granite|tremor|quake|buried|unmov\w*|immov\w*|endur\w*)/i,
    prefer: {
      element: ['Stone', 'Granite', 'Loam', 'Flint', 'Quartz', 'Chalk', 'Lodestone'],
      terrain: ['Crag', 'Ridge', 'Barrow', 'Scarp', 'Basin'],
      body: ['Root', 'Tread', 'Spine', 'Marrow'],
      action: ['Bearing', 'Weathering', 'Stilling'],
      virtue: ['Endurance', 'Patience', 'Weight', 'Certainty'],
    },
  },
  {
    id: 'death',
    cues: /\b(death|dead|dying|kill\w*|corpse\w*|grave\w*|tomb\w*|rot\w*|decay\w*|wither\w*|undead|necro\w*|funeral|mourn\w*|ghost\w*)/i,
    prefer: {
      element: ['Marrow', 'Ash', 'Tar', 'Pitch'],
      terrain: ['Barrow', 'Fen', 'Hollow', 'Moor'],
      action: ['Unmaking', 'Hollowing', 'Severing', 'Devouring', 'Smothering'],
      animal: ['Crow', 'Lamprey', 'Moth', 'Jackal'],
      virtue: ['Sorrow', 'Reckoning', 'Ruin', 'Debt'],
      color: ['Bone', 'Sable', 'Umber'],
    },
  },
  {
    id: 'shadow',
    cues: /\b(shadow\w*|dark\w*|stealth\w*|hidden|hide|conceal\w*|secret\w*|silent\w*|assassin\w*|thief|thieves|steal\w*|unseen|invisib\w*|night)/i,
    prefer: {
      element: ['Smoke', 'Pitch', 'Tar', 'Ash'],
      action: ['Vanishing', 'Silencing', 'Smothering', 'Parting'],
      animal: ['Moth', 'Marten', 'Owl', 'Viper', 'Badger'],
      color: ['Sable', 'Indigo', 'Umber'],
      virtue: ['Silence', 'Cunning', 'Restraint'],
      celestial: ['Longnight', 'Eclipse', 'Waning Moon'],
    },
  },
  {
    id: 'mind',
    cues: /\b(mind\w*|memor\w*|illusion\w*|dream\w*|thought\w*|madness|insan\w*|psychic|telepath\w*|charm\w*|persuad\w*|deceiv\w*|deception|trick\w*)/i,
    prefer: {
      element: ['Glass', 'Smoke', 'Steam'],
      body: ['Eye', 'Gaze', 'Throat', 'Breath'],
      action: ['Folding', 'Turning', 'Waking', 'Vanishing', 'Answering'],
      craft: ['Lens', 'Loom', 'Key', 'Spindle'],
      virtue: ['Cunning', 'Doubt', 'Candour'],
    },
  },
  {
    id: 'life',
    cues: /\b(heal\w*|health|life|living|restor\w*|mend\w*|cure\w*|regenerat\w*|growth|grow\w*|bloom\w*|spring|renew\w*)/i,
    prefer: {
      element: ['Sap', 'Loam', 'Lime'],
      action: ['Mending', 'Waking', 'Kindling', 'Answering'],
      body: ['Root', 'Lung', 'Sinew', 'Breath'],
      virtue: ['Mercy', 'Patience', 'Forbearance'],
      celestial: ['First Light', 'Aurora', 'Highsummer'],
    },
  },
  {
    id: 'poison',
    cues: /\b(poison\w*|venom\w*|toxic|toxin\w*|plague\w*|disease\w*|sick\w*|rot\w*|corros\w*|acid|blight\w*)/i,
    prefer: {
      element: ['Tar', 'Pitch', 'Brine', 'Sap'],
      animal: ['Viper', 'Adder', 'Lamprey', 'Moth'],
      action: ['Withering', 'Smothering', 'Hollowing', 'Devouring'],
      color: ['Verdigris', 'Ochre', 'Dun'],
      virtue: ['Ruin', 'Hunger'],
    },
  },
  {
    id: 'blood',
    cues: /\b(blood\w*|vein\w*|sacrific\w*|butcher\w*|slaughter\w*|wound\w*|scar\w*|carnage|gore)/i,
    prefer: {
      element: ['Marrow', 'Brine', 'Iron'],
      body: ['Marrow', 'Sinew', 'Throat', 'Jaw'],
      action: ['Severing', 'Cleaving', 'Rending', 'Piercing'],
      color: ['Carmine', 'Vermilion', 'Russet'],
      virtue: ['Debt', 'Wrath', 'Reckoning'],
    },
  },
  {
    id: 'war',
    cues: /\b(war|battle\w*|blade\w*|sword\w*|spear\w*|siege\w*|soldier\w*|army|armies|duel\w*|combat|fight\w*|strike\w*|guard\w*|defen[cs]\w*|shield\w*)/i,
    prefer: {
      element: ['Iron', 'Flint', 'Storm'],
      body: ['Grip', 'Stance', 'Shoulder', 'Wrist', 'Heel'],
      action: ['Cleaving', 'Piercing', 'Parting', 'Answering', 'Bearing'],
      craft: ['Anvil', 'Wedge', 'Chain', 'Hammer'],
      animal: ['Boar', 'Falcon', 'Hound', 'Ram'],
    },
  },
  {
    id: 'trade',
    cues: /\b(trade\w*|merchant\w*|money|coin\w*|debt\w*|bank\w*|ledger\w*|contract\w*|law\w*|court\w*|guild\w*|tax\w*|smuggl\w*|cargo|shipment|charter\w*)/i,
    prefer: {
      craft: ['Ledger', 'Tally', 'Key', 'Chain', 'Cask', 'Winch'],
      virtue: ['Debt', 'Fidelity', 'Consequence', 'Certainty'],
      title: ['Compact', 'Company', 'Concord', 'Guild', 'League', 'Charterhouse'],
      terrain: ['Narrows', 'Strand', 'Flats'],
    },
  },
  {
    /*
     * A brief that says "school" should be able to produce a school.
     *
     * The words themselves went into the title bank in lexicons.ts, which is
     * what makes them reachable at all. This is what makes them LIKELY when
     * they are what was asked for — without it, six institutional words among
     * twenty would surface about a third of the time by luck, and an author
     * who asked for an academy and got eight guilds and houses would draw the
     * same conclusion they drew the first time.
     *
     * THEME_PULL still leaves room for the invented and oblique candidates on
     * the same slate. A mix is the point: an author asking for a school wants
     * to see both what it would plainly be called and what else it could be.
     */
    id: 'learning',
    cues: /\b(school\w*|academ\w*|college\w*|universit\w*|institute\w*|seminar\w*|conservator\w*|teach\w*|taught|tutor\w*|train(?:ing|ed|s)?\b|instruct\w*|student\w*|pupil\w*|apprentice\w*|novice\w*|scholar\w*|study|studies|lesson\w*|classroom\w*|curricul\w*)/i,
    prefer: {
      title: ['School', 'Academy', 'College', 'Institute', 'Conservatory', 'Seminary', 'Circle', 'Chapter'],
      craft: ['Lantern', 'Lens', 'Ledger', 'Loom', 'Awl'],
      virtue: ['Patience', 'Restraint', 'Certainty'],
    },
  },
] as const;

/** Every theme the brief mentions. Usually none or one; occasionally two. */
export function themesFor(brief: string): Theme[] {
  if (!brief.trim()) return [];
  return THEMES.filter((t) => t.cues.test(brief));
}

/**
 * The words a matched set of themes reaches for in one bank, filtered to what
 * the bank actually holds — a sound world may override a bank, so a preference
 * naming a word that world does not have must quietly drop rather than sneak a
 * foreign word into its register.
 */
export function preferredWords(
  themes: readonly Theme[],
  bank: keyof WordBanks,
  available: readonly string[]
): string[] {
  if (!themes.length) return [];
  const wanted = new Set<string>();
  for (const theme of themes) for (const word of theme.prefer[bank] ?? []) wanted.add(word);
  return available.filter((word) => wanted.has(word));
}
