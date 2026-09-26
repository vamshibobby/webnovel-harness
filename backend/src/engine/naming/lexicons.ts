/**
 * Sound worlds — the phoneme inventories names are built out of.
 *
 * This is the catalog the whole naming feature stands on, and it exists in code
 * rather than in a prompt for a measured reason: byte-pair tokenization means a
 * model cannot reliably honour "two syllables, hard consonants, no sibilants"
 * however firmly it is asked. Phonotactics have to be *enforced*, so they are
 * data here and a filter in generator.ts, and the model never sees an inventory
 * at all — only finished candidates and, in the system prompt, three sample
 * names that demonstrate the register.
 *
 * Two consumers, like designCatalog.ts:
 *  - the author picks a sound world per culture when editing the charter;
 *  - the generator draws from it.
 *
 * `frontend/src/lib/namingCatalog.ts` mirrors the id/label/blurb fields — and
 * only those, because an inventory in the browser bundle is dead weight. A test
 * pins the two together.
 *
 * A note on what these are NOT: they are not real languages and they are not
 * claims about real ones. "Sand-sea" is a set of sounds English readers hear as
 * arid and old, assembled so the generator produces pronounceable non-words in
 * that register. Naming a donor language would promise a linguistic accuracy
 * eight hand-written arrays cannot deliver.
 */

/**
 * Semantic word banks. These are the meaningful halves of compound names —
 * "Nine Flames Rebirth", "Ironmarch", "the Ash Compact" — so they are English
 * words rather than coined ones, and mostly shared across sound worlds. A world
 * overrides only the banks where its register genuinely differs.
 */
export interface WordBanks {
  /** Landforms and features, for place compounds. */
  terrain: string[];
  /** The classical elements plus weather. */
  element: string[];
  animal: string[];
  /** Abstract qualities, for factions, techniques and titles. */
  virtue: string[];
  color: string[];
  /** Sky, time and the very large. */
  celestial: string[];
  /** Ranks, orders and honorifics. */
  title: string[];
  /** Tools and made things: an Anvil, a Rasp, a Millstone. */
  craft: string[];
  /**
   * The PERSON who does the trade, not the tool they do it with — Cooper,
   * Fletcher, Loriner. Split out of `craft` because the two cannot share a
   * bank: `person-trade` wants "Elias Cooper" and `thing-element-craft` wants
   * "Stone Rasp", and one list serving both produced "Stone Tanner", which
   * reads as a man rather than an object. These are also, not coincidentally,
   * where occupational surnames come from.
   */
  trade: string[];
  /** Body and stance words, which technique names lean on heavily. */
  body: string[];
  /** Verbs in their naming form — "Shattering", "Piercing". */
  action: string[];
}

/** A toponymic or nominal generic: the "-ford" in Oxford, with its sense. */
export interface Generic {
  text: string;
  gloss: string;
}

/**
 * One syllable's shape. `C` draws an onset (which may itself be a cluster),
 * `V` a nucleus, and a trailing `C` a coda. Kept to four shapes because a
 * fifth buys variety the ear cannot hear.
 */
export type SyllableShape = 'V' | 'CV' | 'VC' | 'CVC';

export interface Template {
  shape: SyllableShape[];
  /** Relative likelihood. Two-syllable names should dominate; they read as names. */
  weight: number;
}

export interface SoundWorld {
  id: string;
  label: string;
  /** One line the author reads while choosing, and the register line in the prompt. */
  blurb: string;
  /**
   * Words in a premise that mean "this world sounds like this".
   *
   * The default charter used to draw a sound world at random from the genre's
   * pool, which gave a novel set on a frozen northern coast the vowels of a
   * Mediterranean republic. A premise almost always says where it is; scoring
   * these against it costs nothing and is right far more often than a die.
   */
  cues: RegExp;
  /**
   * Words that suggest this world through GENRE rather than setting, and count
   * for half. A cultivation novel set in a desert should keep its sect
   * structure and take the desert's sound — so "sect" and "qi" must not outvote
   * "dune" and "caravan".
   */
  genreCues?: RegExp;
  /** How the names are built, in a sentence the model can hold while writing. */
  shape: string;
  onsets: string[];
  nuclei: string[];
  /** `''` is a legal coda — it is what makes a syllable open. */
  codas: string[];
  templates: Template[];
  /** Rejected outright. Tested against the assembled lowercase string. */
  illegal: RegExp[];
  /** Place generics for compound toponyms. */
  generics: Generic[];
  /** Overrides merged over DEFAULT_BANKS. */
  banks?: Partial<WordBanks>;
}

/**
 * Runs no ear will accept in any of these worlds. Per-world lists add to this
 * rather than repeat it.
 */
const UNIVERSALLY_ILLEGAL: RegExp[] = [
  /(.)\1\1/, // three of anything
  /[bcdfghjklmnpqrstvwxz]{4}/, // a four-consonant pile-up
  // Three vowels in a row is where "Huuanfiefo" and "Niaowiun" came from. Every
  // world here has multi-letter nuclei, and two of them meeting across a
  // syllable boundary produces something no reader can pronounce on sight.
  /[aeiou]{3}/,
  /^[^a-z]/,
];

/*
 * ── On the size of these lists ────────────────────────────────────────────
 *
 * They were roughly a third this size, and the shortfall showed up the way a
 * small bank always does: not as a bad name, but as the same good name arriving
 * again three chapters later. A formula draws one word per slot, so a bank of
 * twenty is twenty ways for a faction to end, and a novel that names forty
 * things will visibly reuse them.
 *
 * Where the words came from matters more than how many there are, so each bank
 * says. Sourcing real inventories rather than inventing sixty synonyms is what
 * keeps the register honest: an author reading "Loriner" or "Realgar" is
 * reading a word that had a job for centuries, and a reader who does not know
 * it still hears that it is not decoration.
 *
 * Two hard constraints on anything added here, both enforced by naming.test.ts:
 *
 *   Nothing may collide with the slop list in blocklist.ts, or the generator
 *   would offer a word its own filter rejects.
 *
 *   Nothing may end in a SUFFIX_TELL — `-ium`, `-iel`, `-wyn`, `-yth`. Those
 *   are tested against the whole assembled candidate, so one such word makes
 *   EVERY name that ends in it unbuildable. `Consortium` sat in the void bank
 *   doing exactly that until a check for it was written; it is now `Combine`.
 */
export const DEFAULT_BANKS: WordBanks = {
  /*
   * Landforms. The additions are Norse and Old English toponymic elements still
   * living in British place names — beck, fell, gill, tarn, howe, rigg, scar,
   * thwaite, keld, wath — which is the vocabulary English fantasy toponyms are
   * already unconsciously built from. Real ones compound better than invented
   * ones because English has been compounding them for a thousand years.
   */
  terrain: [
    'Reach', 'Hollow', 'Ridge', 'Fen', 'Moor', 'Delve', 'Crag', 'Shoal', 'Barrow', 'Vale',
    'Spire', 'Basin', 'Strand', 'Gulley', 'Scarp', 'Thicket', 'Flats', 'Narrows', 'Headland',
    'Beck', 'Fell', 'Force', 'Gill', 'Tarn', 'Howe', 'Rigg', 'Scar', 'Dale', 'Mire',
    'Moss', 'Nab', 'Ness', 'Pike', 'Scree', 'Slack', 'Wath', 'Keld', 'Knott', 'Hause',
    'Holm', 'Garth', 'Thwaite', 'Dyke', 'Ing', 'Sike', 'Combe', 'Tor', 'Bluff', 'Cleft',
    'Downs', 'Marsh', 'Heath', 'Gorge', 'Sound', 'Spit', 'Weald', 'Brink',
  ],
  /*
   * Materials and weather. Deliberately weighted towards things you could pick
   * up or stand in — a world's elements should be quarried and mined rather
   * than abstract, and these weld into compounds ("Ashholt", "Flintgard")
   * without the seam showing.
   */
  element: [
    'Ash', 'Ember', 'Frost', 'Salt', 'Storm', 'Tide', 'Cinder', 'Sleet', 'Brine', 'Smoke',
    'Flint', 'Marrow', 'Rime', 'Gale', 'Loam', 'Quartz', 'Tar', 'Glass', 'Iron', 'Copper',
    'Stone', 'Thunder', 'Granite', 'Lodestone', 'Pitch', 'Sap', 'Lime', 'Chalk', 'Steam',
    'Slate', 'Basalt', 'Shale', 'Clay', 'Silt', 'Gravel', 'Sand', 'Dust', 'Soot', 'Coal',
    'Amber', 'Resin', 'Wax', 'Tallow', 'Oil', 'Lead', 'Tin', 'Silver', 'Gold', 'Brass',
    'Bronze', 'Steel', 'Sulphur', 'Saltpetre', 'Lye', 'Ice', 'Snow', 'Hail', 'Fog', 'Haze',
    'Dew', 'Rain', 'Wind', 'Squall', 'Surge', 'Undertow', 'Spray', 'Foam', 'Vapour', 'Cloud',
    'Flood', 'Drought', 'Tremor', 'Char', 'Slag', 'Ore', 'Seam', 'Bedrock', 'Pumice', 'Cobble',
    'Grit', 'Peat', 'Turf', 'Bracken', 'Kelp', 'Marl', 'Murk', 'Rust',
  ],
  /*
   * Working animals, quarry and vermin, not heraldic beasts. A world's names
   * come from what people actually hunt, keep and curse at, and a bank of
   * eagles and lions produces a coat of arms rather than a place someone lives.
   */
  animal: [
    'Wolf', 'Crow', 'Heron', 'Adder', 'Boar', 'Kite', 'Hare', 'Shrike', 'Marten', 'Owl',
    'Carp', 'Mantis', 'Jackal', 'Roan', 'Wren', 'Lamprey', 'Hound', 'Falcon',
    'Bear', 'Ox', 'Bull', 'Ram', 'Viper', 'Moth', 'Swift', 'Eel', 'Badger', 'Auroch',
    'Rook', 'Magpie', 'Jay', 'Finch', 'Lark', 'Swallow', 'Swan', 'Gull', 'Tern', 'Curlew',
    'Plover', 'Snipe', 'Bittern', 'Egret', 'Crane', 'Stork', 'Hawk', 'Kestrel', 'Merlin',
    'Buzzard', 'Osprey', 'Eagle', 'Weasel', 'Stoat', 'Otter', 'Beaver', 'Fox', 'Lynx',
    'Ferret', 'Polecat', 'Mole', 'Vole', 'Shrew', 'Bat', 'Stag', 'Elk', 'Goat', 'Mare',
    'Colt', 'Hind', 'Roebuck', 'Ibex', 'Perch', 'Tench', 'Bream', 'Trout', 'Salmon',
    'Sturgeon', 'Skate', 'Seal', 'Crab', 'Whelk', 'Limpet', 'Urchin', 'Hornet', 'Locust',
  ],
  /*
   * Abstractions a faction or a technique could be named for. The bias is
   * towards the transactional and the owed — Debt, Ransom, Toll, Tribute — over
   * the purely noble, because those name institutions people actually resent,
   * which is more useful to a story than another Order of Valour.
   */
  virtue: [
    'Mercy', 'Patience', 'Ruin', 'Silence', 'Reckoning', 'Fidelity', 'Grudge', 'Restraint',
    'Candour', 'Appetite', 'Forbearance', 'Debt', 'Vigil', 'Consequence', 'Nerve', 'Sorrow',
    'Endurance', 'Cunning', 'Wrath', 'Stillness', 'Hunger', 'Weight', 'Certainty', 'Doubt',
    'Resolve', 'Temperance', 'Prudence', 'Valour', 'Honour', 'Duty', 'Oath', 'Troth',
    'Pledge', 'Vow', 'Penance', 'Atonement', 'Remorse', 'Regret', 'Grief', 'Longing',
    'Envy', 'Spite', 'Malice', 'Scorn', 'Contempt', 'Pride', 'Vanity', 'Folly', 'Wisdom',
    'Counsel', 'Reason', 'Memory', 'Oblivion', 'Clemency', 'Pardon', 'Justice', 'Verdict',
    'Judgement', 'Ransom', 'Tribute', 'Toll', 'Levy', 'Bond', 'Fetter', 'Yoke', 'Burden',
    'Solace', 'Refuge', 'Quiet', 'Ferocity', 'Obstinacy', 'Zeal',
  ],
  /*
   * Historic pigments and dyestuffs, plus the coat colours of horses. Every
   * addition is a substance somebody ground, boiled or dug for — orpiment,
   * realgar, madder, woad, smalt — which is why they read as a world's colours
   * rather than a paint chart. `Minium` and the other `-ium` pigments are
   * deliberately absent: see the suffix rule above.
   */
  color: [
    'Grey', 'Sable', 'Vermilion', 'Ochre', 'Verdigris', 'Bone', 'Indigo', 'Russet', 'Pale',
    'Umber', 'Cobalt', 'Dun', 'Jade', 'Carmine',
    'Madder', 'Woad', 'Orpiment', 'Realgar', 'Azurite', 'Malachite', 'Smalt', 'Viridian',
    'Sepia', 'Saffron', 'Cochineal', 'Cinnabar', 'Gamboge', 'Bistre', 'Sienna', 'Fawn',
    'Bay', 'Sorrel', 'Chestnut', 'Auburn', 'Flaxen', 'Hoar', 'Ivory', 'Ebony', 'Pewter',
    'Argent', 'Tawny', 'Buff',
  ],
  /*
   * Sky and calendar. These are how a culture says WHEN, and a world with names
   * for its own turning points feels lived in — the additions lean on the
   * agricultural and tidal year rather than on astronomy.
   */
  celestial: [
    'Dusk', 'Meridian', 'Eclipse', 'Solstice', 'Zenith', 'Nadir', 'Longnight', 'Aurora',
    'Waning Moon', 'First Light', 'Deepwinter', 'Highsummer', 'the Wandering Star',
    'Equinox', 'Twilight', 'Gloaming', 'Daybreak', 'Midnight', 'Evenfall', 'Moonrise',
    'New Moon', 'Full Moon', 'Harvest Moon', 'Comet', 'Meteor', 'Pole Star', 'Morning Star',
    'Evening Star', 'the Long Dark', 'Midwinter', 'Midsummer', 'Lastlight', 'Firstfrost',
    'Thaw', 'Flood Tide', 'Neap Tide', 'the Turning Year', 'Starless Night', 'Highnoon',
  ],
  /*
   * Kinds of organised body. Drawn from what actually incorporates people —
   * livery companies, chapters, synods, benches, exchanges — because the plain
   * word for a body is usually the true one, and a world in which everything is
   * an Order is a world with one institution wearing many hats.
   */
  title: [
    'House', 'Order', 'Compact', 'Assembly', 'Company', 'Covenant', 'Guild', 'Chapter',
    'Concord', 'Syndicate', 'Bureau', 'Circle', 'Charterhouse', 'League',
    // Institutions of teaching. Absent until an author asked for a school name
    // and got eight candidates — House, Guild, Chapter, Covenant, Bureau — not
    // one of which contained the word school or academy. That read as the
    // generator refusing anything plain on principle; it was simply the only
    // vocabulary it had. A body that teaches is as ordinary a kind of faction
    // as a body that trades, and the plain word for one belongs in the mix
    // beside the invented ones rather than being unreachable.
    'School', 'Academy', 'College', 'Institute', 'Conservatory', 'Seminary',
    'Fellowship', 'Fraternity', 'Sodality', 'Trust', 'Union', 'Federation', 'Alliance',
    'Coalition', 'Cartel', 'Chamber', 'Council', 'Senate', 'Convocation', 'Synod',
    'Conclave', 'Curia', 'Tribunal', 'Court', 'Exchange', 'Mint', 'Treasury', 'Commission',
    'Board', 'Lodge', 'Hall', 'Chantry', 'Almshouse', 'Hospice', 'Foundation', 'Livery',
    'Mystery', 'Brotherhood', 'Sisterhood', 'Bench', 'Registry', 'Bank', 'Works', 'Yard',
    'Office', 'Custody',
  ],
  /*
   * Tools and the made objects a workshop is full of. Nothing here is a person:
   * see `trade` below for why that separation is load-bearing.
   */
  craft: [
    'Anvil', 'Ledger', 'Lantern', 'Kiln', 'Loom', 'Sluice', 'Bellows', 'Awl', 'Winch',
    'Crucible', 'Pillory', 'Tally', 'Spindle', 'Forge', 'Cask',
    'Hammer', 'Wedge', 'Chain', 'Needle', 'Lens', 'Key', 'Millstone', 'Vice', 'Bit',
    'Adze', 'Chisel', 'Rasp', 'Auger', 'Plane', 'Shuttle', 'Bobbin', 'Treadle', 'Quern',
    'Trowel', 'Plumbline', 'Caliper', 'Tongs', 'Mallet', 'Punch', 'File', 'Gouge',
    'Drawknife', 'Froe', 'Scythe', 'Sickle', 'Flail', 'Harrow', 'Coulter', 'Bridle',
    'Stirrup', 'Buckle', 'Rivet', 'Nail', 'Peg', 'Dowel', 'Clamp', 'Last', 'Shears',
    'Pincers', 'Ladle', 'Mould', 'Grindstone', 'Whetstone', 'Hone', 'Strop', 'Swage',
    'Tenon', 'Mortise', 'Spokeshave', 'Scraper', 'Stylus', 'Gauge',
  ],
  /*
   * The London livery companies, almost to a word — Cooper, Fletcher, Currier,
   * Loriner, Horner, Farrier, Pavior, Broderer, Girdler. Six hundred years of
   * incorporated trades, which makes them three things at once: what a working
   * faction is named after, what `person-trade` uses for a surname, and the
   * actual historical source of half the surnames in English.
   */
  trade: [
    'Cooper', 'Fletcher', 'Currier', 'Loriner', 'Horner', 'Farrier', 'Pavior', 'Broderer',
    'Upholder', 'Turner', 'Glazier', 'Plaisterer', 'Founder', 'Poulter', 'Girdler', 'Mercer',
    'Draper', 'Salter', 'Vintner', 'Dyer', 'Brewer', 'Pewterer', 'Cutler', 'Chandler',
    'Armourer', 'Saddler', 'Cordwainer', 'Mason', 'Scrivener', 'Stationer', 'Wheelwright',
    'Tanner', 'Fuller', 'Cobbler', 'Wright', 'Smith', 'Wainwright', 'Cartwright',
    'Shipwright', 'Thatcher', 'Slater', 'Collier', 'Miller', 'Baker', 'Butcher',
  ],
  /*
   * Body and stance, which technique names lean on hardest. The additions
   * include the four fencing words — Feint, Lunge, Parry, Guard — because a
   * martial world names its forms after what the body does, not only after the
   * part that does it.
   */
  body: [
    'Palm', 'Fist', 'Step', 'Breath', 'Sinew', 'Heel', 'Throat', 'Spine', 'Shoulder',
    'Knuckle', 'Wrist', 'Eye', 'Tendon',
    'Grip', 'Jaw', 'Tread', 'Gaze', 'Stance', 'Marrow', 'Lung', 'Root',
    'Ankle', 'Elbow', 'Rib', 'Hip', 'Thumb', 'Finger', 'Tooth', 'Tongue', 'Brow', 'Temple',
    'Nape', 'Collar', 'Chest', 'Flank', 'Thigh', 'Shin', 'Calf', 'Sole', 'Knee', 'Vein',
    'Pulse', 'Heart', 'Liver', 'Gut', 'Belly', 'Hide', 'Skull', 'Crown', 'Ear', 'Lip',
    'Cheek', 'Chin', 'Neck', 'Back', 'Waist', 'Feint', 'Lunge', 'Parry', 'Guard', 'Hand',
    'Arm', 'Claw',
  ],
  /*
   * Verbs in their naming form. The additions are mostly the vocabulary of
   * WORK — reaping, winnowing, threshing, tempering, splicing — rather than of
   * violence, because a technique named for a craft motion carries a world with
   * it, and a bank of only breaking and rending names one kind of story.
   */
  action: [
    'Shattering', 'Parting', 'Drowning', 'Unmaking', 'Binding', 'Kindling', 'Severing',
    'Quenching', 'Hollowing', 'Turning', 'Folding', 'Rending', 'Stilling', 'Answering',
    'Breaking', 'Crushing', 'Toppling', 'Cleaving', 'Piercing', 'Smothering', 'Racing',
    'Vanishing', 'Mending', 'Waking', 'Silencing', 'Devouring', 'Weathering', 'Bearing',
    'Withering',
    'Scattering', 'Gathering', 'Reaping', 'Sowing', 'Grinding', 'Sifting', 'Winnowing',
    'Threshing', 'Kneading', 'Tempering', 'Quelling', 'Calming', 'Rousing', 'Stirring',
    'Churning', 'Boiling', 'Freezing', 'Thawing', 'Melting', 'Forging', 'Casting',
    'Hammering', 'Riveting', 'Welding', 'Weaving', 'Spinning', 'Knotting', 'Fraying',
    'Unravelling', 'Splicing', 'Lashing', 'Hauling', 'Heaving', 'Dragging', 'Lifting',
    'Falling', 'Sinking', 'Rising', 'Climbing', 'Leaping', 'Wading', 'Swimming', 'Diving',
    'Circling', 'Wheeling', 'Stooping', 'Striking', 'Parrying', 'Feinting', 'Warding',
    'Shielding', 'Guarding', 'Watching', 'Waiting', 'Hunting', 'Tracking', 'Snaring',
    'Netting',
  ],
};

export const SOUND_WORLDS: readonly SoundWorld[] = [
  {
    id: 'northern',
    label: 'Northern & Hard',
    blurb: 'Short, consonant-heavy, ending on a stop or a cluster. Cold and old.',
    cues: /\b(north|northern|cold|frost|frozen|snow|winter|ice|glacier|fjord|tundra|whal\w*|viking|norse|clan|highland|moor|peat|harbour|harbor|quay|wharf|salt|herring|longship|jarl|thane|hold|keep|stone|iron|axe|raid)\w*/i,
    shape: 'One or two syllables, consonant-heavy, usually ending on a hard stop or a cluster.',
    onsets: [
      'b', 'br', 'd', 'dr', 'f', 'fr', 'g', 'gr', 'h', 'hr', 'k', 'kr', 'l', 'm', 'n', 'r',
      's', 'sk', 'sn', 'st', 'str', 't', 'th', 'thr', 'v', 'w', 'gn', 'sv',
    ],
    nuclei: ['a', 'e', 'i', 'o', 'u', 'au', 'ei', 'ae', 'y'],
    codas: ['', 'd', 'f', 'g', 'k', 'l', 'm', 'n', 'r', 'rk', 'rn', 'rd', 'rth', 's', 'sk', 'st', 't', 'th', 'nd', 'ng', 'll'],
    templates: [
      { shape: ['CVC'], weight: 3 },
      { shape: ['CV', 'CVC'], weight: 5 },
      { shape: ['CVC', 'CVC'], weight: 3 },
      { shape: ['CVC', 'CV'], weight: 2 },
    ],
    illegal: [/(gn|sv|hr)$/],
    // Norse and Old English settlement elements, most of them still doing this
    // job in Cumbria and Yorkshire. They compound cleanly because English has
    // been compounding them since the ninth century.
    generics: [
      { text: 'holt', gloss: 'wooded rise' },
      { text: 'skard', gloss: 'notch, cut' },
      { text: 'fell', gloss: 'bare high ground' },
      { text: 'mark', gloss: 'borderland' },
      { text: 'stead', gloss: 'holding' },
      { text: 'vik', gloss: 'inlet' },
      { text: 'gard', gloss: 'walled place' },
      { text: 'dal', gloss: 'valley' },
      { text: 'ness', gloss: 'headland' },
      { text: 'thorpe', gloss: 'outlying farm' },
      { text: 'beck', gloss: 'stream' },
      { text: 'gill', gloss: 'ravine with water in it' },
      { text: 'tarn', gloss: 'small high lake' },
      { text: 'howe', gloss: 'low hill, or a grave under one' },
      { text: 'rigg', gloss: 'long ridge' },
      { text: 'scar', gloss: 'bare rock face' },
      { text: 'thwaite', gloss: 'a clearing cut from woodland' },
      { text: 'keld', gloss: 'spring' },
      { text: 'wath', gloss: 'ford' },
      { text: 'hause', gloss: 'saddle between summits' },
      { text: 'knott', gloss: 'rocky knoll' },
      { text: 'mire', gloss: 'bog' },
      { text: 'moss', gloss: 'wet moorland' },
      { text: 'nab', gloss: 'jutting peak' },
      { text: 'slack', gloss: 'shallow dip between hills' },
      { text: 'by', gloss: 'farmstead, village' },
      { text: 'toft', gloss: 'the ground a house stands on' },
      { text: 'seat', gloss: 'summer pasture and its hut' },
      { text: 'sty', gloss: 'steep path up' },
      { text: 'force', gloss: 'waterfall' },
    ],
  },

  {
    id: 'meridian',
    label: 'Meridian & Soft',
    blurb: 'Open vowels, liquid consonants, names that end on a vowel. Warm and mannered.',
    cues: /\b(south|southern|sun|sunlit|vineyard|olive|republic|city[- ]state|canal|lagoon|marble|opera|renaissance|duel|duell\w*|courtier|doge|signor\w*|villa|piazza|warm|mediterranean|orange|lemon|siesta)\w*/i,
    shape: 'Two or three syllables, open and vowel-final, built on liquid consonants.',
    onsets: [
      'b', 'c', 'd', 'f', 'g', 'l', 'll', 'm', 'n', 'p', 'r', 's', 't', 'v', 'z',
      'br', 'cr', 'dr', 'fl', 'gr', 'pl', 'pr', 'tr', 'qu', 'ch', 'gl',
    ],
    nuclei: ['a', 'e', 'i', 'o', 'u', 'ia', 'ie', 'io', 'ai', 'ea', 'eo'],
    codas: ['', '', '', 'l', 'n', 'r', 's', 'm', 'nt', 'rt', 'nd'],
    templates: [
      { shape: ['CV', 'CV'], weight: 4 },
      { shape: ['CV', 'CVC'], weight: 3 },
      { shape: ['CV', 'CV', 'CV'], weight: 2 },
      { shape: ['V', 'CV'], weight: 1 },
    ],
    illegal: [/[bcdfgpstvz]{3}/, /qu[^aeiou]/],
    generics: [
      { text: 'mare', gloss: 'sea' },
      { text: 'monte', gloss: 'mountain' },
      { text: 'valle', gloss: 'valley' },
      { text: 'porto', gloss: 'harbour' },
      { text: 'campo', gloss: 'open field' },
      { text: 'ponte', gloss: 'bridge' },
      { text: 'fonte', gloss: 'spring' },
      { text: 'costa', gloss: 'coast' },
      { text: 'torre', gloss: 'tower' },
      { text: 'villa', gloss: 'a country house and its land' },
      { text: 'borgo', gloss: 'walled village' },
      { text: 'piazza', gloss: 'the square a town argues in' },
      { text: 'rocca', gloss: 'crag fort' },
      { text: 'lago', gloss: 'lake' },
      { text: 'riva', gloss: 'shore, bank' },
      { text: 'isola', gloss: 'island' },
      { text: 'colle', gloss: 'low hill' },
      { text: 'prato', gloss: 'meadow' },
      { text: 'selva', gloss: 'wood' },
      { text: 'foce', gloss: 'river mouth' },
      { text: 'molo', gloss: 'stone pier' },
      { text: 'corte', gloss: 'courtyard' },
      { text: 'vico', gloss: 'narrow lane' },
      { text: 'castello', gloss: 'castle' },
    ],
  },

  {
    id: 'cloudsea',
    label: 'Cloud-Sea',
    blurb: 'Clipped one-syllable roots that stack. The register of sects, dao and cultivation.',
    cues: /\b(jade|lotus|silk|dynast\w*|emperor|empress|imperial court|riverlands|terrace\w*|pagoda|incense|tea house|monastery|mountain sect)\w*/i,
    genreCues: /\b(sect|cultivat\w*|qi|dao|tao|immortal|martial|heaven\w*|pill|spirit stone|xianxia|wuxia|jianghu|core formation|elder|disciple|patriarch|celestial)\w*/i,
    shape:
      'One-syllable roots, often stacked two or three deep. Personal names are a one-syllable ' +
      'family name followed by a one- or two-syllable given name.',
    onsets: [
      'b', 'ch', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm', 'n', 'p', 'q', 'r', 's', 'sh',
      't', 'w', 'x', 'y', 'z', 'zh', 'c', 'hu', 'gu', 'li', 'ni',
    ],
    nuclei: ['a', 'e', 'i', 'o', 'u', 'ai', 'ao', 'ei', 'ou', 'ua', 'ie', 'iu', 'uo'],
    codas: ['', '', 'n', 'ng'],
    templates: [
      { shape: ['CVC'], weight: 3 },
      { shape: ['CV'], weight: 2 },
      { shape: ['CVC', 'CVC'], weight: 4 },
      { shape: ['CV', 'CVC'], weight: 4 },
    ],
    illegal: [/[bcdfghjklmnpqrstwxyz]{3}/, /q[^iu]/, /x[^iu]/],
    generics: [
      { text: 'Peak', gloss: 'a sect’s mountain' },
      { text: 'Vale', gloss: 'sheltered ground' },
      { text: 'Gate', gloss: 'the way in, and the sect that holds it' },
      { text: 'Terrace', gloss: 'cut and levelled ground' },
      { text: 'Abyss', gloss: 'the drop nobody surveys' },
      { text: 'Pavilion', gloss: 'a hall of one purpose' },
      { text: 'Sea', gloss: 'water past the last landmark' },
      { text: 'Ridge', gloss: 'the spine between two valleys' },
      { text: 'Grotto', gloss: 'a cave someone has claimed' },
      { text: 'Spring', gloss: 'water coming up out of the rock' },
      { text: 'Pool', gloss: 'still water, usually spoken of' },
      { text: 'Cliff', gloss: 'the face nobody climbs' },
      { text: 'Ford', gloss: 'where the river can be crossed' },
      { text: 'Pass', gloss: 'the only way through' },
      { text: 'Hollow', gloss: 'ground that holds mist' },
      { text: 'Court', gloss: 'walled ground where matters are settled' },
      { text: 'Bridge', gloss: 'a crossing worth naming' },
      { text: 'Isle', gloss: 'land with water all round it' },
      { text: 'Marsh', gloss: 'ground that will not hold a footprint' },
      { text: 'Plateau', gloss: 'high flat ground' },
      { text: 'Cavern', gloss: 'a hollow with a mouth' },
    ],
    /*
     * The four banks where cultivation genuinely differs, each about three
     * times the size it was. The additions come from the standard glossary the
     * genre's English translations settled on — the trigrams and the five
     * elements, the kalpa, the Yellow Springs, the tribulation — plus the plant
     * and beast vocabulary sect names actually use. `School` is here for the
     * same reason it is in the default bank: 门 is a school, and a cultivation
     * novel should be able to say so plainly.
     */
    banks: {
      element: [
        'Flame', 'Frost', 'Thunder', 'Cloud', 'Jade', 'Golden', 'Azure', 'Crimson', 'Ash',
        'Blood', 'Bone', 'Mist', 'Abyssal', 'Starfire', 'Blackwater',
        'Lightning', 'Ice', 'Wind', 'Rain', 'Snow', 'Sand', 'Stone', 'Iron', 'Silver',
        'Verdant', 'Cyan', 'Scarlet', 'Ink', 'Pearl', 'Coral', 'Amber', 'Moonlight',
        'Starlight', 'Nether', 'Spirit', 'Dragon', 'Qilin', 'Serpent', 'Tiger', 'Crane',
        'Lotus', 'Bamboo', 'Pine', 'Willow', 'Cinnabar',
      ],
      celestial: [
        'Heaven', 'Void', 'Nine Heavens', 'Netherworld', 'Cyclic', 'Primordial', 'Myriad',
        'Boundless', 'Origin', 'the Falling Star', 'Great Dao',
        'Three Realms', 'Yellow Springs', 'Heavenly Tribulation', 'Eight Trigrams',
        'Five Elements', 'Nine Provinces', 'Ten Thousand Ages', 'Immortal Realm',
        'Mortal Realm', 'Ninth Firmament', 'Kalpa', 'Samsara', 'Celestial Court', 'Jade Pool',
        'Star River', 'Cloud Sea', 'Dao Origin', 'Grand Circle', 'the Endless Cycle',
        'Highest Heaven', 'Nether Spring', 'Firmament',
      ],
      title: [
        'Sect', 'Pavilion', 'Hall', 'Palace', 'Court', 'Sword Sect', 'Alliance', 'Clan',
        'Immortal Sect', 'Manor',
        'School', 'Gate', 'Temple', 'Monastery', 'Pagoda', 'Tower', 'Terrace', 'Chamber',
        'Valley', 'Peak', 'Society', 'Association', 'Order', 'House', 'Lineage', 'Sanctum',
        'Grotto', 'Cave Abode', 'Sword Hall', 'Dao Palace',
      ],
      virtue: [
        'Severance', 'Longevity', 'Retribution', 'Serenity', 'Ruthlessness', 'Ascension',
        'Rebirth', 'Oblivion', 'Enlightenment', 'Karma',
        'Tribulation', 'Transcendence', 'Detachment', 'Perseverance', 'Insight',
        'Comprehension', 'Fortune', 'Calamity', 'Reversal', 'Harmony', 'Discord', 'Vengeance',
        'Loyalty', 'Betrayal', 'Humility', 'Arrogance', 'Nirvana', 'Purity', 'Corruption',
        'Cultivation',
      ],
      // A cultivation world's trades are its professions, not London's.
      trade: [
        'Swordsmith', 'Alchemist', 'Herbalist', 'Beast Tamer', 'Pill Master', 'Talisman Maker',
        'Formation Master', 'Blacksmith', 'Physician', 'Diviner', 'Scribe', 'Cartographer',
        'Armourer', 'Bowyer', 'Tea Master', 'Incense Maker', 'Silk Merchant', 'Jade Cutter',
        'Spirit Farmer', 'Beast Rider', 'Bell Ringer', 'Gatekeeper', 'Archivist', 'Weaponsmith',
        'Refiner', 'Appraiser', 'Broker', 'Caravanner', 'Boatman', 'Hunter', 'Woodcutter',
        'Fisher', 'Miner', 'Potter', 'Dyer', 'Brewer', 'Cook', 'Groom', 'Steward', 'Warden',
        'Courier', 'Guard', 'Elder', 'Disciple', 'Servant',
      ],
    },
  },

  {
    id: 'island-court',
    label: 'Island Court',
    blurb: 'Even open syllables, every consonant followed by a vowel. Precise and formal.',
    cues: /\b(shogun\w*|samurai|katana|ronin|shrine|torii|island|isle|archipelago|blossom|sakura|daimyo|bamboo|kimono|yokai|onmyo\w*)\w*/i,
    shape:
      'Strict consonant-vowel syllables, three or four of them, no clusters and no hard endings.',
    onsets: [
      'k', 'g', 's', 'sh', 't', 'ch', 'n', 'h', 'f', 'm', 'y', 'r', 'w', 'z', 'j', 'b', 'd', 'p',
      'ts', 'ky', 'ry', 'sh',
    ],
    nuclei: ['a', 'i', 'u', 'e', 'o', 'ai', 'ou'],
    codas: ['', '', '', '', 'n'],
    templates: [
      { shape: ['CV', 'CV'], weight: 3 },
      { shape: ['CV', 'CV', 'CV'], weight: 4 },
      { shape: ['CV', 'CVC', 'CV'], weight: 2 },
    ],
    illegal: [/[bcdfghjklmnpqrstvwxyz]{3}/, /nn/],
    generics: [
      { text: 'yama', gloss: 'mountain' },
      { text: 'kawa', gloss: 'river' },
      { text: 'mori', gloss: 'forest' },
      { text: 'shima', gloss: 'island' },
      { text: 'hara', gloss: 'plain' },
      { text: 'saki', gloss: 'cape' },
      { text: 'tani', gloss: 'valley' },
      { text: 'minato', gloss: 'harbour' },
      { text: 'umi', gloss: 'sea' },
      { text: 'ike', gloss: 'pond' },
      { text: 'sawa', gloss: 'mountain stream' },
      { text: 'take', gloss: 'peak' },
      { text: 'oka', gloss: 'hill' },
      { text: 'sato', gloss: 'village' },
      { text: 'machi', gloss: 'town quarter' },
      { text: 'hama', gloss: 'beach' },
      { text: 'iso', gloss: 'rocky shore' },
      { text: 'taki', gloss: 'waterfall' },
      { text: 'ido', gloss: 'well' },
      { text: 'hashi', gloss: 'bridge' },
      { text: 'mon', gloss: 'gate' },
      { text: 'dera', gloss: 'temple' },
      { text: 'no', gloss: 'open field' },
      { text: 'tou', gloss: 'pagoda' },
    ],
  },

  {
    id: 'sandsea',
    label: 'Sand-Sea',
    blurb: 'Three-consonant roots and long vowels. Dry, formal, very old.',
    cues: /\b(desert|dune|sand|sands|caravan|oasis|caliph\w*|sultan\w*|vizier|bazaar|souk|nomad\w*|drought|arid|waste|wastes|salt flat|scorch\w*|dervish|minaret|camel)\w*/i,
    shape:
      'Built on three-consonant roots with long vowels dropped between them; often carries a ' +
      'linking particle like al- or bin-.',
    onsets: [
      'b', 'd', 'f', 'h', 'j', 'k', 'kh', 'l', 'm', 'n', 'q', 'r', 's', 'sh', 't', 'th', 'z',
      'gh', 'w', 'y', 'dh', 'ss',
    ],
    nuclei: ['a', 'aa', 'i', 'ii', 'u', 'uu', 'ay', 'aw'],
    codas: ['', 'b', 'd', 'f', 'l', 'm', 'n', 'q', 'r', 's', 'sh', 't', 'z', 'kh', 'th'],
    templates: [
      { shape: ['CVC'], weight: 2 },
      { shape: ['CVC', 'CVC'], weight: 5 },
      { shape: ['CV', 'CVC'], weight: 3 },
    ],
    illegal: [/[bcdfghjklmnpqrstvwxyz]{3}/, /(aa|ii|uu){2}/],
    generics: [
      { text: 'wadi', gloss: 'dry watercourse' },
      { text: 'qasr', gloss: 'fortified house' },
      { text: 'bahr', gloss: 'sea' },
      { text: 'jabal', gloss: 'mountain' },
      { text: 'suq', gloss: 'market' },
      { text: 'ain', gloss: 'spring, eye of water' },
      { text: 'ribat', gloss: 'waystation' },
      { text: 'sahra', gloss: 'open desert' },
      { text: 'hajar', gloss: 'stone, stony ground' },
      { text: 'bir', gloss: 'well' },
      { text: 'nahr', gloss: 'river' },
      { text: 'tell', gloss: 'a mound made of older towns' },
      { text: 'khan', gloss: 'caravanserai' },
      { text: 'bab', gloss: 'gate' },
      { text: 'burj', gloss: 'tower' },
      { text: 'dar', gloss: 'house, seat' },
      { text: 'harra', gloss: 'black lava field' },
      { text: 'sabkha', gloss: 'salt flat' },
      { text: 'naqb', gloss: 'pass' },
      { text: 'wahat', gloss: 'oasis' },
      { text: 'darb', gloss: 'road, track' },
    ],
  },

  {
    id: 'sylvan',
    label: 'Sylvan',
    blurb: 'Flowing, vowel-rich, built on l, r, th and n. Never harsh.',
    cues: /\b(forest|wood|woods|woodland|elf|elves|elven|fae|fey|grove|druid|thicket|glade|briar|root|canopy|greenwood|dryad|antler|moss|deep wood|old forest|wild hunt)\w*/i,
    shape: 'Two or three flowing syllables built on l, r, th, n and long vowels. No hard stops.',
    onsets: [
      'l', 'll', 'r', 'n', 'm', 'th', 'thr', 'f', 'fl', 'v', 's', 'sl', 'h', 'gl', 'br', 'w',
      'c', 'cel', 'ael',
    ],
    nuclei: ['a', 'e', 'i', 'o', 'ae', 'ea', 'ei', 'io', 'ui', 'y'],
    codas: ['', '', 'l', 'n', 'r', 'th', 's', 'm', 'lm', 'rn'],
    templates: [
      { shape: ['CV', 'CVC'], weight: 4 },
      { shape: ['CV', 'CV', 'CVC'], weight: 2 },
      { shape: ['V', 'CVC'], weight: 1 },
    ],
    // The Elara/Kaelen problem is a *phonotactic* attractor, not only a word
    // list: a soft world drifts to -iel, -yn, -ael endings on its own. Barred
    // here so the blocklist does not have to catch them one by one.
    illegal: [/[bcdfgpstvz]{3}/, /(iel|yn|ael|wyn|aeth)$/, /ae.*ae/],
    generics: [
      { text: 'glen', gloss: 'wooded hollow' },
      { text: 'mere', gloss: 'still water' },
      { text: 'thicket', gloss: 'close growth' },
      { text: 'combe', gloss: 'short valley' },
      { text: 'wold', gloss: 'open high ground' },
      { text: 'shaw', gloss: 'small wood' },
      { text: 'linn', gloss: 'pool below a fall' },
      { text: 'hurst', gloss: 'wooded hill' },
      { text: 'leigh', gloss: 'a clearing in the wood' },
      { text: 'dell', gloss: 'small sheltered valley' },
      { text: 'bourne', gloss: 'a stream that runs in season' },
      { text: 'brake', gloss: 'fern thicket' },
      { text: 'grove', gloss: 'trees kept for a reason' },
      { text: 'coppice', gloss: 'wood cut and grown again' },
      { text: 'spinney', gloss: 'a small stand of thorn' },
      { text: 'holt', gloss: 'wooded rise' },
      { text: 'weald', gloss: 'old forest country' },
      { text: 'chase', gloss: 'unfenced hunting ground' },
      { text: 'riding', gloss: 'a way cut through trees' },
      { text: 'greave', gloss: 'a thicket on a slope' },
      { text: 'garth', gloss: 'enclosed ground' },
    ],
  },

  {
    id: 'foundry',
    label: 'Foundry',
    blurb: 'Plain English compounds and trade surnames. Industrial, recent, unromantic.',
    cues: /\b(factory|factories|industrial|steam|rail|railway|mill|colliery|coal|foundry|union|dock|docks|machine|machinery|gaslight|tenement|smog|engineer\w*|clerk|ledger|contract|company town|modern|contemporary|detective|precinct)\w*/i,
    shape:
      'Ordinary English words compounded, or plain trade surnames. Nothing invented sounds ' +
      'invented.',
    onsets: [
      'b', 'br', 'ch', 'cl', 'cr', 'd', 'dr', 'f', 'fl', 'g', 'gr', 'h', 'k', 'l', 'm', 'n',
      'p', 'pr', 'r', 's', 'sh', 'sl', 'sp', 'st', 't', 'tr', 'v', 'w',
    ],
    nuclei: ['a', 'e', 'i', 'o', 'u', 'ea', 'oo', 'ow', 'ay'],
    codas: ['', 'b', 'ck', 'd', 'ff', 'g', 'ld', 'll', 'm', 'n', 'nt', 'p', 'r', 'rd', 's', 'sh', 't', 'w'],
    templates: [
      { shape: ['CVC'], weight: 4 },
      { shape: ['CVC', 'CVC'], weight: 4 },
      { shape: ['CV', 'CVC'], weight: 3 },
    ],
    illegal: [/[bcdfghjklmnpqrstvwxz]{3}/],
    generics: [
      { text: 'Yard', gloss: 'working ground' },
      { text: 'Works', gloss: 'a place that makes things' },
      { text: 'Cut', gloss: 'a dug channel' },
      { text: 'Row', gloss: 'a street of one trade' },
      { text: 'Wharf', gloss: 'loading edge' },
      { text: 'Junction', gloss: 'where the lines meet' },
      { text: 'Terrace', gloss: 'a built rank of houses' },
      { text: 'Colliery', gloss: 'a pit and its village' },
      { text: 'Mill', gloss: 'the building the town works in' },
      { text: 'Foundry', gloss: 'where metal is poured' },
      { text: 'Sidings', gloss: 'where wagons wait' },
      { text: 'Basin', gloss: 'still water for loading' },
      { text: 'Lock', gloss: 'a step in the canal' },
      { text: 'Viaduct', gloss: 'the line carried over' },
      { text: 'Crossing', gloss: 'where road meets rail' },
      { text: 'Halt', gloss: 'a stop too small for a station' },
      { text: 'Depot', gloss: 'a store and its sheds' },
      { text: 'Rank', gloss: 'a line of built frontage' },
      { text: 'Alley', gloss: 'the way round the back' },
      { text: 'Bank', gloss: 'the raised ground the line runs on' },
      { text: 'Quarter', gloss: 'the part of town that does one thing' },
      { text: 'Gate', gloss: 'the works entrance, and the street to it' },
      { text: 'Bridge', gloss: 'iron over water, and the district round it' },
      { text: 'Green', gloss: 'the last unbuilt ground' },
    ],
  },

  {
    id: 'void',
    label: 'Void-Machine',
    blurb: 'Clipped, clinical, part-numeric. Designations rather than names.',
    cues: /\b(ship|starship|station|orbit|orbital|void|vacuum|star|stars|colony|colonis\w*|coloniz\w*|hull|airlock|reactor|android|synthetic|quantum|alien|cryo|faster[- ]than[- ]light|ftl|terraform\w*|space|sector|frigate|drone)\w*/i,
    shape:
      'Clipped and clinical — short coined stems, often carrying a numeral, a letter-code or a ' +
      'hyphen. These are designations, not names.',
    onsets: [
      'k', 'kr', 'v', 'vr', 'x', 'z', 'th', 't', 'tr', 's', 'st', 'd', 'dr', 'n', 'm', 'g',
      'gr', 'q', 'ph', 'kh',
    ],
    nuclei: ['a', 'e', 'i', 'o', 'u', 'y', 'ei', 'ou'],
    codas: ['', 'x', 'k', 'l', 'n', 'r', 's', 't', 'th', 'rx', 'sk', 'nt', 'k'],
    templates: [
      { shape: ['CVC'], weight: 5 },
      { shape: ['CVC', 'CVC'], weight: 3 },
      { shape: ['CV', 'CVC'], weight: 2 },
    ],
    illegal: [/[bcdfghjklmnpqrstvwxz]{3}/, /^x[^ae]/],
    generics: [
      { text: 'Station', gloss: 'a held point' },
      { text: 'Array', gloss: 'a spread of instruments' },
      { text: 'Reach', gloss: 'the far edge of a claim' },
      { text: 'Yard', gloss: 'where hulls are cut' },
      { text: 'Well', gloss: 'a drop with something at the bottom' },
      { text: 'Line', gloss: 'a run between two points' },
      { text: 'Node', gloss: 'a point the network needs' },
      { text: 'Relay', gloss: 'something that passes it on' },
      { text: 'Sector', gloss: 'a slice of surveyed space' },
      { text: 'Belt', gloss: 'a ring of rock worth mining' },
      { text: 'Drift', gloss: 'what is no longer under power' },
      { text: 'Anchorage', gloss: 'somewhere to hold position' },
      { text: 'Terminus', gloss: 'the last stop on the run' },
      { text: 'Spur', gloss: 'a branch off the main line' },
      { text: 'Vector', gloss: 'a course, named for where it ends' },
      { text: 'Shell', gloss: 'a structure built round something' },
      { text: 'Rim', gloss: 'the outer edge of the charted' },
      { text: 'Approach', gloss: 'the corridor in' },
    ],
    /*
     * `Consortium` used to sit in the title bank and could never be used: the
     * `/ium$/` suffix tell in blocklist.ts is matched against the whole
     * assembled candidate, so every name ending in it was rejected before the
     * author saw it. A test now walks both banks looking for the same mistake.
     */
    banks: {
      craft: [
        'Lattice', 'Manifold', 'Cortex', 'Relay', 'Substrate', 'Ballast', 'Aperture', 'Cradle',
        'Shunt', 'Housing', 'Registry', 'Governor',
        'Gantry', 'Conduit', 'Busbar', 'Coupling', 'Bearing', 'Flange', 'Gasket', 'Actuator',
        'Servo', 'Gyro', 'Baffle', 'Nacelle', 'Truss', 'Spar', 'Bulkhead', 'Airlock',
        'Scrubber', 'Condenser', 'Regulator', 'Rectifier', 'Transducer', 'Interlock',
        'Armature', 'Feedline',
      ],
      title: [
        'Directorate', 'Authority', 'Bureau', 'Cadre', 'Trust', 'Combine',
        'Administration', 'Executive',
        'Command', 'Agency', 'Office', 'Concern', 'Holding', 'Charter', 'Assembly', 'Council',
        'Board', 'Committee', 'Secretariat', 'Ministry', 'Department', 'Division', 'Section',
        'Collective', 'Syndicate', 'Bloc', 'Protectorate',
      ],
      // Crew roles, not guilds. A war-drone called Dave is a joke, and so is a
      // hull-cutting rig called the Cordwainer Combine.
      trade: [
        'Technician', 'Operator', 'Pilot', 'Rigger', 'Loader', 'Steward', 'Marshal', 'Warden',
        'Inspector', 'Handler', 'Fitter', 'Machinist', 'Welder', 'Surveyor', 'Navigator',
        'Quartermaster', 'Engineer', 'Wrangler', 'Splicer', 'Scrapper', 'Salvager', 'Hauler',
        'Docker', 'Runner', 'Courier', 'Broker', 'Auditor', 'Archivist', 'Analyst', 'Medic',
        'Cutter', 'Driller', 'Prospector', 'Refiner', 'Smelter', 'Tender', 'Watchkeeper',
        'Signaller', 'Gunner', 'Sapper', 'Deckhand', 'Bosun', 'Purser', 'Lookout', 'Rating',
      ],
    },
  },
];

const BY_ID = new Map(SOUND_WORLDS.map((w) => [w.id, w]));

export const DEFAULT_SOUND_WORLD_ID = 'northern';

/**
 * Resolve a stored id. Falls back rather than throwing: a charter written by an
 * earlier deploy may name a world that has since been renamed, and the author's
 * novel must still generate names today.
 */
export function soundWorld(id: string | undefined | null): SoundWorld {
  return (id ? BY_ID.get(id) : undefined) ?? BY_ID.get(DEFAULT_SOUND_WORLD_ID) ?? SOUND_WORLDS[0];
}

export function isSoundWorldId(value: unknown): boolean {
  return typeof value === 'string' && BY_ID.has(value);
}

/** The world's banks, with its overrides applied over the shared defaults. */
export function banksFor(world: SoundWorld): WordBanks {
  return world.banks ? { ...DEFAULT_BANKS, ...world.banks } : DEFAULT_BANKS;
}

/** Everything illegal in this world: the shared runs plus its own rules. */
export function illegalFor(world: SoundWorld): RegExp[] {
  return [...UNIVERSALLY_ILLEGAL, ...world.illegal];
}

/** Picker metadata for the UI — deliberately excludes the inventories. */
export function listSoundWorlds(): Array<Pick<SoundWorld, 'id' | 'label' | 'blurb'>> {
  return SOUND_WORLDS.map(({ id, label, blurb }) => ({ id, label, blurb }));
}
