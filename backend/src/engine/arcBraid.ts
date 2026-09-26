/**
 * Stage D of arc planning: is the braid actually braided?
 *
 * Pure functions of the arc — no model, no network. Everything the author
 * asked to have checked is decidable from the thread list and the blueprints:
 * whether every storyline got planned, whether one went dark, whether the
 * batch ran in blocks instead of rotating, whether an effect landed before
 * its cause, whether a thread's own clock ran backwards, and whether a thread
 * the author left open got tidied shut. A model's opinion would add cost and
 * a second answer nobody can arbitrate; a report the next batch's prompt can
 * read adds pressure exactly where the planning happens.
 *
 * Every check is generous the same way the name checker is: a finding is a
 * line the author reads, so a false positive costs attention. Legacy arcs —
 * no threads, or blueprints planned before any of this existed — must come
 * out CLEAN: unplaced chapters are a count, never a finding.
 */
import { ARC_LIMITS } from '../lib/arcValidate.js';
import type { ArcThread, BraidFinding, BraidReport, ChapterBlueprint, StoryArc } from '../lib/types.js';

type BraidArc = Pick<StoryArc, 'threads' | 'blueprints' | 'timeline' | 'fromChapter' | 'toChapter'>;

const RESOLUTION =
  /\b(?:resolv|finally|at last|settled|closes?d?\b|concluded|dismiss|terminated|wraps? up|puts? .{0,24}to rest)/i;

export function validateBraid(arc: BraidArc): BraidReport {
  const at = Date.now();
  const threads = arc.threads ?? [];
  const bps = [...arc.blueprints].sort((a, b) => a.chapter - b.chapter);
  const from = bps[0]?.chapter ?? arc.fromChapter;
  const to = bps.at(-1)?.chapter ?? arc.fromChapter;

  const empty: BraidReport = {
    at, from, to, clocks: [], findings: [], weaveRate: 0, longestRun: 0, unplaced: bps.length,
  };
  if (threads.length === 0 || bps.length === 0) return empty;

  const threadIds = new Set(threads.map((t) => t.id));
  const labelOf = new Map(threads.map((t) => [t.id, t.label]));
  const placed = bps.filter((bp) => (bp.threads ?? []).some((id) => threadIds.has(id)));
  const unplaced = bps.length - placed.length;
  if (placed.length === 0) return { ...empty, unplaced };

  const findings: BraidFinding[] = [];
  const chaptersOf = new Map<string, ChapterBlueprint[]>(threads.map((t) => [t.id, []]));
  for (const bp of placed) {
    for (const id of bp.threads ?? []) chaptersOf.get(id)?.push(bp);
  }

  // ── per-thread clocks, and the dark run each thread is currently on ──────
  const clocks = threads.map((t) => {
    const own = chaptersOf.get(t.id) ?? [];
    const last = own.at(-1);
    const darkFor = last ? placed.filter((bp) => bp.chapter > last.chapter).length : placed.length;
    return {
      id: t.id,
      lastChapter: last?.chapter ?? null,
      lastDay: [...own].reverse().find((bp) => bp.time)?.time?.day ?? null,
      count: own.length,
      darkFor,
    };
  });

  // ── coverage: a thread never planned, once the arc is well underway ──────
  const span = Math.max(1, arc.toChapter - arc.fromChapter + 1);
  const progress = (to - arc.fromChapter + 1) / span;
  if (progress >= 0.6) {
    for (const t of threads) {
      if ((chaptersOf.get(t.id) ?? []).length > 0) continue;
      // A late-anchored thread is ALLOWED to be absent at 60%.
      if (t.anchor === 'late' && progress < 0.8) continue;
      findings.push({
        kind: 'thread-never-planned',
        message: `"${t.label}" has not been planned at all, and the arc is ${Math.round(progress * 100)}% through.`,
        chapters: [],
        threads: [t.id],
        severity: 'break',
      });
    }
  }

  // ── dark gaps ────────────────────────────────────────────────────────────
  /*
   * The threshold scales with the braid. Eleven threads cannot all appear
   * every four chapters — a fair rotation brings each back roughly every
   * (threads / threads-per-chapter) chapters, so the flat darkGap floor only
   * binds on small braids, and a first real 11-thread run buried the one true
   * finding under eight mathematical inevitabilities.
   */
  const perChapter = Math.max(1, placed.reduce((n, bp) => n + (bp.threads?.length ?? 0), 0) / placed.length);
  const gapLimit = Math.max(ARC_LIMITS.darkGap, Math.ceil((threads.length / perChapter) * 1.25));
  for (const t of threads) {
    const own = chaptersOf.get(t.id) ?? [];
    if (own.length === 0) continue;
    // Chapters between consecutive appearances, measured in planned chapters,
    // plus the tail — a thread dark NOW is the one the next batch must fix.
    const positions = own.map((bp) => placed.findIndex((p) => p.chapter === bp.chapter));
    let worst = 0;
    for (let i = 1; i < positions.length; i++) worst = Math.max(worst, positions[i] - positions[i - 1] - 1);
    const tail = placed.length - 1 - (positions.at(-1) ?? 0);
    /*
     * The tail counts only for a thread still owed something: a minor thread
     * that had its scene, a next-arc seed that had its glimpse, and a thread
     * whose last chapter reads as its conclusion are all allowed to stay
     * finished. The premise that motivated this closes an investigation at
     * 60% of the arc — silence after "the inquiry is dismissed" is not a
     * dropped storyline.
     */
    const concluded = !t.endsOpen && RESOLUTION.test(own.at(-1)?.summary ?? '');
    const tailCounts = t.weight !== 'minor' && !t.seedForNextArc && !concluded && tail > gapLimit;
    if (worst > gapLimit || tailCounts) {
      const dark = Math.max(worst, tailCounts ? tail : 0);
      findings.push({
        kind: 'thread-dark',
        message: `"${t.label}" goes dark for ${dark} chapters — past ${gapLimit} it reads as dropped.`,
        chapters: own.map((bp) => bp.chapter),
        threads: [t.id],
        severity: 'warn',
      });
    }
  }

  // ── rotation: the blocked-run failure the braid exists to prevent ────────
  let longestRun = 0;
  {
    let runId: string | null = null;
    let run = 0;
    let runStart = 0;
    for (const bp of placed) {
      const ids = bp.threads ?? [];
      // A multi-thread chapter breaks every run: it IS rotation.
      const sole = ids.length === 1 ? ids[0] : null;
      if (sole !== null && sole === runId) {
        run++;
      } else {
        runId = sole;
        run = sole === null ? 0 : 1;
        runStart = bp.chapter;
      }
      if (run > longestRun) longestRun = run;
      if (run === ARC_LIMITS.darkGap && runId) {
        findings.push({
          kind: 'blocked-run',
          message:
            `Chapters ${runStart}–${bp.chapter} all carry only "${labelOf.get(runId) ?? runId}" — ` +
            'that is a block, not a braid. Rotate.',
          chapters: placed.filter((p) => p.chapter >= runStart && p.chapter <= bp.chapter).map((p) => p.chapter),
          threads: [runId],
          severity: 'break',
        });
      }
    }
  }

  // ── effect before cause ──────────────────────────────────────────────────
  /*
   * "B waits on A" cannot demand that A has FINISHED before B resolves — the
   * premise that motivated this closes an investigation because a marketing
   * beta is going well, while the marketing thread runs on for months
   * afterwards. What is deterministically checkable is the true inversion:
   * B resolving while A has not even started, or B resolving on an earlier
   * day than any chapter A has had.
   */
  for (const t of threads) {
    if (!t.dependsOn?.length || t.endsOpen) continue;
    const own = chaptersOf.get(t.id) ?? [];
    const resolving = own.at(-1);
    if (!resolving) continue;
    for (const causeId of t.dependsOn) {
      const cause = chaptersOf.get(causeId) ?? [];
      const causeFirst = cause[0];
      // A cause not yet planned at all is coverage's problem, not order's.
      if (!causeFirst) continue;
      const chapterOrderWrong = causeFirst.chapter > resolving.chapter;
      const dayOrderWrong =
        causeFirst.time?.day !== undefined &&
        resolving.time?.day !== undefined &&
        causeFirst.time.day > resolving.time.day;
      if (chapterOrderWrong || dayOrderWrong) {
        findings.push({
          kind: 'effect-before-cause',
          message:
            `"${t.label}" resolves at ch ${resolving.chapter} but waits on ` +
            `"${labelOf.get(causeId) ?? causeId}", which has not begun until ch ${causeFirst.chapter}.`,
          chapters: [resolving.chapter, causeFirst.chapter],
          threads: [t.id, causeId],
          severity: 'break',
        });
      }
    }
  }

  // ── each thread's own clock only moves forward ───────────────────────────
  for (const t of threads) {
    const timed = (chaptersOf.get(t.id) ?? []).filter((bp) => bp.time?.day !== undefined);
    for (let i = 1; i < timed.length; i++) {
      const prev = timed[i - 1];
      const cur = timed[i];
      if ((cur.time?.day ?? 0) < (prev.time?.day ?? 0)) {
        findings.push({
          kind: 'clock-backwards',
          message:
            `"${t.label}" runs backwards: ch ${prev.chapter} is day ${prev.time?.day} but ` +
            `ch ${cur.chapter} is day ${cur.time?.day}. Sideways cuts share a day; a thread's own ` +
            'next chapter never lands earlier.',
          chapters: [prev.chapter, cur.chapter],
          threads: [t.id],
          severity: 'break',
        });
      }
    }
  }

  // ── drift between live threads ───────────────────────────────────────────
  {
    const live = clocks.filter((c) => {
      const t = threads.find((x) => x.id === c.id);
      return c.lastDay !== null && c.count > 0 && (t?.endsOpen || c.darkFor <= ARC_LIMITS.darkGap);
    });
    if (live.length >= 2) {
      const days = live.map((c) => c.lastDay ?? 0);
      const spread = Math.max(...days) - Math.min(...days);
      if (spread > ARC_LIMITS.threadDriftDays) {
        const ahead = live.reduce((a, b) => ((a.lastDay ?? 0) >= (b.lastDay ?? 0) ? a : b));
        const behind = live.reduce((a, b) => ((a.lastDay ?? 0) <= (b.lastDay ?? 0) ? a : b));
        findings.push({
          kind: 'clock-drift',
          message:
            `"${labelOf.get(behind.id)}" is ${spread} days behind "${labelOf.get(ahead.id)}" — ` +
            `past ${ARC_LIMITS.threadDriftDays} the braid stops sharing a clock.`,
          chapters: [],
          threads: [ahead.id, behind.id],
          severity: 'warn',
        });
      }
    }
  }

  // ── a thread the author left open must stay open ─────────────────────────
  for (const t of threads) {
    if (!t.endsOpen) continue;
    const own = chaptersOf.get(t.id) ?? [];
    const last = own.at(-1);
    if (!last) continue;
    const nearEnd = last.chapter >= arc.toChapter - Math.ceil(span * 0.1);
    if (nearEnd && RESOLUTION.test(last.summary)) {
      findings.push({
        kind: 'resolved-open-thread',
        message:
          `"${t.label}" was left open by the author, but ch ${last.chapter} reads like it ` +
          'resolves it. A glimpse, not a closing.',
        chapters: [last.chapter],
        threads: [t.id],
        severity: 'warn',
      });
    }
  }

  // ── anchors ──────────────────────────────────────────────────────────────
  for (const t of threads) {
    const first = (chaptersOf.get(t.id) ?? [])[0];
    if (!first) continue;
    const position = (first.chapter - arc.fromChapter) / span;
    if (t.anchor === 'early' && position > 0.4) {
      findings.push({
        kind: 'anchor-missed',
        message: `"${t.label}" is anchored early but first appears at ch ${first.chapter}, ${Math.round(position * 100)}% in.`,
        chapters: [first.chapter],
        threads: [t.id],
        severity: 'warn',
      });
    }
    if (t.anchor === 'late' && position < 0.5) {
      findings.push({
        kind: 'anchor-missed',
        message: `"${t.label}" is anchored late but starts at ch ${first.chapter}, ${Math.round(position * 100)}% in.`,
        chapters: [first.chapter],
        threads: [t.id],
        severity: 'warn',
      });
    }
  }

  const weaveRate = placed.filter((bp) => (bp.threads ?? []).length >= 2).length / placed.length;
  return { at, from, to, clocks, findings, weaveRate, longestRun, unplaced };
}

/**
 * The report, as the paragraph the NEXT batch's prompt reads.
 *
 * This is the feedback loop: Stage D is deterministic and free, so its
 * findings cost nothing to restate as instructions, and the planner starts
 * every batch knowing where each thread stands instead of re-deriving it
 * from summaries.
 */
export function formatBraidBrief(report: BraidReport, threads: readonly ArcThread[]): string {
  if (threads.length === 0) return '';
  const lines: string[] = [];
  for (const t of threads) {
    const clock = report.clocks.find((c) => c.id === t.id);
    if (!clock || clock.count === 0) {
      const anchor = t.anchorNote ? `"${t.anchorNote}"` : t.anchor;
      lines.push(`- ${t.label}: not yet started; the author anchored it ${anchor}.`);
      continue;
    }
    const day = clock.lastDay !== null ? `, day ${clock.lastDay}` : '';
    const dark =
      clock.darkFor > ARC_LIMITS.darkGap ? ` — DARK FOR ${clock.darkFor} CHAPTERS, come back to it` : '';
    lines.push(`- ${t.label}: last seen ch ${clock.lastChapter}${day}${dark}.`);
  }
  for (const f of report.findings) {
    if (f.kind === 'clock-drift' || f.kind === 'effect-before-cause') lines.push(`- ${f.message}`);
  }
  return `THE BRAID SO FAR — where each thread stands going into this batch:\n${lines.join('\n')}`;
}

/** The thread list, structurally, for the planner's prompt. */
export function formatThreadRoster(
  threads: readonly ArcThread[],
  spanDays: number | undefined
): string {
  if (threads.length === 0) return '';
  const label = new Map(threads.map((t) => [t.id, t.label]));
  const rows = threads.map((t) => {
    const parts: string[] = [
      t.anchor === 'specific' && t.anchorNote ? `anchored "${t.anchorNote}"` : `anchored ${t.anchor}`,
    ];
    if (t.weight) parts.push(t.weight);
    if (t.dependsOn?.length) {
      parts.push(`resolves only AFTER: ${t.dependsOn.map((d) => label.get(d) ?? d).join(', ')}`);
    }
    if (t.seedForNextArc) parts.push('a seed for the NEXT arc — a glimpse here, never a resolution');
    else if (t.endsOpen) parts.push('still open when the arc ends');
    return `${t.authorNumber ?? '-'}. ${t.label} — ${parts.join('; ')}`;
  });
  const span = spanDays ? ` across about ${spanDays} days` : '';
  return `THE STORYLINES OF THIS ARC — all running at once${span}:\n${rows.join('\n')}`;
}
