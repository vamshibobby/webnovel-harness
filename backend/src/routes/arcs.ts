import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { runArcEdit, runArcRefine, runBlueprints } from '../engine/arcAgent.js';
import {
  formatCastBlock,
  runCastPass,
  substituteCast,
  type CastAssignment,
  type CastPassResult,
} from '../engine/arcCast.js';
import { loadCharter, namingOn, takenNames } from '../engine/naming/load.js';
import { OpenRouterError } from '../engine/openrouter.js';
import type { AuthEnv } from '../lib/authMiddleware.js';
import { NO_KEY_MESSAGE, openRouterKey } from '../lib/apiKey.js';
import {
  ARC_LIMITS,
  ArcValidationError,
  applyArcPatch,
  authorPremiseText,
  emptyArc,
  firstUnplannedChapter,
  slugifyArcTitle,
  validateArcPatch,
} from '../lib/arcValidate.js';
import { markStage, mergeBatch, mergeBraid, mergeRefine, mergeThreads, stageFailed, stageOk, stagePartial } from '../lib/arcStages.js';
import { extractThreadSeeds } from '../engine/arcThreads.js';
import { validateBraid } from '../engine/arcBraid.js';
import { BIBLE_LIMITS } from '../lib/bibleValidate.js';
import * as store from '../lib/store.js';
import { BIBLE_ENTRY_TYPES, type BibleEntryType, type Chapter, type Novel, type StoryArc } from '../lib/types.js';
// Hidden novels answer "not found" without an unlocked vault; an arc plan is
// as private as the novel it belongs to.
import { loadAccessibleNovel } from '../lib/vault.js';
import { apiError } from '../lib/validate.js';

export const arcRoutes = new Hono<AuthEnv>();

const OFF_MESSAGE = 'Arc planning is turned off for this novel. Enable it in novel settings first.';

/**
 * Everything an arc agent needs to know about the world it is planning in.
 * Off means no read at all, so a novel that never opted in pays nothing.
 */
async function loadWorld(novel: Novel, arc: StoryArc) {
  const chapters = await store.getAllChapters(novel.id);
  const [bibleEntries, designs] = await Promise.all([
    (novel.bibleMode ?? 'accept') === 'off' ? [] : store.listBibleEntries(novel.id),
    (novel.designMode ?? 'off') === 'off'
      ? []
      : store.listDesigns(novel.id).then((all) => all.filter((d) => d.state === 'active')),
  ]);
  const writtenInArc = chapters.filter(
    (ch) => ch.number >= arc.fromChapter && ch.number <= arc.toChapter && ch.status === 'accepted'
  );
  return { chapters, bibleEntries, designs, writtenInArc };
}

/**
 * Run the cast pass over a set of blueprints and hand back a proposal.
 *
 * Not gated on namingMode — the generator behind the names is local code, and
 * knowing who is in your own plan is a data-integrity question, the argument
 * rename.ts already makes for itself. Not gated on bibleMode either: the bible
 * is only read here to MATCH against, so with it off every entity is simply new
 * and the pass still does its job.
 */
async function castPass(
  novel: Novel,
  arc: StoryArc,
  batch: StoryArc['blueprints'],
  apiKey: string | null,
  signal: AbortSignal,
  emit: (message: string) => void
): Promise<CastPassResult | null> {
  if (batch.length === 0) return null;

  const [charter, bibleEntries, designs] = await Promise.all([
    loadCharter(novel),
    (novel.bibleMode ?? 'accept') === 'off' ? [] : store.listBibleEntries(novel.id),
    (novel.designMode ?? 'off') === 'off'
      ? []
      : store.listDesigns(novel.id).then((all) => all.filter((d) => d.state === 'active')),
  ]);

  return runCastPass({
    apiKey,
    novel,
    arc,
    charter,
    batch,
    bibleEntries,
    designs,
    taken: takenNames({ bible: bibleEntries, designs, novel }),
    signal,
    emit: (event) => {
      if (event.type === 'trace') emit(String(event.data));
    },
  });
}

/**
 * Reading is always allowed, even with the feature off, so the screen can
 * explain itself and offer to turn it on rather than 404ing at someone who
 * followed a link. Same contract as designs and the Atlas.
 */
arcRoutes.get('/', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  return c.json({
    arcs: await store.listArcs(novel.id),
    arcMode: novel.arcMode ?? 'off',
    /** What the UI needs to show overrun and to know where planning starts. */
    chapterCount: novel.chapterCount ?? 0,
  });
});

arcRoutes.post('/', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  if ((novel.arcMode ?? 'off') === 'off') return c.json({ error: OFF_MESSAGE }, 400);

  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return c.json({ error: 'An arc needs a title.' }, 400);

    if ((await store.countArcs(novel.id)) >= ARC_LIMITS.arcsPerNovel) {
      return c.json({ error: `This novel is at its ${ARC_LIMITS.arcsPerNovel}-arc limit.` }, 400);
    }
    const id = slugifyArcTitle(title);
    if (await store.getArc(novel.id, id)) {
      return c.json({ error: `An arc called “${title}” already exists. Edit that one instead.` }, 409);
    }

    const existing = await store.listArcs(novel.id);
    // A new arc starts where the last one ended, which is the common case and
    // saves the author typing the boundary twice.
    const defaultFrom = existing.length > 0 ? Math.max(...existing.map((a) => a.toChapter)) + 1 : 1;
    const arc = emptyArc(id, title.slice(0, ARC_LIMITS.title), existing.length + 1, defaultFrom);
    const patch = validateArcPatch(
      Object.fromEntries(
        Object.entries(body).filter(([k]) => k !== 'title')
      ) as Record<string, unknown>
    );
    const saved = await store.transactArc(novel.id, id, () => applyArcPatch(arc, patch));
    return c.json({ arc: saved });
  } catch (err) {
    if (err instanceof ArcValidationError) return c.json({ error: err.message }, 400);
    return apiError(c, err);
  }
});

arcRoutes.patch('/:arcId', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  if ((novel.arcMode ?? 'off') === 'off') return c.json({ error: OFF_MESSAGE }, 400);

  try {
    const arcId = c.req.param('arcId');
    const existing = await store.getArc(novel.id, arcId);
    if (!existing) return c.json({ error: 'No such arc.' }, 404);
    const patch = validateArcPatch(await c.req.json<Record<string, unknown>>());
    const arc = await store.transactArc(novel.id, arcId, (current) =>
      applyArcPatch(current ?? existing, patch)
    );
    return c.json({ arc });
  } catch (err) {
    if (err instanceof ArcValidationError) return c.json({ error: err.message }, 400);
    return apiError(c, err);
  }
});

arcRoutes.delete('/:arcId', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  await store.deleteArc(novel.id, c.req.param('arcId'));
  return c.json({ ok: true });
});

/**
 * Plan a batch of chapters, streaming one blueprint per SSE event.
 *
 * The per-item contract is the map catch-up's: emit progress before the work,
 * and persist each blueprint as it lands so an aborted run keeps everything it
 * already planned rather than starting over.
 */
arcRoutes.post('/:arcId/blueprints', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  if ((novel.arcMode ?? 'off') === 'off') return c.json({ error: OFF_MESSAGE }, 400);
  const apiKey = openRouterKey(c);
  if (!apiKey) return c.json({ error: NO_KEY_MESSAGE }, 400);

  const arcId = c.req.param('arcId');
  const arc = await store.getArc(novel.id, arcId);
  if (!arc) return c.json({ error: 'No such arc.' }, 404);

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const count = Math.min(
    ARC_LIMITS.batchSize,
    Math.max(1, Number(body.count) || ARC_LIMITS.batchSize)
  );

  const chapters = await store.getAllChapters(novel.id);
  const lastWritten = chapters.reduce((max, ch) => Math.max(max, ch.number), 0);
  const requested = Number(body.from);
  const from = Number.isFinite(requested) && requested > 0 ? requested : firstUnplannedChapter(arc, lastWritten);

  /*
   * Planning is gated on the arc having been refined into beats. A plan built
   * from three vague lines is fifty vague chapters, and the author only finds
   * that out by reading all fifty.
   */
  if (arc.beats.length === 0) {
    return c.json(
      { error: 'Refine this arc first — planning works from its beats, and it has none yet.' },
      400
    );
  }

  if (from > arc.toChapter) {
    return c.json(
      { error: `Chapter ${from} is past the end of this arc. Extend the arc first, or start the next one.` },
      400
    );
  }

  /*
   * Chapters this arc covers that are already written. An author planning late
   * puts arc 2 at "21 onwards" while sitting on chapter 30, so ten of its
   * chapters exist before it has a single blueprint — and they are what the
   * arc has actually spent.
   */
  const writtenInArc = chapters.filter(
    (ch): ch is Chapter => ch.number >= arc.fromChapter && ch.number < from && ch.status === 'accepted'
  );
  const runUp = chapters
    .filter((ch) => ch.number < arc.fromChapter && ch.status === 'accepted')
    .slice(-8);

  const bibleEntries = (novel.bibleMode ?? 'accept') === 'off' ? [] : await store.listBibleEntries(novel.id);
  const designs =
    (novel.designMode ?? 'off') === 'off'
      ? []
      : (await store.listDesigns(novel.id)).filter((d) => d.state === 'active');

  c.header('X-Accel-Buffering', 'no');
  c.header('Cache-Control', 'no-cache, no-transform');

  return streamSSE(c, async (stream) => {
    const controller = new AbortController();
    stream.onAbort(() => controller.abort());

    try {
      await stream.writeSSE({
        event: 'progress',
        data: JSON.stringify({ from, to: Math.min(from + count - 1, arc.toChapter), total: count }),
      });

      const result = await runBlueprints({
        apiKey,
        novel,
        arc,
        writtenInArc,
        runUp,
        bibleEntries,
        designs,
        from,
        count: Math.min(count, arc.toChapter - from + 1),
        signal: controller.signal,
        onBlueprint: (bp) => {
          void stream.writeSSE({ event: 'blueprint', data: JSON.stringify(bp) });
        },
        emit: (event) => {
          void stream.writeSSE({ event: 'trace', data: JSON.stringify(event.data) });
        },
      });

      // Persisted once the batch closes rather than per blueprint: they arrive
      // within seconds of each other, and one transaction cannot interleave
      // with an author editing beats in another tab halfway through. Stage D
      // runs inside the same transaction as a pure function of what was just
      // merged, so its report can never describe an arc that no longer exists.
      const saved = await store.transactArc(novel.id, arcId, (current) => {
        const withBatch = markStage(
          mergeBatch(current ?? arc, result.blueprints),
          'plan',
          result.issues.length
            ? stagePartial(`${result.issues.length} block${result.issues.length === 1 ? '' : 's'} came back unusable.`)
            : stageOk()
        );
        return mergeBraid(withBatch, validateBraid(withBatch));
      });

      if (result.usage.promptTokens > 0) {
        await stream.writeSSE({ event: 'usage', data: JSON.stringify(result.usage) });
      }

      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({ arc: saved, planned: result.blueprints.length, issues: result.issues }),
      });
    } catch (err) {
      console.error(`[arc:blueprints] failed novel=${novel.id} arc=${arcId}:`, err);
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify(err instanceof Error ? err.message : 'The planner failed.'),
      });
    }
  });
});

/**
 * Name the cast of chapters already planned.
 *
 * The backfill for arcs planned before this existed, and the re-run after an
 * AI edit changes who is in a chapter. Batched at the same size as planning, so
 * a fifty-chapter arc is five short reviews rather than one sixty-row wall; the
 * button re-arms until nothing is left.
 */
arcRoutes.post('/:arcId/cast', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  if ((novel.arcMode ?? 'off') === 'off') return c.json({ error: OFF_MESSAGE }, 400);
  const arcId = c.req.param('arcId');
  const arc = await store.getArc(novel.id, arcId);
  if (!arc) return c.json({ error: 'No such arc.' }, 404);

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const from = Number(body.from);
  const written = novel.chapterCount ?? 0;
  // Written chapters are excluded: their roles are prose now, and changing a
  // name there is the rename cascade's job rather than this one's.
  const ahead = arc.blueprints
    .filter((b) => b.chapter > written)
    .filter((b) => (Number.isFinite(from) && from > 0 ? b.chapter >= from : true))
    .sort((a, b) => a.chapter - b.chapter);
  // Chapters with no cast first, but a re-run over resolved ones is allowed —
  // an AI edit changes who is in a chapter, and this is how it gets re-read.
  const unresolved = ahead.filter((b) => !b.cast?.length);
  const pending = (unresolved.length ? unresolved : ahead).slice(0, ARC_LIMITS.batchSize);

  if (!pending.length) {
    return c.json({ error: 'There are no planned chapters ahead of the story to read.' }, 400);
  }

  c.header('X-Accel-Buffering', 'no');
  c.header('Cache-Control', 'no-cache, no-transform');

  return streamSSE(c, async (stream) => {
    const controller = new AbortController();
    stream.onAbort(() => controller.abort());
    try {
      const result = await castPass(novel, arc, pending, openRouterKey(c), controller.signal, (message) => {
        void stream.writeSSE({ event: 'trace', data: JSON.stringify(message) });
      });
      if (result?.usage.promptTokens) {
        await stream.writeSSE({ event: 'usage', data: JSON.stringify(result.usage) });
      }
      if (result) await stream.writeSSE({ event: 'cast', data: JSON.stringify(result.proposal) });
      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({ remaining: Math.max(0, unresolved.length - pending.length) }),
      });
    } catch (err) {
      console.error(`[arc:cast] failed novel=${novel.id} arc=${arcId}:`, err);
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify(err instanceof Error ? err.message : 'Naming the cast failed.'),
      });
    }
  });
});

interface AcceptRow {
  entryId: string | null;
  name: string;
  kind: BibleEntryType;
  role: string;
  brief: string;
  mentions: string[];
  chapters: number[];
}

function acceptRows(input: unknown): AcceptRow[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item): AcceptRow | null => {
      if (typeof item !== 'object' || item === null) return null;
      const row = item as Record<string, unknown>;
      const name = String(row.name ?? '').trim().slice(0, BIBLE_LIMITS.name);
      if (!name) return null;
      const kind = String(row.kind ?? 'character') as BibleEntryType;
      return {
        entryId: typeof row.entryId === 'string' && row.entryId.trim() ? row.entryId.trim() : null,
        name,
        kind: BIBLE_ENTRY_TYPES.includes(kind) ? kind : 'character',
        role: String(row.role ?? '').trim().slice(0, ARC_LIMITS.castMention),
        brief: String(row.brief ?? '').trim().slice(0, BIBLE_LIMITS.summary),
        mentions: (Array.isArray(row.mentions) ? row.mentions : [])
          .map((m) => String(m).trim())
          .filter(Boolean)
          .slice(0, 8),
        chapters: (Array.isArray(row.chapters) ? row.chapters : [])
          .map((n) => Math.round(Number(n)))
          .filter((n) => Number.isFinite(n) && n > 0),
      };
    })
    .filter((r): r is AcceptRow => r !== null && r.chapters.length > 0)
    .slice(0, ARC_LIMITS.castPerBatch);
}

interface AcceptContext {
  chapter: number;
  reveals: string[];
  future: string[];
}

function acceptContext(input: unknown): AcceptContext[] {
  if (!Array.isArray(input)) return [];
  const lines = (value: unknown): string[] =>
    (Array.isArray(value) ? value : [])
      .map((v) => String(v).trim().slice(0, ARC_LIMITS.contextLine))
      .filter(Boolean)
      .slice(0, ARC_LIMITS.contextPerBlueprint);
  return input
    .map((item): AcceptContext | null => {
      if (typeof item !== 'object' || item === null) return null;
      const row = item as Record<string, unknown>;
      const chapter = Math.round(Number(row.chapter));
      if (!Number.isFinite(chapter) || chapter < 1) return null;
      return { chapter, reveals: lines(row.reveals), future: lines(row.future) };
    })
    .filter((r): r is AcceptContext => r !== null)
    .slice(0, ARC_LIMITS.batchSize);
}

/**
 * Accept a cast proposal: the only path that writes anything.
 *
 * Everything before this is a suggestion the author can walk away from, which
 * is what makes "nothing is saved until you accept" structural rather than a
 * convention. The substitution is re-derived here from the phrases and the
 * chosen name, never taken from the client: one implementation of a text
 * rewrite, and a buggy tab cannot post arbitrary prose into a plan.
 *
 * It writes to the ARC and nowhere else. An earlier version created story bible
 * entries here, marked "planned", and that was wrong on both counts — the bible
 * is the record of what reached the page, so filling it with forecasts corrupts
 * what every other agent reads as canon, and the marker went stale the moment
 * the bible agent declined to record a minor character. The bible is written
 * after a chapter is generated, as it always was; the plan carries its own cast.
 */
arcRoutes.post('/:arcId/cast/accept', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  if ((novel.arcMode ?? 'off') === 'off') return c.json({ error: OFF_MESSAGE }, 400);

  const arcId = c.req.param('arcId');
  const arc = await store.getArc(novel.id, arcId);
  if (!arc) return c.json({ error: 'No such arc.' }, 404);

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const rows = acceptRows(body.members);
  const context = acceptContext(body.context);
  if (!rows.length && !context.length) return c.json({ error: 'Nothing to accept.' }, 400);

  const entries =
    (novel.bibleMode ?? 'accept') === 'off' ? [] : await store.listBibleEntries(novel.id);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const byName = new Map(entries.map((e) => [e.name.toLowerCase(), e]));

  const assignments: CastAssignment[] = rows.map((row) => {
    // An author who types a name the bible already has has told us this is that
    // entity — worth recording as the join so the import block can enrich it.
    const existing = row.entryId ? byId.get(row.entryId) : byName.get(row.name.toLowerCase());
    return {
      name: existing?.name ?? row.name,
      note: row.role || row.brief,
      ...(existing ? { entryId: existing.id } : {}),
      mentions: row.mentions,
      chapters: row.chapters,
    };
  });

  const byChapter = new Map(context.map((c2) => [c2.chapter, c2]));
  const skipped: number[] = [];
  const saved = await store.transactArc(novel.id, arcId, (current) => {
    const base = current ?? arc;
    const blueprints = base.blueprints.map((bp) => {
      const { blueprint, substituted, attempted } = substituteCast(bp, assignments);
      // There were phrases to replace and none of them were there any more: the
      // author edited this chapter while the panel was open. It still gets its
      // cast — losing the whole accept over one moved sentence would be the
      // worse failure — and the chapter is named in the response so the UI can
      // say which ones to look at.
      if (attempted > 0 && substituted === 0 && !skipped.includes(bp.chapter)) {
        skipped.push(bp.chapter);
      }
      const ctx = byChapter.get(bp.chapter);
      if (!ctx) return blueprint;
      return {
        ...blueprint,
        ...(ctx.reveals.length ? { reveals: ctx.reveals } : {}),
        ...(ctx.future.length ? { futureContext: ctx.future } : {}),
      };
    });
    return { ...base, blueprints, updatedAt: Date.now() };
  });

  console.log(
    `[cast:accept] novel=${novel.id} arc=${arcId} rows=${rows.length} context=${context.length} skipped=${skipped.length}`
  );
  return c.json({ arc: saved, named: rows.length, skipped });
});

/**
 * The blueprint for one chapter, for the composer to import.
 *
 * Cheap and keyless like GET /:n/suggestions, and answers for the chapter the
 * client is looking at rather than making it find the owning arc first.
 *
 * `castBlock` is built here rather than stored, because a plan written at
 * chapter 12 and used at chapter 34 should describe the characters the reader
 * actually has by then. The extra reads happen only when the blueprint has a
 * cast, so the cheap keyless contract above still holds for everything else.
 */
arcRoutes.get('/blueprint/:n', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  const n = Number(c.req.param('n'));
  if (!Number.isFinite(n) || n < 1) return c.json({ error: 'Bad chapter number.' }, 400);
  const empty = { blueprint: null, arcTitle: null, castBlock: null };
  if ((novel.arcMode ?? 'off') === 'off') return c.json(empty);

  const arcs = await store.listArcs(novel.id);
  for (const arc of arcs) {
    const blueprint = arc.blueprints.find((b) => b.chapter === n);
    if (!blueprint) continue;
    const rich = blueprint.cast?.length || blueprint.reveals?.length || blueprint.futureContext?.length;
    if (!rich) return c.json({ blueprint, arcTitle: arc.title, castBlock: null });

    const [entries, designs] = await Promise.all([
      store.listBibleEntries(novel.id),
      (novel.designMode ?? 'off') === 'off'
        ? []
        : store.listDesigns(novel.id).then((all) => all.filter((d) => d.state === 'active')),
    ]);
    return c.json({
      blueprint,
      arcTitle: arc.title,
      castBlock: formatCastBlock(blueprint, entries, designs, { namingOn: namingOn(novel) }) || null,
    });
  }
  return c.json(empty);
});

/** The arc that owns chapter n. Used by the steer block on generation. */
export async function arcForChapter(novelId: string, n: number): Promise<StoryArc | null> {
  const arcs = await store.listArcs(novelId);
  return arcs.find((a) => n >= a.fromChapter && n <= a.toChapter) ?? null;
}

/**
 * The blueprint for chapter n, if one has been planned.
 *
 * Used by the accept path to decide whether to propose three directions at
 * all: a chapter the author has already planned does not need alternatives.
 */
export async function blueprintForChapter(novelId: string, n: number) {
  const arcs = await store.listArcs(novelId);
  for (const arc of arcs) {
    const blueprint = arc.blueprints.find((b) => b.chapter === n);
    if (blueprint) return blueprint;
  }
  return null;
}

/**
 * Refine the arc description into something worth planning from.
 *
 * Runs before any chapter is planned, and planning is gated on it: fifty
 * chapters generated from three vague lines is fifty vague chapters, and the
 * author would have to read all of them to find that out.
 *
 * Plain JSON rather than SSE — one call, and the author is watching a button
 * rather than a stream. Same choice as POST /:n/suggestions.
 */
arcRoutes.post('/:arcId/refine', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  if ((novel.arcMode ?? 'off') === 'off') return c.json({ error: OFF_MESSAGE }, 400);
  const apiKey = openRouterKey(c);
  if (!apiKey) return c.json({ error: NO_KEY_MESSAGE }, 400);

  const arcId = c.req.param('arcId');
  const arc = await store.getArc(novel.id, arcId);
  if (!arc) return c.json({ error: 'No such arc.' }, 404);
  if (!arc.premise.trim()) {
    return c.json({ error: 'Describe the arc first — there is nothing to refine yet.' }, 400);
  }

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const instructions = typeof body.instructions === 'string' ? body.instructions.slice(0, 1000) : '';

  /*
   * Stage A: the author's premise, made structural — deterministic, and
   * BANKED before the model is called. This ordering is the whole point of
   * the staged pipeline: a refine that dies at the provider still leaves the
   * author with their thread list, because it was already committed.
   */
  const seeds = extractThreadSeeds(authorPremiseText(arc));
  const banked = await store.transactArc(novel.id, arcId, (current) =>
    markStage(mergeThreads(current ?? arc, seeds.threads, seeds.timeline), 'threads', stageOk())
  );

  try {
    const { bibleEntries, designs, writtenInArc } = await loadWorld(novel, arc);
    const result = await runArcRefine({
      apiKey,
      novel,
      arc: banked,
      writtenInArc,
      bibleEntries,
      designs,
      threadSeeds: seeds.threads,
      instructions,
    });

    // Stage B writes its own fields and nothing else (arcStages.test.ts holds
    // that). previousPremise keeps the AUTHOR'S words even across re-refines.
    const saved = await store.transactArc(novel.id, arcId, (current) => mergeRefine(current ?? banked, result));
    return c.json({ arc: saved, usage: result.usage });
  } catch (err) {
    /*
     * Transport, auth or budget — never content: content problems come back
     * as a partial result now. Stage A's threads are already committed and
     * stay; the failure is recorded on the stage so the screen can say which
     * button failed, and the arc rides back in the error body so the client
     * shows the banked threads without a reload.
     */
    const message =
      err instanceof OpenRouterError || err instanceof ArcValidationError || err instanceof Error
        ? err.message
        : 'The refiner failed.';
    const saved = await store
      .transactArc(novel.id, arcId, (current) => markStage(current ?? banked, 'refine', stageFailed(message)))
      .catch(() => banked);
    if (err instanceof OpenRouterError) return c.json({ error: message, arc: saved }, 502);
    if (err instanceof ArcValidationError) return c.json({ error: message, arc: saved }, 400);
    console.error(`[arc:refine] failed novel=${novel.id} arc=${arcId}:`, err);
    return c.json({ error: message, arc: saved }, 502);
  }
});

/**
 * AI edit: rewrite one thing to an instruction.
 *
 * `chapter` picks a blueprint; without it the arc description is the target.
 * Narrow on purpose — the agent is handed one piece of text and returns the
 * same shape, so "make chapter 34 darker" cannot quietly rewrite 35 as well.
 */
arcRoutes.post('/:arcId/edit', async (c) => {
  const novel = await loadAccessibleNovel(c);
  if (!novel) return c.json({ error: 'Novel not found' }, 404);
  if ((novel.arcMode ?? 'off') === 'off') return c.json({ error: OFF_MESSAGE }, 400);
  const apiKey = openRouterKey(c);
  if (!apiKey) return c.json({ error: NO_KEY_MESSAGE }, 400);

  const arcId = c.req.param('arcId');
  const arc = await store.getArc(novel.id, arcId);
  if (!arc) return c.json({ error: 'No such arc.' }, 404);

  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const instruction = typeof body.instruction === 'string' ? body.instruction.trim().slice(0, 1000) : '';
    if (!instruction) return c.json({ error: 'Say what you want changed.' }, 400);
    const chapter = body.chapter === undefined ? undefined : Number(body.chapter);
    if (chapter !== undefined && !Number.isFinite(chapter)) {
      return c.json({ error: 'chapter must be a number.' }, 400);
    }

    const { bibleEntries, designs } = await loadWorld(novel, arc);
    const result = await runArcEdit({
      apiKey,
      novel,
      arc,
      bibleEntries,
      designs,
      instruction,
      chapter,
    });

    const saved = await store.transactArc(novel.id, arcId, (current) => {
      const base = current ?? arc;
      if (result.premise !== undefined) {
        return {
          ...base,
          premise: result.premise,
          premiseSource: 'model' as const,
          previousPremise: base.premise,
          updatedAt: Date.now(),
        };
      }
      const edited = result.blueprint!;
      return {
        ...base,
        blueprints: base.blueprints
          .map((b) => (b.chapter === edited.chapter ? edited : b))
          .sort((a, b) => a.chapter - b.chapter),
        updatedAt: Date.now(),
      };
    });
    return c.json({ arc: saved, usage: result.usage });
  } catch (err) {
    if (err instanceof OpenRouterError) return c.json({ error: err.message }, 502);
    console.error(`[arc:edit] failed novel=${novel.id} arc=${arcId}:`, err);
    return c.json({ error: err instanceof Error ? err.message : 'The editor failed.' }, 502);
  }
});
