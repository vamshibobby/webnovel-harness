/**
 * Stage A of arc planning: the author's premise, made structural — before
 * any model sees it.
 *
 * Deterministic, no network, no key. It runs first and its output is
 * persisted first, which is what makes "a stage failure cannot destroy
 * another stage's work" true rather than aspirational: if the refine call
 * 502s, the author still has their thread list on screen.
 *
 * The reading is deliberately shallow. An author describing a braided arc
 * writes a numbered list — one line or paragraph per storyline — and says
 * things like "early in the arc", "not resolved here", "only once the beta
 * works". This file finds the list, keeps their numbering and their words as
 * the labels, and scans each thread's own text for the timing and dependency
 * phrases. Whatever it cannot read, the refine model is asked to fill in;
 * whatever it CAN read is already banked and the model can only enrich it
 * (mergeThreadSeeds — the model can never delete a storyline).
 */
import { ARC_LIMITS } from '../lib/arcValidate.js';
import type { ArcThread, ArcTimeline, ThreadAnchor } from '../lib/types.js';
import { fnv1a } from './map/prng.js';

export interface ThreadSeedResult {
  threads: ArcThread[];
  timeline?: ArcTimeline;
}

const NUMBERED = /^\s*(\d{1,2})[.)]\s+(.*)$/;
const BULLETED = /^\s*[-•*]\s+(.*)$/;

/** A clause that only says WHEN — "in the 8 months", "over the winter". */
const TEMPORAL_CLAUSE = /^\s*(?:in|over|during|across|by|throughout)\s+(?:the\s+)?(?:next\s+)?[\w\s-]{0,20}(?:days?|weeks?|months?|years?|winter|summer|spring|autumn|fall)\s*$/i;

/** First substantive clause of a thread's text — its name, in the author's words. */
function labelOf(text: string): string {
  const firstSentence = text.split(/(?<=[.!?])\s+/)[0] ?? text;
  const clauses = firstSentence.split(/[,;—–]/);
  // "in the 8 months, agile grew more than expected" — the storyline is the
  // second clause; the first only says when.
  const clause = (clauses.find((c) => c.trim().length >= 12 && !TEMPORAL_CLAUSE.test(c)) ?? firstSentence).trim();
  const label = clause.replace(/[.!?]+$/, '');
  // A label is a handle, not a synopsis: it names chips, badges, prompt
  // rosters and braid briefs, and a first clause can legally run to 120
  // characters of them. Cut at a word boundary around 64.
  if (label.length <= 64) return label;
  const cut = label.slice(0, 64);
  return (cut.slice(0, cut.lastIndexOf(' ')) || cut).replace(/[,;:]$/, '');
}

function anchorOf(text: string): { anchor: ThreadAnchor; anchorNote?: string } {
  const t = text.toLowerCase();
  const specific = t.match(
    /\b(?:in|by|during|around)\s+the\s+(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d{1,2}(?:st|nd|rd|th)?)\s+(?:month|week|day|year)\b|\bweek\s+\d{1,2}\b|\bmonth\s+\d{1,2}\b/
  );
  if (specific) return { anchor: 'specific', anchorNote: specific[0] };
  // "early" alone is too loose — "an early rendition of salesforce" is not a
  // schedule. It counts only with a temporal word beside it.
  if (/\bearly\s+(?:in|on|time|days|chapters|part|stage|months?|weeks?)\b|\bat the (?:start|beginning)\b|\bopens with\b/.test(t)) {
    return { anchor: 'early' };
  }
  if (/\b(?:mid(?:dle)? of|halfway|by the middle|in the middle)\b/.test(t)) return { anchor: 'mid' };
  if (/\b(?:at the end|by the end|the arc ends|end of the arc|final(?:ly)? |last chapters|climax)\b/.test(t)) {
    return { anchor: 'late' };
  }
  if (/\b(?:throughout|over the (?:whole|entire)|all the way|here and there|whenever)\b/.test(t)) {
    return { anchor: 'span' };
  }
  return { anchor: 'span' };
}

const OPEN_ENDED =
  /\b(?:not resolved|unresolved|left hanging|still open|left open|nothing is released|no product is released|still sleeping|remains? unresolved|don'?t go into depth)\b/i;
const NEXT_ARC = /\b(?:next arc|pays? off later|only a glimpse|we get a glimpse|villain for the next)\b/i;

/**
 * "only once the beta works", "as a result of the marketing projects",
 * "propelled by", "using this" — the phrases that say one thread waits on
 * another. Resolution to a thread id happens against the other seeds by
 * label-word overlap; a dependency the scan cannot place is left for the
 * refine model, whose schema asks for it by thread number.
 */
function dependencyHints(text: string): string[] {
  const hints: string[] = [];
  for (const m of text.matchAll(
    /\b(?:only (?:once|after|because|when)|as a result of|because of|thanks to|once)\s+([^,.;]{4,80})/gi
  )) {
    hints.push(m[1].trim());
  }
  return hints;
}

const wordsOf = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3)
  );

export function extractThreadSeeds(premise: string): ThreadSeedResult {
  const lines = premise.split('\n');

  // The list: numbered items win; bullets count only when there are three or
  // more, because two dashes is prose, not a plan.
  type Item = { authorNumber?: number; text: string };
  const items: Item[] = [];
  let current: Item | null = null;
  let bulleted = 0;
  for (const line of lines) {
    const numbered = NUMBERED.exec(line);
    const bullet = numbered ? null : BULLETED.exec(line);
    if (numbered) {
      if (current) items.push(current);
      current = { authorNumber: Number(numbered[1]), text: numbered[2] };
    } else if (bullet) {
      if (current) items.push(current);
      current = { text: bullet[1] };
      bulleted++;
    } else if (current && line.trim()) {
      current.text += ` ${line.trim()}`;
    }
  }
  if (current) items.push(current);

  // A premise written as one flowing paragraph still often numbers its
  // storylines inline: "… 2. his feud with refsdal …". Split on inline
  // numbers when the line scan found fewer than two.
  let list = items;
  if (list.filter((i) => i.authorNumber !== undefined).length < 2) {
    const inline = premise.split(/(?=(?:^|\s)\d{1,2}\.\s+)/);
    if (inline.length >= 3) {
      list = inline
        .map((chunk): Item | null => {
          const m = /^\s*(\d{1,2})\.\s+([\s\S]*)$/.exec(chunk.trim());
          return m ? { authorNumber: Number(m[1]), text: m[2].replace(/\s+/g, ' ').trim() } : null;
        })
        .filter((i): i is Item => i !== null);
    }
  }
  if (list === items && bulleted > 0 && bulleted < 3) {
    list = items.filter((i) => i.authorNumber !== undefined);
  }

  // No list at all: the whole premise is one storyline, and every downstream
  // reader treats a single-thread arc exactly as arcs always worked.
  if (list.length < 2) {
    const label = labelOf(premise.replace(/\s+/g, ' ').trim() || 'the arc');
    return {
      threads: [
        {
          id: `t1-${fnv1a(label.toLowerCase()).toString(36)}`,
          label,
          anchor: 'span',
          source: 'author',
        },
      ],
      timeline: timelineOf(premise),
    };
  }

  const seeds: ArcThread[] = list.slice(0, ARC_LIMITS.threads).map((item, i) => {
    const label = labelOf(item.text);
    const { anchor, anchorNote } = anchorOf(item.text);
    const seed: ArcThread = {
      id: `t${item.authorNumber ?? i + 1}-${fnv1a(label.toLowerCase()).toString(36)}`,
      label,
      anchor,
      source: 'author',
      ...(item.authorNumber !== undefined ? { authorNumber: item.authorNumber } : {}),
      ...(anchorNote ? { anchorNote } : {}),
    };
    if (OPEN_ENDED.test(item.text)) seed.endsOpen = true;
    if (NEXT_ARC.test(item.text)) {
      seed.endsOpen = true;
      seed.seedForNextArc = true;
    }
    // Room: a one-line thread is a scene, not a campaign.
    seed.weight = item.text.length < 160 ? 'minor' : 'major';
    return seed;
  });

  // Dependencies, resolved by word overlap against the other threads' text.
  for (let i = 0; i < seeds.length; i++) {
    const hints = dependencyHints(list[i].text);
    if (!hints.length) continue;
    const deps = new Set<string>();
    for (const hint of hints) {
      const hintWords = wordsOf(hint);
      let best: { id: string; score: number } | null = null;
      for (let j = 0; j < seeds.length; j++) {
        if (j === i) continue;
        const overlap = [...hintWords].filter((w) => wordsOf(list[j].text).has(w)).length;
        if (overlap >= 2 && (best === null || overlap > best.score)) best = { id: seeds[j].id, score: overlap };
      }
      if (best) deps.add(best.id);
    }
    if (deps.size) seeds[i].dependsOn = [...deps];
  }

  return { threads: seeds, timeline: timelineOf(premise) };
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

function timelineOf(premise: string): ArcTimeline | undefined {
  const m = premise
    .toLowerCase()
    .match(/\b(?:over|in|during|across|spanning)\s+the\s+next\s+(\w+)\s+(days?|weeks?|months?|years?)\b|\bnext\s+(\w+)\s+(days?|weeks?|months?|years?)\b/);
  if (!m) return undefined;
  const word = m[1] ?? m[3];
  const unit = (m[2] ?? m[4]) as string;
  const n = NUMBER_WORDS[word] ?? Number(word);
  if (!Number.isFinite(n) || n < 1) return undefined;
  const perUnit = unit.startsWith('day') ? 1 : unit.startsWith('week') ? 7 : unit.startsWith('month') ? 30 : 365;
  return {
    spanDays: Math.min(ARC_LIMITS.arcSpanDays, n * perUnit),
    note: m[0].trim(),
  };
}
