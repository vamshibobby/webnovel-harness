/**
 * Abuse limits.
 *
 * Deliberately narrow. The app is BYOK, so the expensive part of a generation
 * is billed to whoever asks for it — spamming the model is a self-limiting
 * attack and does not need a quota. What is *not* self-limiting is the work
 * that costs the caller nothing:
 *
 *  - creating novels needs no OpenRouter key at all, and consumes storage
 *  - long-lived SSE connections hold server slots, so one caller looping
 *    generations can starve everyone else
 *
 * Locally these are sanity rails, not quotas.
 *
 * Those two are what these limits cover. There is no daily or hourly
 * generation quota by design.
 */

export const LIMITS = {
  /** Simultaneous in-flight generations per user. Availability, not cost. */
  concurrentGenerations: 3,
  novelsPerAccount: 1000,
  chaptersPerNovel: 5000,
} as const;

/**
 * Emails exempt from every limit. Only meaningful if you put the harness
 * behind your own auth; the local single-user mode never matches.
 */
const unlimited = (): Set<string> =>
  new Set(
    (process.env.UNLIMITED_ACCOUNTS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );

/**
 * Anyone can register any address, so matching the email alone would let a
 * stranger claim the exemption by signing up as the owner. The address has to
 * be confirmed before it means anything.
 */
export function isUnlimited(email: string | undefined, emailVerified = false): boolean {
  return emailVerified && !!email && unlimited().has(email.toLowerCase());
}

export class LimitError extends Error {
  status = 429 as const;
}

// Per-instance. With max-instances 3 the real ceiling is 3x the number below,
// which is fine: this exists to stop one account monopolising the service, not
// to meter usage precisely.
const inFlight = new Map<string, number>();

/**
 * Reserve a generation slot. Returns a release function that must be called in
 * a `finally` so a crashed stream cannot leak the slot.
 */
export function acquireGenerationSlot(
  uid: string,
  email: string | undefined,
  emailVerified = false
): () => void {
  if (isUnlimited(email, emailVerified)) return () => {};

  const current = inFlight.get(uid) ?? 0;
  if (current >= LIMITS.concurrentGenerations) {
    throw new LimitError(
      `You already have ${LIMITS.concurrentGenerations} chapters generating. Wait for one to finish.`
    );
  }
  inFlight.set(uid, current + 1);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (inFlight.get(uid) ?? 1) - 1;
    if (next <= 0) inFlight.delete(uid);
    else inFlight.set(uid, next);
  };
}

export function assertNovelAllowed(
  count: number,
  email: string | undefined,
  emailVerified = false
): void {
  if (isUnlimited(email, emailVerified)) return;
  if (count >= LIMITS.novelsPerAccount) {
    throw new LimitError(
      `You've reached the limit of ${LIMITS.novelsPerAccount} novels. Delete one to make room.`
    );
  }
}

/**
 * Chapters must be appended, not scattered. Without this an arbitrary `n`
 * creates a sparse document at chapter 999999.
 */
export function assertChapterAllowed(
  n: number,
  chapterCount: number,
  email: string | undefined,
  emailVerified = false
): void {
  if (isUnlimited(email, emailVerified)) return;
  if (n > chapterCount + 1) {
    throw new LimitError(
      `Write chapter ${chapterCount + 1} next — chapters have to be written in order.`
    );
  }
  if (n > LIMITS.chaptersPerNovel) {
    throw new LimitError(`This novel has reached the limit of ${LIMITS.chaptersPerNovel} chapters.`);
  }
}

