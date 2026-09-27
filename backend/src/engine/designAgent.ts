import {
  DESIGN_LIMITS,
  DesignValidationError,
  applyDesignPatch,
  validateDesignPatch,
} from '../lib/designValidate.js';
import * as store from '../lib/store.js';
import type { BibleEntry, Chapter, CharacterDesign, Novel } from '../lib/types.js';
import type { AgentEvent } from './agent.js';
import {
  formatBibleEntry,
  formatBibleIndex,
  formatBibleSearchResults,
  getBibleToolDefinition,
  searchBibleEntries,
  searchBibleToolDefinition,
} from './bibleTools.js';
import { ARC_DEVICES } from './designCatalog.js';
import { formatDesignSheet, makeTargetResolver, updateDesignToolDefinition } from './designTools.js';
import { streamChat, type ChatMessage, type ToolDefinition, type Usage } from './openrouter.js';

/**
 * Design assistance runs on the same fixed cheap model as the bible agent, and
 * for the same reason: it fills in structure the author then reviews and edits.
 * Never the novel's model, never user-selected.
 */
export const DESIGN_MODEL = 'deepseek/deepseek-v4-flash';

const MAX_ROUNDS = 6;

const EMPTY_USAGE: Usage = {
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
};

function addUsage(a: Usage, b: Usage | null): Usage {
  if (!b) return a;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cost: a.cost + b.cost,
  };
}

const DEVICE_CATALOG_BLOCK = ARC_DEVICES.map(
  (d) => `- ${d.id} (${d.label}): ${d.blurb} Beats: ${d.typicalBeats.join(' → ')}`
).join('\n');

/**
 * The assist agent's instructions.
 *
 * The failure mode this prompt exists to prevent is a sheet full of confident
 * generic filler — "brave, loyal, determined" — which reads as complete and
 * teaches the chapter writer nothing. Hence the craft rules: want must differ
 * from need, a flaw must be able to cost something, and voice must be
 * specific enough to write dialogue from.
 */
const ASSIST_SYSTEM_PROMPT = [
  'You help an author complete a CHARACTER DESIGN: a private planning sheet holding both what',
  'the story has established about a character and what the author intends for them. You are',
  'drafting INTENT, not recording canon. The story bible records canon; you may read it, and',
  'you must never contradict it.',
  '',
  'You have three tools: search_story_bible and get_story_bible_entries to read what the novel',
  'has established, and update_character_design to write the sheet.',
  '',
  '## PROCESS',
  '1. Read the design below and note which sections are empty or thin.',
  '2. Read canon: search the story bible for this character and anyone tied to them. If the',
  '   sheet names a linked bible entry, read it — their established role, status and',
  '   relationships constrain what you may invent.',
  '3. Call update_character_design ONCE with everything you are filling in. Send only the',
  '   sections you are changing.',
  '4. Finish with one short line saying what you filled. Nothing else.',
  '',
  '## WHAT YOU MAY AND MAY NOT INVENT',
  '- The past is constrained. Backstory, age, appearance and role must fit everything the bible',
  '  and the premise establish. If canon is silent, you may invent; if canon speaks, follow it.',
  '- The future is yours to propose: motivations, arcs, secrets, where relationships could go.',
  '- RESPECT WHAT THE AUTHOR WROTE. Fill gaps. Do not rewrite a section the author has already',
  '  filled unless their instructions ask you to. If something they wrote contradicts canon, say',
  "  so in `notes` — do not silently overwrite it.",
  '- Never invent events and present them as things that happened in the novel.',
  '',
  '## CRAFT RULES — this is what separates a useful sheet from filler',
  '- WANT vs NEED: what they are chasing is rarely what would make them whole. If want and need',
  '  say the same thing, you have written one of them wrong.',
  '- THE LIE is the false belief holding want and need apart. It should explain the character.',
  '  ("If I am strong enough, no one can leave me" — not "he distrusts people".)',
  '- FLAWS must be capable of costing them something concrete in a scene. "Stubborn" is a',
  '  label; "will not ask for help even when it is free" is a flaw a chapter can spend.',
  '- VOICE must be specific enough to write dialogue from: rhythm, register, what they say when',
  '  cornered, verbal tics, and what they never say. Adjectives ("charming") are useless here.',
  '- TRAITS and VIRTUES should include at least one that will make trouble for them.',
  '- SECRETS: mark `revealed` true ONLY if the story has already shown it to the reader.',
  '  Unrevealed secrets shape behaviour and are never narrated, so they are the useful ones.',
  '',
  '## ARCS — pick from this catalog',
  DEVICE_CATALOG_BLOCK,
  '',
  'Choose 1-2 devices that genuinely fit this character and premise. For each: adapt the beats',
  'into `stages` phrased for THIS story (2-7 of them), write a `summary`, and write a `nudge` —',
  'one line telling a chapter writer how to lean on the arc, never an instruction to force it.',
  'Set state "current" ONLY if the story has already begun the arc; otherwise "potential".',
  'At most one arc may be "current".',
  '',
  '## ANTI-PATTERNS — do not produce these',
  '- The virtue list: "brave, loyal, kind, determined". Says nothing, constrains nothing.',
  '- Motivation that restates the plot ("wants to defeat the demon lord"). Ask what they want',
  '  that they would still want if the plot went away.',
  '- Arcs that are this-chapter plans ("confronts his rival at the tournament"). An arc spans',
  '  many chapters; a beat is not an arc.',
  '- Secrets that duplicate something already revealed, or that no one would care about.',
  '- Touching every field when three would do. A short sheet with teeth beats a full one without.',
  '',
  '## HARD RULES',
  '- If a tool call returns an error, read it, fix the arguments and retry once. Errors are precise.',
  `- Limits: ${DESIGN_LIMITS.arcs} arcs, ${DESIGN_LIMITS.secrets} secrets,`,
  `  ${DESIGN_LIMITS.traitsPerList} entries per trait list, ${DESIGN_LIMITS.arcStages} stages per arc.`,
  '- You cannot activate a design or turn on arc steering. Those are the author\'s decisions.',
].join('\n');

export interface DesignAssistResult {
  usage: Usage;
  updated: boolean;
}

/**
 * Fill in one design, grounded in the novel's canon.
 *
 * Unlike the bible agent this is NOT best-effort: it is a foreground action
 * the author asked for and is watching, so failures surface rather than being
 * swallowed.
 */
export async function runDesignAssist(args: {
  apiKey: string;
  novel: Novel;
  design: CharacterDesign;
  bibleEntries: BibleEntry[];
  /** Optional author guidance for this run. */
  instructions?: string;
  signal?: AbortSignal;
  emit?: (event: AgentEvent) => void;
}): Promise<DesignAssistResult> {
  const emit = args.emit ?? (() => {});
  const bible = args.bibleEntries;
  const resolve = makeTargetResolver(bible, [args.design]);
  let total = EMPTY_USAGE;
  let updated = false;

  const linked = args.design.linkedEntryId
    ? bible.find((e) => e.id === args.design.linkedEntryId)
    : null;

  const messages: ChatMessage[] = [
    { role: 'system', content: ASSIST_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `NOVEL: ${args.novel.title}\nPREMISE: ${args.novel.premise || '(none)'}\n` +
        `${args.novel.styleNotes ? `AUTHOR'S STYLE NOTES: ${args.novel.styleNotes}\n` : ''}\n` +
        `STORY BIBLE INDEX (${bible.length} entries):\n${formatBibleIndex(bible) || '(empty)'}\n\n` +
        (linked
          ? `THIS CHARACTER'S BIBLE ENTRY (established canon — do not contradict):\n${formatBibleEntry(linked)}\n\n`
          : 'This design is not linked to a story bible entry.\n\n') +
        `CURRENT DESIGN SHEET:\n${formatDesignSheet(args.design, resolve)}\n\n` +
        (args.instructions?.trim()
          ? `THE AUTHOR ASKS: ${args.instructions.trim()}`
          : 'The author has not given specific instructions — fill the gaps you judge most useful.'),
    },
  ];

  const tools: ToolDefinition[] = [
    searchBibleToolDefinition,
    getBibleToolDefinition,
    updateDesignToolDefinition,
  ];

  for (let round = 0; round <= MAX_ROUNDS; round++) {
    const forceStop = round === MAX_ROUNDS;
    const result = await streamChat({
      role: 'characters',
      apiKey: args.apiKey,
      model: DESIGN_MODEL,
      messages,
      tools: forceStop ? undefined : tools,
      maxTokens: 3000,
      signal: args.signal,
    });
    total = addUsage(total, result.usage);

    if (result.finishReason !== 'tool_calls' || result.toolCalls.length === 0) break;

    messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });

    for (const call of result.toolCalls) {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        parsed = {};
      }

      let output: string;
      switch (call.function.name) {
        case 'search_story_bible': {
          const terms = Array.isArray(parsed.terms) ? parsed.terms.map(String) : [];
          output = formatBibleSearchResults(searchBibleEntries(bible, terms));
          break;
        }
        case 'get_story_bible_entries': {
          const ids = Array.isArray(parsed.ids) ? parsed.ids.map(String).slice(0, 12) : [];
          const found = bible.filter((e) => ids.includes(e.id));
          output = found.length
            ? found.map(formatBibleEntry).join('\n\n---\n\n')
            : 'No entries with those ids. Check the index or search first.';
          break;
        }
        case 'update_character_design': {
          try {
            const patch = validateDesignPatch(parsed);
            const next = await store.transactDesign(args.novel.id, args.design.id, (current) =>
              applyDesignPatch(current ?? args.design, args.design.id, patch)
            );
            updated = true;
            emit({ type: 'trace', data: `Updated the design sheet for ${next.name}` });
            output = `Saved.\n${formatDesignSheet(next, resolve)}`;
          } catch (err) {
            if (err instanceof DesignValidationError) output = `Error: ${err.message}`;
            else throw err;
          }
          break;
        }
        default:
          output = `Unknown tool: ${call.function.name}`;
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
    }
  }

  console.log(
    `[design:assist] novel=${args.novel.id} design=${args.design.id} ` +
      `updated=${updated} cost=$${total.cost.toFixed(5)}`
  );
  return { usage: total, updated };
}

// ── Drift ─────────────────────────────────────────────────────────────────

export type DriftAspect =
  | 'voice'
  | 'motivation'
  | 'personality'
  | 'arc'
  | 'relationship'
  | 'history'
  | 'essentials'
  | 'status';

export interface DriftFinding {
  aspect: DriftAspect;
  /** What the design intends. */
  designClaim: string;
  /** What the written story actually shows. */
  canonEvidence: string;
  chapters: number[];
  severity: 'minor' | 'significant' | 'contradiction';
  /** A nudge that would pull future chapters back toward the design. */
  steerSuggestion: string;
  /** How the design would change to accept canon as it stands. */
  updateSuggestion: string;
}

export interface DriftReport {
  designId: string;
  verdict: 'on-track' | 'drifting' | 'diverged';
  summary: string;
  findings: DriftFinding[];
}

/**
 * The report is delivered through a tool call rather than parsed out of prose:
 * the parameter schema is the enforcement, and a malformed report comes back
 * to the model as a correctable error instead of a broken UI.
 */
const reportDriftToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'report_drift',
    description:
      'Report how far the written story has diverged from the character design. Call this exactly once, at the end.',
    parameters: {
      type: 'object',
      properties: {
        verdict: {
          type: 'string',
          enum: ['on-track', 'drifting', 'diverged'],
          description:
            'on-track: the written character matches the design. drifting: real but recoverable divergence. diverged: canon has foreclosed part of the design.',
        },
        summary: { type: 'string', description: 'Two or three sentences for the author.' },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              aspect: {
                type: 'string',
                enum: [
                  'voice',
                  'motivation',
                  'personality',
                  'arc',
                  'relationship',
                  'history',
                  'essentials',
                  'status',
                ],
              },
              designClaim: { type: 'string', description: 'What the design says, quoted or closely paraphrased.' },
              canonEvidence: { type: 'string', description: 'What the story actually shows.' },
              chapters: {
                type: 'array',
                items: { type: 'number' },
                description: 'Chapter numbers where the evidence appears.',
              },
              severity: { type: 'string', enum: ['minor', 'significant', 'contradiction'] },
              steerSuggestion: {
                type: 'string',
                description:
                  'A concrete nudge, usable as an arc nudge, that would pull future chapters back toward the design.',
              },
              updateSuggestion: {
                type: 'string',
                description: 'How the design would change to accept what the story did.',
              },
            },
            required: [
              'aspect',
              'designClaim',
              'canonEvidence',
              'chapters',
              'severity',
              'steerSuggestion',
              'updateSuggestion',
            ],
          },
        },
      },
      required: ['verdict', 'summary', 'findings'],
    },
  },
};

const DRIFT_SYSTEM_PROMPT = [
  'You compare an ACTIVE character design — the author\'s intent for a character — against the',
  'story as actually written. Canon is not wrong: it is what happened. Your job is to report',
  'divergence precisely, not to fix it and not to take sides.',
  '',
  'You have search_story_bible and get_story_bible_entries to check established facts, and',
  'report_drift to deliver your report. You cannot change the design.',
  '',
  '## PROCESS',
  '1. Read the design and the chapter summaries below.',
  '2. For each aspect of the design — voice, motivation, personality, arc, relationships,',
  '   history, essentials, status — ask: does the written character still match this intent?',
  '3. Check the story bible before claiming drift. A character\'s status, allegiances and',
  '   relationships live there and are more reliable than a summary.',
  '4. Call report_drift exactly once.',
  '',
  '## CALIBRATION — the mistake to avoid is inventing drift',
  '- You are reading SUMMARIES. They omit detail. Absence of evidence is NOT drift: if the',
  '  summaries simply never show a trait, that is silence, not divergence.',
  '- Report only what the summaries or the bible POSITIVELY show.',
  '- An arc marked "potential" that the story has not begun is not drifting. It is waiting.',
  '- minor: tone or flavour slippage. significant: motivation or a relationship is heading',
  '  somewhere the design did not intend. contradiction: canon has foreclosed the design —',
  '  the character died, the secret was revealed, they swore the opposite oath.',
  '- If the linked bible entry\'s status contradicts the design\'s premise (a dead character',
  '  with a planned arc), that is always a contradiction finding with aspect "status".',
  '- At most 6 findings. If there are more, report the ones that matter most.',
  '',
  '## SUGGESTIONS — always give both, and stay neutral',
  'Every finding carries two ways out, and the author picks:',
  '- steerSuggestion: a concrete nudge for future chapters that pulls the character back.',
  '- updateSuggestion: how the design would change to embrace what the story did.',
  'Sometimes the story found something better than the plan. Do not assume the design is right.',
  '',
  '## ANTI-PATTERNS',
  '- Inventing evidence, or citing a chapter that does not support the claim.',
  '- Restating the whole design back to the author.',
  '- Vague findings ("the character feels different"). Name the aspect and the evidence.',
  '- Flagging every small variation. A character behaving with normal human range is not drift.',
].join('\n');

export interface DriftResult {
  usage: Usage;
  report: DriftReport;
}

function parseDriftReport(designId: string, raw: Record<string, unknown>): DriftReport | string {
  const verdict = String(raw.verdict ?? '');
  if (!['on-track', 'drifting', 'diverged'].includes(verdict)) {
    return 'Error: verdict must be one of: on-track, drifting, diverged.';
  }
  if (!Array.isArray(raw.findings)) return 'Error: findings must be an array (use [] when on-track).';

  const findings: DriftFinding[] = [];
  for (const item of raw.findings as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const f = item as Record<string, unknown>;
    const aspect = String(f.aspect ?? '');
    const severity = String(f.severity ?? '');
    if (!['voice', 'motivation', 'personality', 'arc', 'relationship', 'history', 'essentials', 'status'].includes(aspect)) {
      return `Error: "${aspect}" is not a valid aspect.`;
    }
    if (!['minor', 'significant', 'contradiction'].includes(severity)) {
      return `Error: "${severity}" is not a valid severity.`;
    }
    const designClaim = String(f.designClaim ?? '').trim();
    const canonEvidence = String(f.canonEvidence ?? '').trim();
    if (!designClaim || !canonEvidence) {
      return 'Error: every finding needs both designClaim and canonEvidence.';
    }
    findings.push({
      aspect: aspect as DriftAspect,
      designClaim: designClaim.slice(0, 600),
      canonEvidence: canonEvidence.slice(0, 600),
      chapters: Array.isArray(f.chapters)
        ? (f.chapters as unknown[]).map(Number).filter((n) => Number.isFinite(n)).slice(0, 20)
        : [],
      severity: severity as DriftFinding['severity'],
      steerSuggestion: String(f.steerSuggestion ?? '').trim().slice(0, 600),
      updateSuggestion: String(f.updateSuggestion ?? '').trim().slice(0, 600),
    });
  }

  return {
    designId,
    verdict: verdict as DriftReport['verdict'],
    summary: String(raw.summary ?? '').trim().slice(0, 1200),
    findings: findings.slice(0, 6),
  };
}

/**
 * Compare an active design against what the novel actually did.
 *
 * Structurally read-only: `update_character_design` is simply absent from the
 * tool list, so no prompt wording is load-bearing for the guarantee. The
 * report is streamed to the author and never persisted — it describes a moment
 * in the novel, and the next chapter changes it.
 */
export async function runDesignDrift(args: {
  apiKey: string;
  novel: Novel;
  design: CharacterDesign;
  bibleEntries: BibleEntry[];
  /** Accepted chapters; their summaries are what the agent reads. */
  chapters: Chapter[];
  signal?: AbortSignal;
  emit?: (event: AgentEvent) => void;
}): Promise<DriftResult> {
  const emit = args.emit ?? (() => {});
  const bible = args.bibleEntries;
  const resolve = makeTargetResolver(bible, [args.design]);
  let total = EMPTY_USAGE;

  const linked = args.design.linkedEntryId
    ? bible.find((e) => e.id === args.design.linkedEntryId)
    : null;

  const summaries = args.chapters
    .map((c) => `Chapter ${c.number}${c.title ? `: ${c.title}` : ''}\n${c.summary.trim() || '(no summary stored)'}`)
    .join('\n\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: DRIFT_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `NOVEL: ${args.novel.title}\nPREMISE: ${args.novel.premise || '(none)'}\n\n` +
        `STORY BIBLE INDEX (${bible.length} entries):\n${formatBibleIndex(bible) || '(empty)'}\n\n` +
        (linked
          ? `THIS CHARACTER'S BIBLE ENTRY:\n${formatBibleEntry(linked)}\n\n`
          : 'This design is not linked to a story bible entry, so canon about them must come from the summaries.\n\n') +
        `THE DESIGN (the author's intent):\n${formatDesignSheet(args.design, resolve)}\n\n` +
        `CHAPTER SUMMARIES (${args.chapters.length} accepted chapters — this is the story as written):\n\n${summaries}`,
    },
  ];

  const tools: ToolDefinition[] = [
    searchBibleToolDefinition,
    getBibleToolDefinition,
    reportDriftToolDefinition,
  ];

  for (let round = 0; round <= MAX_ROUNDS; round++) {
    const result = await streamChat({
      role: 'checker',
      apiKey: args.apiKey,
      model: DESIGN_MODEL,
      messages,
      tools,
      // The last round forces the report rather than dropping tools, since the
      // report IS the deliverable.
      toolChoice:
        round === MAX_ROUNDS ? { type: 'function', function: { name: 'report_drift' } } : undefined,
      maxTokens: 3000,
      signal: args.signal,
    });
    total = addUsage(total, result.usage);

    if (result.finishReason !== 'tool_calls' || result.toolCalls.length === 0) {
      if (round === MAX_ROUNDS) break;
      // No tool call and no report: nudge it to deliver one.
      messages.push({ role: 'assistant', content: result.content || null });
      messages.push({
        role: 'user',
        content: 'Deliver your findings now by calling report_drift.',
      });
      continue;
    }

    messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });

    for (const call of result.toolCalls) {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        parsed = {};
      }

      let output: string;
      switch (call.function.name) {
        case 'search_story_bible': {
          const terms = Array.isArray(parsed.terms) ? parsed.terms.map(String) : [];
          output = formatBibleSearchResults(searchBibleEntries(bible, terms));
          break;
        }
        case 'get_story_bible_entries': {
          const ids = Array.isArray(parsed.ids) ? parsed.ids.map(String).slice(0, 12) : [];
          const found = bible.filter((e) => ids.includes(e.id));
          output = found.length
            ? found.map(formatBibleEntry).join('\n\n---\n\n')
            : 'No entries with those ids. Check the index or search first.';
          break;
        }
        case 'report_drift': {
          const report = parseDriftReport(args.design.id, parsed);
          if (typeof report !== 'string') {
            console.log(
              `[design:drift] novel=${args.novel.id} design=${args.design.id} ` +
                `verdict=${report.verdict} findings=${report.findings.length} cost=$${total.cost.toFixed(5)}`
            );
            emit({ type: 'trace', data: `Drift check complete: ${report.verdict}` });
            return { usage: total, report };
          }
          output = report;
          break;
        }
        default:
          output = `Unknown tool: ${call.function.name}`;
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
    }
  }

  throw new Error('The drift check did not produce a report. Try again.');
}
