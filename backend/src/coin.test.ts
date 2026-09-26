/**
 * The selection contract of the on-demand name coiner.
 *   npx tsx src/coin.test.ts
 *
 * Free — no network. A local HTTP server stands in for OpenRouter, so the real
 * agent loop runs against real SSE.
 *
 * The thing worth testing is the gate. Everything upstream of the model —
 * phonotactics, the cliché filter, the similarity registry — is enforced by
 * code the model never touches, and all of it becomes advisory the moment a
 * model can answer with a name that was not on its slate. So: a returned
 * "Elara" must come back as a correctable error, and a model that keeps
 * refusing must still leave the author holding the generated names.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Novel } from './lib/types.js';

const { runCoin, isFromSlate } = await import('./engine/naming/nameAgent.js');
const { defaultCharter } = await import('./engine/naming/charter.js');
const { generateSlate } = await import('./engine/naming/generator.js');

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failures.push(label);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
}

const READING = {
  register: 'Short, hard, ending on a stop. Two syllables at most.',
  taken: ['Kellrand', 'Skarn'],
  wants: 'Something a carter would say twice a day without thinking about it.',
};

const pick = (name: string) => ({
  name,
  source: 'candidate',
  etymology: 'The pass where the salt carts turn back before the first snow.',
  why: 'Plain enough that the drovers would actually use it.',
});

/** One tool call, encoded as the SSE frames the parser expects. */
function toolCallSSE(args: unknown): string {
  const call = {
    index: 0,
    id: 'call_1',
    type: 'function',
    function: { name: 'choose_names', arguments: JSON.stringify(args) },
  };
  return (
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0 },
    })}\n\n` +
    'data: [DONE]\n\n'
  );
}

/** Serve one scripted reply per round, so the correction loop can be exercised. */
function fakeOpenRouter(replies: unknown[]): {
  server: Server;
  url: Promise<string>;
  rounds: () => number;
  bodies: string[];
} {
  let call = 0;
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    if (req.url?.includes('/models/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { endpoints: [] } }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      bodies.push(body);
      const reply = replies[Math.min(call, replies.length - 1)];
      call++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(toolCallSSE(reply));
    });
  });
  const url = new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
  return { server, url, rounds: () => call, bodies };
}

const realFetch = globalThis.fetch;

const novel = {
  id: 'nv1', ownerUid: 'u1', title: 'The Salt Road',
  premise: 'A carter who owes the wrong house.', styleNotes: '', style: 'webnovel',
  defaultModel: 'x/y', chapterLength: 2000, chapterCount: 4, wordCount: 8000,
  hidden: false, createdAt: 0, updatedAt: 0,
} as unknown as Novel;

const charter = defaultCharter(novel);
const TAKEN = ['Kellrand', 'Skarn'];

/** The slate the agent will build for these arguments — known in advance. */
const slate = generateSlate({
  novelId: novel.id,
  cultureId: charter.cultures[0].id,
  soundWorldId: charter.cultures[0].soundWorldId,
  pack: charter.pack,
  type: 'location',
  brief: 'a mountain pass used for winter trade',
  count: 14,
  taken: TAKEN,
  banned: charter.banned,
  nonce: 0,
});

async function coin(replies: unknown[], apiKey: string | null = 'sk-or-test') {
  const f = fakeOpenRouter(replies);
  const base = await f.url;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return realFetch(href.replace('https://openrouter.ai', base), init);
  }) as typeof fetch;

  let error: unknown = null;
  let result: Awaited<ReturnType<typeof runCoin>> | null = null;
  try {
    result = await runCoin({
      apiKey,
      novel,
      charter,
      kind: 'location',
      brief: 'a mountain pass used for winter trade',
      taken: TAKEN,
      nonce: 0,
    });
  } catch (e) {
    error = e;
  }
  globalThis.fetch = realFetch;
  f.server.close();
  return { result, error, rounds: f.rounds(), bodies: f.bodies };
}

console.log('\nThe model picks from the slate:');
{
  const names = slate.candidates.slice(0, 4).map((c) => c.name);
  const { result, error, rounds } = await coin([{ reading: READING, picks: names.map(pick) }]);
  check('four names come back', result?.proposals.length === 4, `${result?.proposals.length}`);
  check('in one round', rounds === 1, `${rounds}`);
  check('each carries an etymology', result?.proposals.every((p) => p.etymology.length > 10) === true);
  check('the raw slate rides along', (result?.slate.length ?? 0) >= 10, `${result?.slate.length}`);
  check('usage is reported', result?.usage !== null);
  check('no error', error === null, String(error));
}

console.log('\nThe model answers with a name that was never offered:');
{
  const good = slate.candidates.slice(0, 4).map((c) => c.name);
  const { result, rounds, bodies } = await coin([
    { reading: READING, picks: [pick('Elara'), ...good.slice(1).map(pick)] },
    { reading: READING, picks: good.map(pick) },
  ]);
  check('it is refused', result?.proposals.every((p) => p.name !== 'Elara') === true);
  check('and corrected rather than lost', result?.proposals.length === 4, `${result?.proposals.length}`);
  check('which took a second round', rounds === 2, `${rounds}`);
  check(
    'the model is told exactly what was wrong',
    bodies[1].includes('uses a word that was not offered'),
    'the correction has to be actionable or the retry repeats it'
  );
}

console.log('\nThe model builds a name from the parts rather than picking one:');
{
  // The point of the palette: a model that has read the brief can choose words
  // the generator could only guess at. What it must not do is add a word of its
  // own, and the two cases have to be told apart.
  const words = slate.palette.words.flatMap((w) => w.options);
  const composed = `${words[0]} ${words[words.length - 1]}`;
  check(
    'a name composed of palette words is accepted',
    isFromSlate(composed, slate.candidates, slate.palette),
    composed
  );
  check(
    'a stem plus a palette word is accepted',
    slate.palette.stems.length === 0 ||
      isFromSlate(`${slate.palette.stems[0]} ${words[0]}`, slate.candidates, slate.palette)
  );
  check(
    'one foreign word among good ones still fails',
    !isFromSlate(`${words[0]} Aetherium`, slate.candidates, slate.palette),
    'a single word from outside is the whole hole this closes'
  );
  check(
    'the palette carries real words',
    slate.palette.words.length > 0 && words.length > 3,
    `${words.length} words`
  );

  const { result, rounds } = await coin([
    {
      reading: READING,
      picks: [{ ...pick(composed), source: 'blend' }],
    },
  ]);
  check('and the agent accepts it end to end', result?.proposals[0]?.name === composed, `${rounds}`);
}

console.log('\nThe model blends two candidates:');
{
  const a = slate.candidates[0].name.replace(/[^A-Za-z]/g, '');
  const b = slate.candidates[1].name.replace(/[^A-Za-z]/g, '');
  const blend = a.slice(0, Math.max(3, Math.floor(a.length / 2))) + b.slice(Math.floor(b.length / 2));
  check(
    'a genuine blend is recognised',
    isFromSlate(blend, slate.candidates, slate.palette),
    `${blend} from ${a} + ${b}`
  );
  check('an unrelated name is not', !isFromSlate('Elara', slate.candidates, slate.palette));
  check('a candidate itself is', isFromSlate(slate.candidates[0].name, slate.candidates, slate.palette));
  check(
    'a two-word name from two candidates is',
    isFromSlate(`${a} ${b}`, slate.candidates, slate.palette)
  );
}

console.log('\nThe model returns something malformed:');
{
  const good = slate.candidates.slice(0, 2).map((c) => c.name);
  const noReading = await coin([
    { picks: good.map(pick) },
    { reading: READING, picks: good.map(pick) },
  ]);
  check('a missing reading is corrected', noReading.result?.proposals.length === 2, `${noReading.rounds}`);
  check(
    'and the model is told why',
    noReading.bodies[1].includes('reading.register'),
    'the reading exists to be expensive to fake'
  );

  const noEtym = await coin([
    { reading: READING, picks: [{ ...pick(good[0]), etymology: '' }] },
    { reading: READING, picks: good.map(pick) },
  ]);
  check('a missing etymology is corrected', noEtym.result?.proposals.length === 2, `${noEtym.rounds}`);

  const dupes = await coin([
    { reading: READING, picks: [pick(good[0]), pick(good[0])] },
    { reading: READING, picks: good.map(pick) },
  ]);
  check('duplicate picks are corrected', dupes.result?.proposals.length === 2);
  check('and named as duplicates', dupes.bodies[1].includes('appears twice'));
}

console.log('\nThe model never cooperates:');
{
  const { result, error, rounds } = await coin([{ reading: READING, picks: [pick('Elara')] }]);
  check('it gives up after three rounds', rounds === 3, `${rounds}`);
  check('without throwing', error === null, String(error));
  check(
    'and the author still gets the generated names',
    (result?.slate.length ?? 0) >= 10,
    'the slate is what they came for; the model was the polish'
  );
  check('with no bad proposals', result?.proposals.length === 0);
}

console.log('\nWith no API key at all:');
{
  const { result, error, rounds } = await coin([], null);
  check('nothing is called', rounds === 0, `${rounds}`);
  check('the slate still comes back', (result?.slate.length ?? 0) >= 10, `${result?.slate.length}`);
  check('usage is null', result?.usage === null);
  check('and no error', error === null, String(error));
  check(
    'none of it collides with what the novel has',
    result?.slate.every((c) => !TAKEN.includes(c.name)) === true
  );
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
