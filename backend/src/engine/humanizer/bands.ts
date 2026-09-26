/**
 * Reference bands for the humanizer, measured against 200 chapters of a
 * professionally written serialised novel in `research/eval`.
 *
 * Numbers only. The corpus they came from is a copyrighted book that is not in
 * this repository and never will be; what is committed here is the measurement,
 * which is the only part the product needs.
 *
 * Every band is TWO-SIDED, and that is the correction that matters most. The
 * research version of these rules had a floor and no ceiling, so a repair pass
 * that was told "fewer codas" kept going until the chapter had far fewer than a
 * person writes: codas were driven from 11.2% to 4.3% against a human 7.4%, and
 * turns that break off from 11.4% to 2.0% against a human 8.1%. Minimising a
 * tell is not the goal. Landing inside the range a human writer occupies is.
 *
 * A defect therefore fires only when a value sits OUTSIDE [lo, hi], and the
 * instruction it produces names the range rather than a direction.
 */

export interface Band {
  /** Below this is too little. */
  lo: number;
  /** Above this is too much. */
  hi: number;
  /** Centre of the human range, used when an instruction needs one number. */
  target: number;
}

/**
 * Bands are set from the reference mean plus roughly the spread seen across
 * chapters, not from the mean alone: a single chapter legitimately varies, and
 * a band tight to the mean would flag ordinary writing.
 */
export const BANDS = {
  /** Long dashes per 1,000 words. The reference barely uses them. */
  emDash: { lo: 0, hi: 2.5, target: 0.3 },
  /** Share of quoted turns whose last sentence is a summarising fragment. */
  dialogueCoda: { lo: 2, hi: 12, target: 7.4 },
  /** Mean words per quoted turn. */
  turnWords: { lo: 10, hi: 24, target: 18.9 },
  /** Share of the chapter's words inside quotation marks. */
  dialogueShare: { lo: 12, hi: 40, target: 20 },
} as const satisfies Record<string, Band>;

/**
 * Word count is banded relative to the novel's own target rather than to the
 * reference, because the author chooses it. Generated chapters ran ~32% short
 * against a 1,450-word target, so the floor is what catches that; the ceiling
 * stops a repair pass from padding.
 */
export const LENGTH_BAND = { lo: 0.75, hi: 1.35 };

/** Below this many quoted turns, the dialogue bands are not meaningful. */
export const MIN_TURNS_FOR_DIALOGUE_BANDS = 6;

/** Chapters shorter than this are not diagnosed at all. */
export const MIN_WORDS_TO_DIAGNOSE = 300;
