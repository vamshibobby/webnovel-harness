import type { Context } from 'hono';

/**
 * The one credential the harness needs: an OpenRouter key.
 *
 * Two places it can come from, in order:
 *   1. the `X-OpenRouter-Key` header — what the bundled UI sends after you
 *      paste a key into Settings (it lives in your browser's localStorage);
 *   2. `OPENROUTER_API_KEY` in the server's environment / `.env` file — handy
 *      for scripts, curl, or running headless.
 *
 * Empty string when neither is set; routes that need a model answer 400 with
 * NO_KEY_MESSAGE, routes where model work is optional just skip it.
 */
export function openRouterKey(c: Context): string {
  return c.req.header('X-OpenRouter-Key') || process.env.OPENROUTER_API_KEY || '';
}

export const NO_KEY_MESSAGE =
  'No OpenRouter key: paste one in Settings, or set OPENROUTER_API_KEY in .env.';
