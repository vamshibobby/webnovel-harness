/**
 * The narrative-device catalog: the shapes a character arc can take.
 *
 * Three consumers, which is why it lives here rather than in the UI:
 *  - the author picks a device when planning an arc;
 *  - `typicalBeats` seeds that arc's editable stage list, so a device is
 *    immediately actionable instead of being a label;
 *  - the assist agent gets this list embedded in its prompt, so it recommends
 *    from the same vocabulary the author sees.
 *
 * `frontend/src/lib/designCatalog.ts` mirrors this file — keep them in step.
 */

export interface ArcDevice {
  id: string;
  label: string;
  /** One line the author reads while choosing. */
  blurb: string;
  /** Ordered beats, seeded into a new arc's stages and adapted by the author. */
  typicalBeats: string[];
  /** How to lean on this arc chapter to chapter. Shown as a hint, taught to the agent. */
  steerHint: string;
}

export const CUSTOM_DEVICE_ID = 'custom';

export const ARC_DEVICES: readonly ArcDevice[] = [
  {
    id: 'positive-change',
    label: 'Positive Change / Growth',
    blurb: 'Flawed but sympathetic; the story pressures the flaw until they grow past it.',
    typicalBeats: [
      'clings to the flaw, and it works — for now',
      'the flaw starts costing them something real',
      'a failure they cannot blame on anyone else',
      'chooses the harder, truer way',
      'the old test returns and they pass it changed',
    ],
    steerHint: 'Pressure the flaw. Never let the growth come free.',
  },
  {
    id: 'tragic-fall',
    label: 'Tragic Fall',
    blurb: 'A genuine strength curdles into the thing that destroys them.',
    typicalBeats: [
      'the strength wins them admiration',
      'first compromise, easily justified',
      'warnings dismissed, allies alienated',
      'the point of no return — chosen, not stumbled into',
      'ruin that echoes the opening triumph',
    ],
    steerHint: 'Every step down should feel like a victory to the character.',
  },
  {
    id: 'flat-arc',
    label: 'Flat Arc (Testing the Truth)',
    blurb: 'They already hold the truth; the world around them changes instead.',
    typicalBeats: [
      'states the conviction in a place that has no use for it',
      'the world pushes back, hard',
      'a cost that would break a lesser conviction',
      'someone else changes because they did not',
      'the truth holds, and the world is different for it',
    ],
    steerHint: 'Test their conviction, do not change it — change the people watching.',
  },
  {
    id: 'redemption',
    label: 'Redemption',
    blurb: 'A real wrong, paid for slowly and at cost.',
    typicalBeats: [
      'the wrong, and how easily they live with it',
      'confronted by what it did to someone specific',
      'a first restitution nobody accepts',
      'the chance to take the old road again, refused',
      'redemption bought with something they wanted to keep',
    ],
    steerHint: 'Redemption is bought with loss, never granted by apology.',
  },
  {
    id: 'corruption',
    label: 'Corruption',
    blurb: 'Good intentions, incremental rot.',
    typicalBeats: [
      'a good end that justifies a small means',
      'the means works better than the principle did',
      'someone who trusted them notices',
      'the principle is discarded outright, still in its name',
      'they become what they set out to stop',
    ],
    steerHint: 'Each step must be smaller and more reasonable than the reader is comfortable with.',
  },
  {
    id: 'disillusionment',
    label: 'Disillusionment',
    blurb: 'A believed ideal, cause or idol revealed as hollow.',
    typicalBeats: [
      'devotion, uncomplicated and useful',
      'a detail that does not fit, explained away',
      'proof they cannot explain away',
      'the choice to see clearly, and what it costs to say so',
      'what they build on the other side of belief',
    ],
    steerHint: 'Let the ideal keep winning small arguments right up until it cannot.',
  },
  {
    id: 'coming-of-age',
    label: 'Coming of Age',
    blurb: 'Innocence spent on the way to competence and self-knowledge.',
    typicalBeats: [
      'protected, and unaware of it',
      'the first thing no adult can fix',
      'competence bought with a real mistake',
      'sees an elder plainly for the first time',
      'takes a burden nobody assigned them',
    ],
    steerHint: 'Trade naivety for scar tissue, one illusion at a time.',
  },
  {
    id: 'underdog-rise',
    label: 'Underdog Rise',
    blurb: 'Dismissed by everyone; climbs anyway.',
    typicalBeats: [
      'a humiliation that sets the wound',
      'a hidden edge discovered',
      'grinding, unglamorous work',
      'a first upset nobody can ignore',
      'arrival, and the cost of the climb',
    ],
    steerHint: 'Let contempt from others do the motivating. Never skip the grind.',
  },
  {
    id: 'revenge-quest',
    label: 'Revenge Quest',
    blurb: 'A wrong, a hunt, and the question of what the hunt costs.',
    typicalBeats: [
      'the wrong, witnessed and unanswerable',
      'the vow, and what they give up to keep it',
      'the first target — closer to home than expected',
      'a chance at a life outside the hunt, refused',
      'the reckoning, and whether anything is left after it',
    ],
    steerHint: 'Keep asking what the hunt is hollowing out.',
  },
  {
    id: 'identity-discovery',
    label: 'Self-Discovery',
    blurb: 'Who they were told they are, against who they turn out to be.',
    typicalBeats: [
      'performs the assigned identity well',
      'a moment the performance does not cover',
      'seeks the truth and dislikes part of it',
      'discards what was assigned, publicly',
      'chooses a self, knowing the price',
    ],
    steerHint: 'Peel the told-identity in layers, each with a cost for shedding it.',
  },
  {
    id: 'enemies-to-allies',
    label: 'Enemies to Allies',
    blurb: 'Opposition, then grudging respect, then trust.',
    typicalBeats: [
      'a genuine, well-argued opposition',
      'forced to cooperate by something bigger',
      'each sees the other be competent',
      'one covers for the other at real cost',
      'trust, without either surrendering their position',
    ],
    steerHint: 'Force cooperation before either wants it. Respect precedes liking.',
  },
  {
    id: 'mentors-sacrifice',
    label: "Mentor's Sacrifice",
    blurb: 'Guides, then pays the price the student could not.',
    typicalBeats: [
      'takes the student on for their own reasons',
      'teaches the lesson they themselves failed',
      'the student outgrows the teaching',
      'the mentor spends themselves closing a gap',
      'the student carries the lesson and the debt',
    ],
    steerHint: "The mentor's flaws should teach as much as their lessons.",
  },
  {
    id: 'chosen-one-burden',
    label: "Chosen One's Burden",
    blurb: 'Destiny as weight, not gift.',
    typicalBeats: [
      'marked, and celebrated for it',
      'the expectation outpaces the ability',
      'isolation from everyone who is not watching them',
      'tries to refuse, and finds refusal has victims',
      'accepts it on their own terms',
    ],
    steerHint: 'Bill the chosenness — isolation, expectation, resentment.',
  },
  {
    id: 'power-at-a-price',
    label: 'Power at a Price',
    blurb: 'Every gain in strength exacts something human.',
    typicalBeats: [
      'the offer, and the price stated plainly',
      'the first payment, barely felt',
      'strength that solves a problem nothing else could',
      'the price collected somewhere visible',
      'chooses whether to keep paying',
    ],
    steerHint: 'Name the price early, collect it late and visibly.',
  },
  {
    id: 'slow-burn-betrayal',
    label: 'Slow-Burn Betrayal',
    blurb: 'Trusted now; turning, invisibly, for chapters.',
    typicalBeats: [
      'genuine loyalty, genuinely useful',
      'the first private grievance',
      'a secret kept that did not need keeping',
      'small acts of positioning, readable two ways',
      'the turn, prepared so long it feels inevitable',
    ],
    steerHint: 'Plant only behaviour that reads as loyal now and disloyal in hindsight.',
  },
  {
    id: 'found-family',
    label: 'Found Family',
    blurb: 'Strays and outcasts becoming each other’s people.',
    typicalBeats: [
      'thrown together by need, not affection',
      'a first kept promise nobody demanded',
      'an outsider tests the bond',
      'the option to leave, declined',
      'defends them as family, out loud',
    ],
    steerHint: 'Belonging is built in small kept promises, tested by the option to leave.',
  },
  {
    id: 'hidden-lineage',
    label: 'Hidden Lineage',
    blurb: 'Parentage or origin that rewrites their place in the world.',
    typicalBeats: [
      'an anomaly nobody explains',
      'someone reacts to them as if they were someone else',
      'partial truth from an unreliable source',
      'confirmation, and what it costs to be recognised',
      'claims or refuses the inheritance',
    ],
    steerHint: "Foreshadow through others' reactions, never through the narrator.",
  },
  {
    id: 'the-lie-they-believe',
    label: 'The Lie They Believe',
    blurb: 'A false premise about themselves or the world, load-bearing until it breaks.',
    typicalBeats: [
      'the lie stated as obvious common sense',
      'it produces a real success',
      'it costs someone else something',
      'evidence against it, rejected',
      'the break, and what stands in its place',
    ],
    steerHint: 'Show the lie working before you show it failing.',
  },
  {
    id: 'foil-mirror',
    label: 'Foil / Mirror',
    blurb: 'Defined against another character; each exposes the other.',
    typicalBeats: [
      'the same origin, a different choice',
      'meets the mirror and dislikes the resemblance',
      'takes the mirror’s road briefly',
      'the divergence made explicit between them',
      'becomes what the mirror could not',
    ],
    steerHint: 'Advance this arc only in scenes where the mirror is present.',
  },
  {
    id: 'progression-mastery',
    label: 'Progression / Mastery',
    blurb: 'The cultivation ladder: rank by rank, wall by wall.',
    typicalBeats: [
      'the floor, and what is visibly out of reach',
      'a method others dismiss',
      'a plateau that cannot be brute-forced',
      'the breakthrough, paid for in advance',
      'the next wall, higher and differently shaped',
    ],
    steerHint: 'Bottlenecks and plateaus are the arc; breakthroughs are punctuation.',
  },
] as const;

export function getDevice(deviceId: string): ArcDevice | null {
  return ARC_DEVICES.find((d) => d.id === deviceId) ?? null;
}

/** Display name for an arc's device, falling back to the author's custom label. */
export function deviceLabel(deviceId: string, customLabel?: string): string {
  if (deviceId === CUSTOM_DEVICE_ID) return customLabel?.trim() || 'Custom arc';
  return getDevice(deviceId)?.label ?? deviceId;
}
