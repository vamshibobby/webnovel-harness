import { currentArc } from '../lib/designValidate.js';
import { SUGGESTION_MOVES } from '../lib/types.js';
import type {
  BibleEntry,
  Chapter,
  ChapterSuggestion,
  CharacterDesign,
  Novel,
  SuggestionMove,
} from '../lib/types.js';
import type { AgentEvent } from './agent.js';
import { formatBibleIndex } from './bibleTools.js';
import { deviceLabel } from './designCatalog.js';
import { streamChat, type ChatMessage, type ToolDefinition, type Usage } from './openrouter.js';

/**
 * Next-chapter directions.
 *
 * Fixed cheap model, like the bible and design agents: this is not writing, it
 * is reading — the deliverable is three instructions the author will edit
 * anyway, and paying the novel's model to produce them would be paying for
 * prose nobody keeps.
 */
export const SUGGEST_MODEL = 'deepseek/deepseek-v4-flash';

/** Rounds available for correcting a malformed proposal before giving up. */
const MAX_ROUNDS = 3;

/** How many prior chapters' summaries ride along as the run-up. */
const RECENT_SUMMARIES = 6;

/** Active designs digested into the prompt; the rest stay out of it. */
const MAX_DESIGNS = 8;

/**
 * Caps, not targets. The word budget in the prompt is what actually sizes the
 * output; these exist so a runaway generation cannot put a page of text in the
 * author's box. Set too tight, they clip mid-sentence and the joined
 * instruction stops making sense — which is worse than a long one.
 */
const LIMITS = { title: 80, part: 520, prompt: 1500, rationale: 320 };

/**
 * A part shorter than this is a gesture, not a movement of a chapter. The floor
 * is deliberately low — it catches "She agrees." and nothing an author would
 * actually have written.
 */
const MIN_PART = 40;

/** The stated budget is 80–120 words; this is where it stops being a direction. */
const MAX_PROMPT_WORDS = 150;

/**
 * Trim to a length without cutting a word in half. A rationale that ends
 * "...which complicates Mirin'" reads as a bug in the product rather than a
 * long sentence, and the author has no way to tell which it was.
 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const EMPTY_USAGE: Usage = {
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
};

function addUsage(a: Usage, b: Usage | null): Usage {
  if (!b) return a;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cost: a.cost + b.cost,
  };
}

/**
 * The prompt.
 *
 * Two things carry most of the quality here, and both are structural rather
 * than rhetorical.
 *
 * The first is that the reasoning is a REQUIRED FIELD of the tool call, not a
 * request for the model to think first. Asked politely to reason, a model
 * writes three fluent directions that would suit any novel; made to state where
 * the chapter actually stopped and which threads are actually open before it
 * may name a single option, it has to look at the page. The `reading` object is
 * never shown to the author and never stored — it exists to be expensive to
 * fake.
 *
 * The second is that the three options differ along ONE declared axis: how hard
 * the wheel turns. Left free, "give me three ideas" reliably produces three
 * versions of the most obvious idea. The author's real question at the end of a
 * chapter is not which idea is best, it is how much they want to change.
 *
 * The third came out of reading what the first version actually produced. Told
 * a direction must fit in one chapter and must say where the chapter ends, the
 * model wrote an opening move and a closing image and left the middle out — a
 * single gesture dressed as a chapter, which is worse than nothing because it
 * hands the author back the hardest part of the job. So the shape is fields
 * too: `opens`, `turn`, `lands`, and the instruction the author receives is
 * built from all three. A ceiling on size needs a floor beside it.
 */
const SYSTEM_PROMPT = [
  "You read the chapter an author has just finished and propose three directions the NEXT chapter could take. You are not writing the chapter. You are handing the author three instructions they will edit and send to the writer.",

  [
    'THE THREE MOVES — one each, no substitutions:',
    '- follow: the straight line. Pay off what this chapter just set up. If it ended mid-scene, this one finishes the scene. Lowest risk, and often the right answer.',
    '- complicate: the same trajectory, made harder or turned on its side. A cost lands, an advantage flips, a third party wants something, the plan survives contact but not intact. The destination is unchanged; the road is worse.',
    '- swerve: a genuine change of direction — a reveal, a betrayal, a jump in time or place, a force entering the story. It must still be SEEDED: point at the thing already on the page that makes it land instead of arriving from nowhere.',
  ].join('\n'),

  [
    'SIZE — the mistake to avoid above all others:',
    'A chapter is a MOVEMENT, not a moment. At the length you are given there is room for two or three scenes, or one sustained scene that turns at least once. One exchange, one gesture, one reveal is a BEAT — it fills a page, not a chapter, and an author handed a beat has been handed back the hardest part of the job.',
    'So every direction has three parts and you must fill all three. They are IN TIME ORDER: everything in `turn` happens after everything in `opens`, and everything in `lands` happens last of all.',
    '- opens: the situation the chapter starts in, and who wants what.',
    '- turn: what changes PARTWAY THROUGH — new information, a refusal, an arrival, a cost coming due. This is the part that makes it a chapter. Never skip it, and never make it a restatement of the opening.',
    "- lands: the last thing that happens. Concrete, not a mood.",
    'Equally, it must fit in ONE chapter. If a direction needs three chapters to pay off, name the part that fits and stop there.',
    'THE COMMON FAILURE, and it is worth checking for before you answer: the landing quietly rewinds. The turn has her at the almshouse gate questioning the driver, and then the landing says she walks toward the almshouse and the driver who will not meet her eye — the same ground, told twice, as though the landing were a summary of the whole chapter. It is not. It is the next thing that happens after the turn, and nothing else.',
  ].join('\n'),

  [
    'WHAT ELSE MAKES A DIRECTION GOOD:',
    '- It is specific to THIS novel. Name the people, places and objects already in it. If a sentence could be said of any story, it is not a direction.',
    "- It respects the pace of the chapter just read. Do not compress a month of story into the next one because the plot is ready for it.",
    '- The three are genuinely different — different CONSEQUENCES, not the same event at three volumes. If the author could pick any of them and get roughly the same chapter, you have failed.',
    '- Each carries its own turn. Three directions that share one turn are one direction.',
  ].join('\n'),

  [
    'NEVER:',
    '- Contradict the story bible. The dead stay dead, the ruined stay ruined, established rules hold.',
    '- Repeat a beat this chapter already spent. If the confrontation happened, do not stage it again.',
    '- Invent a named character, place or faction the novel has not established — unless the swerve introduces one deliberately, and even then only something the text has already gestured at.',
    '- Escalate all three. If this was a quiet chapter, at least one direction should stay quiet; if it was loud, at least one should let the story breathe.',
    '- Demand a character arc advance. An arc is a long horizon. You may offer it an opening; you may not make it the assignment.',
    '- Write prose, chapter titles, or commentary about your own suggestions.',
  ].join('\n'),

  [
    'HOW TO WRITE opens / turn / lands: they are joined end to end into ONE paragraph and sent to the writer exactly as you wrote them, so they must read as one continuous instruction — each following from the one before, in time order, none contradicting another.',
    'LENGTH: one or two sentences each, and about 80 to 120 words across all three. This is an instruction for a chapter, not a synopsis of one — leave the writer room to find the scene. Past that length you stop directing and start drafting, and a direction that drafts begins contradicting itself: a place named in the turn that the landing has already left, a person in two rooms at once.',
    'Write them the way an author writes: plain imperative, present tense. No preamble, no "in this chapter", no labels, no headings.',
    'THE RATIONALE FIELD is one sentence for the author only, on what this direction buys the story. It is never sent to the writer.',
  ].join('\n'),

  'Fill the reading object first, from the chapter text in front of you — it is what the three directions must be built out of. Then call propose_directions once. Nothing else.',
].join('\n\n');

const proposeToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'propose_directions',
    description:
      'Deliver your reading of the chapter just finished, then exactly three directions for the next one.',
    parameters: {
      type: 'object',
      properties: {
        reading: {
          type: 'object',
          description: 'Your reading of the chapter, from the text. Fill this before the directions.',
          properties: {
            endsOn: {
              type: 'string',
              description:
                'Where the chapter leaves the reader, concretely: who is where, mid-what, knowing what.',
            },
            openThreads: {
              type: 'array',
              description:
                'The unresolved threads, most pressing first. Name the person or thing in each. 2 to 6.',
              items: { type: 'string' },
            },
            pressure: {
              type: 'string',
              description: "What is about to force someone's hand, and whose hand.",
            },
            spent: {
              type: 'string',
              description:
                'The beats this chapter already used up, which the next chapter must not repeat.',
            },
          },
          required: ['endsOn', 'openThreads', 'pressure', 'spent'],
        },
        directions: {
          type: 'array',
          description:
            'Exactly three, one per move, in order: follow, complicate, swerve.',
          items: {
            type: 'object',
            properties: {
              move: { type: 'string', enum: [...SUGGESTION_MOVES] },
              title: { type: 'string', description: 'A handle, three to six words. No chapter numbers.' },
              opens: {
                type: 'string',
                description:
                  'How the chapter opens: who is on the page, where, and what they are trying to do. Write it as an instruction beginning "Open with…". One or two sentences.',
              },
              turn: {
                type: 'string',
                description:
                  'What changes partway through, following on from the opening — the thing that makes this a chapter rather than a beat. Never a restatement of the opening.',
              },
              lands: {
                type: 'string',
                description:
                  'What happens LAST, after everything in the turn — the closing action or image. Not a summary of the chapter, and never a repeat of ground the turn already covered.',
              },
              rationale: {
                type: 'string',
                description: 'One sentence for the author on what this buys the story.',
              },
            },
            required: ['move', 'title', 'opens', 'turn', 'lands', 'rationale'],
          },
        },
      },
      required: ['reading', 'directions'],
    },
  },
};

/**
 * Validate a proposal. Returns the three directions, or an error string that
 * goes back to the model as tool output — the same correctable-error contract
 * the bible and drift agents use, so a near miss is fixed rather than lost.
 */
function parseProposal(raw: Record<string, unknown>): ChapterSuggestion[] | string {
  const reading = raw.reading as Record<string, unknown> | undefined;
  if (!reading || !String(reading.endsOn ?? '').trim()) {
    return 'Error: reading.endsOn is required — say where the chapter leaves the reader before proposing anything.';
  }
  if (!Array.isArray(raw.directions)) return 'Error: directions must be an array of three objects.';
  if (raw.directions.length !== 3) {
    return `Error: exactly three directions are required, one per move (follow, complicate, swerve). You sent ${raw.directions.length}.`;
  }

  const out: ChapterSuggestion[] = [];
  const seen = new Set<string>();
  for (const item of raw.directions as unknown[]) {
    if (typeof item !== 'object' || item === null) return 'Error: every direction must be an object.';
    const d = item as Record<string, unknown>;
    const move = String(d.move ?? '').trim().toLowerCase();
    if (!(SUGGESTION_MOVES as readonly string[]).includes(move)) {
      return `Error: "${move}" is not a move. Use follow, complicate, or swerve.`;
    }
    if (seen.has(move)) {
      return `Error: two directions share the move "${move}". One of each, so the author is choosing how hard to turn.`;
    }
    seen.add(move);

    const title = String(d.title ?? '').trim();
    if (!title) return 'Error: every direction needs a title.';

    // The floor that stops a beat being handed over as a chapter. An empty or
    // one-clause `turn` is the specific failure worth naming back, because it
    // is the one a model reaches for when it is describing a moment.
    const parts: string[] = [];
    for (const field of ['opens', 'turn', 'lands'] as const) {
      const value = String(d[field] ?? '').trim();
      if (value.length < MIN_PART) {
        return field === 'turn'
          ? `Error: "${title}" has no turn — something must change partway through, or it is a beat and not a chapter. Say what changes.`
          : `Error: "${title}" needs a fuller ${field}: one or two sentences, concrete.`;
      }
      parts.push(value);
    }

    // Measured on what the model wrote, BEFORE the character caps trim it —
    // otherwise an overlong part is silently cut mid-sentence and passes the
    // check that exists to prevent exactly that.
    //
    // Length is not the point in itself. Past roughly this much the model stops
    // directing and starts drafting, and a drafting direction is where the
    // landing begins repeating the turn. Sending it back for a shorter one buys
    // the coherence, not just the size. Generous enough that a direction
    // written to the stated budget never sees it.
    const words = parts.join(' ').split(/\s+/).length;
    if (words > MAX_PROMPT_WORDS) {
      return (
        `Error: "${title}" runs to ${words} words across opens/turn/lands. That is a draft, not a ` +
        `direction. Rewrite it under ${MAX_PROMPT_WORDS} — say what happens and leave the writer ` +
        `room to find the scene.`
      );
    }

    out.push({
      move: move as SuggestionMove,
      title: clip(title, LIMITS.title),
      // Joined into the single editable block the author actually receives.
      // The per-part cap is a backstop for a lopsided direction that passed the
      // word count on the strength of two short parts.
      prompt: clip(parts.map((p) => clip(p, LIMITS.part)).join(' '), LIMITS.prompt),
      rationale: clip(String(d.rationale ?? '').trim(), LIMITS.rationale),
    });
  }

  // Presented in escalating order regardless of the order they arrived in, so
  // the dial reads left to right.
  out.sort((a, b) => SUGGESTION_MOVES.indexOf(a.move) - SUGGESTION_MOVES.indexOf(b.move));
  return out;
}

/**
 * A compact digest of the author's intent for their characters. Not the full
 * sheets: eight of those would swamp the chapter text, and what a direction
 * needs from a design is the engine (want/need/fear/lie) and where the arc
 * currently stands, not the wardrobe.
 */
function formatDesignDigest(designs: CharacterDesign[]): string {
  const shown = [...designs]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_DESIGNS)
    .sort((a, b) => a.name.localeCompare(b.name));

  return shown
    .map((d) => {
      const bits: string[] = [];
      if (d.essentials.role.trim()) bits.push(d.essentials.role.trim());
      const m = d.motivation;
      if (m.want.trim()) bits.push(`wants ${m.want.trim()}`);
      if (m.need.trim()) bits.push(`needs ${m.need.trim()}`);
      if (m.fear.trim()) bits.push(`fears ${m.fear.trim()}`);
      if (m.lie.trim()) bits.push(`believes ${m.lie.trim()}`);

      const arc = currentArc(d);
      const arcLine = arc
        ? ` Arc: ${deviceLabel(arc.device, arc.customLabel)}, stage ${arc.currentStage + 1}/${arc.stages.length}` +
          (arc.stages[arc.currentStage] ? ` "${arc.stages[arc.currentStage]}"` : '') +
          (arc.nudge.trim() ? ` — ${arc.nudge.trim()}` : '')
        : '';

      const unrevealed = d.history.secrets.filter((s) => !s.revealed && s.text.trim());
      const secretLine = unrevealed.length
        ? ` Not yet revealed: ${unrevealed.map((s) => s.text.trim()).slice(0, 3).join('; ')}`
        : '';

      return `- ${d.name}${bits.length ? ` — ${bits.join('; ')}` : ''}.${arcLine}${secretLine}`;
    })
    .join('\n');
}

export interface SuggestResult {
  usage: Usage;
  suggestions: ChapterSuggestion[];
}

/**
 * Read the chapter just accepted and propose three directions for the next one.
 *
 * Structurally read-only: it holds no write tool, so nothing it says can change
 * the novel. The author picks a direction, edits it, and sends it — the model
 * never puts words into a chapter on its own.
 */
export async function runSuggestions(args: {
  apiKey: string;
  novel: Novel;
  /** The chapter just accepted, with its full text. */
  chapter: Chapter;
  /** Earlier accepted chapters, oldest first — the run-up. */
  previous: Chapter[];
  bibleEntries: BibleEntry[];
  /** Active designs only. */
  designs: CharacterDesign[];
  signal?: AbortSignal;
  emit?: (event: AgentEvent) => void;
}): Promise<SuggestResult> {
  const emit = args.emit ?? (() => {});
  const { novel, chapter } = args;
  let total = EMPTY_USAGE;

  const runUp = args.previous
    .slice(-RECENT_SUMMARIES)
    .map(
      (c) =>
        `Chapter ${c.number}${c.title ? `: ${c.title}` : ''}\n${c.summary.trim() || '(no summary stored)'}`
    )
    .join('\n\n');

  const next = chapter.number + 1;
  // Stated as scenes as well as words, because "2200 words" is not a length a
  // model can feel, and the size mistake this guards against is structural.
  const scenes = Math.max(2, Math.round((novel.chapterLength || 2000) / 900));
  const lengthNote =
    novel.chapterLength > 0
      ? `Chapter ${next} will run about ${novel.chapterLength} words, like the ones before it — room for roughly ${scenes} scenes, so size each direction to fill that.`
      : `Chapter ${next} should run about as long as the chapter you are reading, so size each direction to fill it.`;

  const context = [
    `NOVEL: ${novel.title}`,
    novel.premise.trim() ? `PREMISE:\n${novel.premise.trim()}` : '',
    novel.styleNotes.trim() ? `AUTHOR'S NOTES:\n${novel.styleNotes.trim()}` : '',
    args.bibleEntries.length
      ? `STORY BIBLE — what the novel has established so far:\n${formatBibleIndex(args.bibleEntries)}`
      : '',
    args.designs.length
      ? [
          "CHARACTER DESIGNS — the author's intent, including things the novel has not revealed yet:",
          formatDesignDigest(args.designs),
          'You may offer an arc an opening. Never make advancing one the assignment.',
        ].join('\n')
      : '',
    runUp ? `THE CHAPTERS BEFORE THIS ONE:\n\n${runUp}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      // Context first, the chapter itself last: the chapter is what the reading
      // must come from, and last is where a model looks hardest.
      content:
        `${context}\n\n` +
        `THE CHAPTER JUST FINISHED — Chapter ${chapter.number}${chapter.title ? `: ${chapter.title}` : ''}\n\n` +
        `${chapter.content}\n\n` +
        `Propose three directions for chapter ${next}. ${lengthNote}`,
    },
  ];

  emit({ type: 'trace', data: `Reading chapter ${chapter.number} for what comes next…` });

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const result = await streamChat({
      role: 'suggestions',
      apiKey: args.apiKey,
      model: SUGGEST_MODEL,
      messages,
      tools: [proposeToolDefinition],
      // Forced every round: the proposal IS the deliverable, and there is
      // nothing useful this agent could say in prose instead.
      toolChoice: { type: 'function', function: { name: 'propose_directions' } },
      maxTokens: 2000,
      // Every chapter is a different prompt, so there is no cached prefix for a
      // pin to protect — and the preferred providers time out on a reply this
      // long often enough that pinning cost three requests where one would do.
      pinProvider: false,
      signal: args.signal,
    });
    total = addUsage(total, result.usage);

    const call = result.toolCalls[0];
    if (!call) {
      messages.push({ role: 'assistant', content: result.content || null });
      messages.push({ role: 'user', content: 'Call propose_directions now.' });
      continue;
    }

    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
    } catch {
      parsed = {};
    }

    const suggestions = parseProposal(parsed);
    if (typeof suggestions !== 'string') {
      console.log(
        `[suggest] novel=${novel.id} ch=${chapter.number} → ${next} ` +
          `cost=$${total.cost.toFixed(5)}`
      );
      emit({ type: 'trace', data: `Three directions ready for chapter ${next}` });
      return { usage: total, suggestions };
    }

    messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });
    messages.push({ role: 'tool', tool_call_id: call.id, content: suggestions });
  }

  throw new Error('The suggestion agent did not produce three usable directions.');
}
