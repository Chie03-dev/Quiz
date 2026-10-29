import type { QuestionType } from '../../shared/types'

/**
 * What a question of each type looks like in the JSON the model writes.
 *
 * The model is told the exact shape of "data" and "key" for the one type it
 * is asked for. The example is a template with <...> placeholders: a small
 * model copies a worked example word for word, and then the question is not
 * about the text at all.
 */
const TYPE_SHAPES: Record<
  QuestionType,
  { body: string; data: string; key: string; example: string }
> = {
  mcq: {
    body:
      'the question text. It asks about the source text and ends with a question mark.',
    data: '{"options":[{"id":"a","text":"..."},{"id":"b","text":"..."}]} - four options with the ids a, b, c and d. The correct option must be a phrase that is in the source text.',
    key: 'the id of the correct option, for example "a"',
    example:
      '{"type":"mcq","body":"<the question about the text>","points":1,' +
      '"data":{"options":[{"id":"a","text":"<option a from the text>"},{"id":"b","text":"<option b>"},' +
      '{"id":"c","text":"<option c>"},{"id":"d","text":"<option d>"}]},"key":"<the id of the correct option>"}'
  },
  tf: {
    body:
      'one short statement of at most 15 words about the source text that is either true or false. It must be a complete sentence ending with a period. It must NOT be a question: no "?" at the end and no words like "what", "which", "who" or "how" at the start. It must NOT repeat the source text.',
    data: '{} - an empty object',
    key: 'true or false, written as a JSON boolean',
    example:
      '{"type":"tf","body":"<the statement about the text>","points":1,"data":{},"key":true}'
  },
  identification: {
    body: 'the question text. It asks about the source text and ends with a question mark.',
    data: '{} - an empty object',
    key: 'a list of the accepted answers, copied word for word from the source text',
    example:
      '{"type":"identification","body":"What is the chemical symbol for gold?","points":1,' +
      '"data":{},"key":["Au"]}'
  },
  fillin: {
    body:
      'the question text with ___ exactly where the answer goes, and nothing else. It asks about the source text.',
    data: '{"blanks":N} - N is the number of ___ in the body',
    key: 'a list of N lists, one per blank, with only the words that fill the blank, copied word for word from the source text',
    example:
      '{"type":"fillin","body":"The symbol of gold is ___","points":1,' +
      '"data":{"blanks":1},"key":[["Au"]]}'
  },
  enumeration: {
    body:
      'the question text. It asks for several things from the source text and ends with a question mark.',
    data: '{"count":N} - N is the number of items the question asks for',
    key: 'a list of N short items, each one a phrase from the source text. The items are the answer, not the question',
    example:
      '{"type":"enumeration","body":"Which three things does the author like?","points":1,' +
      '"data":{"count":3},"key":["red","green","blue"]}'
  },
  problem: {
    body: 'the question text. It asks about the source text.',
    data: '{} - an empty object',
    key: 'an object with the final answer',
    example:
      '{"type":"problem","body":"<the question about the text>","points":1,' +
      '"data":{},"key":{"answer":"<the final answer>"}}'
  },
  matching: {
    body: 'the question text. It asks about the source text.',
    data: '{"left":[{"id":"l1","text":"..."}],"right":[{"id":"r1","text":"..."}]} - three items on each side',
    key: 'a map from a left id to a right id, for example {"l1":"r1","l2":"r2","l3":"r3"}',
    example:
      '{"type":"matching","body":"<the question about the text>","points":1,' +
      '"data":{"left":[{"id":"l1","text":"<left item 1>"}],"right":[{"id":"r1","text":"<right item 1>"}]},' +
      '"key":{"l1":"r1"}}'
  },
  connect: {
    body: 'the question text. It asks about the source text.',
    data: '{"prompts":[{"id":"p1","text":"..."}],"answers":[{"id":"a1","text":"..."}]} - three items on each side',
    key: 'a map from a prompt id to an answer id, for example {"p1":"a1","p2":"a2","p3":"a3"}',
    example:
      '{"type":"connect","body":"<the question about the text>","points":1,' +
      '"data":{"prompts":[{"id":"p1","text":"<prompt item 1>"}],"answers":[{"id":"a1","text":"<answer item 1>"}]},' +
      '"key":{"p1":"a1"}}'
  }
}

/**
 * The prompt for one question type. The model is asked for one type at a
 * time: a small model mixes the types up when it may choose.
 */
export const PROMPT_QUESTION_OF_TYPE = (input: {
  sourceText: string
  type: QuestionType
  count: number
  points: number
  /** An extra line for the second try, when the first one came back empty. */
  hint?: string
  /** The questions that were written already, so the model picks another fact. */
  avoid?: string[]
  /** The facts of the source text, one question per fact. */
  facts?: string[]
  /** The one sentence the question has to be about. */
  focus?: string
}): string => {
  const shape = TYPE_SHAPES[input.type]
  const avoid =
    input.avoid && input.avoid.length > 0
      ? `\nDo not ask about these again, they are used already:\n${input.avoid
          .map((b) => `- ${b}`)
          .join('\n')}\n`
      : ''
  const facts =
    input.facts && input.facts.length > 0
      ? `\nWrite one question about each of these facts of the text, in this order. The fact says what the question is about; the question itself is a sentence that ends with a question mark:\n${input.facts
          .map((f, i) => `${i + 1}. ${f}`)
          .join('\n')}\n`
      : ''
  const focus = input.focus
    ? `\nWrite one question about this sentence of the text. The question is about this sentence and nothing else:\n"${input.focus}"\n`
    : ''
  return `You are an expert quiz generator. Write ${input.count} quiz question(s) of the type "${input.type}" from the text below.

Rules:
- Answer with a JSON array and nothing else. No text before or after it.
- Every object in the array has the keys "type", "body", "points", "data" and "key".
- "type" must be exactly "${input.type}".
- "body" is ${shape.body}
- "points" is ${input.points}.
- "data" must be ${shape.data}.
- "key" must be ${shape.key}.
- The question and the answer must come from the source text. Never leave the answer empty and never write "1" as a placeholder.
- Fill in every <...> placeholder with words from the source text. The template shows the shape only.
${avoid}${facts}${focus}
Template:
${shape.example}

Source text:
"""
${input.sourceText}
"""

Now write ${input.count} ${input.type} question(s) about the source text above.
${input.hint ? `\n${input.hint}\n` : ''}`
}

/**
 * The separate facts of a text, so every question can be about another one.
 *
 * Notes are often one long sentence with no punctuation at all, so when the
 * text has no full stops the facts are cut at the words that start a new
 * thought ("and", "i", "im", ...).
 */
export function splitFacts(text: string): string[] {
  const sentences = text
    .split(/(?<=[.!?])\s+|\r?\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part.split(/\s+/).length >= 3)

  const facts: string[] = []
  const seen = new Set<string>()

  const push = (part: string): void => {
    const trimmed = part.replace(/^[\s,;:.!?-]+/, '').trim()
    if (trimmed.split(/\s+/).length < 2) return
    const key = trimmed.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    facts.push(trimmed)
  }

  for (const sentence of sentences) {
    // A long run-on sentence is cut further, at the words that start a new
    // thought. A short sentence is a fact of its own.
    if (sentence.split(/\s+/).length > 12) {
      const parts = sentence.split(/\s+(?:and|but|so|then|also|plus|im|i|my)\s+/i)
      if (parts.length > 1) {
        parts.forEach(push)
        continue
      }
    }
    push(sentence)
  }

  return facts
}

/** What the key of each question type looks like. */
const KEY_SHAPES: Record<QuestionType, string> = {
  mcq: 'the id of the correct option, for example "a"',
  tf: 'true or false, written as a JSON boolean',
  identification: 'a list of accepted answers, for example ["carbon dioxide"]',
  fillin: 'a list of one list per blank, for example [["Au"],["Ag"]]',
  enumeration: 'a list of accepted items, for example ["red","green","blue"]',
  problem: 'an object with "answer", for example {"answer":"15 EUR"}',
  matching: 'a map from a left id to a right id, for example {"l1":"r1"}',
  connect: 'a map from a prompt id to an answer id, for example {"p1":"a1"}'
}

/**
 * The prompt that completes the answer keys of questions that have none.
 *
 * The expected shape is written under every question, so a model does not
 * answer every question in the shape of the first one.
 */
export const PROMPT_AUTO_KEY = (input: {
  questions: { type: QuestionType; body: string; options?: { id: string; text: string }[] }[]
  sourceText?: string
}): string => {
  const lines = input.questions.map((q, i) => {
    const options =
      q.options && q.options.length > 0
        ? ` Options: ${q.options.map((o) => `${o.id}) ${o.text}`).join('  ')}`
        : ''
    return `${i + 1}. (${q.type}) ${q.body}${options}\n   The key is ${KEY_SHAPES[q.type]}`
  })

  return `You are an expert at completing answer keys for quiz questions. For each question below, write the correct answer key.

Answer with a JSON array and nothing else: one entry per question, in the same order as the questions. Every entry must have exactly the shape that is written under its question. For a multiple choice question, return ONLY the option id (such as a or b), never the option text.

${lines.join('\n')}

Example of the whole answer for a multiple choice, an identification and a true/false question:
[
  "a",
  ["carbon dioxide"],
  true
]

Source text (for context):
"""
${input.sourceText ?? 'Not provided'}
"""
`
}

