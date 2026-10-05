import type { Quiz } from '../shared/types'

/**
 * The step-2 sample quiz: one question of every type, five-minute limit.
 *
 * The keys live here in the main process only. `toPublicQuestions` builds the
 * phone-facing list by whitelisting fields, so a key can never leak by being
 * forgotten to delete.
 */
export const SAMPLE_QUIZ: Quiz = {
  quizId: 'sample-1',
  title: 'Sample quiz',
  limitMs: 5 * 60 * 1000,
  questions: [
    {
      qid: 'q1',
      type: 'mcq',
      body: 'Which planet is known as the Red Planet?',
      points: 1,
      options: [
        { id: 'a', text: 'Venus' },
        { id: 'b', text: 'Mars' },
        { id: 'c', text: 'Jupiter' }
      ],
      key: 'b'
    },
    {
      qid: 'q2',
      type: 'tf',
      body: 'Water boils at 100 °C at sea level.',
      points: 1,
      key: true
    },
    {
      qid: 'q3',
      type: 'identification',
      body: 'Identify the capital of Japan.',
      points: 1,
      key: 'Tokyo'
    },
    {
      qid: 'q4',
      type: 'fillin',
      body: 'The chemical symbol for gold is ___ and for silver it is ___.',
      points: 2,
      blanks: 2,
      key: ['Au', 'Ag']
    },
    {
      qid: 'q5',
      type: 'enumeration',
      body: 'Name three primary colours.',
      points: 2,
      count: 3,
      key: ['red', 'green', 'blue']
    },
    {
      qid: 'q6',
      type: 'problem',
      body: 'A shirt costs 20 € and is discounted by 25 %. What is the final price?',
      points: 3,
      key: '15 €'
    },
    {
      qid: 'q7',
      type: 'matching',
      body: 'Match each animal to its food.',
      points: 3,
      left: [
        { id: 'l1', text: 'cat' },
        { id: 'l2', text: 'bee' },
        { id: 'l3', text: 'cow' }
      ],
      right: [
        { id: 'r1', text: 'grass' },
        { id: 'r2', text: 'nectar' },
        { id: 'r3', text: 'fish' }
      ],
      key: { l1: 'r3', l2: 'r2', l3: 'r1' }
    },
    {
      qid: 'q8',
      type: 'connect',
      body: 'Connect each prompt to its matching answer.',
      points: 3,
      prompts: [
        { id: 'p1', text: 'Square' },
        { id: 'p2', text: 'Circle' },
        { id: 'p3', text: 'Triangle' }
      ],
      answers: [
        { id: 'a1', text: 'Three sides' },
        { id: 'a2', text: 'Four equal sides' },
        { id: 'a3', text: 'No corners' },
        { id: 'a4', text: 'Decoy: nothing' }
      ],
      key: { p1: 'a2', p2: 'a3', p3: 'a1' }
    }
  ]
}