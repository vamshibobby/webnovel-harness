// Offline checks: npx tsx src/smoke.test.ts (no network, no API key)
import {
  buildGenerationMessages,
  buildPreviousChaptersBlock,
  buildSystemPrompt,
} from './engine/context.js';
import { cachePolicyFor } from './engine/cache.js';
import { defaultCharter } from './engine/naming/charter.js';
import { bareModelId, isSafeModelId } from './engine/models.js';
import {
  acquireGenerationSlot,
  assertChapterAllowed,
  assertNovelAllowed,
  isUnlimited,
  LimitError,
  LIMITS as LIMITS_ABUSE,
} from './lib/limits.js';
import {
  boundedString,
  chapterNumber,
  LIMITS,
  safeModelId,
  ValidationError,
} from './lib/validate.js';
import { formatSearchResults, searchChapters } from './engine/search.js';
import {
  buildProfile,
  describeWait,
  lockoutFor,
  mintToken,
  pinMatches,
  tokenIsValid,
  validPin,
} from './lib/vault.js';
import { DEFAULT_STYLE, listStyles, NOVEL_STYLES, type StyleKey } from './engine/styles.js';
import type { TextPart } from './engine/openrouter.js';
import type { Chapter, Novel } from './lib/types.js';

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function chapter(number: number, title: string, content: string, summary = ''): Chapter {
  return {
    number,
    title,
    content,
    status: 'accepted',
    summary,
    userPrompt: '',
    revisionNotes: [],
    model: '',
    createdAt: 0,
    updatedAt: 0,
  };
}

const novel: Novel = {
  id: 'n1',
  ownerUid: 'u1',
  title: 'The Drowned Ledger',
  premise: 'A courier finds a conspiracy.',
  styleNotes: 'Wry, atmospheric.',
  style: 'webnovel',
  defaultModel: '',
  chapterLength: 0,
  chapterCount: 0,
  wordCount: 0,
  hidden: false,
  createdAt: 0,
  updatedAt: 0,
};

// --- keyword retrieval -------------------------------------------------
const chapters = [
  chapter(
    1,
    'The Letter',
    'Mara the courier rowed through the flooded streets.\n\nShe found a sealed letter marked with a silver fox emblem.\n\nThe harbormaster Joren warned her about the tides.'
  ),
  chapter(
    2,
    'The Fox',
    'The silver fox emblem belonged to House Vane.\n\nJoren refused to speak of House Vane again.'
  ),
];

const results = searchChapters(chapters, ['silver fox', 'Vane']);
console.log(formatSearchResults(results));
check(results.length === 3, `expected 3 snippets, got ${results.length}`);
check(
  results[0].paragraph === 'The silver fox emblem belonged to House Vane.',
  'multi-keyword paragraph should rank first'
);

// --- context compaction ------------------------------------------------
const big = chapter(1, 'Huge', 'x'.repeat(400_000), 'summary of huge chapter');
const recent = chapter(2, 'Recent', 'Short recent chapter text.');
const block = buildPreviousChaptersBlock([big, recent]);
check(block.includes('summary of huge chapter'), 'old chapter should be summarized');
check(block.includes('Short recent chapter text.'), 'recent chapter should be full');

// --- prompt caching structure -----------------------------------------
// Long enough to clear the 1024-token minimum for a breakpoint.
const longHistory = [1, 2, 3].map((n) => chapter(n, `Ch${n}`, 'word '.repeat(1500)));

function historyParts(model: string): TextPart[] {
  const messages = buildGenerationMessages({
    novel,
    chapterNumber: 4,
    previous: longHistory,
    userPrompt: 'Continue the story.',
    model,
  });
  const historyMessage = messages[1];
  // The generation path only ever builds text parts; the filter narrows the
  // wider MessageContent union (which also admits images for the sketch agent).
  return Array.isArray(historyMessage.content)
    ? historyMessage.content.filter((p): p is TextPart => p.type === 'text')
    : [];
}

// Anthropic needs explicit breakpoints on the reusable history prefix.
const anthropic = historyParts('anthropic/claude-haiku-4.5');
check(anthropic.length === 4, `expected intro + 3 chapter blocks, got ${anthropic.length}`);
check(
  anthropic[3].cache_control?.ttl === '1h' && anthropic[2].cache_control?.ttl === '1h',
  'last two history blocks should carry a 1h cache breakpoint'
);
check(
  anthropic[0].cache_control === undefined && anthropic[1].cache_control === undefined,
  'earlier history blocks should not carry breakpoints'
);
// One block per chapter is what keeps the prefix byte-identical as the novel grows.
const grown = historyParts('anthropic/claude-haiku-4.5');
check(
  grown[1].text === anthropic[1].text && grown[2].text === anthropic[2].text,
  'chapter blocks must be stable across builds'
);

// Providers that cache automatically get plain strings — no cache_control.
const openaiMessages = buildGenerationMessages({
  novel,
  chapterNumber: 4,
  previous: longHistory,
  userPrompt: 'Continue the story.',
  model: 'openai/gpt-4o-mini',
});
check(
  JSON.stringify(openaiMessages).includes('cache_control') === false,
  'automatic-caching providers should get no cache_control fields'
);

// A short history is not worth a cache write.
const shortMessages = buildGenerationMessages({
  novel,
  chapterNumber: 2,
  previous: [chapter(1, 'Tiny', 'A very short chapter.')],
  userPrompt: 'Continue.',
  model: 'anthropic/claude-haiku-4.5',
});
check(
  JSON.stringify(shortMessages).includes('cache_control') === false,
  'history below the minimum should not get a breakpoint'
);

// The system prompt must not mention the chapter number, or the cached prefix
// would differ for every chapter of the novel.
const system = buildSystemPrompt(novel);
check(/chapter \d/i.test(system) === false, 'system prompt must stay chapter-independent');

// --- chapter length setting -------------------------------------------
const sized = buildSystemPrompt({ ...novel, chapterLength: 1500 });
check(sized.includes('1500 words'), 'chapter length should reach the system prompt');
// Easy to break by phrasing it "chapter 1500 words", which would put a digit
// after "chapter" and read as a chapter number in the shared cache prefix.
check(/chapter \d/i.test(sized) === false, 'length wording must not look like a chapter number');
check(
  buildSystemPrompt({ ...novel, chapterLength: 0 }).includes('LENGTH:') === false,
  'unset chapter length should add nothing to the prompt'
);

// --- the naming charter in the system prompt ---------------------------
// The charter rides in the CACHED prefix, not the per-chapter instruction: it
// changes when the author edits it, which is the class premise and styleNotes
// are in, not the class the bible index is in.
const charter = defaultCharter(novel);
const named = buildSystemPrompt(novel, charter);
check(named.includes('coin_name'), 'the charter block should point the writer at the tool');
check(named.length > system.length, 'a charter should add to the system prompt');
check(
  buildSystemPrompt(novel, null) === system && buildSystemPrompt(novel) === system,
  'no charter should leave the prompt byte-identical'
);
// Same rule as everything else in the shared prefix.
check(/chapter \d/i.test(named) === false, 'the charter block must stay chapter-independent');
// The sample names are generated, so this is the assertion that keeps the
// prefix reusable: two chapters of one novel must produce the same block.
check(
  buildSystemPrompt(novel, charter) === named,
  'the charter block must be byte-stable for a novel, or the cache prefix dies'
);
check(
  buildSystemPrompt({ ...novel, id: 'other' }, defaultCharter({ ...novel, id: 'other' })) !== named,
  'a different novel should get different sample names'
);
// The slop list must never reach a model: naming an unwanted behaviour in this
// prompt has been measured to prime it (see the FORMAT note in context.ts).
check(
  /elara|kaelen|aetherium|thorne/i.test(named) === false,
  'the cliché list must stay a code-side filter and out of the prompt'
);

const twoCultures = buildSystemPrompt(novel, {
  ...charter,
  cultures: [
    { id: 'court', label: 'The Meridian court', soundWorldId: 'meridian', appliesTo: 'the capital' },
    { id: 'clans', label: 'The northern clans', soundWorldId: 'northern', appliesTo: 'the fells' },
  ],
});
check(
  twoCultures.includes('The northern clans') && twoCultures.includes('The Meridian court'),
  'every culture should reach the prompt'
);
check(/chapter \d/i.test(twoCultures) === false, 'a multi-culture block must stay chapter-independent');

// A charter must not disturb where the cache breakpoints land.
const breakpoints = (charterArg: typeof charter | undefined): number =>
  JSON.stringify(
    buildGenerationMessages({
      novel,
      chapterNumber: 4,
      previous: longHistory,
      userPrompt: 'Write it.',
      model: 'anthropic/claude-haiku-4.5',
      charter: charterArg,
    })
  ).split('cache_control').length;
check(
  breakpoints(charter) === breakpoints(undefined),
  'a charter must not change the number of cache breakpoints'
);

// --- model aliases -----------------------------------------------------
// `~provider/model-latest` ids must behave like the model they point at.
check(bareModelId('~anthropic/claude-haiku-latest') === 'anthropic/claude-haiku-latest', 'alias marker should be stripped');
check(bareModelId('openai/gpt-4o-mini') === 'openai/gpt-4o-mini', 'plain ids should be untouched');
check(
  cachePolicyFor('~anthropic/claude-haiku-latest').explicit,
  'Anthropic aliases must still get explicit cache breakpoints'
);
check(
  cachePolicyFor('~anthropic/claude-haiku-latest').ttl ===
    cachePolicyFor('anthropic/claude-haiku-4.5').ttl,
  'an alias should get the same cache policy as its provider'
);
check(
  cachePolicyFor('~deepseek/deepseek-v4-flash-latest').explicit === false,
  'DeepSeek aliases stay on automatic caching'
);

// --- input validation --------------------------------------------------
function rejects(fn: () => unknown, why: string): void {
  try {
    fn();
  } catch (err) {
    if (err instanceof ValidationError) return;
    throw err;
  }
  throw new Error(`expected rejection: ${why}`);
}

check(boundedString('  spaced  ', 'title') === 'spaced', 'strings should be trimmed');
check(boundedString(undefined, 'premise') === '', 'optional fields default to empty');
rejects(() => boundedString(undefined, 'title', { required: true }), 'missing required field');
rejects(() => boundedString(42, 'title'), 'non-string input');
rejects(() => boundedString('x'.repeat(LIMITS.prompt + 1), 'prompt'), 'over-length prompt');
check(boundedString('x'.repeat(LIMITS.prompt), 'prompt').length === LIMITS.prompt, 'cap is inclusive');

// Model ids are interpolated into OpenRouter URL paths, so anything that could
// rewrite the path has to be refused rather than encoded.
check(safeModelId('deepseek/deepseek-v4-flash') === 'deepseek/deepseek-v4-flash', 'plain id ok');
check(safeModelId('~anthropic/claude-haiku-latest').startsWith('~'), 'alias id ok');
check(isSafeModelId('openai/gpt-4o-mini:free'), 'variant suffixes are legitimate');
for (const bad of [
  '../../admin',
  'deepseek/../../etc',
  'deepseek/model?key=x',
  'deepseek/model#frag',
  'https://evil.example/x',
  'deepseek',
  '/leading',
]) {
  rejects(() => safeModelId(bad), `path-unsafe model id: ${bad}`);
}

check(chapterNumber('3', 500) === 3, 'valid chapter number');
rejects(() => chapterNumber('abc', 500), 'non-numeric chapter');
rejects(() => chapterNumber('0', 500), 'chapter zero');
rejects(() => chapterNumber('-1', 500), 'negative chapter');
rejects(() => chapterNumber('501', 500), 'chapter beyond the cap');

// --- abuse limits ------------------------------------------------------
function refuses(fn: () => unknown, why: string): void {
  try {
    fn();
  } catch (err) {
    if (err instanceof LimitError) return;
    throw err;
  }
  throw new Error(`expected limit: ${why}`);
}

refuses(() => assertNovelAllowed(LIMITS_ABUSE.novelsPerAccount, undefined), 'novel cap reached');
assertNovelAllowed(LIMITS_ABUSE.novelsPerAccount - 1, undefined);
// Chapters are appended, not scattered.
assertChapterAllowed(4, 3, undefined);
refuses(() => assertChapterAllowed(5, 3, undefined), 'skipping ahead of the next chapter');
refuses(() => assertChapterAllowed(999_999, 3, undefined), 'sparse chapter far past the end');

// Concurrency slots must be released, including on the failure path.
const slots = [1, 2, 3].map(() => acquireGenerationSlot('u-test', undefined));
refuses(() => acquireGenerationSlot('u-test', undefined), 'fourth concurrent generation');
slots[0]();
slots[0](); // releasing twice must not free a second slot
acquireGenerationSlot('u-test', undefined)();
slots.slice(1).forEach((r) => r());

// Listed accounts (UNLIMITED_ACCOUNTS) bypass every limit — but only with a verified address.
process.env.UNLIMITED_ACCOUNTS = 'owner@example.com';
// Anyone can register any email, so matching the string alone would let a stranger
// claim the exemption by signing up as the owner.
check(isUnlimited('owner@example.com', true), 'verified owner is exempt');
check(isUnlimited('Owner@Example.com', true), 'exemption is case-insensitive');
check(!isUnlimited('owner@example.com', false), 'unverified owner address is NOT exempt');
check(!isUnlimited('owner@example.com'), 'exemption defaults to unverified');
check(!isUnlimited('someone-else@example.com', true), 'other accounts are not exempt');
check(!isUnlimited(undefined, true), 'a missing address is not exempt');

assertNovelAllowed(10_000, 'owner@example.com', true);
assertChapterAllowed(999_999, 3, 'owner@example.com', true);
for (let i = 0; i < 10; i++) acquireGenerationSlot('u-owner', 'owner@example.com', true);

// An unverified claim of the owner address gets the ordinary limits.
refuses(
  () => assertNovelAllowed(LIMITS_ABUSE.novelsPerAccount, 'owner@example.com', false),
  'unverified owner address still hits the novel cap'
);

// --- style dial --------------------------------------------------------
const styleKeys = Object.keys(NOVEL_STYLES) as StyleKey[];
check(styleKeys.length >= 4, `expected at least 4 styles, got ${styleKeys.length}`);

for (const key of styleKeys) {
  const prompt = buildSystemPrompt({ ...novel, style: key });
  const definition = NOVEL_STYLES[key];
  check(prompt.includes(definition.prompt), `style ${key} should reach the system prompt`);
  // Same cache-prefix rule as everything else in the system prompt.
  check(/chapter \d/i.test(prompt) === false, `style ${key} must not look like a chapter number`);
  check(definition.blurb.length > 0 && definition.examples.length > 0, `style ${key} needs UI copy`);
}

// The dial has to actually change the prompt, or it is decoration.
const uniquePrompts = new Set(styleKeys.map((k) => buildSystemPrompt({ ...novel, style: k })));
check(uniquePrompts.size === styleKeys.length, 'each style must produce a distinct system prompt');

// Novels created before styles existed have no key stored, and must not break.
check(
  buildSystemPrompt({ ...novel, style: undefined as unknown as StyleKey }).includes(
    NOVEL_STYLES[DEFAULT_STYLE].prompt
  ),
  'a missing style should fall back to the default'
);

// The picker payload must never leak the prompt text itself.
check(
  listStyles().every((s) => !('prompt' in s)),
  'style listing should not expose prompt text'
);

// --- hidden-novel vault ------------------------------------------------
// Crypto and token rules only; the Firestore-backed paths (lockout bookkeeping,
// unlock) need a database and are exercised by hand.

for (const good of ['1234', '00000', '987654']) {
  check(validPin(good) === good, `${good} should be a valid PIN`);
}
for (const bad of ['123', '1234567', '12a4', ' 1234', '', 1234, null, undefined]) {
  rejects(() => validPin(bad), `PIN ${JSON.stringify(bad)}`);
}

const vaultUid = 'u-vault';
const profile = await buildProfile('4821');

check(await pinMatches(profile, '4821'), 'the PIN that built the profile should match');
check(!(await pinMatches(profile, '4822')), 'a different PIN must not match');
check(!profile.pinHash.includes('4821'), 'the PIN itself must never be stored');

// Random salt per profile: the same PIN twice must not produce the same hash,
// or one leaked hash would identify every account using that PIN.
const twin = await buildProfile('4821');
check(twin.pinHash !== profile.pinHash, 'identical PINs should hash differently');
check(twin.tokenSecret !== profile.tokenSecret, 'each profile should sign with its own key');

const { token, expiresAt } = mintToken(profile, vaultUid);
check(tokenIsValid(profile, vaultUid, token), 'a fresh token should verify');
check(expiresAt > Date.now(), 'a fresh token should not be expired');

// A token is only good for the account, key and window it was minted for.
check(!tokenIsValid(profile, 'someone-else', token), 'a token must not work for another account');
check(!tokenIsValid(twin, vaultUid, token), 'a token must not survive a PIN change');
check(
  !tokenIsValid(profile, vaultUid, token, expiresAt + 1),
  'an expired token should be refused'
);
check(!tokenIsValid(profile, vaultUid, `${expiresAt}.` + 'A'.repeat(43)), 'forged signature');
check(!tokenIsValid(profile, vaultUid, 'not-a-token'), 'a malformed token should be refused');
// The expiry travels in the clear, so pushing it out has to break the signature.
check(
  !tokenIsValid(profile, vaultUid, token.replace(String(expiresAt), String(expiresAt + 3_600_000))),
  'an extended expiry should break the signature'
);

// Guessing is the attack a 4-digit PIN has to survive, so the lockout ladder is
// what carries the security — it must start at zero, then only ever grow.
check(lockoutFor(1) === 0 && lockoutFor(4) === 0, 'the first few attempts are free');
check(lockoutFor(5) > 0, 'the fifth wrong PIN should start locking out');
for (let n = 6; n <= 12; n++) {
  check(lockoutFor(n) >= lockoutFor(n - 1), `lockout must not shrink at attempt ${n}`);
}
check(lockoutFor(50) === lockoutFor(12), 'the ladder should cap rather than grow forever');
check(describeWait(45_000) === '45 seconds', 'sub-minute waits are counted in seconds');
check(describeWait(10 * 60_000) === '10 minutes', 'longer waits are rounded to minutes');

console.log('\nAll smoke tests passed.');
