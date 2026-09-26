/**
 * Prompt-caching policy per model.
 *
 * OpenRouter providers split into two groups:
 *  - Automatic: OpenAI, Grok, DeepSeek, Groq, Moonshot, Z.AI, Gemini 2.5
 *    (implicit). Caching happens with no request changes at all.
 *  - Explicit: Anthropic and Qwen only cache where you place `cache_control`
 *    breakpoints, so we must mark the reusable prefix ourselves.
 *
 * We deliberately do NOT send explicit breakpoints to Gemini: its 2.5 models
 * already cache implicitly for free, while explicit Gemini caching bills for
 * cache storage by the hour — a surprise cost for a BYOK user.
 */

import { bareModelId } from './models.js';

export interface CachePolicy {
  /** Whether to emit cache_control breakpoints for this model. */
  explicit: boolean;
  /** Anthropic/Qwen extended cache retention. Undefined = provider default (5m). */
  ttl?: '1h';
}

export function cachePolicyFor(model: string): CachePolicy {
  // Alias ids carry a `~` prefix (`~anthropic/claude-haiku-latest`). Without
  // stripping it the provider check below never matches and Anthropic aliases
  // silently lose explicit caching entirely.
  const id = bareModelId(model).toLowerCase();
  if (id.startsWith('anthropic/')) {
    // Novel-writing sessions are long and sparse (write → read → revise →
    // accept → next chapter), so 5 minutes almost always expires between
    // calls. The 1h TTL costs 2x on write but turns a whole session's worth
    // of prior chapters into 0.1x reads.
    return { explicit: true, ttl: '1h' };
  }
  if (id.startsWith('qwen/') || id.startsWith('alibaba/')) {
    return { explicit: true };
  }
  return { explicit: false };
}

/**
 * Smallest prefix worth a breakpoint. Provider minimums range from 1024
 * (Sonnet, Gemini Flash) to 4096 (Opus) tokens; below the minimum a
 * breakpoint is ignored rather than an error, so this only avoids pointless
 * cache writes on tiny prompts.
 */
export const MIN_CACHEABLE_TOKENS = 1024;
