import type { MiddlewareHandler } from 'hono';

/**
 * There are no accounts: the harness runs on your machine for one author.
 * Every request is attributed to the same local user, so the routes and the
 * store keep their per-owner shape (and a future multi-user deployment has
 * one file to swap).
 */
export const LOCAL_UID = 'local';

export interface AuthEnv {
  Variables: {
    uid: string;
    email: string | undefined;
    emailVerified: boolean;
  };
}

export const localUser: MiddlewareHandler<AuthEnv> = async (c, next) => {
  c.set('uid', LOCAL_UID);
  c.set('email', undefined);
  c.set('emailVerified', false);
  await next();
};
