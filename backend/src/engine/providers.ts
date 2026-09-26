/**
 * Upstream provider routing.
 *
 * OpenRouter serves an open-weight model from many providers and load-balances
 * between them by default. That silently breaks prompt caching: a cache lives
 * only on the provider that wrote it, so three consecutive identical requests
 * measured here landed on AtlasCloud, Parasail and Novita and every one was a
 * cold read. Pinning the provider made the same request reuse 6,656 of 6,819
 * prompt tokens on the second call and halved its cost.
 *
 * Pinning has to be conditional. These providers only serve open-weight
 * models, so sending the same routing block for `anthropic/*` or `openai/*`
 * would fail outright ("No endpoints found"), and leaving fallbacks enabled
 * lets a request drift to an unpinned provider and lose the cache — which is
 * exactly what happened to one chapter here (it landed on DigitalOcean and
 * took 76s). So we ask OpenRouter which providers actually serve the model,
 * pin hard when a preferred one does, and stay out of the way when none does.
 */

import { isSafeModelId, resolveModelId } from './models.js';

/** Preferred upstreams, in order. */
export const PREFERRED_PROVIDERS = ['coreweave', 'deepinfra'] as const;

export interface ProviderRouting {
  order: string[];
  allow_fallbacks: boolean;
}

interface Entry {
  routing: ProviderRouting | undefined;
  at: number;
}

const TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, Entry>();

interface EndpointsResponse {
  data?: { endpoints?: Array<{ tag?: string; provider_name?: string }> };
}

/**
 * Which of the preferred providers serve this model, in preference order.
 * Result is memoised for 30 minutes; a lookup failure yields `undefined`,
 * meaning "route normally" so a hiccup here never blocks a generation.
 */
export async function routingFor(model: string): Promise<ProviderRouting | undefined> {
  const hit = cache.get(model);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.routing;

  // Values reaching here can predate input validation (they are stored on
  // novels and chapters), so guard at the point of interpolation too.
  if (!isSafeModelId(model)) {
    cache.set(model, { routing: undefined, at: Date.now() });
    return undefined;
  }

  let routing: ProviderRouting | undefined;
  try {
    // Aliases expose no endpoints of their own — resolve to the concrete model
    // first, or pinning silently never applies. The request still sends the
    // alias; only this lookup uses the resolved id.
    const lookupId = await resolveModelId(model);
    const res = await fetch(`https://openrouter.ai/api/v1/models/${lookupId}/endpoints`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const body = (await res.json()) as EndpointsResponse;
      // Tags look like "deepinfra" or "deepinfra/fp4"; match on the base slug.
      const available = new Set(
        (body.data?.endpoints ?? []).map((e) => (e.tag ?? '').split('/')[0]).filter(Boolean)
      );
      const order = PREFERRED_PROVIDERS.filter((p) => available.has(p));
      if (order.length > 0) {
        // Hard pin: fallbacks would defeat the point by scattering the cache.
        routing = { order: [...order], allow_fallbacks: false };
      }
    }
  } catch {
    /* leave undefined — route normally */
  }

  cache.set(model, { routing, at: Date.now() });
  return routing;
}
