import type {
  AnswerValue,
  Choice,
  QuestionData,
  QuestionType,
  StoredKey
} from './types'

/**
 * The pure helpers that read an answer or an answer key. They are shared by
 * the grader in the main process and by the instructor's results screen, so
 * both read a key the same way.
 */

/** Trimmed and lower-cased, so "Paris " matches "paris". */
export const normalizeText = (value: string): string => value.trim().toLowerCase()

/** The same, but without any whitespace at all ("15 €" matches "15€"). */
export const normalizeTight = (value: string): string => normalizeText(value).replace(/\s+/g, '')

/** The strings of a list, ignoring anything that is not a string. */
export const asStringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

/**
 * The accepted answers of an identification or enumeration question. The
 * library stores a list, the runtime quiz a single string.
 */
export const asAcceptedList = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : asStringList(value)

/**
 * The accepted answers per blank. The library stores string[][], the runtime
 * quiz a flat string[]; both shapes are accepted.
 */
export const asBlankList = (value: unknown): string[][] =>
  Array.isArray(value)
    ? value.map((entry) =>
        Array.isArray(entry) ? asStringList(entry) : typeof entry === 'string' ? [entry] : []
      )
    : []

/** The problem key; the runtime shape is a plain answer string. */
export const asProblemKey = (value: unknown): { answer: string; tolerance?: number } | null => {
  if (typeof value === 'string') return { answer: value }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (typeof record.answer !== 'string') return null
    const tolerance =
      typeof record.tolerance === 'number' && Number.isFinite(record.tolerance)
        ? record.tolerance
        : undefined
    return tolerance === undefined ? { answer: record.answer } : { answer: record.answer, tolerance }
  }
  return null
}

/** The fromId -> toId map of a matching or connect question. */
export const asPairMap = (value: unknown): Record<string, string> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [from, to] of Object.entries(value as Record<string, unknown>)) {
    if (typeof to === 'string') out[from] = to
  }
  return out
}

/** A number the student may have typed, or null when it is not one. */
export const asNumber = (value: string): number | null => {
  const text = value.trim().replace(',', '.')
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

/** The text of a choice id; the id itself when the choice is unknown. */
export const choiceText = (list: Choice[] | undefined, id: string): string =>
  list?.find((c) => c.id === id)?.text ?? id

/** The parts of a question the text helpers need. */
export interface AnswerTextSource {
  type: QuestionType
  data: QuestionData
  key: StoredKey
}

/** The answer as the instructor reads it, in the words of the question. */
export function answerText(question: AnswerTextSource, value: AnswerValue | null): string {
  if (value === null || value === undefined) return '—'
  switch (question.type) {
    case 'mcq':
      return typeof value === 'string' ? choiceText(question.data.options, value) : '—'
    case 'tf':
      return value === true ? 'True' : value === false ? 'False' : '—'
    case 'identification':
    case 'problem':
      return typeof value === 'string' ? value : '—'
    case 'fillin': {
      if (!Array.isArray(value)) return '—'
      return value.map((v) => (typeof v === 'string' && v.trim() ? v : '—')).join('  |  ')
    }
    case 'enumeration': {
      if (!Array.isArray(value)) return '—'
      return value.filter((v): v is string => typeof v === 'string').join(', ')
    }
    case 'matching': {
      if (typeof value !== 'object' || Array.isArray(value)) return '—'
      return Object.entries(value as Record<string, string>)
        .map(([from, to]) => `${choiceText(question.data.left, from)} → ${choiceText(question.data.right, to)}`)
        .join('; ')
    }
    case 'connect': {
      if (typeof value !== 'object' || Array.isArray(value)) return '—'
      return Object.entries(value as Record<string, string>)
        .map(
          ([from, to]) =>
            `${choiceText(question.data.prompts, from)} → ${choiceText(question.data.answers, to)}`
        )
        .join('; ')
    }
    default:
      return '—'
  }
}

/** The key as the instructor reads it, in the words of the question. */
export function keyText(question: AnswerTextSource): string {
  const key = question.key
  switch (question.type) {
    case 'mcq':
      return typeof key === 'string' ? choiceText(question.data.options, key) : '—'
    case 'tf':
      return typeof key === 'boolean' ? (key ? 'True' : 'False') : '—'
    case 'identification': {
      const accepted = asAcceptedList(key)
      return accepted.length ? accepted.join(' / ') : '—'
    }
    case 'fillin': {
      const blanks = asBlankList(key)
      return blanks.length ? blanks.map((b) => b.join(' / ')).join('  |  ') : '—'
    }
    case 'enumeration': {
      const accepted = asAcceptedList(key)
      return accepted.length ? accepted.join(', ') : '—'
    }
    case 'problem': {
      const problem = asProblemKey(key)
      if (!problem) return '—'
      return problem.tolerance === undefined
        ? problem.answer
        : `${problem.answer} (±${problem.tolerance})`
    }
    case 'matching':
      return pairText(key, question.data.left, question.data.right)
    case 'connect':
      return pairText(key, question.data.prompts, question.data.answers)
    default:
      return '—'
  }
}

/** A pairing key as text: "cat → grass; bee → nectar". */
function pairText(
  key: StoredKey,
  from: Choice[] | undefined,
  to: Choice[] | undefined
): string {
  const pairs = asPairMap(key)
  const entries = Object.entries(pairs)
  if (!entries.length) return '—'
  return entries
    .map(([fromId, toId]) => `${choiceText(from, fromId)} → ${choiceText(to, toId)}`)
    .join('; ')
}
