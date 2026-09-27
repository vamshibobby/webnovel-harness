import { ValidationError } from './validate.js';
export interface ProseProfile { genre?: string; voiceSample?: string; protectedFacts?: string; disabledMetrics?: string[] }
export const OPTIONAL_METRICS = ['emDash', 'thematicClose', 'dialogueCoda', 'thinDialogue', 'lowDialogue', 'short'];
export function validateProseProfile(raw: unknown): ProseProfile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('proseProfile must be an object');
  const input = raw as Record<string, unknown>;
  const result: ProseProfile = {};
  for (const [key, limit] of [['genre', 120], ['voiceSample', 4000], ['protectedFacts', 2000]] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'string' || input[key].length > limit) throw new ValidationError(`${key} must be at most ${limit} characters`);
    result[key] = input[key];
  }
  if (input.disabledMetrics !== undefined) {
    if (!Array.isArray(input.disabledMetrics) || input.disabledMetrics.some(m => !OPTIONAL_METRICS.includes(m)) || input.disabledMetrics.length > OPTIONAL_METRICS.length) throw new ValidationError('Unknown optional prose check');
    result.disabledMetrics = [...new Set(input.disabledMetrics)] as string[];
  }
  return result;
}
