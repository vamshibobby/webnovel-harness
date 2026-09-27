import { assertRoleBudget, rolePolicy, recordModelRun, promptHash, type ModelRole } from '../lib/modelPolicy.js';
/**
 * Minimal OpenRouter chat-completions client with streaming, tool-call, and
 * prompt-caching support. The user's API key is passed per-request (BYOK) and
 * never persisted.
 */
import { routingFor } from './providers.js';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** A text block. `cache_control` marks the end of a reusable prefix. */
export interface TextPart {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral'; ttl?: '1h' };
}

/**
 * An image block for vision models (the Atlas sketch reader). Always a data
 * URL here — the backend never fetches remote images on a user's behalf.
 */
export interface ImagePart {
  type: 'image_url';
  image_url: { url: string };
}

export type MessageContent = string | Array<TextPart | ImagePart>;

export type ChatMessage =
  | { role: 'system' | 'user'; content: MessageContent }
  | { role: 'assistant'; content: MessageContent | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens served from cache at a large discount (0.1x on Anthropic). */
  cachedTokens: number;
  /** Prompt tokens written into the cache (1.25x, or 2x for a 1h TTL). */
  cacheWriteTokens: number;
  cost: number;
  costKnown?: boolean;
}

export interface StreamResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: Usage | null;
  provider: string | null;
  /**
   * The model that actually answered. Usually the slug that was asked for,
   * but router slugs (openrouter/free, openrouter/auto) resolve to a concrete
   * model per request, and which one matters — the free pool's members differ
   * wildly in speed and quality.
   */
  model: string | null;
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

interface StreamOptions {
  role?: ModelRole;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /**
   * Force a specific tool. Used when the tool call IS the deliverable (the
   * drift report), so a model that would rather answer in prose cannot.
   */
  toolChoice?: { type: 'function'; function: { name: string } };
  maxTokens?: number;
  /**
   * Set false for a call whose prompt is different every time. Pinning exists
   * to keep a cached prefix addressable (see providers.ts); a one-shot with no
   * reusable prefix gets none of that benefit and still inherits the pinned
   * providers' capacity — which, on a long structured reply, means waiting out
   * their timeout twice before the pin is dropped anyway.
   */
  pinProvider?: boolean;
  /**
   * Decoding parameters. Omitted entirely when absent, so production behaviour
   * is byte-identical to before: no temperature, no seed, provider defaults.
   *
   * This exists because research/eval needs to sweep them. The client shipping
   * without any sampling control is itself a finding -- every measurement in
   * that spike runs at whatever the serving provider happens to default to, and
   * a run that hit a retry may have been served by a different provider at a
   * different quantisation. `seed` in particular makes the whole harness
   * reproducible for the first time.
   *
   * Support is per-provider, not per-model: of the endpoints serving
   * deepseek-v4-flash, DeepInfra exposes min_p, seed and repetition_penalty
   * while DigitalOcean exposes only temperature and top_p. Pin accordingly, or
   * the parameter is silently ignored.
   */
  sampling?: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    min_p?: number;
    repetition_penalty?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    seed?: number;
  };
  /** Force specific upstream providers, overriding the cache-warming pin. */
  providerOverride?: { order: string[]; allow_fallbacks: boolean };
  signal?: AbortSignal;
  /** Called for each content token as it streams in. */
  onToken?: (token: string) => void;
  /** Called for each reasoning token, which usually arrives well before content. */
  onReasoning?: (token: string) => void;
  /** Called once with the upstream provider actually serving the request. */
  onProvider?: (provider: string) => void;
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}

function parseUsage(raw: RawUsage | undefined): Usage | null {
  if (!raw) return null;
  return {
    promptTokens: raw.prompt_tokens ?? 0,
    completionTokens: raw.completion_tokens ?? 0,
    cachedTokens: raw.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: raw.prompt_tokens_details?.cache_write_tokens ?? 0,
    cost: raw.cost ?? 0,
    ...(raw.cost === undefined ? { costKnown: false } : {}),
  };
}

/**
 * Statuses worth trying again. A pinned provider that is busy, restarting or
 * briefly gatewaying is the common case, and none of them mean the request was
 * wrong — only that it arrived at a bad moment.
 */
const TRANSIENT_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Honour Retry-After when the server sends one, capped so we never hang. */
function retryDelay(res: Response, attempt: number): number {
  const header = res.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 15_000);
  }
  // 1s, then 3s, with jitter so concurrent callers do not retry in lockstep.
  return (attempt === 1 ? 1000 : 3000) + Math.floor(Math.random() * 400);
}

/**
 * A provider that accepted the request and then produced nothing before
 * failing. Raised only while the response is still empty, which is what makes
 * a second attempt safe — see the comment at the retry site.
 */
class ProviderStalled extends Error {
  constructor(readonly detail: string) {
    super(detail);
  }
}

/**
 * Optional OpenRouter app attribution. Set APP_URL / APP_TITLE in .env to have
 * your usage show up under your own app name on openrouter.ai; unset, nothing
 * is sent.
 */
export function appAttribution(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (process.env.APP_URL) headers['HTTP-Referer'] = process.env.APP_URL;
  if (process.env.APP_TITLE) headers['X-Title'] = process.env.APP_TITLE;
  return headers;
}

export async function streamChat(opts: StreamOptions): Promise<StreamResult> {
  const role = opts.role ?? 'writer';
  const policy = rolePolicy(role);
  assertRoleBudget(role);
  const primary = role === 'writer' ? opts.model : policy.model || opts.model;
  const models = [...new Set([primary, ...(policy.fallbackModels ?? [])])];
  let emitted = false;
  for (let i = 0; i < models.length; i++) {
    opts.signal?.throwIfAborted();
    const started = Date.now();
    const record = { role, model: models[i], provider: null as string | null, promptHash: promptHash(opts.messages), promptVersion: 'harness-2026-09', cost: null as number | null, promptTokens: 0, completionTokens: 0, durationMs: 0 };
    try {
      const result = await streamChatOnce({
        ...opts, model: models[i],
        maxTokens: policy.maxOutputTokens === undefined ? opts.maxTokens : Math.min(opts.maxTokens ?? policy.maxOutputTokens, policy.maxOutputTokens),
        onToken: token => { emitted = true; opts.onToken?.(token); },
        onReasoning: token => { emitted = true; opts.onReasoning?.(token); },
      });
      recordModelRun({ ...record, model: result.model || models[i], provider: result.provider, cost: result.usage?.costKnown === false ? null : result.usage?.cost ?? null, promptTokens: result.usage?.promptTokens ?? 0, completionTokens: result.usage?.completionTokens ?? 0, durationMs: Date.now() - started, outcome: 'completed' });
      return result;
    } catch (err) {
      recordModelRun({ ...record, durationMs: Date.now() - started, outcome: 'failed' });
      if (opts.signal?.aborted || emitted || i === models.length - 1 || !(err instanceof OpenRouterError) || [401, 402, 403].includes(err.status)) throw err;
    }
  }
  throw new Error('No model available');
}

async function streamChatOnce(opts: StreamOptions): Promise<StreamResult> {
  const model = opts.model;

  // Pin to a preferred upstream when one serves this model, so repeat requests
  // hit the same provider's prompt cache instead of being load-balanced away.
  // OpenRouter's free router load-balances by design, so pinning is skipped for it.
  const providerRouting =
    opts.pinProvider === false || model === 'openrouter/free' ? undefined : await routingFor(model);

  for (let attempt = 1; ; attempt++) {
    // Last attempt drops the pin. Pinning buys prompt-cache reuse, which is
    // worth real money on a long novel — but only if the request succeeds at
    // all. Once a provider has refused twice, a cache miss is a far better
    // outcome than failing the turn, so we let OpenRouter route anywhere.
    const lastAttempt = attempt === MAX_ATTEMPTS;
    const routing = lastAttempt ? undefined : providerRouting;

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: opts.signal,
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        ...appAttribution(),
      },
      body: JSON.stringify({
        model,
        messages: opts.messages,
        tools: opts.tools,
        tool_choice: opts.toolChoice,
        max_tokens: opts.maxTokens,
        stream: true,
        // Spread rather than assigned, so an absent `sampling` adds no keys at
        // all and the request body stays exactly what it was before.
        ...(opts.sampling ?? {}),
        // Omitted for models the preferred providers don't serve. See providers.ts.
        provider: opts.providerOverride ?? routing,
      }),
    });

    if (!res.ok && TRANSIENT_STATUSES.has(res.status) && !lastAttempt) {
      void res.body?.cancel();
      await backOff(`${res.status}`, attempt, opts, retryDelay(res, attempt));
      continue;
    }

    if (!res.ok || !res.body) throw refusal(res, await errorDetail(res));

    try {
      return await consumeStream(res, opts);
    } catch (err) {
      // A stall reaches here only when nothing has been handed to the caller,
      // so the whole request can be made again without duplicating output.
      // This is a distinct failure from an HTTP refusal: the provider took the
      // request, held it, and timed out — which the status-code path above
      // never sees, and which used to end a story bible run on its first
      // chapter.
      if (!(err instanceof ProviderStalled)) throw err;
      if (lastAttempt) throw new OpenRouterError(`OpenRouter: ${err.detail}`, 502);
      await backOff(err.detail, attempt, opts, retryDelay(res, attempt));
    }
  }
}

async function backOff(
  reason: string,
  attempt: number,
  opts: StreamOptions,
  delay: number
): Promise<void> {
  console.log(
    `[openrouter] ${reason} on attempt ${attempt}/${MAX_ATTEMPTS} for ${opts.model}; ` +
      `retrying in ${delay}ms${attempt + 1 === MAX_ATTEMPTS ? ' without the provider pin' : ''}`
  );
  await sleep(delay, opts.signal);
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? '';
  } catch {
    return ''; /* non-JSON error body */
  }
}

function refusal(res: Response, detail: string): OpenRouterError {
  const friendly =
    res.status === 401
      ? 'OpenRouter rejected your API key. Check it in Settings.'
      : res.status === 402
        ? 'OpenRouter reports insufficient credits on your account.'
        : res.status === 429
          ? // We already retried this and backed off, including once with the
            // provider pin removed, so "try again" is not useful advice.
            'OpenRouter is rate limiting this model right now. It usually clears within a minute or two.'
          : res.status === 404
            ? 'No provider is currently serving this model. Try again shortly or pick another model.'
            : `OpenRouter error (${res.status})`;
  return new OpenRouterError(detail ? `${friendly} — ${detail}` : friendly, res.status);
}

/** Read one SSE response to the end. Callbacks fire as the tokens arrive. */
async function consumeStream(res: Response, opts: StreamOptions): Promise<StreamResult> {
  let content = '';
  let reasoning = '';
  let finishReason: string | null = null;
  let usage: Usage | null = null;
  let provider: string | null = null;
  let model: string | null = null;
  // Tool call deltas arrive keyed by index; arguments accumulate across chunks.
  const toolCallsByIndex = new Map<number, ToolCall>();

  const decoder = new TextDecoder();
  let buffer = '';
  const reader = res.body!.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6);
      if (payload === '[DONE]') continue;

      let parsed: {
        provider?: string;
        model?: string;
        choices?: Array<{
          delta?: {
            content?: string;
            reasoning?: string;
            tool_calls?: Array<{
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string | null;
        }>;
        usage?: RawUsage;
        error?: { message?: string };
      };
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      if (parsed.error?.message) {
        // Nothing out yet means the caller cannot tell this attempt happened,
        // so it can be retried. Anything already emitted makes that unsafe.
        const emitted = content !== '' || reasoning !== '' || toolCallsByIndex.size > 0;
        if (emitted) throw new OpenRouterError(`OpenRouter: ${parsed.error.message}`, 502);
        throw new ProviderStalled(parsed.error.message);
      }

      // Usage arrives on the final SSE message of the stream.
      if (parsed.usage) usage = parseUsage(parsed.usage);
      if (parsed.provider && !provider) {
        provider = parsed.provider;
        opts.onProvider?.(provider);
      }
      if (parsed.model && !model) model = parsed.model;

      const choice = parsed.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta;
      // Reasoning models emit this during the wait before any prose appears.
      if (delta?.reasoning) {
        reasoning += delta.reasoning;
        opts.onReasoning?.(delta.reasoning);
      }
      if (delta?.content) {
        content += delta.content;
        opts.onToken?.(delta.content);
      }
      for (const tc of delta?.tool_calls ?? []) {
        const existing = toolCallsByIndex.get(tc.index);
        if (existing) {
          existing.function.arguments += tc.function?.arguments ?? '';
        } else {
          toolCallsByIndex.set(tc.index, {
            id: tc.id ?? `call_${tc.index}`,
            type: 'function',
            function: {
              name: tc.function?.name ?? '',
              arguments: tc.function?.arguments ?? '',
            },
          });
        }
      }
    }
  }

  return {
    content,
    reasoning,
    toolCalls: [...toolCallsByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, tc]) => tc),
    finishReason,
    usage,
    provider,
    model,
  };
}

