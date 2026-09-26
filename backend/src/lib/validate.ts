import type { Context } from 'hono';
import { isSafeModelId } from '../engine/models.js';
import { LimitError } from './limits.js';

/**
 * Input validation. Kept dependency-free deliberately — the backend runs on
 * hono + firebase-admin only, and these rules are simple enough that a schema
 * library would be more weight than help.
 */

/** Field length caps, in characters. */
export const LIMITS = {
  title: 200,
  model: 120,
  premise: 4_000,
  styleNotes: 4_000,
  prompt: 8_000,
  notes: 8_000,
  // Hand-edited chapter text. Well above any real chapter, safely under the
  // 256KB request body limit.
  content: 200_000,
} as const;

/**
 * Thrown for any bad input; carries the status the route should return. The
 * status is part of it so that specialised failures (a wrong PIN, a locked
 * vault) can subclass this and be routed by `apiError` like any other expected
 * client error, instead of each route growing its own error funnel.
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public status: 400 | 401 | 403 | 409 | 413 | 429 = 400
  ) {
    super(message);
  }
}

/**
 * Parse a JSON body without turning malformed input into a 500.
 * `c.req.json()` throws on bad JSON and Hono surfaces that as a server error,
 * which blames us for the caller's mistake.
 */
export async function readJson<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new ValidationError('Request body must be valid JSON');
  }
}

/** Trimmed string within a cap. Rejects non-strings rather than coercing. */
export function boundedString(
  value: unknown,
  field: keyof typeof LIMITS,
  { required = false } = {}
): string {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${field} is required`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be text`);
  }
  const trimmed = value.trim();
  if (required && !trimmed) throw new ValidationError(`${field} is required`);
  const max = LIMITS[field];
  if (trimmed.length > max) {
    throw new ValidationError(`${field} is too long (max ${max.toLocaleString()} characters)`);
  }
  return trimmed;
}

export function safeModelId(value: unknown, { required = true } = {}): string {
  const model = boundedString(value, 'model', { required });
  if (!model) return '';
  if (!isSafeModelId(model)) throw new ValidationError('That model id is not valid');
  return model;
}

/** Chapter numbers are positive integers with a sane ceiling. */
export function chapterNumber(raw: string | undefined, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('Invalid chapter number');
  }
  if (n > max) {
    throw new ValidationError(`Chapter number is too high (max ${max})`);
  }
  return n;
}

/** Target words per chapter; 0 means "let the model decide". */
export function chapterLength(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.max(Math.round(value), 100), 20_000);
}

/**
 * Single exit point for expected request failures: bad input (400/413) and
 * abuse limits (429). Anything else is a real bug and is rethrown so it
 * surfaces as a 500 rather than being swallowed as a client error.
 */
export function apiError(c: Context, err: unknown) {
  if (err instanceof ValidationError) return c.json({ error: err.message }, err.status);
  if (err instanceof LimitError) return c.json({ error: err.message }, 429);
  throw err;
}
