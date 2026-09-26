# webnovel-harness

**An open-source, local harness for writing web novels chapter by chapter with LLMs.**

📄 Companion paper: [*Choosing Affordable Language Models for Serial Fiction*](https://zenodo.org/records/22977925) (DOI [10.5281/zenodo.22977925](https://doi.org/10.5281/zenodo.22977925))

This is the same generation backend that runs our hosted web-novel app, extracted so that any
author can run it on their own machine. You get the same agents, prompts, story-memory tools,
and cost optimisations. You supply one thing: **an [OpenRouter](https://openrouter.ai) API key**.

- **Local by default.** No accounts, no cloud database, no telemetry. Every novel, bible entry,
  arc, map and cover is a plain JSON/image file under `./data/`, so you can read it, back it up, or put it in git.
- **Bring your own key, bring your own model.** Any chat model on OpenRouter works (DeepSeek, GLM,
  Qwen, Gemini, Claude, GPT, Grok, etc.). You pay OpenRouter directly for what you use and nothing else.
- **Batteries included.** A web UI ships in `frontend/`. The HTTP API is also documented by its
  routes, so you can script it or build your own client.

---

## Quick start

Requirements: **Node.js 20+**.

```bash
git clone https://github.com/vamshibobby/webnovel-harness.git
cd webnovel-harness
npm run setup                 # installs backend + frontend deps
cp .env.example .env          # optional: put OPENROUTER_API_KEY here

# two terminals:
npm run dev:api               # API on http://localhost:8787
npm run dev:ui                # UI  on http://localhost:5173  ← open this
```

Open <http://localhost:5173>, click **Settings**, paste your OpenRouter key, create a novel, and
generate chapter 1.

**Single-process mode:** `npm run build && npm start` serves the UI and API together at
<http://localhost:8787>.

**Where is my key stored?** Keys pasted in the UI stay in your browser's `localStorage` and are sent
to your local server with each request, which forwards them to OpenRouter. Alternatively, set
`OPENROUTER_API_KEY` in `.env` and the server uses it whenever the UI doesn't send one. The key never
goes anywhere except `openrouter.ai`.

---

## Why use this harness instead of a chat window

Writing a 100-chapter serial with a raw chat window falls apart in predictable ways. The model forgets who
people are, contradicts chapter 12 in chapter 40, re-sends the whole book every turn, and burns
money doing it. This harness is built around those failure modes.

### 💸 Prefix caching (the big cost saver)

Every chapter request is assembled so that **almost all of it is byte-identical to the previous
request**, and providers bill that repeated prefix at their discounted *cached-input* rate instead of full price.

- **A stable system prompt.** Premise, style, naming charter and craft rules never mention the current chapter
  number, so the system prompt is identical for every chapter of a novel.
- **Append-only chapter history.** Each previous chapter is its own message block. When chapter
  N is added, blocks 1…N-1 don't change, so the provider reuses its cached copy rather than
  re-reading the whole novel.
- **Per-chapter instructions go last**, after the cacheable prefix.
- **Explicit cache breakpoints where needed.** Anthropic and Qwen only cache where you mark
  `cache_control`, so the harness places the breakpoints itself. Anthropic gets the 1-hour TTL,
  because writing sessions are long and sparse. OpenAI, DeepSeek, Grok, Gemini, Moonshot and Z.AI
  cache automatically. Gemini is deliberately *not* sent explicit breakpoints, because those bill
  hourly storage.
- **Provider pinning.** Requests for a model are pinned to one upstream provider, so repeat calls hit
  the *same* provider's cache instead of being load-balanced onto a cold one. The pin is dropped on
  the final retry, because a cache miss beats a failed chapter.
- **Guarded by tests.** The `*.invariant.ts` suites fail the build if a change would put
  per-chapter content into the cached prefix.

By chapter 30 the prefix is tens of thousands of tokens and the new, uncached part of each request
is a few hundred. Cached input is billed at a fraction of the normal rate: roughly 10% on Anthropic,
with automatic discounts on DeepSeek, OpenAI and Gemini. **Most of each request's input is therefore
billed at the cached rate**, which is where the savings come from on long novels.

### 🧠 Auto-summarization and context compaction

When you **accept** a chapter, a model writes a compact summary of it and stores it with the
chapter. At generation time, the context works like a coding agent's. The newest chapters go in as
full text up to a ~60k-token budget, and older chapters fall back to their stored summaries. The
model always sees recent prose verbatim and the whole arc in outline, and the prompt never grows
without bound. When compaction first kicks in, the cache is invalidated once at that point and
rebuilds on the next request.

### 📖 Story bible, used through tool calls

The story bible is structured canon: characters, factions, locations, items, techniques,
creatures, events and concepts, each with aliases and chapter-sourced facts. It isn't stuffed into
the prompt. The writing agent gets **tools** instead:

- `search_story_bible`: search by name, alias or content (titles and nicknames are stored as aliases)
- `get_story_bible_entries`: fetch full entries by id
- `search_previous_chapters`: grep earlier chapters for exact phrasing and events

The model looks things up *when a scene needs them*, so a 200-entry bible costs nothing on
chapters that don't touch it. After each accepted chapter, a bible agent reads the chapter and
**upserts** entries through a schema-enforced `upsert_story_bible_entry` tool. It records new people
and new facts, each tagged with its source chapter. Deleting a chapter removes the facts it
introduced and renumbers the rest.

### 🎭 Character consistency

- **Character design sheets** hold each character's essentials (role, age, appearance, voice),
  motivation (want, need, fear, lie), personality, history and secrets, arcs and relationships.
  There is one *active* sheet per character, linked to the character's bible entry. The writer reads them through
  `get_character_design`, and a design agent keeps them updated with `update_character_design`.
- **Drift detection** (`report_drift`) compares a chapter against the active sheets and flags
  where a character drifted in voice, motivation, personality, arc, relationships, history,
  essentials or status. For example: a stoic character suddenly bubbly, a relationship that reset,
  or a secret revealed too early.
- **The naming charter** keeps a world's names sounding like one world, per culture. Names are coined
  deterministically, with real-name corpora for people and a cliché blocklist applied *before* the
  model ever sees candidates. A **rename cascade** updates a name across the bible, sheets, arcs,
  map and every chapter's prose in one step.

### Everything else the backend does

| Feature | What it does |
|---|---|
| **Arcs & blueprints** | Plan an arc, stream per-chapter blueprints, resolve the cast for them, refine or edit, and braid plot threads so each is checked, not just intended |
| **Next-chapter suggestions** | `propose_directions` offers a few distinct directions from the current ending |
| **Inline edit & revise** | Rewrite a selection or a whole chapter from a note, with the diff kept |
| **Humanizer** | Deterministic detection of measurable prose tells (dash rate, trailing dialogue, preamble) against ranges measured from published fiction, followed by a targeted model repair loop that stops on measured progress |
| **Atlas** | A world map built from geographic facts in the text (`upsert_geofacts`), solved into a consistent layout and rendered as SVG. You can dictate or sketch corrections |
| **Power systems** | Structured cultivation/magic ladders, ranks, costs and regional variants, linked to bible entries |
| **Covers** | Optional AI covers via OpenRouter image models (~$0.015 each), or upload your own |
| **Vault** | Hide novels behind a local PIN (scrypt-hashed, with exponential lockout) |
| **Export** | Markdown per novel, or a full JSON export of everything |

---

## The research paper

This harness comes with a companion study that evaluates **which affordable models to use for which
job, under which conditions**:

> **Choosing Affordable Language Models for Serial Fiction: Instruction Following, Creative
> Writing, and Story Memory**
>
> Sai Vamshi Atukuri, 2026. 📄 **[Read the paper on Zenodo](https://zenodo.org/records/22977925)**,
> DOI [10.5281/zenodo.22977925](https://doi.org/10.5281/zenodo.22977925)

The study compares six models priced **below $1 per million input and output tokens** across 687
chapter-generation attempts. It varies instruction detail, output constraints, reasoning settings,
story bibles, retrieval, history compression, and sequential continuation. Some findings:

- Detailed prose instructions raised reference-event coverage from **4.7% (vague direction) to
  90.7%**. Numbering the same instructions made no consistent difference.
- **Tencent Hy3 had the lowest cost per usable draft (about $0.0011)** and was the most reliable
  writer. Gemini 2.5 Flash-Lite was the fastest. DeepSeek V3.2 led the detailed-instruction checks,
  and GLM 5.3 Flash was the most balanced creative-scene candidate.
- Story-bible updates bring their own risks, such as retained contradictions and unexecuted repairs.
  That is why the harness validates both chapters *and* memory updates.
- Recommendation: **pick models by role** (writer, bible-keeper, summarizer), and specify causal
  requirements separately from creative freedom.

| Model | OpenRouter slug | $/M input | $/M output | Cost per usable draft |
|---|---|---|---|---|
| Tencent Hy3 | `tencent/hy3` | 0.132 | 0.528 | $0.0011 |
| Gemini 2.5 Flash-Lite | `google/gemini-2.5-flash-lite` | 0.100 | 0.400 | $0.0013 |
| Xiaomi MiMo v2.5 | `xiaomi/mimo-v2.5` | 0.140 | 0.280 | $0.0018 |
| DeepSeek V4 Flash | `deepseek/deepseek-v4-flash-0731` | 0.030 | 0.320 | $0.0020 |
| GLM 5.3 Flash | `z-ai/glm-5.3-flash` | 0.045 | 0.140 | $0.0026 |
| DeepSeek V3.2 | `deepseek/deepseek-v3.2` | 0.269 | 0.400 | $0.0028 |

*Prices as listed at the time of the study. Cost per usable draft is from the 144-attempt
instruction-design comparison and includes failed calls and tool rounds.*

These are practical starting points from a single-novel study, not a universal literary ranking.
Paste any of these slugs as a novel's model to try them in the harness.

If you use the harness or the findings, please cite:

```bibtex
@misc{atukuri2026affordable,
  author    = {Atukuri, Sai Vamshi},
  title     = {Choosing Affordable Language Models for Serial Fiction: Instruction Following, Creative Writing, and Story Memory},
  year      = {2026},
  publisher = {Zenodo},
  doi       = {10.5281/zenodo.22977925},
  url       = {https://zenodo.org/records/22977925}
}
```

---

## Layout

```
backend/            Hono + TypeScript API (Node 20+)
  src/engine/       agents, prompt assembly (context.ts), caching (cache.ts), OpenRouter client,
                    humanizer/, naming/, map/
  src/routes/       HTTP surface, one file per resource
  src/lib/          validators, local JSON store (store.ts, localdb.ts), vault, limits
frontend/           Vite + React UI (a lightweight reference client)
data/               your novels (created on first run, gitignored)
```

Storage is a folder of JSON documents (see `backend/src/lib/localdb.ts`). Writes are atomic
(temp file, then rename), and every read-modify-write runs synchronously in the single server
process, so the agents' concurrent updates can't clobber each other. To use a real database instead,
reimplement `backend/src/lib/store.ts`. Nothing above it knows where the data lives.

## Tests

```bash
npm test          # backend: 900+ offline checks, no network, no key
```

This covers the agents' tool-call validation, prompt-cache invariants, arc planning, naming, the map
solver, the humanizer, retries, and the local store.

## Configuration

All settings are optional and go in `.env` (see `.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `OPENROUTER_API_KEY` | none | Server-side fallback key (the UI's key wins) |
| `DATA_DIR` | `./data` | Where everything is stored |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | API bind address |
| `APP_URL` / `APP_TITLE` | none | Optional OpenRouter app attribution headers |
| `EXTRA_CORS_ORIGINS` | none | Extra browser origins allowed to call the API |

The server binds to `127.0.0.1` and has **no authentication**, because it is meant for one author on
one machine. Don't expose it to a network without putting your own auth in front of it.

## License

MIT. See [LICENSE](LICENSE). The bundled name corpus is derived from Wikidata (CC0), and the vendored
d3-delaunay/delaunator code is ISC-licensed.
