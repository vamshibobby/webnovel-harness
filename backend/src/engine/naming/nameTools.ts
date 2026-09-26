/**
 * `coin_name` — the tool the chapter writer calls before it names something.
 *
 * It is the only tool in this codebase that manufactures its answer rather than
 * reading one, and that difference is what makes it cheap enough to sit in the
 * middle of a streaming generation: the executor is synchronous local code, so
 * a call costs a fraction of a millisecond, no tokens and no network. The
 * author waits for nothing.
 *
 * The schema is deliberately small, and one omission in it is the whole design.
 * There is no `sound`, `syllables` or `vibe` parameter. Letting the model
 * specify the phonology would hand mode collapse straight back — it would ask
 * for what it always asks for — and byte-pair tokenization means it could not
 * reliably honour its own request anyway. The charter fixes the sound world; a
 * PRNG draws the shape; the model chooses between finished names.
 */

import { BIBLE_ENTRY_TYPES, type BibleEntryType } from '../../lib/types.js';
import type { ToolDefinition } from '../openrouter.js';
import { resolveCulture, type NamingCharter } from './charter.js';
import { generateSlate } from './generator.js';

export const coinNameToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'coin_name',
    description:
      'Get candidate names for something you are about to introduce and name for the first time — ' +
      'a person, place, faction, item, weapon, creature, technique, concept or event. Call it ' +
      'BEFORE you begin the passage that names the thing. It returns names built to this novel’s ' +
      'naming rules and checked against every name already in it. Pick one, or blend two. Do not ' +
      'name anything new without calling this first.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          description: 'What sort of thing needs the name.',
          enum: [...BIBLE_ENTRY_TYPES],
        },
        brief: {
          type: 'string',
          description:
            'One line: what it is, who in the world would have named it, and what it should feel ' +
            'like. e.g. "a mountain pass the northern clans use for winter trade, harsh and old".',
        },
        culture: {
          type: 'string',
          description:
            'The people, region or faction it belongs to, if the novel has more than one. Omit ' +
            'when it does not matter.',
        },
        count: {
          type: 'integer',
          description: 'How many candidates to return, 3 to 10. Defaults to 6.',
        },
      },
      required: ['kind', 'brief'],
    },
  },
};

export interface CoinNameArgs {
  kind: BibleEntryType;
  brief: string;
  culture?: string;
  count: number;
}

/** Read the model's arguments, clamping everything it can get wrong. */
export function parseCoinArgs(raw: Record<string, unknown>): CoinNameArgs {
  const kind = String(raw.kind ?? '').trim().toLowerCase();
  const count =
    typeof raw.count === 'number' && Number.isFinite(raw.count)
      ? Math.min(Math.max(Math.round(raw.count), 3), 10)
      : 6;
  return {
    kind: (BIBLE_ENTRY_TYPES as readonly string[]).includes(kind)
      ? (kind as BibleEntryType)
      : 'character',
    brief: String(raw.brief ?? '').trim().slice(0, 300),
    culture: raw.culture ? String(raw.culture).trim().slice(0, 80) : undefined,
    count,
  };
}

export interface CoinNameContext {
  novelId: string;
  charter: NamingCharter;
  /** Every name the novel has already spent. */
  taken: readonly string[];
  /** Distinguishes repeat calls in one generation. */
  nonce: number;
}

export interface CoinNameOutput {
  /** What the model reads. */
  text: string;
  /** The names offered, so the caller can mark them spent without re-parsing. */
  offered: string[];
}

/**
 * Run the tool. Pure and synchronous.
 *
 * The output is prose rather than JSON because a writer reads it mid-draft, and
 * the three things it has to carry are the register, the candidates, and the
 * names it must not reuse. The last of those is doing real work: the generator
 * has already rejected anything close to them, and restating them is what stops
 * the model overriding its slate with the name it would have picked anyway.
 *
 * `offered` rides alongside the text rather than being recovered from it. The
 * caller needs the list — everything shown is spent for the rest of the
 * generation, whether or not the model takes it — and re-parsing formatted
 * output to get back a value the function already had is a bug waiting for
 * someone to adjust the column alignment.
 */
export function runCoinName(args: CoinNameArgs, ctx: CoinNameContext): CoinNameOutput {
  const culture = resolveCulture(ctx.charter, args.culture);
  const slate = generateSlate({
    novelId: ctx.novelId,
    cultureId: culture.id,
    soundWorldId: culture.soundWorldId,
    pack: ctx.charter.pack,
    type: args.kind,
    brief: args.brief,
    count: args.count,
    taken: ctx.taken,
    banned: ctx.charter.banned,
    nonce: ctx.nonce,
  });

  const width = Math.max(...slate.candidates.map((c) => c.name.length), 0);
  const lines: string[] = [`NAMES FOR: ${args.kind}${args.brief ? ` — ${args.brief}` : ''}`];

  if (ctx.charter.cultures.length > 1) lines.push(`Culture: ${culture.label}.`);
  lines.push(`Register: ${slate.spec.register}`, `Shape: ${slate.spec.shape}`);
  if (ctx.charter.notes.trim()) lines.push(`The author's rule: ${ctx.charter.notes.trim()}`);

  lines.push('', 'CANDIDATES — pick one, or blend two. Do not use a name that is not on this list:');
  for (const [i, c] of slate.candidates.entries()) {
    lines.push(`  ${i + 1}. ${c.name.padEnd(width)}   ${c.note}`);
  }

  /*
   * Left to itself a model takes the strangest name on the slate every time.
   * Asked for a school it will pass over "The Ash School" for "Briopros
   * Conservatory", on the reasoning that the plain one is not trying hard
   * enough — and a world in which nothing is plainly named is as monotone as
   * one in which everything is, just in the other direction.
   *
   * Real places are mixed. Some are called what they are and some carry a name
   * nobody can parse any more, and which a given thing gets is mostly an
   * accident of who was there first. So the instruction is about the NOVEL's
   * balance rather than this one name: an ordinary name here is not a failure
   * of imagination, it is what makes the strange ones land.
   */
  lines.push(
    '',
    'Some of these are plain and some are invented, and that is the point. Choose whichever ' +
      'genuinely fits this thing and who named it — the ordinary word is often right, especially ' +
      'for something ordinary people use daily. Across the novel you want a mix: if the last few ' +
      'things you named were strange, take the plain one here.'
  );

  if (slate.nearby.length) {
    lines.push(
      '',
      'ALREADY IN THIS NOVEL — do not reuse one of these, and do not coin something that rhymes with one:',
      `  ${slate.nearby.join(', ')}`
    );
  }

  // The parts, so a name can MEAN the thing rather than merely sound right for
  // the world. Every word here came out of this world's own vocabulary, so
  // recombining stays in register by construction — there is nothing on this
  // list that could produce a name from somewhere else.
  const palette = slate.palette;
  if (palette.stems.length || palette.words.length) {
    lines.push('', 'OR BUILD YOUR OWN from these parts, if none of the above fits what this is:');
    if (palette.stems.length) lines.push(`  invented words: ${palette.stems.join(', ')}`);
    for (const { bank, options } of palette.words) {
      if (options.length) lines.push(`  ${bank}: ${options.join(', ')}`);
    }
    // Without these a writer can pick "Crushing" and "Fist" and have no legal
    // way to say "Nine Crushing Fist Form" — the numerals and the kind-of-thing
    // words are half of what a technique name is made of.
    if (palette.structural.length) lines.push(`  joining words: ${palette.structural.join(', ')}`);
    lines.push(
      '  Combine them the way the candidates above are combined. Use no word that is not on ' +
        'this list or in a candidate.'
    );
  }

  lines.push('', 'Once you have chosen, spell it the same way every time it appears in this chapter.');
  return { text: lines.join('\n'), offered: slate.candidates.map((c) => c.name) };
}
