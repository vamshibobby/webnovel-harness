# Canon, recovery, and editing controls

This batch implements recommendations 1, 4, 5, 6, and 7 from the harness review in both the hosted app and the local harness.

## Canon and character knowledge

Open **Canon and memory** on a chapter to preview extraction. Previewing uses the configured canon model and stores a proposal without changing the bible. Accept the chapter before approving its proposal. Status changes, changed attributes or relationships, supersession, and power-system updates require review. Evidenced additions can be applied automatically during upkeep. Approval checks the exact proposal, source text revision, and current entries; a stale proposal must be extracted again.

Character entries distinguish **knows**, **believes**, **unaware**, and **secret**. Each record identifies when and how the character learned it and includes supporting evidence. Author corrections preserve the earlier record in the canon history. A character's beliefs are separate from world truth in writing context.

Editing an accepted chapter saves immediately, including without an API key. It invalidates derived summaries, proposals, and chapter-derived bible changes from that point forward. Author bible edits survive. Use **Refresh memory / retry upkeep**, then catch up or review later affected chapters. Legacy mutable state whose source cannot be reconstructed is cleared and flagged for review, rather than retaining an unsupported status. Power systems touched by affected extraction are flagged and excluded from writing context until their details are reviewed and saved. Map reconciliation continues to use the existing atlas tools; broader map revision support belongs to the next map batch.

## Jobs and recovery

**Jobs and recovery** shows running, interrupted, cancelled, and failed generation or upkeep. A draft checkpoints partial prose during streaming. **Stop job** cancels the server request; **Resume from checkpoint** uses that prose to request a complete chapter. A resumed model can rewrite wording, so review its output. Generated text cannot overwrite a chapter changed since the job began.

Upkeep checkpoints summary, suggestions, canon, and map stages separately. Retrying skips completed work for the same source text. A pending canon proposal pauses upkeep for review. Repeated acceptance of completed upkeep does not repeat model calls.

Execution belongs to the open request. A lost connection or server restart leaves a recoverable checkpoint; it does not start an unattended worker. A running lease expires after 30 seconds. A resumed request supplies the API key again; keys are not stored in jobs. Checkpoints are periodic, so a sudden process failure can lose the last few seconds. Local storage uses a write-ahead journal for multi-document chapter and canon commits; it remains a single-server-process store.

## Models and scene editing

Novel settings now include **Models by role**. Set a primary model, a fallback, an output ceiling, and an optional spending limit for each role. Blank settings preserve defaults. The writer's session selection takes precedence. Fallbacks run before output begins, never halfway through emitted prose. Authentication and credit failures are not retried on another model.

Spending limits are checked between calls, including resumed jobs. An individual call can exceed the limit. If a completed call omits cost, a configured limit pauses subsequent calls instead of treating that cost as zero. Generation records show actual reported model/provider, token usage, cost (or unknown), duration, prompt version, and prompt hash. They do not contain the key or a copy of the prompt.

Selected passages up to 20,000 characters support tension, voice, and clarity edits alongside existing actions. Keep up to five alternatives for a selection, specify facts to preserve, and review the replacement before applying it. A separate checker warns about possible changes to protected facts. Voice samples, genre/register, and optional prose-check exclusions are saved per novel.

Manual chapter edits are backed up in device storage. Reloading offers **Restore local draft** or **Discard local draft**. A draft based on an older server version is identified; saving uses a version check to avoid silently replacing another tab's changes. Browser storage can be cleared by the browser and is not a substitute for exports.

## Next batch

The [roadmap epic](https://github.com/vamshibobby/webnovelgen/issues/153) links the remaining review recommendations. The user explicitly deferred [map generation and editing](https://github.com/vamshibobby/webnovelgen/issues/151) and [inline chapter maps and journey animations](https://github.com/vamshibobby/webnovelgen/issues/152).

## Verification

`backend/src/harness.test.ts` covers canon replay, evidence, beliefs, role isolation, fallbacks, and budget checks. The local harness additionally runs `backend/src/harnessStore.test.ts` against temporary storage and mocked OpenRouter responses, covering public routes, stale writes, journal recovery, canon review, generation, and idempotent upkeep. Both are included in their backend's normal offline test command.

Manual browser verification uses isolated sample data and fake model responses. It covers canon preview/approval, accepted edits, device draft recovery, persistent role/voice preferences, and authored beliefs. No paid model evaluation is part of these checks.
