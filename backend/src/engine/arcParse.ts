/**
 * The incremental blueprint parser.
 *
 * A batch asks for ten chapters in one request, because ten planned together
 * know what the others are doing in a way ten planned separately never do. But
 * the author should not watch a spinner for the length of ten chapters and
 * then get a wall, so the batch has to arrive one chapter at a time.
 *
 * That rules out a tool call: tool arguments stream as one JSON string and are
 * only parseable once closed. So blueprints come back as delimited plain text,
 * and this closes a block the moment the NEXT header appears:
 *
 *     ### CH 26
 *     title: Cold Harbour
 *     tags: political, negotiation
 *     opens: ...
 *     turn: ...
 *     lands: ...
 *     ### CH 27          <- this line completes chapter 26
 *
 * Two things make it safe against a token stream that splits anywhere: only
 * whole lines are examined, and a block is emitted on the header that follows
 * it rather than on any guess about where it ended. Proved offline across
 * chunk sizes from one character up — see backend/src/arc.test.ts.
 */
import { ARC_LIMITS, validateTags } from '../lib/arcValidate.js';
import { knownFromTokens, newNamesInText as checkNames } from '../lib/nameCheck.js';
import type { ChapterBlueprint } from '../lib/types.js';

export interface BlueprintIssue {
  chapter: number | null;
  message: string;
}

/*
 * Decoration is tolerated on both, because models emit it whatever the format
 * says. `## **CH 26**` and `**opens:**` are the shapes seen in practice — the
 * same failure the chapter-title extractor was widened for, where five of six
 * sampled chapters lost their title to a `**` the pattern did not allow. Here
 * the cost is higher: an undecorated pattern loses the whole batch, not a
 * title. A header may also carry its title inline, which is a natural thing to
 * write and cheap to accept.
 */
const HEADER = /^\s*(?:[*_#]{1,4}\s*){0,3}CH(?:APTER)?\s*(\d+)\s*(?:[:—–-]\s*(.*?))?\s*[*_#]*\s*$/i;
const FIELD = /^\s*(?:[*_]{1,3}\s*)?(title|tags|opens|turn|lands|summary|who|context)\s*(?:[*_]{1,3})?\s*:\s*(.*)$/i;
/** "none", "n/a", "-" — what a model writes for a field it has nothing for. */
const NOTHING = /^(?:none|n\/?a|nothing|null|,|-|—)?\.?$/i;
/** A rule between blocks is punctuation, not a continuation of the last field. */
const RULE = /^\s*(?:[-*_=]\s*){3,}$/;
/** Leading and trailing emphasis around a field's value. */
const EMPHASIS = /^[*_\s]+|[*_\s]+$/g;
/** A part shorter than this is a gesture, not a movement of a chapter. */
const PART_MIN = 60;

export class BlueprintStream {
  private buffer = '';
  private current: { chapter: number; title: string; lines: string[] } | null = null;
  private seen = new Set<number>();

  constructor(
    private readonly onBlueprint: (bp: ChapterBlueprint) => void,
    private readonly onIssue: (issue: BlueprintIssue) => void
  ) {}

  push(text: string): void {
    this.buffer += text;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this.line(line);
    }
  }

  end(): void {
    if (this.buffer.trim()) this.line(this.buffer);
    this.buffer = '';
    this.flush();
  }

  private line(raw: string): void {
    const header = HEADER.exec(raw);
    if (header) {
      this.flush();
      this.current = {
        chapter: Number(header[1]),
        title: (header[2] ?? '').replace(EMPHASIS, ''),
        lines: [],
      };
      return;
    }
    // A rule belongs to neither block. Kept out here rather than in flush()
    // because the continuation branch there would otherwise glue "---" onto
    // the end of whichever field came last.
    if (this.current && !RULE.test(raw)) this.current.lines.push(raw);
  }

  private flush(): void {
    const block = this.current;
    this.current = null;
    if (!block) return;

    const fields = new Map<string, string>();
    /*
     * The same values, kept unjoined.
     *
     * `who` and `context` are list-valued and are written one entry per line
     * about as often as they are written as prose, so gluing their lines
     * together with a space throws away the only boundary the model gave —
     * and then the delimiter split has to guess it back. It guesses wrong on
     * exactly the lines a braided arc cares about: a `Thread:` line whose name
     * contains a "·", or a `Time:` line that ends without a full stop, merges
     * into its neighbour and one of the two is lost.
     *
     * The prose fields still get the joined string: there, a line break really
     * is just a wrap in the middle of a sentence.
     */
    const lines = new Map<string, string[]>();
    let last: string | null = null;
    for (const line of block.lines) {
      const field = FIELD.exec(line);
      if (field) {
        last = field[1].toLowerCase();
        const value = field[2].replace(EMPHASIS, '');
        fields.set(last, value);
        lines.set(last, [value]);
      } else if (last && line.trim()) {
        // A field that wrapped onto its own line still belongs to that field.
        const value = line.replace(EMPHASIS, '');
        fields.set(last, `${fields.get(last) ?? ''} ${value}`.trim());
        lines.get(last)?.push(value);
      }
    }

    const clip = (s: string) => s.trim().slice(0, ARC_LIMITS.blueprintPart);
    const opens = clip(fields.get('opens') ?? '');
    const turn = clip(fields.get('turn') ?? '');
    const lands = clip(fields.get('lands') ?? '');
    const fallback = (fields.get('summary') ?? '').trim();
    const summary = [opens, turn, lands].filter(Boolean).join(' ') || fallback;
    // A `title:` field wins over one written inline on the header, because the
    // field is what the format asks for.
    const title = (fields.get('title') ?? '').trim() || block.title.trim();

    if (!title && !summary) {
      this.onIssue({ chapter: block.chapter, message: 'block had neither a title nor any content' });
      return;
    }

    /*
     * The floor is on SUBSTANCE, not on labelling. A spike run came back with
     * all three movements packed into `opens` and no turn or lands at all —
     * a well-planned chapter wearing the wrong headings. Rejecting those threw
     * away ten chapters the author would have been glad of, so per-part floors
     * apply only to the parts the model actually used.
     */
    const used = ([['opens', opens], ['turn', turn], ['lands', lands]] as const).filter(
      ([, v]) => v.length > 0
    );
    if (used.length > 1) {
      for (const [name, value] of used) {
        if (value.length >= PART_MIN) continue;
        this.onIssue({
          chapter: block.chapter,
          message:
            name === 'turn'
              ? `"turn" is ${value.length} characters — it is what makes this a chapter rather than a scene, and needs at least ${PART_MIN}`
              : `"${name}" is ${value.length} characters; needs at least ${PART_MIN}`,
        });
        return;
      }
    }
    if (summary.length < ARC_LIMITS.summaryMin) {
      this.onIssue({
        chapter: block.chapter,
        message: `only ${summary.length} characters of chapter here; a chapter of 500+ words needs at least ${ARC_LIMITS.summaryMin} to be written from`,
      });
      return;
    }
    if (this.seen.has(block.chapter)) {
      this.onIssue({ chapter: block.chapter, message: 'chapter appeared twice in one batch' });
      return;
    }
    this.seen.add(block.chapter);

    /*
     * `who` and `context` are structure, not content: a chapter is perfectly
     * plannable without them, and the floors above deliberately do not mention
     * them. A model that drops one loses that line, never the chapter.
     */
    const list = (raw: string[], sep: RegExp, max: number, cap: number): string[] =>
      NOTHING.test(raw.join(' ').trim())
        ? []
        : [
            ...new Set(
              raw
                .flatMap((r) => r.split(sep))
                .map((s) => s.trim().replace(/^[-•*]\s*/, ''))
                .filter(Boolean)
            ),
          ]
            .map((s) => s.slice(0, max))
            .slice(0, cap);

    const roles = list(lines.get('who') ?? [], /[,;]|\s+·\s+/, ARC_LIMITS.castMention, ARC_LIMITS.castPerBlueprint);
    const futureContext = list(
      lines.get('context') ?? [],
      // Sentence-split as well as delimiter-split: this field is written as
      // prose far more often than as a list, and one 300-character blob is a
      // worse thing to hand a writer than three lines.
      //
      // The `Thread:`/`Time:` lookahead is the bookkeeping a braided arc opens
      // this field with, and it is what recovers the boundary when a model
      // writes both on ONE line without a full stop between them: without it,
      // "Thread: the feud Time: the third week" is a single entry and the Time
      // half is lost. Seen on the first real braided run — 0 of 10 blueprints
      // placed themselves in time.
      //
      // "·" is deliberately NOT a separator here, though it is one for `who`.
      // Models write the thread as "Thread: 2 · the Refsdal feud", and cutting
      // there leaves the number stranded from the name it labels.
      /(?<=[.!?])\s+|;|\s+(?=(?:thread|time)\s*:)/i,
      ARC_LIMITS.contextLine,
      ARC_LIMITS.contextPerBlueprint
    );

    this.onBlueprint({
      chapter: block.chapter,
      title: title.slice(0, ARC_LIMITS.blueprintTitle),
      tags: validateTags((fields.get('tags') ?? '').split(',').map((t) => t.trim()).filter(Boolean)),
      summary: summary.slice(0, ARC_LIMITS.blueprintSummary),
      opens,
      turn,
      lands,
      source: 'model',
      ...(roles.length ? { roles } : {}),
      ...(futureContext.length ? { futureContext } : {}),
    });
  }
}

/** Convenience for tests and for re-parsing a stored batch. */
export function parseBlueprints(text: string): {
  blueprints: ChapterBlueprint[];
  issues: BlueprintIssue[];
} {
  const blueprints: ChapterBlueprint[] = [];
  const issues: BlueprintIssue[] = [];
  const stream = new BlueprintStream(
    (bp) => blueprints.push(bp),
    (issue) => issues.push(issue)
  );
  stream.push(text);
  stream.end();
  return { blueprints, issues };
}

/**
 * Proper nouns a blueprint uses that the world has never heard of.
 *
 * The planner is told not to name new people and the chosen model does not,
 * but a silent cast addition is the one failure an author would not notice
 * until forty chapters later — so it is surfaced for accept-or-edit rather
 * than trusted. Sentence-initial words and possessives are ignored: they are
 * capitalised by grammar, not because they name anything.
 */
export function findNewNames(bp: ChapterBlueprint, known: Set<string>): string[] {
  return newNamesInText(bp.summary, known);
}

/**
 * The same scan over any text.
 *
 * Split out because the blueprint is no longer the only place a name can be
 * invented. The refine step is told not to name anything and does it anyway —
 * the first real test of the cast feature found refine-invented names sitting
 * in the arc premise — and because the planner's `known` set is built from that
 * premise, every one of them read as the author's own. The scan is the same;
 * only what you point it at differs.
 */
export function newNamesInText(text: string, known: Set<string>): string[] {
  // The scan itself lives in lib/nameCheck.ts now, with the judgement about
  // what is ordinary English (stopwords, morphology) that this signature's
  // bare token set cannot carry. "Monday" was a character until it moved.
  return checkNames(text, knownFromTokens(known));
}

/**
 * The structural half of a blueprint's bookkeeping lines.
 *
 * A braided plan opens `context` with `Threads: the feud (2), the audit (5).`
 * and `Day: 47 — a week after ch 34.` The lines STAY in futureContext — they
 * are what the writer reads through the prompt box, and the plan must stay
 * readable by a human with no thread list — but the braid validator needs a
 * machine-readable copy, because a `Time: a week later` line proves nothing,
 * which is why nothing used to be checked.
 *
 * `Thread:` (singular) and `Time:` are the previous generation of the format
 * and still parse: labels without a day, a day without labels, both fine.
 */
export function readBookkeeping(lines: readonly string[]): {
  /**
   * Each thread the line names: the words, and the author number when the
   * model wrote one. The NUMBER is the reliable half — a model paraphrases a
   * label freely ("the marketing beta" for a seed that says "his marketing
   * projects go from pilot to beta…"), and a real batch resolved 0 of 10
   * chapters while the numbers sat discarded on the floor.
   */
  threads: Array<{ label: string; number?: number }>;
  time?: { day: number; hint?: string };
} {
  const threads: Array<{ label: string; number?: number }> = [];
  let time: { day: number; hint?: string } | undefined;

  for (const line of lines) {
    const threadLine = /^threads?\s*:\s*(.+)$/i.exec(line.trim());
    if (threadLine) {
      for (const part of threadLine[1].split(',')) {
        // "the Refsdal feud (2)" and "2 · the feud" both carry the number —
        // matched after the trailing full stop is gone, or the "$" never hits.
        const bare = part.trim().replace(/[.。]\s*$/, '');
        const trailing = /\((\d{1,2})\)\s*$/.exec(bare);
        const leading = /^\s*(\d{1,2})\s*[·:—–-]\s*/.exec(bare);
        const label = bare
          .replace(/\s*\((\d{1,2})\)\s*$/, '')
          .replace(/^\d{1,2}\s*[·:—–-]\s*/, '')
          .trim();
        const number = trailing ? Number(trailing[1]) : leading ? Number(leading[1]) : undefined;
        if ((label || number !== undefined) && !threads.some((t) => t.label === label && t.number === number)) {
          threads.push({ label, ...(number !== undefined ? { number } : {}) });
        }
      }
      continue;
    }
    const dayLine = /^day\s*:\s*(.+)$/i.exec(line.trim());
    if (dayLine) {
      const day = /(\d{1,4})/.exec(dayLine[1]);
      if (day) {
        const hint = dayLine[1].split(/[—–-]/).slice(1).join('—').trim().replace(/[.。]\s*$/, '');
        time = { day: Number(day[1]), ...(hint ? { hint } : {}) };
      }
      continue;
    }
    // A legacy `Time:` line carries no day number, so there is nothing here
    // the validator could check — the hint already survives in futureContext,
    // where the writer reads it.
  }
  return { threads, ...(time ? { time } : {}) };
}
