/**
 * The slop list — names a language model reaches for when left to itself.
 *
 * This file is SERVER-ONLY and is never sent to a model, in either direction.
 * That is a deliberate reversal of the obvious design, and the reason is
 * measured in this codebase: the note at engine/context.ts documents that
 * enumerating unwanted behaviours in a prompt PRIMED them — listing forbidden
 * preamble took preamble from 0 to 30.5 words a chapter. Telling a model "never
 * write Elara" puts Elara in its context, and the next thing it writes is
 * Elara-adjacent. So the list is a rejection filter and nothing else: candidates
 * that match never reach the model, and the model is never told why.
 *
 * The entries are not a matter of taste. `Elara` was 2025's name of the year on
 * the strength of being the name AI reaches for, and readers of serialised
 * fiction now clock these as a signature of machine-written prose — which is the
 * concrete harm, not the aesthetics.
 *
 * Maintenance: add, rarely remove. A name here is not banned from the novel —
 * the author can type whatever they like, and the bible will keep it. It is
 * banned from being *suggested*.
 *
 * One rule this list has to respect: nothing here may be a word our own banks
 * use. `Ember`, `Sable` and `Vale` were all on it and all in lexicons.ts, which
 * made the two files quietly contradict each other — the generator offering a
 * word the filter would reject. They are ordinary English, they only read as
 * slop standing alone as a person's name, and the formulas never use a bare
 * bank word as a whole name. A test pins the two lists apart.
 */

/** Compared against the normalized form: lowercase, no spaces, no punctuation. */
const EXACT = [
  // The attractor set proper.
  'elara', 'elaravoss', 'elaravex', 'aris', 'aristhorne', 'eliasvance', 'elenavoss',
  'kael', 'kaelen', 'kaelan', 'kaelith', 'lyra', 'lyria', 'seraphina', 'seraphine',
  'thorne', 'vex', 'vance', 'voss', 'rylan', 'rhys', 'caelan', 'caelum',
  'aelin', 'aeliana', 'lyrian', 'sylas', 'silas', 'orion', 'zephyr', 'zephyrine',
  'nyx', 'nox', 'raven', 'ravenna', 'phoenix', 'evelyn', 'evangeline',
  'isolde', 'aurelia', 'aurelian', 'cassius', 'cassian', 'lucian', 'lucien',
  'darius', 'draven', 'mireille', 'liora', 'talia', 'thalia', 'kira', 'kyra',
  'anya', 'mira', 'maeve', 'nadia', 'sera', 'selene', 'soren', 'theron', 'valen',
  'alaric', 'alaria', 'eldrin', 'eldric', 'faelan', 'kieran', 'rowan',

  // Places.
  'eldoria', 'eldora', 'eldermere', 'aethermoor', 'silverwood', 'whisperingwoods',
  'shadowfen', 'ravenwood', 'thornwood', 'stormhaven', 'ironhold', 'grimhold',
  'valoria', 'valdoria', 'lumina', 'luminara', 'nocturne', 'emberfall', 'frostvale',
  'silvermere', 'moonhaven', 'sunspire', 'starfall', 'duskwood', 'mistvale',

  // Substances, orders and the abstract-noun-as-proper-noun habit.
  'aetherium', 'aether', 'aetheria', 'etherium', 'luminite', 'obsidianorder',
  'thecrimsonorder', 'theobsidianorder', 'shadowveil', 'theveil', 'thenexus',
  'nexus', 'theconvergence', 'thesundering', 'thereckoning', 'thecataclysm',
  'arcanum', 'thearcanum', 'chronos', 'kronos', 'thevoidborn', 'voidborn',
];

export const SLOP_NAMES: ReadonlySet<string> = new Set(EXACT);

/**
 * Stems that carry the register wherever they land — "Thornwick", "Vexley" and
 * "Shadowmoor" are all the same reflex wearing a different hat. Tested as
 * substrings, so they are deliberately few and deliberately distinctive; a stem
 * short enough to appear inside an innocent coined name does more harm than good.
 */
export const SLOP_STEMS: readonly string[] = [
  'aether', 'shadowmoor', 'thornwick', 'grimwald', 'darkholme',
  'nightshade', 'bloodmoon', 'dragonsbane', 'lightbringer', 'stormborn',
  'eldritch', 'wraithborn', 'moonshadow', 'silverblade', 'ravensworn',
];

/**
 * Endings that mark a name as machine-made regardless of what precedes them.
 * The sylvan sound world bars several of these phonotactically as well — belt
 * and braces, because a compound formula can reintroduce one the syllable
 * assembler never would.
 *
 * Kept narrow on purpose. `-fell`, `-mark` and `-holt` are real toponymic
 * generics this feature deliberately uses (see lexicons.ts), so a tell that
 * caught them would reject the good names along with the bad.
 */
export const SUFFIX_TELLS: readonly RegExp[] = [
  /iel$/, /wyn$/, /wynne$/, /aeth$/, /yth$/, /ium$/,
  /thorne$/, /vayne$/, /vex$/,
];

/**
 * Title shapes. "The Shattered Crown", "Order of Whispers" — the article-plus-
 * participle and the of-abstract-noun constructions are the two the model
 * defaults to for anything that wants to sound important.
 */
export const TITLE_TELLS: readonly RegExp[] = [
  /^the (shattered|whispering|forgotten|eternal|crimson|obsidian|silent|hidden|last|first|broken|fallen|ancient) /i,
  / of (whispers|shadows|echoes|the void|the dawn|the eternal night|blood and ash|fire and ash)$/i,
  /^(order|circle|brotherhood|sisterhood) of the /i,
];

/** lowercase, letters and digits only — so "Al-Rashid" and "AlRashid" collide. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Is this name one the model would have produced on its own?
 *
 * Applied to every candidate the generator emits AND to every name the
 * selection agent returns — the second is the one that matters, because a model
 * handed a slate it dislikes will happily answer with a name that was never on
 * it.
 */
export function isSlop(name: string): boolean {
  const flat = normalizeName(name);
  if (!flat) return true;
  if (SLOP_NAMES.has(flat)) return true;
  // Strip a leading article before checking stems, so "The Aetherium" is caught.
  const bare = flat.replace(/^the/, '');
  if (SLOP_NAMES.has(bare)) return true;
  for (const stem of SLOP_STEMS) if (flat.includes(stem)) return true;
  for (const tell of SUFFIX_TELLS) if (tell.test(flat)) return true;
  for (const tell of TITLE_TELLS) if (tell.test(name.trim())) return true;
  return false;
}
