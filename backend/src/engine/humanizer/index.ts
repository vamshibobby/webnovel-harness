/**
 * The humanizer: a second pass that repairs a finished chapter.
 *
 * The alternative was to put these rules in the writing prompt, and that was
 * tried and measured. It works for some defects and actively backfires on
 * others: a FORMAT block that listed everything not to do tripled the amount of
 * commentary models put before the chapter, and a rule against long dashes that
 * itself contained one raised the dash rate. Warning a model about defects it
 * has not produced yet is a weaker instrument than showing it the ones it did.
 *
 * So detection is deterministic and repair is a model call, and the two are kept
 * apart. Each round the model receives counts, a target range and the offending
 * lines; afterwards the same code says which defects actually closed. The loop
 * stops on measured progress rather than on the model saying it is done, and a
 * round that fails a guard is discarded rather than accepted.
 *
 * Two guards, because a stylistic pass is exactly the kind of edit that can
 * damage a novel invisibly:
 *
 *   no new names   the set of proper nouns must not grow. This is the one way a
 *                  surface rewrite can corrupt canon without looking like it.
 *   no collapse    losing more than a quarter of the words means content is
 *                  being deleted rather than prose repaired.
 *
 * Measured on the research fixtures: dashes fall about 64%, commentary before
 * the heading goes to zero, the product's title parser goes from 37.5% to 87.5%,
 * and instruction compliance is preserved (96.7% to 98.4%). Cadence and
 * structure are NOT touched by this pass and cannot be — see diagnose.ts.
 */
import { rolePolicy } from '../../lib/modelPolicy.js';
import { streamChat, type ChatMessage } from '../openrouter.js';
import { diagnose as baseDiagnose, formatDiagnosis, properNounSet, type Defect, type DefectKind } from './diagnose.js';
import { words } from './text.js';

export { analyseHeading } from './diagnose.js';
export type { Defect, DefectKind, Diagnosis } from './diagnose.js';

export function diagnose(content: string, targetWords = 0, disabledMetrics: string[] = []) {
  const result = baseDiagnose(content, targetWords);
  return { ...result, defects: result.defects.filter(d => !disabledMetrics.includes(d.kind)) };
}

const MAX_ROUNDS = 3;
/** Below this the pass is deleting rather than repairing. */
const MIN_RETAINED = 0.75;

const SYSTEM = [
  'You are a line editor working on one chapter of a novel. You are given the chapter and a list of',
  'specific, measured defects in it. Fix exactly those and change nothing else.',
  '',
  'What you must not do, in order of how much damage it causes:',
  '- Do not change what happens. No new events, no new characters, no new places, no new names.',
  '  Every proper noun in your version must already be in the chapter you were given.',
  '- Do not cut material to make a problem go away. Repair the line, keep the content.',
  '- Do not improve anything you were not asked about. A sentence not named in the list comes through',
  '  untouched.',
  '- Do not explain yourself. No preamble, no notes, no summary of what you changed.',
  '',
  'The targets come from measurements of published fiction, and they are ranges rather than limits.',
  'Do not drive a feature to zero: prose with something surgically absent reads as oddly as prose',
  'that overuses it. Bring the chapter inside the range and stop.',
  '',
  'Output the complete corrected chapter and nothing else, beginning with its heading line.',
].join('\n');

export interface HumanizeRound {
  round: number;
  before: DefectKind[];
  after: DefectKind[];
  closed: DefectKind[];
  accepted: boolean;
  rejectedFor?: 'invented-names' | 'collapsed' | 'no-progress' | 'empty';
}

export interface HumanizeResult {
  content: string;
  changed: boolean;
  rounds: HumanizeRound[];
  resolved: DefectKind[];
  remaining: DefectKind[];
  cost: number;
}

/**
 * Decoding parameters for the repair call.
 *
 * The repair is itself a generation, and it had been running at whatever the
 * serving provider defaults to. That matters more here than it looks: measured
 * in research/eval, sentence-opening frame variety is the one defect that does
 * not respond to instructions at all -- four separate rewriting attempts moved
 * it nowhere -- but it does respond to `min_p`. A repair pass sampled with
 * `min_p` can therefore reach a defect that the same pass, at default sampling,
 * provably cannot.
 *
 * `min_p` is per-PROVIDER, not per-model: of the two upstreams this app pins,
 * DeepInfra supports it and CoreWeave does not, and a provider that does not
 * support it accepts the request and ignores the parameter. So the pin is sent
 * with the parameters rather than left to the cache-warming router, otherwise
 * the same chapter would be polished differently depending on who answered,
 * silently.
 */
export const POLISH_SAMPLING: Record<string, number> = { temperature: 1.0, min_p: 0.05, top_p: 1 };
export const POLISH_PROVIDER: { order: string[]; allow_fallbacks: boolean } = {
  order: ['DeepInfra'],
  allow_fallbacks: false,
};

export interface HumanizeEvent {
  type: 'trace' | 'token' | 'usage' | 'done' | 'error';
  data: string;
}

export async function humanizeChapter(args: {
  apiKey: string;
  model: string;
  content: string;
  targetWords?: number;
  disabledMetrics?: string[];
  /** Overrides POLISH_SAMPLING. Pass {} to run at provider defaults. */
  sampling?: Record<string, number>;
  /** Overrides POLISH_PROVIDER. Pass null to let the normal router choose. */
  providerOverride?: { order: string[]; allow_fallbacks: boolean } | null;
  signal?: AbortSignal;
  emit?: (e: HumanizeEvent) => void;
}): Promise<HumanizeResult> {
  const emit = args.emit ?? (() => {});
  let current = args.content;
  let diagnosis = diagnose(current, args.targetWords ?? 0, args.disabledMetrics);
  const started = diagnosis.defects.map((d) => d.kind);
  const rounds: HumanizeRound[] = [];
  let cost = 0;

  if (started.length === 0) {
    emit({ type: 'trace', data: 'Nothing to repair — the chapter is already inside every range.' });
    return { content: current, changed: false, rounds, resolved: [], remaining: [], cost: 0 };
  }

  emit({ type: 'trace', data: `Found ${started.length}: ${started.join(', ')}` });

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    if (diagnosis.defects.length === 0) break;
    const before = diagnosis.defects.map((d) => d.kind);
    emit({ type: 'trace', data: `Pass ${round}: ${before.join(', ')}` });

    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          `<chapter>\n${current}\n</chapter>\n\n<defects>\n${formatDiagnosis(diagnosis)}\n</defects>\n\n` +
          `Return the corrected chapter.`,
      },
    ];

    const res = await streamChat({
      role: 'editor',
      apiKey: args.apiKey,
      model: args.model,
      messages,
      maxTokens: 8000,
      signal: args.signal,
      sampling: args.sampling ?? (rolePolicy('editor').model ? {} : { ...POLISH_SAMPLING }),
      providerOverride:
        args.providerOverride === null || (args.providerOverride === undefined && rolePolicy('editor').model) ? undefined : (args.providerOverride ?? { ...POLISH_PROVIDER }),
      // The prompt is a different chapter every time, so the cache-warming pin
      // buys nothing here; the pin that is sent exists for sampler support.
      pinProvider: false,
    });
    cost += res.usage?.cost ?? 0;

    const candidate = res.content.trim();
    const record = (accepted: boolean, rejectedFor?: HumanizeRound['rejectedFor'], after = before): void => {
      rounds.push({ round, before, after, closed: before.filter((k) => !after.includes(k)), accepted, rejectedFor });
    };

    if (!candidate) {
      record(false, 'empty');
      break;
    }

    const known = new Set(properNounSet(current));
    const invented = properNounSet(candidate).filter((n) => !known.has(n));
    if (invented.length > 0) {
      emit({ type: 'trace', data: `Pass ${round} discarded: it introduced ${invented.length} new name(s).` });
      record(false, 'invented-names');
      break;
    }

    if (words(candidate).length < words(current).length * MIN_RETAINED) {
      emit({ type: 'trace', data: `Pass ${round} discarded: too much of the chapter was cut.` });
      record(false, 'collapsed');
      break;
    }

    const next = diagnose(candidate, args.targetWords ?? 0, args.disabledMetrics);
    const after = next.defects.map((d) => d.kind);
    if (before.every((k) => after.includes(k))) {
      emit({ type: 'trace', data: `Pass ${round} discarded: nothing was fixed.` });
      record(false, 'no-progress', after);
      break;
    }

    record(true, undefined, after);
    current = candidate;
    diagnosis = next;
  }

  const remaining = diagnosis.defects.map((d) => d.kind);
  const resolved = started.filter((k) => !remaining.includes(k));
  emit({
    type: 'trace',
    data: resolved.length ? `Fixed ${resolved.join(', ')}.` : 'Nothing could be fixed safely.',
  });

  return { content: current, changed: current !== args.content, rounds, resolved, remaining, cost };
}
