import { dataPath, removeDoc, writeBinary } from './localdb.js';
import type { Novel } from './types.js';

/**
 * Cover images — generation prompts, and the local folder they land in
 * (`data/covers/`). Image models cost real money per call (~$0.015 standard).
 */

/**
 * The default renders a cover for ~$0.015. Krea over FLUX Klein at the same
 * price, measured on the same prompt: Klein letters garbled pseudo-titles
 * onto the art despite "no text", Krea obeys and paints better — its one
 * limit is square-only output, which every cover surface centre-crops to 2:3
 * anyway (the prompt biases the subject centre so the crop stays safe).
 */
export const COVER_MODELS = {
  standard: 'krea/krea-2-medium-turbo',
  best: 'x-ai/grok-imagine-image-quality',
} as const;

export type CoverQuality = keyof typeof COVER_MODELS;

/** Portrait, book-cover shaped, and small enough to load fast on a shelf. */
export const COVER_SIZE = '768x1152';

/**
 * Optional art direction. Keys mirror the frontend's select; the strings are
 * what the model actually reads. Kept short — the story does the describing.
 */
export const COVER_THEMES: Record<string, string> = {
  'epic-fantasy': 'epic fantasy book cover art, painterly, dramatic lighting',
  anime: 'anime-style illustration, clean lines, vibrant colour',
  'dark-moody': 'dark, moody, atmospheric cover art, muted palette',
  watercolour: 'ink and watercolour illustration, soft washes, textured paper',
  'sci-fi': 'science-fiction concept art, cinematic scale',
  minimal: 'minimalist symbolic book cover, flat shapes, bold composition',
};

/**
 * The default prompt when the author types nothing: the novel introduces
 * itself. "No text" because models letter badly — the title is typography's
 * job, and every surface that shows a cover shows the title beside it.
 */
export function buildCoverPrompt(
  novel: Pick<Novel, 'title' | 'premise'>,
  firstChapterSummary: string,
  userPrompt: string,
  themeKey: string
): string {
  const theme = COVER_THEMES[themeKey] ?? '';
  const subject =
    userPrompt.trim() ||
    [
      `Book cover illustration for a web novel titled "${novel.title}".`,
      novel.premise.trim(),
      firstChapterSummary.trim(),
    ]
      .filter(Boolean)
      .join(' ');
  return [subject, theme, 'Portrait book cover composition, main subject centred. No text, no lettering, no words.']
    .filter(Boolean)
    .join(' ');
}

/** Public URL prefix the server serves covers under (see index.ts). */
export const COVER_URL_PREFIX = '/files/covers/';

/**
 * Store a cover on disk and return the URL the server serves it at. Names are
 * versioned by timestamp so a replaced cover is a new URL, never a stale cache.
 */
export async function storeCover(novelId: string, png: Buffer, contentType: string): Promise<string> {
  const ext = contentType === 'image/webp' ? 'webp' : contentType === 'image/jpeg' ? 'jpg' : 'png';
  const name = `${novelId}-${Date.now()}.${ext}`;
  writeBinary(dataPath('covers', name), png);
  return `${COVER_URL_PREFIX}${name}`;
}

/** Best-effort delete of a previous cover when it is replaced or removed. */
export async function deleteCoverByUrl(url: string | undefined): Promise<void> {
  if (!url || !url.startsWith(COVER_URL_PREFIX)) return;
  const name = url.slice(COVER_URL_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+\.(png|jpg|webp)$/.test(name)) return;
  removeDoc(dataPath('covers', name));
}
