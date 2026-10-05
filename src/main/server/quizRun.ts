import type { Choice, PublicQuestion, Quiz, QuizState, ServerErrorCode } from '../../shared/types'

/** What the session must do after an answer arrived. */
export type AnswerOutcome =
  | { kind: 'ack'; seq: number; stored: boolean }
  | { kind: 'error'; code: ServerErrorCode }

interface StoredAnswer {
  value: unknown
  seq: number
}

/**
 * The authoritative quiz run: status, the timer, and the latest answer per
 * (student, qid). In memory only, no grading.
 */
export class QuizRun {
  private quiz: Quiz | null = null
  private status: QuizState['status'] = 'lobby'
  private endsAt: number | null = null
  private timer: NodeJS.Timeout | null = null
  private answers = new Map<string, Map<string, StoredAnswer>>()
  private endReason: 'time' | 'instructor' | null = null

  constructor(private onEnded: () => void, private onChange: (s: QuizState) => void) {}

  get currentStatus(): QuizState['status'] {
    return this.status
  }

  /** phone-safe payload for quiz_start. */
  startPayload(now: number): {
    quizId: string
    title: string
    questions: PublicQuestion[]
    endsAt: number
    serverTime: number
  } {
    const quiz = this.quiz!
    return {
      quizId: quiz.quizId,
      title: quiz.title,
      questions: toPublicQuestions(quiz),
      endsAt: this.endsAt!,
      serverTime: now
    }
  }

  /** Starts a run; endsAt is computed from the server clock, never the phone. */
  start(quiz: Quiz, now: number): void {
    this.quiz = quiz
    this.status = 'running'
    this.answers.clear()
    this.endReason = null
    this.endsAt = now + quiz.limitMs
    this.timer = setTimeout(() => this.end('time'), Math.max(0, quiz.limitMs))
    this.publish()
  }

  end(reason: 'time' | 'instructor'): boolean {
    if (this.status !== 'running') return false
    this.status = 'ended'
    this.endReason = reason
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.publish()
    this.onEnded()
    return true
  }

  reset(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.quiz = null
    this.status = 'lobby'
    this.endsAt = null
    this.endReason = null
    this.answers.clear()
    this.publish()
  }

  private question(qid: string): Quiz['questions'][number] | undefined {
    return this.quiz?.questions.find((q) => q.qid === qid)
  }

  handleAnswer(studentId: string, qid: unknown, value: unknown, seq: unknown): AnswerOutcome {
    if (this.status !== 'running') return { kind: 'error', code: 'QUIZ_ENDED' }
    if (typeof qid !== 'string') return { kind: 'error', code: 'UNKNOWN_QUESTION' }
    const question = this.question(qid)
    if (!question) return { kind: 'error', code: 'UNKNOWN_QUESTION' }
    if (typeof seq !== 'number' || !Number.isFinite(seq)) {
      return { kind: 'error', code: 'BAD_ANSWER' }
    }

    let mine = this.answers.get(studentId)
    if (!mine) {
      mine = new Map()
      this.answers.set(studentId, mine)
    }
    const previous = mine.get(qid)
    const outOfOrder = previous !== undefined && seq <= previous.seq

    // A stale value is ignored but still acked, so the phone can drop it.
    if (outOfOrder) return { kind: 'ack', seq, stored: false }
    if (!isValidAnswer(question, value)) return { kind: 'error', code: 'BAD_ANSWER' }

    mine.set(qid, { value, seq })
    this.publish()
    return { kind: 'ack', seq, stored: true }
  }

  /** The student's own answers, for answers_state after a mid-quiz rejoin. */
  answersFor(studentId: string): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [qid, a] of this.answers.get(studentId) ?? []) out[qid] = a.value
    return out
  }

  state(): QuizState {
    const questions = (this.quiz?.questions ?? []).map((q) => ({
      qid: q.qid,
      type: q.type,
      body: q.body,
      answered: this.countAnswered(q.qid)
    }))
    const answeredByStudent: Record<string, number> = {}
    for (const [studentId, m] of this.answers) answeredByStudent[studentId] = m.size
    return {
      status: this.status,
      title: this.quiz?.title ?? null,
      endsAt: this.endsAt,
      questions,
      answeredByStudent,
      endReason: this.endReason
    }
  }

  private countAnswered(qid: string): number {
    let n = 0
    for (const m of this.answers.values()) if (m.has(qid)) n++
    return n
  }

  private publish(): void {
    this.onChange(this.state())
  }
}

/** Fields copied to a phone, per question type. Everything else stays here. */
function publicQuestion(q: Quiz['questions'][number]): PublicQuestion {
  const base = { qid: q.qid, type: q.type, body: q.body, points: q.points }
  const has = <T>(v: T[] | undefined): T[] | undefined => (v && v.length ? v : undefined)
  switch (q.type) {
    case 'mcq':
      return { ...base, options: q.options ?? [] }
    case 'fillin':
      return { ...base, blanks: q.blanks ?? 0 }
    case 'enumeration':
      return { ...base, count: q.count ?? 0 }
    case 'matching':
      return { ...base, left: q.left ?? [], right: q.right ?? [] }
    case 'connect':
      return { ...base, prompts: q.prompts ?? [], answers: has(q.answers) ?? [] }
    default:
      return base
  }
}

/** Phone-facing question list, built by whitelist so keys cannot leak. */
export function toPublicQuestions(quiz: Quiz): PublicQuestion[] {
  return quiz.questions.map(publicQuestion)
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const knownIds = (list: Choice[] | undefined, id: unknown): boolean =>
  Array.isArray(list) && list.some((c) => c.id === id)

/**
 * Shared rule for matching and connect: every key must be a known left/prompt
 * id, every value a known right/answer id, and no target used twice.
 */
function validPairing(value: unknown, from: Choice[], to: Choice[]): boolean {
  if (!isPlainObject(value)) return false
  const used = new Set<string>()
  for (const [fromId, toId] of Object.entries(value)) {
    if (typeof toId !== 'string') return false
    if (!knownIds(from, fromId) || !knownIds(to, toId)) return false
    if (used.has(toId)) return false
    used.add(toId)
  }
  return true
}

/** Does a phone's answer value match the question type? Grading is step 3+. */
export function isValidAnswer(q: Quiz['questions'][number], value: unknown): boolean {
  switch (q.type) {
    case 'mcq':
      return typeof value === 'string' && knownIds(q.options, value)
    case 'tf':
      return typeof value === 'boolean'
    case 'identification':
    case 'problem':
      return typeof value === 'string'
    case 'fillin':
      return Array.isArray(value) && value.length === (q.blanks ?? 0)
    case 'enumeration':
      return (
        Array.isArray(value) && value.length <= (q.count ?? 0) && value.every((v) => typeof v === 'string')
      )
    case 'matching':
      return validPairing(value, q.left ?? [], q.right ?? [])
    case 'connect':
      return validPairing(value, q.prompts ?? [], q.answers ?? [])
    default:
      return false
  }
}