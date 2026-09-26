/**
 * The standard questions a power system is designed from.
 *
 * One catalog, two consumers: the Generate wizard renders these as cards with
 * option chips, and the generator embeds the same text in its prompt via
 * formatAnswersBlock — so what the author was asked and what the model was
 * told can never drift apart. The designCatalog contract.
 *
 * Mirrored at frontend/src/lib/powerCatalog.ts — keep the two in step.
 */

export interface PowerQuestion {
  id: string;
  /** Shown to the author AND embedded in the prompt. */
  question: string;
  /** One line under the field. */
  hint: string;
  /** Suggested answers rendered as chips; free text is always allowed. */
  options: string[];
}

export const POWER_QUESTIONS: readonly PowerQuestion[] = [
  {
    id: 'energy',
    question: 'What powers abilities in this world?',
    hint: 'The resource everything else is priced in.',
    options: ['qi / spiritual energy', 'mana', 'soul or lifeforce', 'divine grace', 'technology', 'no single energy'],
  },
  {
    id: 'ladder',
    question: 'What shape is the ladder?',
    hint: 'How progress is named and counted.',
    options: [
      'named tiers with breakthroughs',
      'numeric levels',
      'ranks and orders (knight, master…)',
      'grades of a gift people are born with',
    ],
  },
  {
    id: 'advancement',
    question: 'How does someone climb it?',
    hint: 'The engine of the whole story — what a training arc is made of.',
    options: [
      'accumulation, then a breakthrough',
      'trials and deeds',
      'bestowed by an institution or being',
      'bloodline or talent decides the ceiling',
    ],
  },
  {
    id: 'ceiling',
    question: 'How strong is the top of the ladder?',
    hint: 'Sets the scale of every fight you will ever write.',
    options: ['peak human', 'city-shaking', 'nation-shaking', 'world-shaking or cosmic'],
  },
  {
    id: 'cost',
    question: 'What does power cost?',
    hint: 'The price is what keeps power interesting.',
    options: ['years of lifespan', 'scarce resources', 'humanity or sanity', 'time and toil only'],
  },
  {
    id: 'access',
    question: 'Who can walk this path?',
    hint: 'Decides how special the protagonist is.',
    options: ['anyone who trains', 'the talented few', 'specific bloodlines', 'whoever can pay'],
  },
  {
    id: 'institutions',
    question: 'Who teaches and gatekeeps it?',
    hint: 'Power structures are story structures.',
    options: ['sects', 'guilds', 'the state or military', 'churches', 'no one — it is wild knowledge'],
  },
  {
    id: 'distribution',
    question: 'How steep is the pyramid?',
    hint: 'How rare is each level, out in the world?',
    options: [
      'most people have nothing',
      'everyone has a little, few have much',
      'power is common but mastery is rare',
    ],
  },
] as const;

/**
 * Answers as the generator's prompt block. Unanswered questions are stated as
 * the model's to decide — silence from the author is a delegation, not a gap.
 */
export function formatAnswersBlock(answers: Array<{ id: string; answer: string }>): string {
  const byId = new Map(answers.map((a) => [a.id, a.answer.trim()]));
  const lines: string[] = [];
  for (const q of POWER_QUESTIONS) {
    const answer = byId.get(q.id);
    lines.push(
      answer
        ? `Q: ${q.question}\nA: ${answer}`
        : `Q: ${q.question}\nA: (unanswered — decide it yourself, from the premise)`
    );
  }
  return lines.join('\n');
}
