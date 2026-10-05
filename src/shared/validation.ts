import type { ProblemKey, StoredKey, StoredQuestion, StoredQuiz } from './types'

/**
 * Step-4 validation (pure, shared by the editor UI, the main process on save,
 * import, and start). A question with no problems is 'ready'; anything else
 * stays 'draft' and blocks starting the quiz.
 */

/** Number of ___ blanks in a fill-in body. The body is the source of truth. */
export function countBlanks(body: string): number {
  const matches = body.match(/___/g)
  return matches ? matches.length : 0
}

const isNonEmpty = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0

const isStringMap = (v: unknown): v is Record<string, string> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) &&
  Object.entries(v).every(([k, val]) => typeof k === 'string' && typeof val === 'string')

const isChoiceArray = (v: unknown): v is { id: string; text: string }[] =>
  Array.isArray(v) &&
  v.every(
    (c) =>
      typeof c === 'object' && c !== null &&
      typeof (c as { id?: unknown }).id === 'string' &&
      typeof (c as { text?: unknown }).text === 'string'
  )

/**
 * Pairing rule shared by matching and connect: every from-item (left/prompt)
 * must point at a known to-item (right/answer), and no to-item is used twice.
 * Extra to-items (right decoys / unused answers) are fine.
 */
function validatePairing(q: StoredQuestion, from: 'left' | 'prompts', to: 'right' | 'answers'): string[] {
  const problems: string[] = []
  const fromLabel = from === 'left' ? 'left item' : 'prompt'
  const toLabel = to === 'right' ? 'right item' : 'answer'
  const fromList = q.data[from] ?? []
  const toList = q.data[to] ?? []

  if (fromList.length === 0) problems.push(`needs at least one ${fromLabel}`)
  if (toList.length === 0) problems.push(`needs at least one ${toLabel}`)
  fromList.forEach((c, i) => {
    if (!isNonEmpty(c.text)) problems.push(`the ${fromLabel} #${i + 1} has no text`)
  })
  toList.forEach((c, i) => {
    if (!isNonEmpty(c.text)) problems.push(`the ${toLabel} #${i + 1} has no text`)
  })

  const map = isStringMap(q.key) ? q.key : {}
  const knownTo = new Set(toList.map((c) => c.id))
  const used = new Set<string>()
  fromList.forEach((c, i) => {
    const target = map[c.id]
    if (target === undefined) problems.push(`the ${fromLabel} #${i + 1} is not paired`)
    else if (!knownTo.has(target)) problems.push(`the ${fromLabel} #${i + 1} points at an unknown ${toLabel}`)
    else if (used.has(target)) problems.push(`the ${toLabel} is paired twice`)
    else used.add(target)
  })
  return problems
}

/** All reasons a question is not ready. Empty list means 'ready'. */
export function validateQuestion(q: StoredQuestion): string[] {
  const problems: string[] = []
  if (!isNonEmpty(q.body)) problems.push('the question text is empty')
  if (!Number.isInteger(q.points) || q.points < 1) {
    problems.push('points must be a whole number of at least 1')
  }

  switch (q.type) {
    case 'mcq': {
      const options = q.data.options ?? []
      if (options.length < 2) problems.push('needs at least 2 options')
      if (options.length > 0 && new Set(options.map((o) => o.id)).size !== options.length) {
        problems.push('option ids must be unique')
      }
      options.forEach((o, i) => {
        if (!isNonEmpty(o.text)) problems.push(`option ${i + 1} has no text`)
      })
      if (typeof q.key !== 'string' || !options.some((o) => o.id === q.key)) {
        problems.push('no correct option is marked')
      }
      break
    }
    case 'tf':
      if (typeof q.key !== 'boolean') problems.push('the correct answer (true or false) is not chosen')
      break
    case 'identification': {
      const accepted = Array.isArray(q.key) ? q.key : []
      if (!accepted.some(isNonEmpty)) problems.push('needs at least one accepted answer')
      break
    }
    case 'fillin': {
      const blanks = countBlanks(q.body)
      if (blanks === 0) problems.push('the question text has no ___ blank')
      const key = Array.isArray(q.key) ? q.key : []
      if (key.length !== blanks) {
        problems.push(
          `needs accepted answers for each of the ${blanks} blank${blanks === 1 ? '' : 's'}`
        )
      }
      key.forEach((accepted, i) => {
        if (!Array.isArray(accepted) || !accepted.some(isNonEmpty)) {
          problems.push(`blank ${i + 1} has no accepted answer`)
        }
      })
      break
    }
    case 'enumeration': {
      const count = q.data.count
      const accepted = Array.isArray(q.key) ? q.key : []
      if (!Number.isInteger(count) || (count as number) < 1) {
        problems.push('the item count must be a whole number of at least 1')
      } else if (accepted.length < (count as number)) {
        problems.push(`needs at least ${count} accepted items`)
      }
      accepted.forEach((item, i) => {
        if (!isNonEmpty(item)) problems.push(`accepted item ${i + 1} is empty`)
      })
      break
    }
    case 'problem': {
      const key: ProblemKey | null =
        typeof q.key === 'object' && q.key !== null && !Array.isArray(q.key) && 'answer' in q.key
          ? (q.key as ProblemKey)
          : null
      if (!key || !isNonEmpty(key.answer)) problems.push('the final answer is empty')
      if (
        key && key.tolerance !== undefined &&
        (!Number.isFinite(key.tolerance) || key.tolerance < 0)
      ) {
        problems.push('the tolerance must be zero or a positive number')
      }
      break
    }
    case 'matching':
      problems.push(...validatePairing(q, 'left', 'right'))
      break
    case 'connect':
      problems.push(...validatePairing(q, 'prompts', 'answers'))
      break
  }
  return problems
}

/** The status a question gets when saved: 'ready' only when fully valid. */
export function statusFor(q: StoredQuestion): 'draft' | 'ready' {
  return validateQuestion(q).length === 0 ? 'ready' : 'draft'
}

/**
 * Why a quiz cannot be started, or null when it can. Validation is recomputed
 * from the question data (not the stored status flag), so a stale 'ready' can
 * never start a draft.
 */
export function quizStartError(quiz: Pick<StoredQuiz, 'questions'>): string | null {
  if (quiz.questions.length === 0) return 'This quiz has no questions.'
  const drafts: number[] = []
  quiz.questions.forEach((q, i) => {
    if (validateQuestion(q).length > 0) drafts.push(i + 1)
  })
  if (drafts.length === 0) return null
  const list = drafts.join(', ')
  return drafts.length === 1
    ? `Question ${list} is still a draft — fix it before starting.`
    : `Questions ${list} are still drafts — fix them before starting.`
}

// --- key narrowing helpers, so each editor form works with its own shape ---

/** Narrow an edited key to the identification shape. */
export const asStringArray = (key: StoredKey): string[] =>
  Array.isArray(key) && key.every((v) => typeof v === 'string') ? (key as string[]) : []

/** Narrow an edited key to the fill-in shape (accepted answers per blank). */
export const asBlankAnswers = (key: StoredKey): string[][] =>
  Array.isArray(key) && key.every((v) => Array.isArray(v) && v.every((x) => typeof x === 'string'))
    ? (key as string[][])
    : []

/** Narrow an edited key to the problem shape. */
export const asProblemKey = (key: StoredKey): ProblemKey =>
  typeof key === 'object' && key !== null && !Array.isArray(key) && 'answer' in key
    ? (key as ProblemKey)
    : { answer: '' }

/** Narrow an edited key to the fromId -> toId map used by matching/connect. */
export const asPairMap = (key: StoredKey): Record<string, string> => (isStringMap(key) ? key : {})

/** True when the value can be a choice list (mcq options, matching sides, ...). */
export const isChoiceList = isChoiceArray