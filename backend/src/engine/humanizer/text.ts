/**
 * Text primitives for the humanizer.
 *
 * Small and self-contained on purpose: the diagnosis has to agree exactly with
 * the measurements in research/eval that set the bands, and a shared helper
 * quietly changing its sentence splitter would move every threshold without
 * anyone noticing.
 */

/** Curly quotes, ellipses and unicode dashes folded to ASCII. */
export function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/…/g, '...')
    .replace(/[–—―]/g, '--')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

/** Drops the `Chapter N: Title` line so it is not counted as a paragraph. */
export const stripHeading = (text: string): string =>
  text.replace(/^\s*#{0,4}\s*chapter\s+\d+\s*[:：—–-].*$/im, '').trim();

export function paragraphs(text: string): string[] {
  return normalise(stripHeading(text))
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\n/g, ' ').trim())
    .filter(Boolean);
}

const ABBREV = /\b(mr|mrs|ms|dr|st|prof|sr|jr|vs|etc|no|fig)\.$/i;

export function sentences(text: string): string[] {
  const out: string[] = [];
  for (const para of paragraphs(text)) {
    let buf = '';
    for (const part of para.split(/(?<=[.!?]["']?)\s+/)) {
      buf = buf ? `${buf} ${part}` : part;
      if (ABBREV.test(buf.trim())) continue;
      out.push(buf.trim());
      buf = '';
    }
    if (buf.trim()) out.push(buf.trim());
  }
  return out.filter((s) => /[A-Za-z0-9]/.test(s));
}

export const words = (text: string): string[] =>
  text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));

/** Contents of every double-quoted span: speech, in practice. */
export const quotes = (text: string): string[] =>
  [...normalise(text).matchAll(/"([^"]{1,600})"/g)].map((m) => m[1].trim()).filter(Boolean);

export const hasQuote = (para: string): boolean => /"[^"]{1,600}"/.test(normalise(para));

/** A paragraph with its quoted spans removed: the narration around speech. */
export const outsideQuotes = (para: string): string =>
  normalise(para).replace(/"[^"]*"/g, ' ').replace(/\s+/g, ' ').trim();
