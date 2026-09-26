/**
 * Telling the chapter apart from the model talking about writing the chapter.
 *
 * Reasoning models are supposed to put deliberation in the `reasoning` field,
 * where streamChat routes it to its own panel. Several do not — measured on the
 * managed free tier, which routes wherever capacity is and is what every new
 * account writes its first chapter on. What arrives instead is a plan in the
 * CONTENT channel: it streams into the chapter view token by token and, unless
 * something catches it, is saved as the author's prose and word-counted.
 *
 * Two call sites need this and had drifted apart, which is why it now lives in
 * one file:
 *
 *   agent.ts       decides whether to throw the reply away and ask again.
 *   chapters.ts    decides how far to look for the heading before giving up.
 *
 * ── Why the first version of this missed the failure it was written for
 *
 * The original marker list was built around first-person-PLURAL deliberation —
 * "we need to", "let's write", "we should include". Real replies do not sound
 * like that. They announce, in the singular:
 *
 *     "Good. Now I have full context. Let me write Chapter 7."
 *     "I have all the context I need. Let me now write Chapter 9."
 *
 * Neither scored a single marker, so `looksLikeReasoning` returned false on
 * both. The second of those is quoted verbatim in research/eval/README.md as a
 * measured Phase-1 failure — the detector never covered the case that motivated
 * it. Hence the singular family below, and hence the tests.
 *
 * ── Why quoted speech is stripped before matching
 *
 * "Let me start," she said. is a line of dialogue, not a model announcing
 * itself, and a chapter opening on that must not be thrown away. Removing
 * quoted spans before matching kills that whole class of false positive, which
 * matters more than usual here: the penalty for a false positive is discarding
 * a chapter the author is watching arrive.
 */

/** Quoted spans blanked, so speech cannot trip a marker. */
const withoutSpeech = (text: string): string => text.replace(/["“][^"”]{0,600}["”]/g, ' ');

/**
 * Phrases that belong to a model planning a chapter, never to the chapter.
 *
 * Every entry is high-precision by construction: PLANNING_MIN below requires
 * two DISTINCT markers before anything is discarded, so a list of merely
 * suggestive patterns would be worse than a short list of damning ones.
 */
export const PLANNING_MARKERS: readonly RegExp[] = [
  // ── first person plural: the model deliberating with itself
  /\bwe need to\b/i,
  /\bwe (?:should|must|can|could) (?:write|open|include|avoid|produce|aim|start)\b/i,
  /\blet'?s (?:pick|write|start|use|aim|go with|say)\b/i,
  // ── first person singular: the model announcing itself. The family that
  //    actually ships, and the one the original list had no entry for.
  /\blet me (?:now )?(?:write|start|begin|draft|compose|get started|do this)\b/i,
  /\bI(?:'ll|'m going to| will| am going to| shall) (?:now )?(?:write|start|begin|draft|compose)\b/i,
  /\bI (?:now )?have (?:all |enough |the |full )*context\b/i,
  // ── the scaffolding of a plan, which prose does not have
  /^\s*paragraph \d+\s*[:.]/im,
  /^\s*constraints?\s*:/im,
  /^\s*key\s+points?\s*:/im,
  /^\s*(?:plan|outline|beats?|structure|approach)\s*:/im,
  // ── talking about the assignment rather than doing it
  /\b(?:approx(?:imately)?|about|around|~)\s*[\d,]{3,6}\s*words\b/i,
  /\bthe (?:user|prompt|instructions?|brief) (?:says?|asks?|wants?|requires?)\b/i,
  /\bmust (?:not repeat|end with|include|avoid)\b/i,
  /\bword count\b/i,
];

/**
 * Only the opening is examined.
 *
 * A chapter opens with its heading or with narrative, so planning at the top is
 * decisive. Scanning the whole thing would fail the other way: a character is
 * allowed to say "we need to leave", and a long chapter gives that phrase many
 * chances to appear innocently.
 */
export const PLANNING_WINDOW = 1500;
/** Two independent markers, because one can be a coincidence in dialogue. */
export const PLANNING_MIN = 2;

export function looksLikeReasoning(text: string): boolean {
  const opening = withoutSpeech(text.slice(0, PLANNING_WINDOW));
  let hits = 0;
  for (const marker of PLANNING_MARKERS) {
    if (marker.test(opening) && ++hits >= PLANNING_MIN) return true;
  }
  return false;
}

/**
 * Detection only — deliberately NOT the product's title contract.
 *
 * `HEADING_LINE` in routes/chapters.ts decides what a chapter is called and is
 * the thing tests pin. This one only answers "did a chapter start here", so it
 * is allowed to be looser, and the two must not be collapsed into one: making
 * the title contract tolerant enough for detection is how a chapter ends up
 * titled after a line of the model's own commentary. Same split, same reason, as
 * PRODUCT_TITLE vs ANY_HEADING in humanizer/diagnose.ts.
 */
const ANY_HEADING = /^\s*(?:[*_#]{1,4}\s*){0,3}chapter\s+\d+\s*[:：—–-]\s*\S/im;

/** Enough prose under a heading to be worth keeping rather than regenerating. */
const MIN_BODY_WORDS = 200;

/**
 * Did a real chapter turn up underneath the planning?
 *
 * This is what stops the widened markers above from costing money. A reply that
 * plans and then writes is a nuisance the title extractor already handles for
 * free; throwing it away would buy a cleaner stream at the price of a second
 * full generation the author pays for. So the agent only restarts when the plan
 * is ALL there is — which is the case that has to be regenerated anyway, since
 * there is no chapter in it.
 */
export function hasChapterBody(text: string): boolean {
  const match = text.match(ANY_HEADING);
  if (match?.index === undefined) return false;
  const body = text.slice(match.index + match[0].length);
  return body.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length >= MIN_BODY_WORDS;
}

/** A bullet, or a numbered step. Prose does not open lines this way. */
const BULLET = /^\s*(?:[-*•‣]|\d+[.)])\s+\S/;
/** A bare label on its own line: "Key points:", "Beats:", "Plan:". */
const LABEL = /^[A-Z][A-Za-z' ]{0,28}:$/;

/**
 * Is this line part of a plan rather than part of the story?
 *
 * Used by the title extractor to decide whether to keep looking for the
 * heading. The budget it guards exists so that prose mentioning a chapter
 * heading cannot swallow everything above it, and that budget must stay small —
 * so instead of raising it, a line positively identified as planning is not
 * charged against it. Same shape as FREE_NAMING_ROUNDS in agent.ts: the limit is
 * there to bound one thing, and material that is not that thing rides free.
 */
export function isPlanningLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (BULLET.test(line) || LABEL.test(trimmed)) return true;
  const bare = withoutSpeech(trimmed);
  return PLANNING_MARKERS.some((m) => m.test(bare));
}
