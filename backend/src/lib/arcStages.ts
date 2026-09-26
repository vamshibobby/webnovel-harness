/**
 * Every stage of arc planning writes ONLY its own outputs.
 *
 * The failure this file exists to make impossible: a refine that could not
 * check its own names threw, the route saved nothing, and an author lost a
 * premise and forty beats to a checker that called "Monday" a character.
 * Isolation is not a convention here — each merge is a named function that
 * touches a fixed set of fields, and arcStages.test.ts asserts that
 * everything outside that set comes through untouched. A later stage failing
 * can therefore never cost an earlier stage's work, because the earlier
 * stage's transaction has already committed and no merge can reach back into
 * its fields.
 */
import type {
  ArcNameFlag,
  ArcStageName,
  ArcStageRecord,
  ArcThread,
  ArcTimeline,
  BraidReport,
  ChapterBlueprint,
  StoryArc,
} from './types.js';

export function stageOk(message?: string): ArcStageRecord {
  return { status: 'ok', at: Date.now(), ...(message ? { message } : {}) };
}

export function stagePartial(message: string, issues?: string[]): ArcStageRecord {
  return { status: 'partial', at: Date.now(), message, ...(issues?.length ? { issues } : {}) };
}

export function stageFailed(message: string): ArcStageRecord {
  return { status: 'failed', at: Date.now(), message };
}

export function markStage(base: StoryArc, name: ArcStageName, rec: ArcStageRecord): StoryArc {
  return { ...base, stages: { ...base.stages, [name]: rec }, updatedAt: Date.now() };
}

/** Stage A's merge: the thread list and the clock, nothing else. */
export function mergeThreads(base: StoryArc, threads: ArcThread[], timeline?: ArcTimeline): StoryArc {
  return {
    ...base,
    threads,
    ...(timeline ? { timeline } : {}),
    updatedAt: Date.now(),
  };
}

/** What Stage B is allowed to write. The shape runArcRefine returns. */
export interface RefineOutput {
  premise: string;
  beats: StoryArc['beats'];
  threads: ArcThread[];
  timeline?: ArcTimeline;
  nameFlags: ArcNameFlag[];
  stage: ArcStageRecord;
}

/**
 * Stage B's merge: premise (keeping the author's words as previousPremise —
 * the existing contract), beats, threads enriched through mergeThreadSeeds,
 * flags and the stage record. Blueprints, braid and every other field pass
 * through untouched.
 */
export function mergeRefine(base: StoryArc, out: RefineOutput): StoryArc {
  return {
    ...base,
    premise: out.premise,
    premiseSource: 'model',
    // Only ever hold the AUTHOR'S text here: refining twice must not bury the
    // author's words under the first refine's rewrite.
    previousPremise: base.premiseSource === 'model' ? (base.previousPremise ?? '') : base.premise,
    beats: out.beats,
    threads: mergeThreadSeeds(base.threads ?? [], out.threads),
    ...(out.timeline ? { timeline: out.timeline } : {}),
    nameFlags: out.nameFlags,
    stages: { ...base.stages, refine: out.stage },
    updatedAt: Date.now(),
  };
}

/**
 * Stage C's merge, lifted verbatim from the blueprints route so it is
 * testable: merge by chapter, and replacing something the author edited keeps
 * what it replaced so the UI can show the change instead of silently
 * overwriting.
 */
export function mergeBatch(base: StoryArc, batch: ChapterBlueprint[]): StoryArc {
  const byChapter = new Map(base.blueprints.map((b) => [b.chapter, b]));
  for (const bp of batch) {
    const previous = byChapter.get(bp.chapter);
    byChapter.set(
      bp.chapter,
      previous && previous.source === 'author' ? { ...bp, previousSummary: previous.summary } : bp
    );
  }
  return {
    ...base,
    blueprints: [...byChapter.values()].sort((a, b) => a.chapter - b.chapter),
    updatedAt: Date.now(),
  };
}

/** Stage D's merge: the report and its stage record, nothing else. */
export function mergeBraid(base: StoryArc, report: BraidReport): StoryArc {
  return {
    ...base,
    braid: report,
    stages: {
      ...base.stages,
      braid: {
        status: report.findings.some((f) => f.severity === 'break') ? 'partial' : 'ok',
        at: report.at,
        ...(report.findings.length
          ? { message: `${report.findings.length} finding${report.findings.length === 1 ? '' : 's'}.` }
          : {}),
      },
    },
    updatedAt: Date.now(),
  };
}

const normalise = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Enrich the author's seeds with what the model worked out — and never lose
 * one.
 *
 * Matched by authorNumber first, then by normalised label. A seed the model
 * did not mention keeps its id, its label and its anchor. A thread the model
 * invented is appended with source 'model'. The model can never delete a
 * storyline, and the label the author typed always wins over the model's
 * paraphrase of it.
 */
export function mergeThreadSeeds(seeds: ArcThread[], fromModel: ArcThread[]): ArcThread[] {
  const claimed = new Set<ArcThread>();
  const matchOf = (m: ArcThread): ArcThread | undefined => {
    const byNumber =
      m.authorNumber !== undefined
        ? seeds.find((s) => !claimed.has(s) && s.authorNumber === m.authorNumber)
        : undefined;
    if (byNumber) return byNumber;
    const key = normalise(m.label);
    return seeds.find(
      (s) =>
        !claimed.has(s) &&
        (normalise(s.label) === key || normalise(s.label).includes(key) || key.includes(normalise(s.label)))
    );
  };

  const enriched = new Map<ArcThread, ArcThread>();
  const extras: ArcThread[] = [];
  for (const m of fromModel) {
    const seed = matchOf(m);
    if (!seed) {
      extras.push({ ...m, source: 'model' });
      continue;
    }
    claimed.add(seed);
    enriched.set(seed, {
      ...seed,
      // What the model may add: the parts the author left implicit. What it
      // may not: the identity — id, label, number and source stay the seed's.
      anchor: m.anchor ?? seed.anchor,
      ...(m.anchorNote ? { anchorNote: m.anchorNote } : seed.anchorNote ? { anchorNote: seed.anchorNote } : {}),
      ...(m.dependsOn?.length ? { dependsOn: m.dependsOn } : seed.dependsOn ? { dependsOn: seed.dependsOn } : {}),
      ...(m.endsOpen || seed.endsOpen ? { endsOpen: true } : {}),
      ...(m.seedForNextArc || seed.seedForNextArc ? { seedForNextArc: true } : {}),
      ...(m.weight ? { weight: m.weight } : seed.weight ? { weight: seed.weight } : {}),
    });
  }

  return [...seeds.map((s) => enriched.get(s) ?? s), ...extras];
}
