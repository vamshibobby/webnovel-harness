import { Hono } from 'hono';
import type { AuthEnv } from '../lib/authMiddleware.js';
import * as store from '../lib/store.js';
import {
  assertUnlocked,
  buildProfile,
  isUnlocked,
  mintToken,
  unlock,
  validPin,
  verifyPin,
} from '../lib/vault.js';
import { apiError, readJson } from '../lib/validate.js';

/**
 * Settings → Access Novels. The only door to hidden novels: nothing else in the
 * API will list one, and every other route treats one as nonexistent unless the
 * request carries a token minted here. See lib/vault.ts for why it works this
 * way.
 */
export const vaultRoutes = new Hono<AuthEnv>();

interface PinBody {
  pin?: unknown;
  currentPin?: unknown;
}

/**
 * Whether this account has a PIN, and whether this request is already past it.
 * Deliberately says nothing about how many hidden novels there are — that is
 * behind the PIN too.
 */
vaultRoutes.get('/', async (c) => {
  const profile = await store.getVaultProfile(c.get('uid'));
  return c.json({ pinSet: profile !== null, unlocked: await isUnlocked(c) });
});

/**
 * Set the PIN, or change it with the current one. Either way the caller ends up
 * unlocked, so setting a PIN and immediately hiding a novel is one flow rather
 * than two.
 */
vaultRoutes.post('/pin', async (c) => {
  try {
    const body = await readJson<PinBody>(c);
    const pin = validPin(body.pin, 'New PIN');
    const uid = c.get('uid');

    const existing = await store.getVaultProfile(uid);
    if (existing) {
      // Changing a PIN requires proving you know the old one — otherwise a
      // borrowed signed-in session could lock the owner out of their own vault.
      await verifyPin(uid, validPin(body.currentPin, 'Current PIN'));
    }

    // A fresh profile rotates the signing key as well as the hash, so unlock
    // tokens issued under the old PIN stop working the moment it changes.
    const profile = await buildProfile(pin);
    await store.saveVaultProfile(uid, profile);
    return c.json(mintToken(profile, uid));
  } catch (err) {
    return apiError(c, err);
  }
});

/**
 * Remove the PIN. There is no vault without one, so everything hidden comes
 * back to the dashboard rather than being stranded behind a lock that no longer
 * exists.
 */
vaultRoutes.delete('/pin', async (c) => {
  try {
    const body = await readJson<PinBody>(c);
    const uid = c.get('uid');
    await verifyPin(uid, validPin(body.pin));

    const unhidden = await store.unhideAllNovels(uid);
    await store.deleteVaultProfile(uid);
    return c.json({ ok: true, unhidden });
  } catch (err) {
    return apiError(c, err);
  }
});

vaultRoutes.post('/unlock', async (c) => {
  try {
    const body = await readJson<PinBody>(c);
    return c.json(await unlock(c.get('uid'), validPin(body.pin)));
  } catch (err) {
    return apiError(c, err);
  }
});

/** The hidden shelf. The one endpoint in the API that returns hidden novels. */
vaultRoutes.get('/novels', async (c) => {
  try {
    await assertUnlocked(c);
  } catch (err) {
    return apiError(c, err);
  }
  return c.json(await store.listNovels(c.get('uid'), 'hidden'));
});
