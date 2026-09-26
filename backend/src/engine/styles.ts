/**
 * Writing styles — the "dial" a novel is set to at creation.
 *
 * These are prose registers, not genres. Genre (cultivation, LitRPG, romance,
 * whatever) belongs in the novel's premise and author's notes, because a
 * cultivation story can be told in plain web-serial prose or in an elevated
 * mythic register and those are genuinely different books. The dial controls
 * *how the sentences sound*: word choice, sentence and paragraph length, how
 * much interiority, how much description, how figurative the language is.
 *
 * The chosen style is baked into the system prompt, which is the cache prefix
 * shared by every chapter of the novel. Changing it mid-novel would invalidate
 * that prefix and break the book's voice halfway through, so it is set once
 * and locked.
 *
 * Each block is concrete mechanics rather than adjectives about tone: "short
 * sentences, one to three sentence paragraphs" steers a model; "evocative and
 * immersive" does not.
 */

export type StyleKey = 'webnovel' | 'literary' | 'cinematic' | 'pulp' | 'mythic' | 'wry';

export interface NovelStyle {
  key: StyleKey;
  label: string;
  /** One-line description for the picker. */
  blurb: string;
  /** The register readers will recognise. */
  examples: string;
  /** The directive block injected into the system prompt. */
  prompt: string;
}

export const DEFAULT_STYLE: StyleKey = 'webnovel';

export const NOVEL_STYLES: Record<StyleKey, NovelStyle> = {
  webnovel: {
    key: 'webnovel',
    label: 'Web Novel',
    blurb: 'Clear, natural modern English. Easy to read, never choppy.',
    examples: 'the plain, readable prose of popular serialised fiction',
    prompt: [
      'STYLE: Web novel — clear, natural, modern English.',
      '- Write the way you would tell a friend what happened: plain, direct and easy to follow. Everyday vocabulary. Never reach for an ornate or antique word.',
      '- Use complete, properly formed sentences. Most should run about twelve to twenty-five words. Vary the length — a short sentence only lands when the sentences around it are not also short.',
      '- Do NOT write in clipped, choppy, telegraphic bursts. Avoid runs of three- and four-word sentences, and avoid sentence fragments except where someone is genuinely cut off.',
      '- Paragraphs usually run three to six sentences. Save the one-line paragraph for a moment that has earned the emphasis.',
      '- Dialogue must sound like a real person talking: contractions, complete thoughts, the occasional digression or unnecessary word. Let people finish their sentences. Avoid clipped one-word exchanges and avoid everyone speaking in the same terse register.',
      '- Give speech a little room — a line of dialogue can run a full sentence or two, with a small gesture or bit of business around it so a scene is not a bare list of quotes.',
      '- Keep the PROSE modern even when the world is not. In a historical, fantasy, cultivation or far-future setting the characters use that world\'s words for things — ranks, places, titles, techniques — but the sentence construction, grammar and vocabulary stay contemporary and plain. Never write "thee", "thou", "\'tis", "mayhap", or inverted archaic phrasing, and never let a formal setting make the narration formal.',
      '- Be clear about what is happening. The reader should always know who is speaking, where they are, and what just changed.',
      '- Very little metaphor. Describe things plainly and move on. Say a thing once, then trust it.',
    ].join('\n'),
  },

  literary: {
    key: 'literary',
    label: 'Literary',
    blurb: 'Dense and interior. Meaning carried by image and implication.',
    examples: 'contemporary literary fiction',
    prompt: [
      'STYLE: Literary.',
      '- Let concrete images carry the meaning. Imply rather than state, and never explain a moment you have already dramatised.',
      '- Vary sentence length with intent. Long sentences with subordinate clauses are welcome where the rhythm earns them; a short sentence after a long one lands like a full stop in the chest.',
      '- Stay inside one character\'s perception for the whole scene. What they notice — and what they fail to notice — is the characterisation.',
      '- Choose words precisely. Uncommon is fine when it is exact; showy is not. Cut any word doing no work.',
      '- Leave things unsaid and let ambiguity stand. Trust the reader with unresolved feeling and unstated motive.',
      '- Dialogue is oblique. People talk around the thing that matters, and the subtext does the work.',
      '- Interiority and close observation can carry a scene in which little visibly happens.',
    ].join('\n'),
  },

  cinematic: {
    key: 'cinematic',
    label: 'Cinematic',
    blurb: 'Camera-eye. Action, gesture and dialogue, almost no interiority.',
    examples: 'thriller and screenplay-style prose',
    prompt: [
      'STYLE: Cinematic.',
      '- Write only what a camera could record: movement, gesture, expression, and what is said aloud.',
      '- No interiority. Never state a thought or a feeling; show the behaviour that implies it and let the reader do the rest.',
      '- Keep sentences concrete and active, in the order things happen. Present one beat, then the next.',
      '- Short paragraphs — each is a shot, and the white space between them is a cut.',
      '- Cut hard between scenes. Skip arrivals, departures, travel, and anything a film would trim.',
      '- Dialogue carries the emotion and most of the exposition. Keep speeches short and let people talk over each other.',
      '- Describe the setting only through what the action touches.',
    ].join('\n'),
  },

  pulp: {
    key: 'pulp',
    label: 'Pulp',
    blurb: 'Terse, punchy and wry. Short declaratives with attitude.',
    examples: 'hardboiled crime and pulp adventure',
    prompt: [
      'STYLE: Pulp / hardboiled.',
      '- Short, declarative sentences with muscle in them. Cut adverbs, hedges and qualifiers.',
      '- Concrete nouns and active verbs. No abstraction, no philosophising, no throat-clearing before a scene starts.',
      '- The narration has a voice: dry, unimpressed, quick to size up a person or a room in one line.',
      '- One sharp wry observation per scene. More than that and it curdles into shtick.',
      '- State violence, money and danger flatly. Understatement carries the weight.',
      '- Dialogue is fast and hits back. People needle each other and nobody makes speeches.',
      '- End scenes on a hard beat: a line of dialogue, or a short blunt sentence.',
    ].join('\n'),
  },

  mythic: {
    key: 'mythic',
    label: 'Mythic',
    blurb: 'Elevated and formal, told with the weight of legend.',
    examples: 'high fantasy and translated epic',
    prompt: [
      'STYLE: Mythic / epic register.',
      '- Narrate at a slight remove, as someone recounting events long past and already famous.',
      '- Use long, cadenced sentences with parallel structure and deliberate repetition. Rhythm matters as much as sense.',
      '- Name places, lineages and objects with weight, and let the land and its history feel present in the scene.',
      '- Formal register: avoid contractions and modern idiom in the narration. Dialogue may be plainer but stays dignified.',
      '- Archaism through cadence, never through vocabulary. Do not write "thee", "thou", "mayhap" or mock-medieval spelling.',
      '- Understate emotion and let the scale of events supply the feeling.',
      '- Description is grand but specific: this river, this gate, this name — not generic grandeur.',
    ].join('\n'),
  },

  wry: {
    key: 'wry',
    label: 'Dry & Comic',
    blurb: 'Deadpan narration that never signals the joke.',
    examples: 'comic fantasy and deadpan satire',
    prompt: [
      'STYLE: Dry / deadpan comic.',
      '- Narrate calamity calmly and trivial inconveniences with enormous seriousness. The gap between tone and event is the joke.',
      '- Comic timing is sentence order: the surprising word goes last.',
      '- Allow brief asides and digressions — about one per scene — then return to the story promptly.',
      '- Characters treat absurd situations as entirely reasonable and argue about procedure and paperwork.',
      '- Never signal a joke, explain it, or let the narrator enjoy its own line.',
      '- Dialogue is straight-faced. The funniest character is the one who believes they are being helpful.',
      '- The plot must still advance and the stakes must still be real, or the comedy has nothing to push against.',
    ].join('\n'),
  },
};

export function isStyleKey(value: unknown): value is StyleKey {
  return typeof value === 'string' && value in NOVEL_STYLES;
}

/** Falls back to the default so novels without a stored style still work. */
export function styleFor(key: string | undefined | null): NovelStyle {
  return isStyleKey(key) ? NOVEL_STYLES[key] : NOVEL_STYLES[DEFAULT_STYLE];
}

/** Picker metadata for the UI — deliberately excludes the prompt text. */
export function listStyles(): Array<Omit<NovelStyle, 'prompt'>> {
  return Object.values(NOVEL_STYLES).map(({ key, label, blurb, examples }) => ({
    key,
    label,
    blurb,
    examples,
  }));
}
