# Novel Harness — frontend

A small, local-only web UI for the writing harness. Vite + React 18 + TypeScript. It has no router library, no CSS framework and no auth.

## Run

```bash
# 1. start the backend on :8787 (see ../backend)
# 2. then:
cd frontend
npm install
npm run dev        # http://localhost:5173, proxies /api and /files to :8787
```

`npm run build` type-checks and writes `dist/`. `npm run preview` serves that build.

Open **Settings** (bottom of the left rail) and paste an OpenRouter key. It is kept in `localStorage` and sent on every request as `X-OpenRouter-Key`. If you leave it blank, the header is not sent, so a key configured on the server is used. When the server answers "no key", a banner links back to Settings.

## Where things live

| UI | What it does | Server routes |
|---|---|---|
| Left rail | List novels, create one (title, premise, style, length, start hidden) | `GET/POST /api/novels`, `GET /api/styles` |
| **Write** tab | Chapter list. The composer handles direction, suggestions and the arc plan for the next chapter, and streams generation live. On a chapter you can hand-edit, revise, humanize (with a free defect check), run an inline edit on a selection, accept (runs the summary, suggestions, bible and map agents), restore a past version, or delete | `/chapters`, `/chapters/:n`, `/:n/generate`, `/:n/revise`, `/:n/humanize`, `/:n/humanize/preview`, `/:n/edit`, `/:n/accept`, `/:n/suggestions`, `/arcs/blueprint/:n` |
| **Bible** tab | Browse and filter entries, create by hand, add or remove facts, edit fields as JSON, delete, run the batch catch-up, change the mode | `/bible`, `/bible/:id`, `/bible/update` |
| **Characters** tab | Character designs: create blank or from a bible character, set state and steer, edit the sheet as JSON, run the AI assistant, check drift | `/designs`, `/designs/:id`, `/:id/assist`, `/:id/drift` |
| **Arcs** tab | Create an arc, edit its range, status, premise and steer, refine into beats, plan chapters (streamed), name the cast and accept it, apply an AI edit, see the braid report | `/arcs`, `/arcs/:id`, `/:id/refine`, `/:id/blueprints`, `/:id/cast`, `/:id/cast/accept`, `/:id/edit` |
| **Names** tab | Naming charter (edit as JSON, derive, reset), the name coiner, and a novel-wide rename with preview then apply | `/naming`, `/naming/charter`, `/naming/charter/derive`, `/naming/coin`, `/naming/rename/preview`, `/naming/rename` |
| **Atlas** tab | The server-rendered SVG map. Catch up from chapters, dictate geography, draw a sketch (PNG plus labelled shapes), rename or pin places, reset | `/maps?theme=dark`, `/maps/update`, `/maps/dictate`, `/maps/sketch`, `/maps/entities/:id`, `DELETE /maps` |
| **Power** tab | Power systems: AI design from a questionnaire (streamed), create blank, refine, edit as JSON, delete | `/power`, `/power/generate`, `/power/:id`, `/power/:id/refine` |
| **Settings** tab (novel) | Title, premise, style notes, model, length, every agent mode, cover (generate, upload, remove), hide in the vault, export, delete | `PATCH/DELETE /api/novels/:id`, `/export`, `/cover`, `/cover/generate` |
| Settings modal | OpenRouter key, default model, export everything | `GET /api/account/export` |
| Vault panel | Set, change or remove the PIN, unlock or lock, open hidden novels | `/api/vault`, `/vault/pin`, `/vault/unlock`, `/vault/novels` |

All per-novel routes are under `/api/novels/:novelId`. Streaming calls are POSTs read with `fetch` and a `ReadableStream` (`src/lib/api.ts → streamPost`). The live view (`StreamPanel`) shows streamed prose, trace lines, reasoning, warnings and summed cost and token usage.

## Code map

- `src/lib/api.ts`: fetch wrapper, SSE reader, settings storage, the no-key event
- `src/lib/useStream.ts`: the state for one running agent call
- `src/lib/router.ts`: hash router (`#/n/<id>/<tab>`)
- `src/components/`: rail, workspace shell, modals, shared bits (`JsonEditor`, `StreamPanel`, …)
- `src/tabs/`: one file per workspace tab
- `src/styles.css`: the entire stylesheet
