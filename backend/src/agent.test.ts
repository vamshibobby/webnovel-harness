/**
 * What the chapter agent does when the model does not write a chapter.
 *   npx tsx src/agent.test.ts
 *
 * Free — no network. A local server stands in for OpenRouter.
 *
 * This exists because of a real report: a generation finished and the chapter
 * on screen was a fenced block containing `search_previous_chapters`. The model
 * had described the tool call it wanted rather than making one, finished with
 * `stop`, and the loop read that as "the chapter is written" — so three words
 * of plumbing were titled, saved, and counted towards the novel's word count.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Novel } from './lib/types.js';

const { runChapterAgent } = await import('./engine/agent.js');
const { defaultCharter } = await import('./engine/naming/charter.js');
const { runCoinName } = await import('./engine/naming/nameTools.js');

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failures.push(label);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
}

/** An SSE reply that streams `text` as content and stops. */
function sse(text: string): string {
  const chunks = text.match(/[\s\S]{1,40}/g) ?? [];
  return (
    chunks
      .map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c }, finish_reason: null }] })}\n\n`)
      .join('') +
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0 },
    })}\n\n` +
    'data: [DONE]\n\n'
  );
}

/**
 * An SSE reply that streams some prose and then makes a tool call — the shape
 * that matters for coin_name, which a writer reaches for partway through.
 */
function sseCall(name: string, args: Record<string, unknown>, prose = ''): string {
  const lead = prose
    ? (prose.match(/[\s\S]{1,40}/g) ?? [])
        .map((ch) => `data: ${JSON.stringify({ choices: [{ delta: { content: ch }, finish_reason: null }] })}\n\n`)
        .join('')
    : '';
  return (
    lead +
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: `call_${name}`, function: { name, arguments: JSON.stringify(args) } },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n` +
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0 },
    })}\n\n` +
    'data: [DONE]\n\n'
  );
}

/**
 * Serves one scripted reply per request; the last repeats. A reply that is
 * already an SSE body (from sseCall) is sent verbatim; anything else is
 * streamed as prose.
 */
function fake(replies: string[]): {
  server: Server;
  url: Promise<string>;
  calls: () => number;
  sawTools: boolean[];
  toolNames: string[][];
  maxTokens: Array<number | undefined>;
} {
  let n = 0;
  const sawTools: boolean[] = [];
  const toolNames: string[][] = [];
  const maxTokens: Array<number | undefined> = [];
  const server = createServer((req, res) => {
    if (req.url?.includes('/models/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { endpoints: [] } }));
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const sent = JSON.parse(body || '{}') as {
        tools?: Array<{ function: { name: string } }>;
        max_tokens?: number;
      };
      sawTools.push(Array.isArray(sent.tools));
      toolNames.push((sent.tools ?? []).map((t) => t.function.name));
      maxTokens.push(sent.max_tokens);
      const reply = replies[Math.min(n, replies.length - 1)];
      n++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(reply.startsWith('data: ') ? reply : sse(reply));
    });
  });
  const url = new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
  return { server, url, calls: () => n, sawTools, toolNames, maxTokens };
}

const realFetch = globalThis.fetch;

const novel = {
  id: 'nv', ownerUid: 'u', title: 'A Novel', premise: 'Something happens.',
  styleNotes: '', style: 'webnovel', defaultModel: 'x/y', chapterLength: 2000,
  chapterCount: 3, wordCount: 6000, hidden: false, createdAt: 0, updatedAt: 0,
} as unknown as Novel;

const CHAPTER = `Chapter 4: The Gate\n\n${'Kael waited at the wall, and the cold came up off the stones. '.repeat(20)}`;

async function generate(replies: string[], extra: Partial<Parameters<typeof runChapterAgent>[0]> = {}) {
  const f = fake(replies);
  const base = await f.url;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return realFetch(href.replace('https://openrouter.ai', base), init);
  }) as typeof fetch;

  const events: Array<{ type: string; data: string }> = [];
  let error: unknown = null;
  let content = '';
  let truncated: boolean | undefined;
  try {
    const r = await runChapterAgent({
      apiKey: 'sk-or-test',
      model: `test/m-${Math.random().toString(36).slice(2, 8)}`,
      novel,
      chapterNumber: 4,
      previous: [],
      userPrompt: 'Kael reaches the gate.',
      emit: (e) => events.push(e),
      ...extra,
    });
    content = r.content;
    truncated = r.truncated;
  } catch (e) {
    error = e;
  }
  globalThis.fetch = realFetch;
  f.server.close();
  return {
    content,
    error,
    events,
    calls: f.calls(),
    sawTools: f.sawTools,
    toolNames: f.toolNames,
    maxTokens: f.maxTokens,
    truncated,
  };
}

console.log('\nThe model writes out a tool call instead of making one:');
{
  const babble = '```html\nsearch_previous_chapters\n```';
  const { content, error, events, calls, sawTools } = await generate([babble, CHAPTER]);
  check('it is not accepted as the chapter', !content.includes('search_previous_chapters'), content.slice(0, 40));
  check('the real chapter is returned instead', content.includes('Kael waited at the wall'));
  check('it took a second attempt', calls === 2, `${calls}`);
  check('and the retry had the tools taken away', sawTools[0] === true && sawTools[1] === false);
  check(
    'the client is told to drop what it streamed',
    events.some((e) => e.type === 'restart'),
    events.map((e) => e.type).join(',')
  );
  check('no error surfaced', error === null, String(error));
}

console.log('\nThe model never writes a chapter:');
{
  const { content, error, calls } = await generate(['```\nsearch_previous_chapters\n```']);
  check('it gives up rather than saving plumbing', error instanceof Error, String(error).slice(0, 60));
  check('nothing is returned to be saved', content === '');
  check('it did not loop forever', calls <= 7, `${calls}`);
}

console.log('\nThe model returns nothing at all:');
{
  const { error } = await generate(['', '']);
  check('an empty chapter is refused', error instanceof Error, String(error).slice(0, 60));
}

console.log('\nA normal chapter:');
{
  const { content, error, events, calls } = await generate([CHAPTER]);
  check('is returned unchanged', content === CHAPTER);
  check('in one call', calls === 1, `${calls}`);
  check('with no restart', !events.some((e) => e.type === 'restart'));
  check('and no error', error === null);
}

console.log('\nA chapter that legitimately mentions searching:');
{
  // The guard keys on length as well as the tool name, so a long chapter that
  // happens to contain one is still a chapter. Only short replies are suspect.
  const withWord = `${CHAPTER}\nHe would search_previous_chapters, he thought, if such a thing existed.`;
  const { content, error, calls } = await generate([withWord]);
  check('is not mistaken for plumbing', content === withWord && error === null, `calls=${calls}`);
}

console.log('\nA narrated call sitting on top of a real chapter:');
{
  // Measured on grok-4.5: it emits the fenced tool name alongside the prose,
  // and a chapter is long enough to sail past the length guard. Stripping the
  // fence is what stops it landing at the top of the saved chapter.
  const messy = '```search_previous_chapters```\nkeywords: ["woman", "quay"]\n\n' + CHAPTER;
  const { content, error, calls } = await generate([messy]);
  check('the fence is removed', !content.includes('search_previous_chapters'), content.slice(0, 40));
  check('the chapter opens where it should', content.startsWith('Chapter 4: The Gate'), content.slice(0, 24));
  check('and it was not sent round again', calls === 1 && error === null, `calls=${calls}`);
}

console.log('\nProse that merely opens with a code fence:');
{
  const fenced = '```\nconst x = 1;\n```\n\n' + CHAPTER;
  const { content } = await generate([fenced]);
  check('is left alone when no tool is named', content === fenced, content.slice(0, 24));
}

/*
 * Leaked chain-of-thought. Measured in production on the managed free tier —
 * which is what every new account writes its first chapter on. The model
 * returned 21,000 characters of itself drafting and grading its own paragraphs,
 * and it was saved as the author's chapter and word-counted at 3,644 words. The
 * heading it eventually wrote was thousands of lines down, far past the point
 * extractTitle stops looking for one.
 */
console.log('\nThe model streams its plan instead of the chapter:');
{
  const thinking =
    'We need to write Chapter 1 with title format "Chapter N: Title". Need to open on the clerk ' +
    'counting crates at dawn.\n\nConstraints: web novel style, modern English, approximately 1500 ' +
    'words. Must not repeat beats.\n\nParagraph 1: establish the quay, the cold, the crates. ' +
    "Let's pick \"Mira\" for the clerk.\n\nParagraph 2: she finds the second ledger.\n\n" +
    'Chapter 1: Cold Light on the Quay\n\nThe crates came in before the light did.';
  const { content, error, events, calls, sawTools } = await generate([thinking, CHAPTER]);
  check('the plan is not saved as the chapter', !content.includes('We need to write'), content.slice(0, 50));
  check('the real chapter is returned instead', content === CHAPTER);
  check('it took a second attempt', calls === 2, `${calls}`);
  check('and the retry had the tools taken away', sawTools[1] === false);
  check(
    'the client is told to drop what it streamed',
    events.some((e) => e.type === 'restart'),
    'the author watched all of it arrive token by token'
  );
  check('no error surfaced', error === null, String(error));
  check(
    'the trace says what went wrong in the author’s words',
    events.some((e) => e.type === 'trace' && /wrote out its plan/.test(e.data)),
    events.filter((e) => e.type === 'trace').map((e) => e.data).join(' | ').slice(0, 120)
  );
}

console.log('\nA model that will not stop planning:');
{
  const thinking = 'We need to write Chapter 1. Constraints: about 1500 words. Paragraph 1: the quay.';
  const { content, error } = await generate([thinking, thinking]);
  check('it gives up rather than saving the plan', error instanceof Error, String(error).slice(0, 70));
  check('and nothing reaches the novel', content === '');
}

console.log('\nThe model announces itself in the first person:');
{
  /*
   * Reported from a real generation, and the case the original marker list was
   * blind to: it was built around first-person-PLURAL deliberation ("we need
   * to", "let's write"), and real replies announce in the singular. Neither this
   * text nor the "I have all the context I need. Let me now write Chapter 9."
   * quoted in research/eval/README.md scored a SINGLE marker, so the guard let
   * both through to the author's chapter.
   */
  const announced =
    'Good. Now I have full context. Let me write Chapter 7.\n\nKey points:\n' +
    "- Beap visits the apartment with supplies, checks on Fler's training\n" +
    '- Kuw follows and harasses Grey with familiar touch she tolerates\n' +
    '- Fler notices and objects; Grey stops him\n' +
    '- Beap offers Grey continued protection\n\nLet me write this now.';
  const { content, error, events, calls } = await generate([announced, CHAPTER]);
  check('the plan is not saved as the chapter', !content.includes('Key points'), content.slice(0, 40));
  check('the real chapter is returned instead', content === CHAPTER);
  check('it took a second attempt', calls === 2, `${calls}`);
  check(
    'the client is told to drop what it streamed',
    events.some((e) => e.type === 'restart'),
    'this is what stops it appearing on the chapter page'
  );
  check('no error surfaced', error === null, String(error));
}
{
  // The other half of the fix, and the reason it does not cost anything: a
  // reply that plans and THEN writes a real chapter is left alone. extractTitle
  // strips the plan for free, where a restart would buy a cleaner stream at the
  // price of a second full generation the author pays for.
  const plannedThenWrote =
    'Let me write Chapter 4 now. Key points:\n- she counts the crates\n- the tide turns\n\n' +
    `Chapter 4: The Gate\n\n${'She counted the crates again and the cold came up off the stones. '.repeat(30)}`;
  const { content, error, calls } = await generate([plannedThenWrote]);
  check('a plan with a real chapter under it is not thrown away', calls === 1, `calls=${calls}`);
  check('the reply comes back whole for the title extractor', content === plannedThenWrote && error === null);
}

console.log('\nProse that merely sounds like planning:');
{
  // Precision matters more than recall here: a false positive costs the author
  // a whole regeneration. One marker in dialogue must not be enough.
  const dialogue =
    'Chapter 4: The Gate\n\n"We need to leave," she said. "Before the tide turns."\n\n' +
    'He counted the crates again and said nothing.\n\n' + CHAPTER;
  const { content, error, calls } = await generate([dialogue]);
  check('a character saying "we need to" is still a chapter', content === dialogue && error === null, `calls=${calls}`);
}
{
  /*
   * The window is the OPENING, not the whole chapter. A real chapter runs to
   * eight or nine thousand characters, so a scene about a scribe counting words
   * deep in one must survive — padded to that length here, because the fixture
   * above is a twentieth of a real chapter and everything lands in its opening.
   */
  const long = `Chapter 4: The Gate\n\n${'She counted the crates again and the cold came up off the stones. '.repeat(150)}`;
  const late = `${long}\n\nShe read the word count aloud. "We need to write it again," he said.`;
  check('the padded chapter is realistically long', late.length > 8000, `${late.length} chars`);
  const { content, error } = await generate([late]);
  check('planning words deep in a long chapter are ignored', content === late && error === null);
}

// ── get_power_system ───────────────────────────────────────────────────────

const powerSystem = {
  id: 'qi-cultivation',
  name: 'Qi Cultivation',
  summary: 'Meridians and cores.',
  source: 'author' as const,
  energyName: 'qi',
  costsAndLimits: '',
  rarityNote: '',
  crossSystemNote: '',
  ranks: [
    {
      id: 'foundation', name: 'Foundation', summary: '', capabilities: ['temper the body'],
      skills: [], advancement: '', rarity: '', characterIds: [], note: '',
    },
  ],
  professions: [],
  artifacts: [],
  regions: [],
  openQuestions: [],
  createdAt: 0,
  updatedAt: 0,
};

console.log('\nget_power_system is only offered when systems exist:');
{
  const off = await generate([CHAPTER]);
  check('absent with no systems', !off.toolNames[0].includes('get_power_system'), off.toolNames[0].join(','));
  const on = await generate([CHAPTER], { powerSystems: [powerSystem] });
  check('present with one', on.toolNames[0].includes('get_power_system'), on.toolNames[0].join(','));
}

console.log('\nThe writer fetches a power system before a breakthrough scene:');
{
  const { content, error, calls, events } = await generate(
    [sseCall('get_power_system', { ids: ['qi-cultivation'] }), CHAPTER],
    { powerSystems: [powerSystem] }
  );
  check('the chapter comes back', content === CHAPTER, content.slice(0, 40));
  check('after two calls', calls === 2 && error === null, `calls=${calls}`);
  check(
    'and the trace names the system',
    events.some((e) => e.type === 'tool' && e.data.includes('Qi Cultivation')),
    events.filter((e) => e.type === 'tool').map((e) => e.data).join(' | ')
  );
}

console.log('\nA narrated get_power_system call is not saved as prose:');
{
  const babble = '```\nget_power_system\n```';
  const { content, error, calls } = await generate([babble, CHAPTER], {
    powerSystems: [powerSystem],
  });
  check('the plumbing is refused', !content.includes('get_power_system'), content.slice(0, 40));
  check('the real chapter arrives on retry', content.includes('Kael waited at the wall') && error === null, `calls=${calls}`);
}

// ── coin_name ──────────────────────────────────────────────────────────────

const charter = defaultCharter(novel);
const TAKEN = ['Kellrand', 'Skarn', 'Vennes'];
const naming = { charter, takenNames: TAKEN };

console.log('\ncoin_name is only offered when the author has naming on:');
{
  const off = await generate([CHAPTER]);
  check('absent with no charter', !off.toolNames[0].includes('coin_name'), off.toolNames[0].join(','));
  const on = await generate([CHAPTER], naming);
  check('present with one', on.toolNames[0].includes('coin_name'), on.toolNames[0].join(','));
  check(
    'and it is offered even with an empty bible',
    on.toolNames[0].includes('coin_name'),
    'unlike the readers, it manufactures its answer, so there is never nothing to return'
  );
}

console.log('\nThe writer coins a name before it starts:');
{
  const call = sseCall('coin_name', { kind: 'location', brief: 'a winter trade pass', count: 6 });
  const { content, error, events, calls } = await generate([call, CHAPTER], naming);
  check('the chapter still comes back', content === CHAPTER, content.slice(0, 40));
  check('it took two calls', calls === 2, `${calls}`);
  check('no error', error === null, String(error));
  check(
    'the author is told what is happening',
    events.some((e) => e.type === 'tool' && e.data.includes('location')),
    events.filter((e) => e.type === 'tool').map((e) => e.data).join(' | ')
  );
  check(
    'nothing is restarted for a call made before any prose',
    !events.some((e) => e.type === 'restart')
  );
}

console.log('\nThe model narrates its own tool calls:');
{
  /*
   * Reported with a screenshot: thirteen rounds of "Let me search for the
   * relevant characters and details before writing." / "Now let me coin some
   * names for the neighbouring town." rendered in the chapter column, in the
   * prose font, as if the novel had been written by an assistant thinking
   * aloud. Each line is short, so the old >400-character test for a fragment
   * never fired and nothing took them back.
   */
  const searched = sseCall(
    'search_previous_chapters',
    { keywords: ['Fler', 'Grey'] },
    'Let me search for the relevant characters and details before writing.'
  );
  const coined = sseCall(
    'coin_name',
    { kind: 'location', brief: 'a neighbouring town' },
    'Now let me coin some names for the neighboring town and other new elements.'
  );
  const { content, error, events } = await generate([searched, coined, CHAPTER], naming);
  const streamed = events.filter((e) => e.type === 'token').map((e) => e.data).join('');
  const thought = events.filter((e) => e.type === 'reasoning').map((e) => e.data).join('');

  check('no narration reaches the chapter column', streamed === CHAPTER, `${streamed.slice(0, 60)}…`);
  check('specifically not the search line', !streamed.includes('Let me search'));
  check('nor the naming line', !streamed.includes('coin some names'));
  check('it is shown as thinking instead', thought.includes('Let me search for the relevant characters'), thought.slice(0, 50));
  check('both rounds of it', thought.includes('coin some names for the neighboring town'));
  check(
    'and nothing had to be taken back',
    !events.some((e) => e.type === 'restart'),
    'a restart here would blank real prose in the other direction'
  );
  check('the chapter is returned', content === CHAPTER, content.slice(0, 40));
  check('no error surfaced', error === null, String(error));
}
{
  // The other side of the gate: real prose before a tool call is a fragment,
  // and still has to be taken back. Held to the same behaviour as before the
  // gate existed, because the value returned is the LAST round's content alone.
  const opening = `Chapter 4: The Gate\n\n${'She counted the crates again and the cold came up off the stones. '.repeat(12)}`;
  const wrote = sseCall('coin_name', { kind: 'character', brief: 'a dock clerk' }, opening);
  const { content, events, error } = await generate([wrote, CHAPTER], naming);
  const streamed = events.filter((e) => e.type === 'token').map((e) => e.data).join('');
  check('a real chapter opening does stream', streamed.includes('She counted the crates'), `${streamed.length} chars`);
  check('and is taken back when the tool call lands', events.some((e) => e.type === 'restart'));
  check('the finished chapter is what comes back', content === CHAPTER, content.slice(0, 40));
  check('no error surfaced', error === null, String(error));
}
{
  // A heading is not required to be recognised as prose: a model that opens
  // without one must still stream, just after the buffer fills.
  const unheaded = 'She counted the crates again and the cold came up off the stones. '.repeat(12);
  const { content, events, error } = await generate([unheaded]);
  const streamed = events.filter((e) => e.type === 'token').map((e) => e.data).join('');
  check('an unheaded chapter still streams in full', streamed === unheaded, `${streamed.length}/${unheaded.length}`);
  check('and is returned', content === unheaded && error === null);
}

console.log('\nThe tool output itself:');
{
  const { text: slate, offered } = runCoinName(
    { kind: 'location', brief: 'a winter trade pass', count: 6 },
    { novelId: novel.id, charter, taken: TAKEN, nonce: 0 }
  );
  check('the names offered come back alongside the text', offered.length === 6, `${offered.length}`);
  check('and every one of them is in it', offered.every((n) => slate.includes(n)));
  check('it names the register', slate.includes('Register:') && slate.includes('Shape:'));
  check('it offers candidates', /^ {2}1\. /m.test(slate), slate.split('\n')[4]);
  check('it restates what is already spent', TAKEN.every((t) => slate.includes(t)));
  check(
    'and it offers none of them back',
    !TAKEN.some((t) => new RegExp(`^ {2}\\d+\\. ${t}\\b`, 'm').test(slate))
  );

  const { text: again } = runCoinName(
    { kind: 'location', brief: 'a winter trade pass', count: 6 },
    { novelId: novel.id, charter, taken: TAKEN, nonce: 1 }
  );
  check(
    'a second call gives different names',
    again !== slate,
    'a model that dislikes its slate must not be handed the same one'
  );
}

console.log('\nNaming rounds do not eat the research budget:');
{
  const coin = sseCall('coin_name', { kind: 'character', brief: 'a dock clerk' });
  // Two naming rounds, then a search, then the chapter. Under the old counter
  // this would have burned three of the five rounds meant for canon lookups.
  const search = sseCall('search_previous_chapters', { keywords: ['gate'] });
  const { content, calls, sawTools, error } = await generate([coin, coin, search, CHAPTER], naming);
  check('the chapter is written', content === CHAPTER, content.slice(0, 40));
  check('after four calls', calls === 4, `${calls}`);
  check('with tools still on the table throughout', sawTools.slice(0, 4).every(Boolean));
  check('and no error', error === null, String(error));
}

console.log('\nA model that only ever coins names still has to stop:');
{
  const coin = sseCall('coin_name', { kind: 'character', brief: 'someone' });
  const { calls, sawTools } = await generate([coin], naming);
  check('the loop terminates', calls <= 9, `${calls}`);
  check('the last round has the tools removed', sawTools[sawTools.length - 1] === false);
}

console.log('\nProse written before a coin_name call:');
{
  // The bug this guards: runChapterAgent returns the LAST round's content, so a
  // chapter that starts, stops to name something, and continues would be saved
  // without its opening — after the author watched that opening stream past.
  const opening = `Chapter 4: The Gate\n\n${'The wall had stood a long time, and nobody remembered who built it. '.repeat(12)}`;
  const call = sseCall('coin_name', { kind: 'location', brief: 'the pass beyond the wall' }, opening);
  const { content, events, error } = await generate([call, CHAPTER], naming);
  check(
    'the client is told to drop the fragment',
    events.some((e) => e.type === 'restart'),
    events.map((e) => e.type).join(',')
  );
  check('the saved chapter is the complete one', content === CHAPTER, content.slice(0, 40));
  check(
    'and it is not the fragment plus the chapter',
    !content.includes('nobody remembered who built it'),
    'the opening must not appear twice'
  );
  check('no error', error === null, String(error));
}

console.log('\nA throat-clearing line before a tool call:');
{
  const call = sseCall('coin_name', { kind: 'character', brief: 'a clerk' }, 'Let me pick a name first.');
  const { content, events } = await generate([call, CHAPTER], naming);
  check(
    'does not trigger a restart',
    !events.some((e) => e.type === 'restart'),
    'a one-line aside is not a chapter opening'
  );
  check('and the chapter comes back', content === CHAPTER);
}

console.log('\nThe model narrates coin_name instead of calling it:');
{
  const { content, error } = await generate(['```\ncoin_name\n```', CHAPTER], naming);
  check('it is not saved as the chapter', !content.includes('coin_name'), content.slice(0, 40));
  check('the real chapter is returned', content.includes('Kael waited at the wall') && error === null);
}

/*
 * Room to write in.
 *
 * The budget used to be left unset — "whatever the provider defaults to" — and
 * some providers default to a couple of thousand tokens, which is half a
 * chapter. The draft then stopped mid-sentence with nothing anywhere saying
 * why. Two things are asserted: a reservation is always sent, and it scales
 * with the target length while leaving headroom for a reasoning model, which
 * spends this same budget thinking before it writes a word.
 */
console.log('\nThe chapter gets room to be written:');
{
  const { maxTokens } = await generate([CHAPTER]);
  check('a reservation is always sent', typeof maxTokens[0] === 'number', String(maxTokens[0]));
  check('it clears the target length with headroom to think', (maxTokens[0] ?? 0) >= 1500 * 1.6 + 2000);

  const short = await generate([CHAPTER], { novel: { ...novel, chapterLength: 800 } as Novel });
  const epic = await generate([CHAPTER], { novel: { ...novel, chapterLength: 4000 } as Novel });
  check('a longer target reserves more', (epic.maxTokens[0] ?? 0) > (short.maxTokens[0] ?? 0));
  check('and it stays under a ceiling a small context can hold', (epic.maxTokens[0] ?? 0) <= 8000);

  // "Model decides" is 0 words, which must not read as "no room needed".
  const modelDecides = await generate([CHAPTER], { novel: { ...novel, chapterLength: 0 } as Novel });
  check('"model decides" still reserves a full chapter', (modelDecides.maxTokens[0] ?? 0) >= 4000);
}

console.log('\nA chapter cut off at the output limit:');
{
  const cutOff =
    `data: ${JSON.stringify({ choices: [{ delta: { content: CHAPTER }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0 } })}\n\n` +
    'data: [DONE]\n\n';
  const { content, truncated, events, error } = await generate([cutOff]);
  check('the draft is still returned — it is the author\'s to keep', content.includes('Kael waited at the wall'));
  check('but it is reported as truncated', truncated === true);
  check('and the reason is traced', events.some((e) => e.type === 'trace' && /output limit/i.test(e.data)));
  check('it is not treated as a failure', error === null);

  const normal = await generate([CHAPTER]);
  check('a chapter that finished normally is not flagged', normal.truncated === false);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
