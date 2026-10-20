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

/**
 * Every character that counts as a dash.
 *
 * A phone keyboard types a hyphen, a word processor produces an en dash and a
 * keyboard shortcut produces an em dash, so the key and the answer can spell
 * the same word with different characters in it. The soft hyphen is in the
 * list because it is invisible and would otherwise change the word.
 */
const DASHES = /[\u002D\u00AD\u2010-\u2015\u2212\u2E3A\u2E3B\u30A0\uFE58\uFE63\uFF0D]/gu

/**
 * The form two answers are compared in.
 *
 * - the case does not count: "Paris" and "PARIS" are the same answer
 * - a run of spaces is one space: "the  beatles" is "the beatles"
 * - every dash is the same dash, and a dash separates like a space does:
 *   "e-mail", "e–mail" and "e mail" are all "e mail"
 *
 * The underscore is left alone on purpose: it carries meaning in a name or a
 * file name, and a student who cannot type a space usually types nothing.
 *
 * Pure: takes a string, returns a string.
 */
export const normalizeAnswer = (value: string): string =>
  value
    .replace(DASHES, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase()

/**
 * The same, but a separator does not have to be there at all.
 *
 * This is what makes "e-mail" and "email" the same answer: a student who
 * answers on a phone keyboard often leaves a space out or adds one.
 *
 * Pure: takes a string, returns a string.
 */
export const normalizeAnswerTight = (value: string): string => normalizeAnswer(value).replace(/ /gu, '')

/** How an answer compares with the key. */
export type AnswerMatch =
  /** The same, letter for letter. */
  | 'exact'
  /** The same once the case, the spacing and the dashes are ignored. */
  | 'loose'
  /** Not the same. */
  | 'none'

/**
 * Compares what the student wrote with what the key says.
 *
 * The two steps are the two ways an answer can be right: the same text, or
 * the same text once the case, the spacing and the dashes are ignored. The
 * difference matters to the instructor, who can see that a student knew the
 * answer but typed it carelessly - and who is free to mark it wrong anyway.
 *
 * Pure: takes two strings, returns how they compare.
 */
export const compareAnswers = (given: string, accepted: string): AnswerMatch => {
  if (given.trim() === accepted.trim()) return 'exact'
  if (normalizeAnswer(given) === normalizeAnswer(accepted)) return 'loose'
  if (normalizeAnswerTight(given) === normalizeAnswerTight(accepted)) return 'loose'
  return 'none'
}

/**
 * Whether the student's answer is one of the accepted answers.
 *
 * Pure: takes the accepted list and the given answer, returns a boolean.
 */
export const answersMatch = (accepted: readonly string[], given: string): boolean =>
  accepted.some((a) => compareAnswers(given, a) !== 'none')

/**
 * The number of single-character edits that turn one string into the other.
 *
 * The classic edit distance, with the usual insert, delete and replace costs.
 * It is only ever used on short answers, so the quadratic cost does not
 * matter.
 *
 * Pure: takes two strings, returns a number.
 */
export const editDistance = (a: string, b: string): number => {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let previous = Array.from({ length: b.length + 1 }, (_v, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost)
    }
    previous = current
  }
  return previous[b.length]
}

/**
 * The accepted answer closest to what the student wrote, when one is close
 * enough to be worth suggesting.
 *
 * "Paris" and "Pariss" are one edit apart, so the key is suggested. "Paris"
 * and "London" are not, and nothing is said - suggesting a wrong answer would
 * be worse than saying nothing.
 *
 * The distance is measured on the folded forms, so a student who only got
 * the case or the dashes wrong is not told about it twice: that answer is
 * already right.
 *
 * Pure: takes the accepted list and the given answer, returns a string or null.
 */
export const suggestAnswer = (accepted: readonly string[], given: string): string | null => {
  const target = normalizeAnswerTight(given)
  if (!target.length) return null
  let best: { text: string; distance: number } | null = null
  for (const text of accepted) {
    const candidate = normalizeAnswerTight(text)
    if (!candidate.length) continue
    const distance = editDistance(candidate, target)
    if (!best || distance < best.distance) best = { text, distance }
  }
  if (!best) return null
  // Two edits at most, and never more than half of the answer away, so a
  // short answer is not "close" to everything.
  const longest = Math.max(normalizeAnswerTight(best.text).length, target.length)
  return best.distance <= 2 && best.distance * 2 <= longest ? best.text : null
}


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

/** What the instructor is told about one answer. */
export interface AnswerAdvice {
  /** How the answer compares with the key. */
  match: AnswerMatch
  /** The accepted answer closest to what the student wrote, when there is one. */
  suggestion: string | null
}

/** The advice for a question with one written answer. */
function textAdvice(accepted: readonly string[], given: string): AnswerAdvice {
  const match: AnswerMatch = accepted.some((a) => compareAnswers(given, a) === 'exact')
    ? 'exact'
    : answersMatch(accepted, given)
      ? 'loose'
      : 'none'
  return { match, suggestion: match === 'none' ? suggestAnswer(accepted, given) : null }
}

/**
 * What the instructor is told about one answer: how close it came, and which
 * accepted answer it was closest to.
 *
 * A student who wrote "E Mail" for a key of "e-mail" has the right answer, and
 * the instructor should see that it was right for a sloppy reason. A student
 * who wrote "Pariss" for a key of "Paris" is close, and the key is worth
 * suggesting.
 *
 * Pure: takes the question and the answer, returns the advice.
 */
export function adviseAnswer(question: AnswerTextSource, value: AnswerValue | null): AnswerAdvice {
  if (value === null || value === undefined) return { match: 'none', suggestion: null }

  switch (question.type) {
    case 'mcq':
    case 'tf': {
      const correct = value === question.key
      return { match: correct ? 'exact' : 'none', suggestion: null }
    }
    case 'identification': {
      if (typeof value !== 'string') return { match: 'none', suggestion: null }
      return textAdvice(asAcceptedList(question.key), value)
    }
    case 'fillin': {
      if (!Array.isArray(value)) return { match: 'none', suggestion: null }
      const blanks = asBlankList(question.key)
      let match: AnswerMatch = 'exact'
      let suggestion: string | null = null
      blanks.forEach((accepted, i) => {
        const given = typeof value[i] === 'string' ? (value[i] as string) : ''
        const part = textAdvice(accepted, given)
        if (part.match === 'none') {
          match = 'none'
          if (!suggestion) suggestion = part.suggestion
        } else if (part.match === 'loose' && match === 'exact') {
          match = 'loose'
        }
      })
      return { match, suggestion }
    }
    case 'enumeration': {
      if (!Array.isArray(value)) return { match: 'none', suggestion: null }
      const accepted = asAcceptedList(question.key)
      let match: AnswerMatch = 'exact'
      let suggestion: string | null = null
      for (const given of value) {
        if (typeof given !== 'string') continue
        const part = textAdvice(accepted, given)
        if (part.match === 'none') {
          match = 'none'
          if (!suggestion) suggestion = part.suggestion
        } else if (part.match === 'loose' && match === 'exact') {
          match = 'loose'
        }
      }
      return { match, suggestion }
    }
    case 'problem': {
      const key = asProblemKey(question.key)
      if (!key || typeof value !== 'string') return { match: 'none', suggestion: null }
      const expected = asNumber(key.answer)
      const given = asNumber(value)
      if (expected !== null && given !== null) {
        // Within the tolerance the instructor set is close enough, but not
        // the same number, so it is worth telling them apart.
        if (expected === given) return { match: 'exact', suggestion: null }
        const tolerance = key.tolerance ?? 0
        return {
          match: Math.abs(given - expected) <= tolerance ? 'loose' : 'none',
          suggestion: null
        }
      }
      return textAdvice([key.answer], value)
    }
    case 'matching':
    case 'connect': {
      const pairs = asPairMap(question.key)
      const total = Object.keys(pairs).length
      if (total === 0 || typeof value !== 'object' || Array.isArray(value)) {
        return { match: 'none', suggestion: null }
      }
      const given = value as Record<string, string>
      const hits = Object.entries(pairs).filter(([from, to]) => given[from] === to).length
      if (hits === total) return { match: 'exact', suggestion: null }
      return { match: hits > 0 ? 'loose' : 'none', suggestion: null }
    }
    default:
      return { match: 'none', suggestion: null }
  }
}
