/**
 * The proposal contract of the next-chapter suggestion agent.
 *   npx tsx src/suggest.test.ts
 *
 * Free — no network. A local HTTP server stands in for OpenRouter and replies
 * with whatever tool call each case wants to test, so the real agent loop runs
 * against real SSE.
 *
 * What is worth testing here is not the writing, which no assertion can judge,
 * but the contract around it: exactly three directions, one per move, presented
 * in escalating order, and a malformed proposal corrected rather than lost. A
 * model that quietly returns two options, or three variations of the same
 * intensity, breaks the only promise the feature makes.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const { runSuggestions } = await import('./engine/suggestAgent.js');
import type { Chapter, Novel } from './lib/types.js';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failures.push(label);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
}

const READING = {
  endsOn: 'Kael alone on the wall, the gate already open behind him.',
  openThreads: ['the open gate', "Sera's silence"],
  pressure: 'The column reaches the gate by dawn, and Kael is the only one who knows.',
  spent: 'The argument in the barracks; the ride north.',
};

const direction = (move: string, title = `${move} title`) => ({
  move,
  title,
  opens: `Open on the ${move}, with Kael wanting the gate shut and Sera in his way.`,
  turn: `Partway through, the ${move} costs him the one thing he was holding back.`,
  lands: `End on a closed door and Sera on the wrong side of it, saying nothing.`,
  rationale: `Because ${move}.`,
});

/** One tool call, encoded as the SSE frames the parser expects. */
function toolCallSSE(args: unknown): string {
  const call = {
    index: 0,
    id: 'call_1',
    type: 'function',
    function: { name: 'propose_directions', arguments: JSON.stringify(args) },
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

/** Serve one scripted reply per round, so a correction loop can be exercised. */
function fakeOpenRouter(replies: unknown[]): { server: Server; url: Promise<string>; rounds: () => number } {
  let call = 0;
  const server = createServer((req, res) => {
    if (req.url?.includes('/models/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { endpoints: [] } }));
      return;
    }
    req.on('data', () => {});
    req.on('end', () => {
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
  return { server, url, rounds: () => call };
}

const realFetch = globalThis.fetch;

const novel = {
  id: 'nv1',
  ownerUid: 'u1',
  title: 'The Long Watch',
  premise: 'A gate that must not open.',
  styleNotes: '',
  style: 'plain',
  defaultModel: 'x/y',
  chapterLength: 2000,
  chapterCount: 4,
  wordCount: 8000,
  hidden: false,
  createdAt: 0,
  updatedAt: 0,
} as unknown as Novel;

const chapter: Chapter = {
  number: 4,
  title: 'The Gate',
  content: 'Kael waited. '.repeat(40),
  status: 'accepted',
  summary: 'Kael finds the gate open.',
  userPrompt: '',
  revisionNotes: [],
  model: 'x/y',
  createdAt: 0,
  updatedAt: 0,
};

async function propose(replies: unknown[]) {
  const { server, url, rounds } = fakeOpenRouter(replies);
  const base = await url;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return realFetch(href.replace('https://openrouter.ai', base), init);
  }) as typeof fetch;

  let error: unknown = null;
  let result: Awaited<ReturnType<typeof runSuggestions>> | null = null;
  try {
    result = await runSuggestions({
      apiKey: 'sk-or-test',
      novel,
      chapter,
      previous: [],
      bibleEntries: [],
      designs: [],
    });
  } catch (e) {
    error = e;
  }
  globalThis.fetch = realFetch;
  server.close();
  return { result, error, rounds: rounds() };
}

console.log('\nA well-formed proposal, delivered out of order:');
{
  const { result, error, rounds } = await propose([
    { reading: READING, directions: [direction('swerve'), direction('follow'), direction('complicate')] },
  ]);
  check('it is accepted', error === null, error ? String(error) : '');
  check('in one round', rounds === 1, `${rounds}`);
  check(
    'presented as follow, complicate, swerve',
    result?.suggestions.map((s) => s.move).join(',') === 'follow,complicate,swerve',
    result?.suggestions.map((s) => s.move).join(',')
  );
  check('all three carry a prompt', result?.suggestions.every((s) => s.prompt.length > 0) === true);
}

console.log('\nTwo directions instead of three:');
{
  const { result, error, rounds } = await propose([
    { reading: READING, directions: [direction('follow'), direction('swerve')] },
    { reading: READING, directions: [direction('follow'), direction('complicate'), direction('swerve')] },
  ]);
  check('the shortfall is sent back, not accepted', rounds === 2, `${rounds}`);
  check('and the corrected proposal stands', error === null && result?.suggestions.length === 3);
}

console.log('\nThree options at the same intensity:');
{
  const { result, error, rounds } = await propose([
    { reading: READING, directions: [direction('follow', 'a'), direction('follow', 'b'), direction('follow', 'c')] },
    { reading: READING, directions: [direction('follow'), direction('complicate'), direction('swerve')] },
  ]);
  check('the duplicate move is refused', rounds === 2, `${rounds}`);
  check('the author ends up with a real choice', error === null && result?.suggestions.length === 3);
}

console.log('\nDirections proposed without reading the chapter:');
{
  const { rounds } = await propose([
    { directions: [direction('follow'), direction('complicate'), direction('swerve')] },
    { reading: READING, directions: [direction('follow'), direction('complicate'), direction('swerve')] },
  ]);
  check('the missing reading is sent back', rounds === 2, `${rounds}`);
}

console.log('\nA model that never gets it right:');
{
  const { error, rounds } = await propose([{ reading: READING, directions: [direction('follow')] }]);
  check('it gives up rather than looping forever', rounds === 3, `${rounds}`);
  check('and says so', error instanceof Error, String(error));
}

console.log('\nOverlong fields:');
{
  const long = {
    ...direction('follow'),
    title: 'T'.repeat(500),
    opens: `Open on a ${'P'.repeat(700)} of a thing.`,
    rationale: 'R'.repeat(5000),
  };
  const { result } = await propose([
    { reading: READING, directions: [long, direction('complicate'), direction('swerve')] },
  ]);
  const first = result?.suggestions[0];
  check('the title is cut to size', (first?.title.length ?? 0) === 80, `${first?.title.length}`);
  check('and so is the instruction', (first?.prompt.length ?? 0) <= 900, `${first?.prompt.length}`);
  check('a clipped field says so', first?.rationale.endsWith('\u2026') === true, first?.rationale.slice(-8));
}

console.log('\nA rationale one word too long:');
{
  const wordy = {
    ...direction('follow'),
    // 320 is the cap; this runs past it mid-word, which is the case that used
    // to reach the author as "...complicates Mirin'".
    rationale: ('because ' .repeat(60)).trim(),
  };
  const { result } = await propose([
    { reading: READING, directions: [wordy, direction('complicate'), direction('swerve')] },
  ]);
  const r = result?.suggestions[0].rationale ?? '';
  check('it is cut at a word, not through one', /\bbecause\u2026$/.test(r), r.slice(-20));
  check('and stays within the cap', r.length <= 320, `${r.length}`);
}

console.log('\nA direction with no middle:');
{
  // The failure this whole three-part shape exists to catch: an opening move
  // and a closing image, with the chapter's actual work left out.
  const beat = { ...direction('follow'), turn: 'She agrees.' };
  const { result, error, rounds } = await propose([
    { reading: READING, directions: [beat, direction('complicate'), direction('swerve')] },
    { reading: READING, directions: [direction('follow'), direction('complicate'), direction('swerve')] },
  ]);
  check('a beat is refused as a chapter', rounds === 2, `${rounds}`);
  check('and the replacement stands', error === null && result?.suggestions.length === 3);
}

console.log('\nThe instruction the author receives:');
{
  const { result } = await propose([
    { reading: READING, directions: [direction('follow'), direction('complicate'), direction('swerve')] },
  ]);
  const p = result?.suggestions[0].prompt ?? '';
  check('carries the opening', p.includes('Open on the follow'), p.slice(0, 30));
  check('carries the turn', p.includes('Partway through'), '');
  check('carries the landing', p.includes('End on a closed door'), '');
}

console.log('\nA direction that has stopped directing and started drafting:');
{
  // Long is not wrong in itself; it is where the landing starts repeating the
  // turn, so the cap is the cheapest way to buy the coherence back.
  const drafted = {
    ...direction('follow'),
    turn: `Partway through, ${'she considers the matter at some length and then again, '.repeat(20)}`,
  };
  const { result, error, rounds } = await propose([
    { reading: READING, directions: [drafted, direction('complicate'), direction('swerve')] },
    { reading: READING, directions: [direction('follow'), direction('complicate'), direction('swerve')] },
  ]);
  check('the draft is sent back for a direction', rounds === 2, `${rounds}`);
  check('and the shorter one is kept', error === null && result?.suggestions.length === 3);
  const words = (result?.suggestions[0].prompt ?? '').split(/\s+/).length;
  check('what the author gets is under the cap', words <= 150, `${words}`);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
