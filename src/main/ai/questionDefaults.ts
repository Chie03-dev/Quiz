import type { QuestionData, QuestionType, StoredKey } from '../../shared/types'

export interface QuestionDefault {
  body: string
  points: number
  data: QuestionData
  key: StoredKey
}

export const QUESTION_TYPE_DEFAULTS: Record<QuestionType, QuestionDefault> = {
  mcq: {
    body: 'Which planet is known as the Red Planet?',
    points: 1,
    data: {
      options: [
        { id: 'a', text: 'Venus' },
        { id: 'b', text: 'Mars' },
        { id: 'c', text: 'Jupiter' }
      ]
    },
    key: 'b'
  },
  tf: {
    body: 'Water boils at 100 °C at sea level.',
    points: 1,
    data: {},
    key: true
  },
  identification: {
    body: 'Identify the capital of Japan.',
    points: 1,
    data: {},
    key: ['Tokyo']
  },
  fillin: {
    body: 'The chemical symbol for gold is ___ and for silver it is ___.',
    points: 2,
    data: { blanks: 2 },
    key: [['Au'], ['Ag']]
  },
  enumeration: {
    body: 'Name three primary colours.',
    points: 2,
    data: { count: 3 },
    key: ['red', 'green', 'blue']
  },
  problem: {
    body: 'A shirt costs 20 € and is discounted by 25 %. What is the final price?',
    points: 3,
    data: {},
    key: { answer: '15 €' }
  },
  matching: {
    body: 'Match each animal to its food.',
    points: 3,
    data: {
      left: [
        { id: 'l1', text: 'cat' },
        { id: 'l2', text: 'bee' },
        { id: 'l3', text: 'cow' }
      ],
      right: [
        { id: 'r1', text: 'grass' },
        { id: 'r2', text: 'nectar' },
        { id: 'r3', text: 'fish' }
      ]
    },
    key: { l1: 'r3', l2: 'r2', l3: 'r1' }
  },
  connect: {
    body: 'Connect each prompt to its matching answer.',
    points: 3,
    data: {
      prompts: [
        { id: 'p1', text: 'Square' },
        { id: 'p2', text: 'Circle' },
        { id: 'p3', text: 'Triangle' }
      ],
      answers: [
        { id: 'a1', text: 'Three sides' },
        { id: 'a2', text: 'Four equal sides' },
        { id: 'a3', text: 'No corners' }
      ]
    },
    key: { p1: 'a2', p2: 'a3', p3: 'a1' }
  }
}
