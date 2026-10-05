import type {
  AnswerValue,
  ProblemKey,
  QuestionData,
  Quiz,
  QuizQuestion,
  StoredKey,
  StoredQuestion,
  StoredQuiz
} from '../shared/types'
import { QUESTION_TYPES } from '../shared/types'
import { countBlanks, statusFor, validateQuestion } from '../shared/validation'

/**
 * Conversions between the stored library format and the runtime `Quiz` format
 * used by the server (src/shared/types). The runtime format is unchanged —
 * toRuntimeQuiz only re-assembles the flat question shape quizRun expects.
 */

/** Phone-facing fields of a stored question, as a flat spread for QuizQuestion. */
function pickData(data: QuestionData): QuestionData {
  const out: QuestionData = {}
  if (data.options) out.options = data.options
  if (data.blanks !== undefined) out.blanks = data.blanks
  if (data.count !== undefined) out.count = data.count
  if (data.left) out.left = data.left
  if (data.right) out.right = data.right
  if (data.prompts) out.prompts = data.prompts
  if (data.answers) out.answers = data.answers
  return out
}

/** The runtime answer key: the first accepted answer of the stored key. */
function toRuntimeKey(q: StoredQuestion): AnswerValue {
  switch (q.type) {
    case 'identification': {
      const key = q.key
      return Array.isArray(key) && typeof key[0] === 'string' ? key[0] : ''
    }
    case 'fillin':
      return Array.isArray(q.key) ? q.key.map((blank) => (Array.isArray(blank) && typeof blank[0] === 'string' ? blank[0] : '')) : []
    case 'problem':
      return typeof q.key === 'object' && q.key !== null && !Array.isArray(q.key) && 'answer' in q.key
        ? (q.key as ProblemKey).answer
        : ''
    default:
      // mcq: option id · tf: boolean · enumeration: items · matching/connect: map
      return q.key as AnswerValue
  }
}

/** Stored quiz -> runtime quiz. Only called for quizzes that passed start checks. */
export function toRuntimeQuiz(quiz: StoredQuiz): Quiz {
  return {
    quizId: quiz.id,
    title: quiz.title,
    limitMs: quiz.timeLimitSec * 1000,
    questions: quiz.questions.map((q) => ({
      qid: q.id,
      type: q.type,
      body: q.body,
      points: q.points,
      ...pickData(q.data),
      key: toRuntimeKey(q)
    }))
  }
}

/** The stored data fields of a flat runtime question. */
function runtimeData(q: QuizQuestion): QuestionData {
  const out: QuestionData = {}
  if (q.options) out.options = q.options
  if (q.blanks !== undefined) out.blanks = q.blanks
  if (q.count !== undefined) out.count = q.count
  if (q.left) out.left = q.left
  if (q.right) out.right = q.right
  if (q.prompts) out.prompts = q.prompts
  if (q.answers) out.answers = q.answers
  return out
}

/** The stored key of a flat runtime question (the reverse of toRuntimeKey). */
function storedKey(q: QuizQuestion): StoredKey {
  switch (q.type) {
    case 'identification':
      return [String(q.key)]
    case 'fillin':
      return (Array.isArray(q.key) ? q.key : []).map((answer) => [String(answer)])
    case 'problem':
      return { answer: String(q.key) }
    default:
      return q.key as StoredKey
  }
}

/**
 * Runtime quiz -> stored quiz. Used to seed the sample quiz into a fresh
 * library; ids and question statuses map one-to-one.
 */
export function fromRuntimeQuiz(quiz: Quiz): StoredQuiz {
  const now = Date.now()
  const questions: StoredQuestion[] = quiz.questions.map((q) => {
    const stored: StoredQuestion = {
      id: q.qid,
      type: q.type,
      body: q.body,
      points: q.points,
      data: runtimeData(q),
      key: storedKey(q),
      sourceText: '',
      status: 'ready'
    }
    stored.status = statusFor(stored) // the sample is valid, but never trust the source
    return stored
  })
  return {
    id: quiz.quizId,
    title: quiz.title,
    timeLimitSec: Math.round(quiz.limitMs / 1000),
    createdAt: now,
    updatedAt: now,
    questions
  }
}

// --- interchange JSON (export/import; later importers produce this format) ---

export const QUIZ_EXPORT_FORMAT = 'quiz-export'
export const QUIZ_EXPORT_VERSION = 1

/** A question without its row id and status — both are assigned on import. */
export type StoredQuestionInput = Omit<StoredQuestion, 'id' | 'status'>

/** What a parsed, structurally valid export file contains. */
export interface QuizImport {
  title: string
  timeLimitSec: number
  questions: StoredQuestionInput[]
}

/** Anything with a title, a limit and questions shaped like stored questions. */
export type ExportableQuiz = Pick<StoredQuiz, 'title' | 'timeLimitSec' | 'questions'>

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string')

const isChoiceArray = (v: unknown): v is { id: string; text: string }[] =>
  Array.isArray(v) &&
  v.every((c) => isRecord(c) && typeof c.id === 'string' && typeof c.text === 'string')

const uniqueIds = (list: { id: string }[]): boolean =>
  new Set(list.map((c) => c.id)).size === list.length

/** Serializes a quiz to the interchange JSON. Stable field order, pretty-printed. */
export function serializeQuiz(quiz: ExportableQuiz): string {
  const doc = {
    format: QUIZ_EXPORT_FORMAT,
    version: QUIZ_EXPORT_VERSION,
    title: quiz.title,
    timeLimitSec: quiz.timeLimitSec,
    questions: quiz.questions.map((q) => ({
      type: q.type,
      body: q.body,
      points: q.points,
      data: q.data,
      key: q.key,
      sourceText: q.sourceText
    }))
  }
  return JSON.stringify(doc, null, 2)
}

type ParseResult = { ok: true; quiz: QuizImport } | { ok: false; error: string }
type QuestionResult = { ok: true; question: StoredQuestionInput } | { ok: false; error: string }

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

/**
 * Parses and validates an exported quiz file. Rejects anything malformed or
 * semantically invalid with a clear, human-readable message.
 */
export function parseQuizJson(text: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return fail(`the file is not valid JSON (${err instanceof Error ? err.message : String(err)})`)
  }
  if (!isRecord(raw)) return fail('the file must contain a JSON object')
  if (raw.format !== QUIZ_EXPORT_FORMAT) {
    return fail(`unknown format ${JSON.stringify(raw.format)}; expected "${QUIZ_EXPORT_FORMAT}"`)
  }
  if (raw.version !== QUIZ_EXPORT_VERSION) {
    return fail(`unsupported version ${JSON.stringify(raw.version)}; expected ${QUIZ_EXPORT_VERSION}`)
  }
  if (typeof raw.title !== 'string' || raw.title.trim() === '') return fail('the quiz title is missing')
  if (!Number.isInteger(raw.timeLimitSec) || (raw.timeLimitSec as number) < 1) {
    return fail('timeLimitSec must be a positive whole number of seconds')
  }
  if (!Array.isArray(raw.questions)) return fail('questions must be an array')

  const questions: StoredQuestionInput[] = []
  for (let i = 0; i < raw.questions.length; i++) {
    const parsed = parseQuestion(raw.questions[i], i + 1)
    if (!parsed.ok) return parsed
    const problems = validateQuestion({ ...parsed.question, id: '', status: 'ready' })
    if (problems.length > 0) {
      return fail(`question ${i + 1} is not valid: ${problems.join('; ')}`)
    }
    questions.push(parsed.question)
  }
  return { ok: true, quiz: { title: raw.title.trim(), timeLimitSec: raw.timeLimitSec as number, questions } }
}

/** Structural checks per question type; semantics are checked by validateQuestion. */
function parseQuestion(raw: unknown, n: number): QuestionResult {
  if (!isRecord(raw)) return fail(`question ${n} must be an object`)
  const type = raw.type
  if (typeof type !== 'string' || !QUESTION_TYPES.includes(type as (typeof QUESTION_TYPES)[number])) {
    return fail(`question ${n} has unknown type ${JSON.stringify(type)}`)
  }
  if (typeof raw.body !== 'string') return fail(`question ${n}: body must be a string`)
  if (!Number.isInteger(raw.points) || (raw.points as number) < 1) {
    return fail(`question ${n}: points must be a positive whole number`)
  }
  if (!isRecord(raw.data)) return fail(`question ${n}: data must be an object`)
  if (raw.sourceText !== undefined && typeof raw.sourceText !== 'string') {
    return fail(`question ${n}: sourceText must be a string`)
  }
  const data = raw.data
  const key = (raw.key ?? null) as unknown
  const base = {
    type: type as StoredQuestion['type'],
    body: raw.body,
    points: raw.points as number,
    sourceText: (raw.sourceText ?? '') as string
  }

  const choices = (
    value: unknown,
    name: string
  ): { ok: true; list: { id: string; text: string }[] } | { ok: false; error: string } => {
    if (value === undefined) return { ok: true, list: [] }
    if (!isChoiceArray(value)) return fail(`question ${n}: data.${name} must be a list of {id, text}`)
    if (!uniqueIds(value)) return fail(`question ${n}: data.${name} has duplicate ids`)
    return { ok: true, list: value }
  }

  switch (base.type) {
    case 'mcq': {
      const options = choices(data.options, 'options')
      if (!options.ok) return options
      if (key !== null && typeof key !== 'string') {
        return fail(`question ${n}: the mcq key must be the id of the correct option`)
      }
      return { ok: true, question: { ...base, data: { options: options.list }, key: key as StoredKey } }
    }
    case 'tf': {
      if (key !== null && typeof key !== 'boolean') {
        return fail(`question ${n}: the tf key must be true or false`)
      }
      return { ok: true, question: { ...base, data: {}, key: key as StoredKey } }
    }
    case 'identification': {
      if (key !== null && !isStringArray(key)) {
        return fail(`question ${n}: the identification key must be a list of accepted answers`)
      }
      return { ok: true, question: { ...base, data: {}, key: (key as string[] | null) ?? [] } }
    }
    case 'fillin': {
      if (key !== null && !(Array.isArray(key) && key.every(isStringArray))) {
        return fail(`question ${n}: the fillin key must be a list of accepted-answer lists, one per blank`)
      }
      // The body is the source of truth for the blank count; never trust data.blanks.
      return {
        ok: true,
        question: { ...base, data: { blanks: countBlanks(base.body) }, key: (key as string[][] | null) ?? [] }
      }
    }
    case 'enumeration': {
      if (!Number.isInteger(data.count) || (data.count as number) < 1) {
        return fail(`question ${n}: data.count must be a positive whole number`)
      }
      if (key !== null && !isStringArray(key)) {
        return fail(`question ${n}: the enumeration key must be a list of accepted items`)
      }
      return {
        ok: true,
        question: { ...base, data: { count: data.count as number }, key: (key as string[] | null) ?? [] }
      }
    }
    case 'problem': {
      if (key !== null) {
        if (!isRecord(key) || typeof key.answer !== 'string') {
          return fail(`question ${n}: the problem key must be { answer, tolerance? }`)
        }
        if (
          key.tolerance !== undefined &&
          (typeof key.tolerance !== 'number' || !Number.isFinite(key.tolerance) || key.tolerance < 0)
        ) {
          return fail(`question ${n}: key.tolerance must be zero or a positive number`)
        }
      }
      return { ok: true, question: { ...base, data: {}, key: (key as StoredKey) ?? { answer: '' } } }
    }
    case 'matching':
    case 'connect': {
      const fromName = base.type === 'matching' ? 'left' : 'prompts'
      const toName = base.type === 'matching' ? 'right' : 'answers'
      const from = choices(data[fromName], fromName)
      if (!from.ok) return from
      const to = choices(data[toName], toName)
      if (!to.ok) return to
      if (key !== null && !isRecord(key)) {
        return fail(`question ${n}: the ${base.type} key must be a map of ids`)
      }
      // Known-id pairing is a validation concern (the question is then stored
      // as 'draft'); the structural concern is only that it maps ids to ids.
      if (key !== null && !Object.values(key).every((v) => typeof v === 'string')) {
        return fail(`question ${n}: the ${base.type} key must map ids to ids`)
      }
      const pairData: QuestionData =
        base.type === 'matching'
          ? { left: from.list, right: to.list }
          : { prompts: from.list, answers: to.list }
      return {
        ok: true,
        question: { ...base, data: pairData, key: (key as Record<string, string> | null) ?? {} }
      }
    }
  }
}