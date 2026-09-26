import type { Chapter } from '../lib/types.js';
import type { ToolDefinition } from './openrouter.js';

export const searchToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'search_previous_chapters',
    description:
      'Keyword-search the full text of all previous accepted chapters of this novel. ' +
      'Use this when you need details that are not in your context: character names, ' +
      'past events, locations, items, unresolved plot threads, or exact phrasing. ' +
      'Returns the best-matching paragraphs tagged with their chapter number.',
    parameters: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Keywords or short phrases to search for (case-insensitive), e.g. character or place names.',
        },
        max_results: {
          type: 'integer',
          description: 'Maximum number of paragraph snippets to return (default 8).',
        },
      },
      required: ['keywords'],
    },
  },
};

interface Snippet {
  chapter: number;
  chapterTitle: string;
  paragraph: string;
  score: number;
}

/**
 * Simple keyword search: split chapters into paragraphs, score each by keyword
 * occurrences with a strong bonus for matching several distinct keywords.
 */
export function searchChapters(
  chapters: Chapter[],
  keywords: string[],
  maxResults = 8
): Snippet[] {
  const terms = keywords.map((k) => k.trim().toLowerCase()).filter((k) => k.length > 1);
  if (terms.length === 0) return [];

  const snippets: Snippet[] = [];
  for (const chapter of chapters) {
    const paragraphs = chapter.content.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
    for (const paragraph of paragraphs) {
      const lower = paragraph.toLowerCase();
      let occurrences = 0;
      let distinct = 0;
      for (const term of terms) {
        let idx = lower.indexOf(term);
        if (idx === -1) continue;
        distinct++;
        while (idx !== -1) {
          occurrences++;
          idx = lower.indexOf(term, idx + term.length);
        }
      }
      if (distinct === 0) continue;
      snippets.push({
        chapter: chapter.number,
        chapterTitle: chapter.title,
        paragraph: paragraph.trim(),
        score: distinct * 10 + occurrences,
      });
    }
  }

  snippets.sort((a, b) => b.score - a.score || a.chapter - b.chapter);
  return snippets.slice(0, maxResults);
}

export function formatSearchResults(snippets: Snippet[]): string {
  if (snippets.length === 0) {
    return 'No matches found in previous chapters for those keywords.';
  }
  return snippets
    .map((s) => `[Chapter ${s.chapter}${s.chapterTitle ? ` — ${s.chapterTitle}` : ''}]\n${s.paragraph}`)
    .join('\n\n---\n\n');
}
