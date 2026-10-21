import type { QuestionType } from '../../shared/types'

export const PROMPT_QUESTION_GENERATION = (input: {
  sourceText: string
  questionTypes: QuestionType[]
  count: number
  points: number
}): string => `
You are an expert quiz generator. Read the following source text and generate ${input.count} questions.
The questions must be of these types: ${input.questionTypes.join(', ')}.
Each question is worth ${input.points} points.

For each question, provide:
- The question type
- The question body text
- The answer key

Source text:
\`\`\`
${input.sourceText}
\`\`\`

Output a JSON array of questions. Each question object has:
- "type": one of mcq|tf|identification|fillin|enumeration|problem|matching|connect
- "body": the question text
- "points": ${input.points}
- "data": type-specific data (options for mcq, blanks for fillin, etc.)
- "key": the answer key
`

export const PROMPT_AUTO_KEY = (input: {
  questionBodies: string[]
  sourceText?: string
}): string => `
You are an expert at completing answer keys for quiz questions. For each question below, provide the correct answer key.

Source text (for context):
\`\`\`
${input.sourceText ?? 'Not provided'}
\`\`\`

Questions:
${input.questionBodies.map((b, i) => `${i + 1}. ${b}`).join('\n')}

Output a JSON array where each element is the answer key for the corresponding question.
The key shape depends on the question type:
- mcq: a single string (the option ID)
- tf: a boolean
- identification: a string
- fillin: a string array
- enumeration: a string array
- problem: an object with "answer" and optional "work"
- matching: an object mapping left IDs to right IDs
- connect: an object mapping prompt IDs to answer IDs
`
