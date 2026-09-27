import { configureModelPolicy } from './modelPolicy.js';
import {
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { promisify } from 'node:util';
import type { Context } from 'hono';
import type { AuthEnv } from './authMiddleware.js';
import * as store from './store.js';
import type { Novel, VaultProfile } from './types.js';
import { ValidationError } from './validate.js';

/**
 * The hidden-novel vault.
 *
 * A hidden novel is invisible to every ordinary route — it is not in the
 * dashboard list, and fetching it by id answers 404 exactly as a stranger's
 * novel does. The only way back in is Settings → Access Novels with the
 * account's PIN.
 *
 * A 4-6 digit PIN is a small secret by design — it is the kind of lock you can
 * type on a phone, not a password. Two things do the real work:
 *
 *  - the PIN never leaves the server as anything but a scrypt hash, so a
 *    Firestore leak does not hand over the digits, and
 *  - unlock attempts lock out exponentially, so the ~1M-key space cannot be
 *    walked. Guessing is the attack that matters here, not cracking.
 *
 * Unlocking mints a short-lived HMAC token instead of keeping the PIN around:
 * the client can hold it for the session without holding the secret, and
 * changing or removing the PIN rotates the signing key, which invalidates every
 * outstanding token at once.
 */

// The cast picks scrypt's with-options overload; promisify cannot infer which
// of its several signatures is meant.
const scryptAsync = promisify(
  scrypt as (
    password: string,
    salt: string,
    keylen: number,
    options: ScryptOptions,
    callback: (err: Error | null, derivedKey: Buffer) => void
  ) => void
);

const SCRYPT_KEYLEN = 32;
/** Node's default cost. ~100ms per hash here, which only unlock/set pay. */
const SCRYPT_COST = 16_384;

/**
 * How long an unlock lasts before the PIN is needed again. Long enough to
 * write in — a token that expires mid-chapter turns every save into a 404 —
 * and short of open-ended, with the tab closing and the Lock button as the
 * boundaries that actually matter day to day.
 */
export const UNLOCK_TTL_MS = 2 * 60 * 60 * 1000;

export const PIN_PATTERN = /^\d{4,6}$/;

/** Wrong PINs tolerated before lockouts start. */
const FREE_ATTEMPTS = 4;

/**
 * Lockout after each failure past the free allowance, in ms. A determined
 * guesser gets a few hundred tries a year at the tail of this, which is what
 * makes four digits defensible.
 */
const LOCKOUT_LADDER = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000];

/** An expected vault failure — wrong PIN, locked out, still locked. */
export class VaultError extends ValidationError {}

/** A PIN as typed, or a ValidationError naming what is wrong with it. */
export function validPin(value: unknown, field = 'PIN'): string {
  if (typeof value !== 'string' || !PIN_PATTERN.test(value)) {
    throw new ValidationError(`${field} must be 4 to 6 digits`);
  }
  return value;
}

async function hashPin(pin: string, salt: string): Promise<string> {
  const derived = await scryptAsync(pin, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST });
  return derived.toString('base64');
}

export async function pinMatches(profile: VaultProfile, pin: string): Promise<boolean> {
  const candidate = Buffer.from(await hashPin(pin, profile.pinSalt), 'base64');
  const stored = Buffer.from(profile.pinHash, 'base64');
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

/** A profile for a brand-new PIN. Salt and signing key are freshly random. */
export async function buildProfile(pin: string): Promise<VaultProfile> {
  const pinSalt = randomBytes(16).toString('base64');
  return {
    pinHash: await hashPin(pin, pinSalt),
    pinSalt,
    tokenSecret: randomBytes(32).toString('base64'),
    failedAttempts: 0,
    lockedUntil: 0,
    updatedAt: Date.now(),
  };
}

function sign(secret: string, uid: string, expiresAt: number): string {
  return createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(`${uid}.${expiresAt}`)
    .digest('base64url');
}

export function mintToken(
  profile: VaultProfile,
  uid: string,
  now = Date.now()
): { token: string; expiresAt: number } {
  const expiresAt = now + UNLOCK_TTL_MS;
  return { token: `${expiresAt}.${sign(profile.tokenSecret, uid, expiresAt)}`, expiresAt };
}

export function tokenIsValid(
  profile: VaultProfile,
  uid: string,
  token: string,
  now = Date.now()
): boolean {
  const dot = token.indexOf('.');
  if (dot === -1) return false;
  const expiresAt = Number(token.slice(0, dot));
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;

  const provided = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = Buffer.from(sign(profile.tokenSecret, uid, expiresAt), 'base64url');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** How long the nth consecutive failure locks the account out for. */
export function lockoutFor(failedAttempts: number): number {
  if (failedAttempts <= FREE_ATTEMPTS) return 0;
  return LOCKOUT_LADDER[Math.min(failedAttempts - FREE_ATTEMPTS - 1, LOCKOUT_LADDER.length - 1)];
}

/**
 * Check a PIN, recording the attempt either way, and return the profile it
 * unlocked. Every PIN check goes through here — unlocking, changing the PIN and
 * removing it alike — so none of them can be used as a way around the lockout.
 *
 * The lockout is stored rather than held in memory: Cloud Run runs several
 * instances and scales to zero, so an in-process counter would reset itself on
 * every cold start — which is to say, whenever an attacker wanted it to.
 */
export async function verifyPin(uid: string, pin: string): Promise<VaultProfile> {
  const profile = await store.getVaultProfile(uid);
  if (!profile) throw new VaultError('No PIN has been set for this account', 409);

  const now = Date.now();
  if (profile.lockedUntil > now) {
    throw new VaultError(
      `Too many incorrect PINs. Try again in ${describeWait(profile.lockedUntil - now)}.`,
      429
    );
  }

  if (!(await pinMatches(profile, pin))) {
    const failedAttempts = profile.failedAttempts + 1;
    const penalty = lockoutFor(failedAttempts);
    await store.updateVaultAttempts(uid, {
      failedAttempts,
      lockedUntil: penalty ? now + penalty : 0,
    });
    throw new VaultError(
      penalty
        ? `Incorrect PIN. Too many attempts — try again in ${describeWait(penalty)}.`
        : 'Incorrect PIN',
      401
    );
  }

  if (profile.failedAttempts !== 0 || profile.lockedUntil !== 0) {
    await store.updateVaultAttempts(uid, { failedAttempts: 0, lockedUntil: 0 });
  }
  return profile;
}

/** Check a PIN and mint an unlock token for it. */
export async function unlock(
  uid: string,
  pin: string
): Promise<{ token: string; expiresAt: number }> {
  return mintToken(await verifyPin(uid, pin), uid);
}

/** "45 seconds" / "3 minutes" — rounded, and never a raw timestamp. */
export function describeWait(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** Whether this request carries a live unlock token for its own account. */
export async function isUnlocked(c: Context<AuthEnv>): Promise<boolean> {
  const token = c.req.header('X-Vault-Token');
  if (!token) return false;
  const profile = await store.getVaultProfile(c.get('uid'));
  if (!profile) return false;
  return tokenIsValid(profile, c.get('uid'), token);
}

export async function assertUnlocked(c: Context<AuthEnv>): Promise<void> {
  if (!(await isUnlocked(c))) {
    throw new VaultError('Enter your PIN in Settings → Access Novels first', 403);
  }
}

/**
 * The novel behind `:novelId`, or null if the caller may not see it — which
 * covers "does not exist", "belongs to someone else" and "is hidden and this
 * request is locked out" identically. Callers answer 404 for all three, so a
 * hidden novel's id cannot be probed for existence.
 *
 * Costs an extra read only when the novel is actually hidden.
 */
export async function loadAccessibleNovel(c: Context<AuthEnv>): Promise<Novel | null> {
  const novel = await store.getNovel(c.get('uid'), c.req.param('novelId') ?? '');
  if (!novel) return null;
  if (novel.hidden && !(await isUnlocked(c))) return null;
  configureModelPolicy(novel.modelRoles);
  return novel;
}
