/**
 * Transient-failure handling in streamChat.
 *   npx tsx src/retry.test.ts
 *
 * Free — no network. A local HTTP server stands in for OpenRouter, and
 * global.fetch is pointed at it, so the real retry path runs against real
 * status codes. This exists because a single 429 used to abort a whole story
 * bible catch-up on its first chapter and make the user the retry loop.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const { streamChat, OpenRouterError } = await import('./engine/openrouter.js');

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failures.push(label);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
}

/** One SSE reply that looks enough like OpenRouter to satisfy the parser. */
const SSE_OK =
  'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"cost":0}}\n\n' +
  'data: [DONE]\n\n';

interface Recorded {
  provider: unknown;
}

/**
 * Serve `statuses` in order, then succeed. Records the provider routing block
 * of every request so we can assert the pin is dropped on the last attempt.
 */
function fakeOpenRouter(statuses: number[]): {
  server: Server;
  url: Promise<string>;
  seen: Recorded[];
} {
  const seen: Recorded[] = [];
  let call = 0;
  const server = createServer((req, res) => {
    // The provider-routing lookup hits /models/... — answer "no endpoints" so
    // routingFor stays out of the way unless a test wants it.
    if (req.url?.includes('/models/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { endpoints: [{ tag: 'coreweave' }] } }));
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ provider: (JSON.parse(body || '{}') as { provider?: unknown }).provider });
      const status = statuses[call++];
      // 0 means: accept the request, stream nothing, then fail mid-stream —
      // the shape of an upstream provider timeout.
      if (status === 0) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"error":{"message":"Provider timed out after 12002ms"}}\n\ndata: [DONE]\n\n');
        return;
      }
      if (status && status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Provider returned error' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(SSE_OK);
    });
  });
  const url = new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
  return { server, url, seen };
}

const realFetch = globalThis.fetch;

/** Point every openrouter.ai call at the local stand-in. */
function redirectFetch(base: string): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return realFetch(href.replace('https://openrouter.ai', base), init);
  }) as typeof fetch;
}

async function run(
  statuses: number[],
  opts: { signal?: AbortSignal } = {}
): Promise<{ error: unknown; seen: Recorded[]; ms: number }> {
  const { server, url, seen } = fakeOpenRouter(statuses);
  const base = await url;
  redirectFetch(base);
  const started = Date.now();
  let error: unknown = null;
  try {
    await streamChat({
      apiKey: 'sk-or-test',
      // A distinct model per case keeps providers.ts's 30-minute memo from
      // leaking routing between tests.
      model: `test/model-${statuses.join('-')}-${Math.random().toString(36).slice(2, 8)}`,
      messages: [{ role: 'user', content: 'hi' }],
      signal: opts.signal,
    });
  } catch (e) {
    error = e;
  }
  const ms = Date.now() - started;
  globalThis.fetch = realFetch;
  server.close();
  return { error, seen, ms };
}

console.log('\nA 429 that clears on the second try:');
{
  const { error, seen } = await run([429, 200]);
  check('the call succeeds instead of failing', error === null, error ? String(error) : '');
  check('it took exactly two attempts', seen.length === 2, `${seen.length}`);
  check('the provider pin was kept on the retry', seen[1].provider !== undefined);
}

console.log('\nA provider that refuses twice:');
{
  const { error, seen } = await run([429, 503, 200]);
  check('the call still succeeds', error === null, error ? String(error) : '');
  check('it took three attempts', seen.length === 3, `${seen.length}`);
  check('the pin was dropped on the last one', seen[2].provider === undefined);
  check('the earlier attempts kept the pin', seen[0].provider !== undefined && seen[1].provider !== undefined);
}

console.log('\nA provider that never recovers:');
{
  const { error, seen } = await run([429, 429, 429]);
  check('it gives up rather than looping', seen.length === 3, `${seen.length}`);
  check('it throws an OpenRouterError', error instanceof OpenRouterError);
  check('the status is preserved for callers', (error as { status?: number })?.status === 429);
  check(
    'the message no longer tells the user to just try again',
    !/Wait a moment and try again/.test(String((error as Error)?.message)),
    String((error as Error)?.message).slice(0, 90)
  );
}

console.log('\nErrors that are the request\'s own fault:');
for (const [status, label] of [
  [401, 'a rejected key'],
  [402, 'insufficient credits'],
  [400, 'a bad request'],
] as Array<[number, string]>) {
  const { error, seen } = await run([status, 200]);
  check(`${label} is not retried`, seen.length === 1, `${seen.length} attempt(s)`);
  check(`${label} still throws`, error instanceof OpenRouterError);
}

console.log('\nBacking off respects an abort:');
{
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  const { seen, ms } = await run([429, 429, 200], { signal: controller.signal });
  check('it stops instead of sleeping out the backoff', ms < 900, `${ms}ms`);
  check('it did not keep retrying after the abort', seen.length <= 2, `${seen.length}`);
}

console.log('\nA provider that accepts the request and then stalls:');
{
  const { error, seen } = await run([0, 200]);
  check('the stall is retried, not surfaced', error === null, error ? String(error) : '');
  check('it took two attempts', seen.length === 2, `${seen.length}`);
}

console.log('\nA provider that stalls every time:');
{
  const { error, seen } = await run([0, 0, 0]);
  check('it gives up after three', seen.length === 3, `${seen.length}`);
  check('the pin was dropped on the last one', seen[2].provider === undefined);
  check(
    'and the provider message reaches the caller',
    error instanceof OpenRouterError && /timed out/.test((error as Error).message),
    String(error)
  );
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('Failed:\n  ' + failures.join('\n  '));
process.exit(failures.length ? 1 : 0);
