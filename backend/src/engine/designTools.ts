import { currentArc } from '../lib/designValidate.js';
import type { BibleEntry, CharacterDesign } from '../lib/types.js';
import { ARC_DEVICES, CUSTOM_DEVICE_ID, deviceLabel } from './designCatalog.js';
import type { ToolDefinition } from './openrouter.js';

/**
 * Character design tools.
 *
 * The chapter-writing agent gets exactly one — get_character_design — and only
 * when active designs exist. Everything else here is formatting: the index
 * line that makes the tool discoverable, and the sheet itself, whose two-part
 * shape is the feature's safety mechanism.
 */

export const getDesignToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'get_character_design',
    description:
      "Fetch the author's CHARACTER DESIGN sheet(s) by name — their intended motivation (what " +
      'they want vs what they need, their fear, the lie they believe), personality, VOICE, ' +
      'backstory and secrets, planned character arcs with the current stage, and intended ' +
      'relationships. Use this before writing a scene that features a designed character, ' +
      'especially for voice, motivation, and where their arc currently stands. A design is ' +
      'authorial INTENT and partly future-facing: prefer the story bible and previous chapters ' +
      'for established canon facts, and when design and canon disagree, canon wins. Sections ' +
      'marked AUTHOR-PRIVATE (unrevealed secrets, arc plans, intended future relationships) may ' +
      'shape how a character behaves, but must NEVER be stated, narrated, or revealed to the reader.',
    parameters: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Character names from the CHARACTER DESIGNS index.',
        },
      },
      required: ['names'],
    },
  },
};

/**
 * The assist agent's write tool. Its parameter schema is the structured-output
 * enforcement for a design — and note what it CANNOT express: `state` and
 * `steer` are absent, so no agent can activate a design or press its arc into
 * generation. Those stay author actions.
 */
export const updateDesignToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'update_character_design',
    description:
      'Write to the character design you are working on. Send ONLY the sections you are filling ' +
      'or changing; omitted sections are left exactly as the author wrote them. Lists you do ' +
      'send (arcs, secrets, relationships, traits) REPLACE the existing list, so include the ' +
      'full set you intend to keep.',
    parameters: {
      type: 'object',
      properties: {
        essentials: {
          type: 'object',
          properties: {
            role: { type: 'string', description: 'Their function in the story: protagonist, rival, mentor…' },
            age: { type: 'string' },
            appearance: { type: 'string', description: 'The two or three details a reader would recognise them by.' },
            voice: {
              type: 'string',
              description:
                'How they actually speak: rhythm, register, verbal tics, what they never say. ' +
                'Concrete enough to write dialogue from — not adjectives.',
            },
          },
        },
        motivation: {
          type: 'object',
          properties: {
            want: { type: 'string', description: 'What they are consciously pursuing.' },
            need: { type: 'string', description: 'What would actually make them whole. Rarely the same as want.' },
            fear: { type: 'string', description: 'What they will not face.' },
            lie: {
              type: 'string',
              description: 'The false thing they believe about themselves or the world that keeps want and need apart.',
            },
          },
        },
        personality: {
          type: 'object',
          properties: {
            traits: { type: 'array', items: { type: 'string' } },
            flaws: { type: 'array', items: { type: 'string' }, description: 'Must be capable of costing them something.' },
            virtues: { type: 'array', items: { type: 'string' } },
          },
        },
        history: {
          type: 'object',
          properties: {
            backstory: { type: 'string', description: 'Their past before the novel opens. Must not contradict the story bible.' },
            secrets: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  revealed: {
                    type: 'boolean',
                    description: 'True only if the story has already shown this to the reader.',
                  },
                },
                required: ['text'],
              },
            },
          },
        },
        arcs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              device: {
                type: 'string',
                enum: [...ARC_DEVICES.map((d) => d.id), CUSTOM_DEVICE_ID],
                description: 'The narrative device this arc follows.',
              },
              customLabel: { type: 'string', description: 'Required only when device is "custom".' },
              summary: { type: 'string', description: 'This arc for THIS character, in a sentence or two.' },
              stages: {
                type: 'array',
                items: { type: 'string' },
                description:
                  "2-7 ordered beats, adapted from the device's typical beats to this story and character.",
              },
              currentStage: { type: 'number', description: 'Index of the beat the story is at now. 0 if it has not started.' },
              nudge: {
                type: 'string',
                description:
                  'One line telling the chapter writer how to lean on this arc — a direction, not an instruction to force.',
              },
              state: {
                type: 'string',
                enum: ['potential', 'current', 'done', 'dropped'],
                description: 'At most ONE arc may be "current". Use "potential" for arcs the story has not begun.',
              },
            },
            required: ['device', 'stages', 'state'],
          },
        },
        relationships: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              targetId: { type: 'string', description: 'A story bible entry id, or another design id.' },
              targetKind: { type: 'string', enum: ['bible', 'design'] },
              nature: { type: 'string', description: 'What the relationship is now.' },
              intent: { type: 'string', description: 'Where the author wants it to go. Author-private.' },
            },
            required: ['targetId', 'targetKind', 'nature'],
          },
        },
        notes: { type: 'string', description: 'Anything else worth keeping, including conflicts you noticed but did not resolve.' },
      },
      required: [],
    },
  },
};

// ── Formatting ────────────────────────────────────────────────────────────

/**
 * One line per active design, sent with every generation call. Its whole job
 * is discoverability: the model cannot fetch a sheet for a character it does
 * not know has one. Terse on purpose — this is the recurring cost.
 */
export function formatDesignIndexLine(design: CharacterDesign, entry?: BibleEntry | null): string {
  const bits = [design.name];
  // Age is the one essential worth its bytes in the recurring line rather than
  // behind the tool. It is short, it is the fact that decides how a character
  // is allowed to SOUND, and the writer was previously blind to it in the
  // common path: a design's sheet only enters the prompt if the model elects to
  // fetch it, so a chapter written without that call had twelve-year-olds
  // speaking like veterans and nothing in the context to say otherwise.
  // Clamped because the field is free text and this line is paid for on every
  // chapter — "twelve" and "appears thirty, is four hundred" both survive it.
  const age = design.essentials.age.trim();
  if (age) bits.push(`age ${age.slice(0, 40)}`);
  if (design.essentials.voice.trim()) bits.push('voice ✓');

  const arc = currentArc(design);
  if (arc) {
    const stage = `stage ${arc.currentStage + 1}/${arc.stages.length}`;
    bits.push(`arc: ${deviceLabel(arc.device, arc.customLabel)} (${stage})`);
    if (design.steer) bits.push('steered');
  } else {
    bits.push('no current arc');
  }

  // A design whose character canon has already killed would otherwise be
  // steered blind; the bible is the authority on that, so it rides along.
  const status = entry?.status?.trim();
  if (status && /dead|destroyed|deceased|killed/i.test(status)) {
    bits.push(`bible status: ${status}`);
  }
  return bits.join(' · ');
}

function labelledList(label: string, items: string[]): string {
  return items.length ? `${label}: ${items.join(', ')}` : '';
}

/**
 * The full sheet, split into what may reach the page and what may not.
 *
 * The split is the point. A design holds the character's unrevealed secrets
 * and the destination of their arc; handed over as one flat block, those are
 * exactly the details a model narrates. Separating them — and saying plainly
 * what each half is for — is what makes it safe to give the writer this much
 * about a character's future.
 */
export function formatDesignSheet(
  design: CharacterDesign,
  resolveTarget: (targetId: string, kind: 'bible' | 'design') => string
): string {
  const e = design.essentials;
  const m = design.motivation;
  const p = design.personality;
  const revealed = design.history.secrets.filter((s) => s.revealed);
  const hidden = design.history.secrets.filter((s) => !s.revealed);

  const safe = [
    e.role && `role: ${e.role}`,
    e.age && `age: ${e.age}`,
    e.appearance && `appearance: ${e.appearance}`,
    e.voice && `voice: ${e.voice}`,
    labelledList('traits', p.traits),
    labelledList('virtues', p.virtues),
    design.history.backstory && `backstory: ${design.history.backstory}`,
    revealed.length && `already revealed to the reader:\n${revealed.map((s) => `  - ${s.text}`).join('\n')}`,
    design.relationships.length &&
      `relationships:\n${design.relationships
        .map((r) => `  - ${r.nature} → ${resolveTarget(r.targetId, r.targetKind)}`)
        .join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n');

  const arcLines = design.arcs
    .filter((a) => a.state === 'current' || a.state === 'potential')
    .map((a) => {
      const head = `  - [${a.state}] ${deviceLabel(a.device, a.customLabel)}${a.summary ? ` — ${a.summary}` : ''}`;
      const stage =
        a.state === 'current'
          ? `\n    now at stage ${a.currentStage + 1}/${a.stages.length}: "${a.stages[a.currentStage] ?? ''}"`
          : '';
      const plan = a.stages.length ? `\n    planned beats: ${a.stages.join(' → ')}` : '';
      const nudge = a.nudge ? `\n    nudge: ${a.nudge}` : '';
      return head + stage + plan + nudge;
    });

  const intents = design.relationships.filter((r) => r.intent.trim());

  const priv = [
    labelledList('flaws', p.flaws),
    m.want && `wants: ${m.want}`,
    m.need && `needs (often without knowing it): ${m.need}`,
    m.fear && `fears: ${m.fear}`,
    m.lie && `the lie they believe: ${m.lie}`,
    (m.want || m.need || m.lie) &&
      '  → express these only through action, choice and subtext. Never state them.',
    hidden.length &&
      `secrets NOT yet revealed to the reader:\n${hidden.map((s) => `  - ${s.text}`).join('\n')}`,
    arcLines.length && `planned arcs:\n${arcLines.join('\n')}`,
    intents.length &&
      `where the author wants relationships to go:\n${intents
        .map((r) => `  - ${resolveTarget(r.targetId, r.targetKind)}: ${r.intent}`)
        .join('\n')}`,
    design.notes && `author's notes: ${design.notes}`,
  ]
    .filter(Boolean)
    .join('\n');

  const header = [
    `CHARACTER DESIGN: ${design.name}`,
    "This is the author's intent for this character. Canon in the written chapters always wins over it.",
  ].join('\n');

  return [
    header,
    '',
    '== SAFE TO SHOW (established, or free to express on the page) ==',
    safe || '(nothing filled in yet)',
    '',
    '== AUTHOR-PRIVATE — informs behaviour; NEVER narrate, state, or foreshadow openly ==',
    priv || '(nothing filled in yet)',
  ].join('\n');
}

/** Case-insensitive match on name or id, so index names are enough to fetch. */
export function matchDesignsByName(designs: CharacterDesign[], names: string[]): CharacterDesign[] {
  const needles = names.map((n) => n.trim().toLowerCase()).filter(Boolean);
  return designs.filter((d) =>
    needles.some((n) => d.name.toLowerCase() === n || d.id === n || d.name.toLowerCase().includes(n))
  );
}

/**
 * Resolver for relationship targets: ids are storage detail, names are what a
 * writer can use. An unresolvable id (a deleted entry) renders as a label
 * rather than throwing — a broken link is not worth failing a chapter over.
 */
export function makeTargetResolver(
  bible: BibleEntry[],
  designs: CharacterDesign[]
): (targetId: string, kind: 'bible' | 'design') => string {
  return (targetId, kind) => {
    const found =
      kind === 'bible'
        ? bible.find((b) => b.id === targetId)?.name
        : designs.find((d) => d.id === targetId)?.name;
    return found ?? `${targetId} (no longer in the story bible)`;
  };
}
