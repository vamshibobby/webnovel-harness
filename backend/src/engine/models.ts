/**
 * OpenRouter model-id helpers.
 *
 * OpenRouter publishes auto-updating aliases like
 * `~deepseek/deepseek-v4-flash-latest`. They are real, usable ids, but the
 * alias itself exposes no endpoints — so a naive provider lookup finds nothing,
 * skips pinning, and the request gets load-balanced onto whatever is cheapest.
 * Measured on the chapter-summary call, that cost 11.3s on DeepInfra versus
 * 4.7s pinned to CoreWeave.
 *
 * We resolve the alias only to discover its providers; the request keeps
 * sending the alias so "latest" still means latest.
 */

interface ModelEntry {
  id: string;
  alias_target?: { slug?: string } | null;
}

const TTL_MS = 30 * 60 * 1000;
let aliasMap: Map<string, string> | null = null;
let fetchedAt = 0;
let inflight: Promise<void> | null = null;

/**
 * Model ids are interpolated into OpenRouter URL paths, and the slash in
 * `provider/model` is a real path separator — so percent-encoding would break
 * the request rather than secure it. Strict validation is the guard instead:
 * nothing here can contain `..`, `?` or `#` and rewrite the path.
 */
const MODEL_ID = /^~?[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function isSafeModelId(model: string): boolean {
  return !model.includes('..') && MODEL_ID.test(model);
}

export function isAlias(model: string): boolean {
  return model.startsWith('~');
}

/**
 * Strip the alias marker without a network call. `~anthropic/claude-haiku-latest`
 * keeps its `anthropic/` prefix, which is all the cache policy needs.
 */
export function bareModelId(model: string): string {
  return model.startsWith('~') ? model.slice(1) : model;
}

async function loadAliasMap(): Promise<void> {
  if (aliasMap && Date.now() - fetchedAt < TTL_MS) return;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return;
      const body = (await res.json()) as { data?: ModelEntry[] };
      const next = new Map<string, string>();
      for (const m of body.data ?? []) {
        const target = m.alias_target?.slug;
        if (target && m.id !== target) next.set(m.id, target);
      }
      aliasMap = next;
      fetchedAt = Date.now();
    } catch {
      /* keep any previous map; callers fall back to the id as given */
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * The concrete model an id points at. Non-aliases return immediately without
 * touching the network.
 */
export async function resolveModelId(model: string): Promise<string> {
  if (!isAlias(model) || !isSafeModelId(model)) return model;
  await loadAliasMap();
  return aliasMap?.get(model) ?? model;
}
