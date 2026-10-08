import type { Choice, PublicQuestion, Quiz, QuizState, ServerErrorCode } from '../../shared/types'

/** What the session must do after an answer arrived. */
export type AnswerOutcome =
  | { kind: 'ack'; seq: number; stored: boolean }
  | { kind: 'error'; code: ServerErrorCode }

interface StoredAnswer {
  value: unknown
  seq: number
}

/** Floor for timer adjustments: a change alone can never leave less than this. */
export const MIN_REMAINING_MS = 10_000

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
  // --- timer control: pausing freezes the countdown, storing the remainder ---
  private paused = false
  private remainingMs = 0

  constructor(private onEnded: () => void, private onChange: (s: QuizState) => void) {}

  get currentStatus(): QuizState['status'] {
    return this.status
  }

  /** phone-safe payload for quiz_start, including the timer-control paused flag. */
  startPayload(now: number): {
    quizId: string
    title: string
    questions: PublicQuestion[]
    endsAt: number
    serverTime: number
    paused: boolean
  } {
    const quiz = this.quiz!
    return {
      quizId: quiz.quizId,
      title: quiz.title,
      questions: toPublicQuestions(quiz),
      // While paused endsAt is stale by design (it stopped moving), so send
      // the effective deadline instead: the phone's offset math then yields
      // the frozen remainder rather than a shrinking clock.
      endsAt: this.paused ? now + this.remainingMs : this.endsAt!,
      serverTime: now,
      paused: this.paused
    }
  }

  /** Starts a run; endsAt is computed from the server clock, never the phone. */
  start(quiz: Quiz, now: number): void {
    this.quiz = quiz
    this.status = 'running'
    this.answers.clear()
    this.endReason = null
    this.paused = false
    this.remainingMs = 0
    this.endsAt = now + quiz.limitMs
    this.scheduleTimer(quiz.limitMs)
    this.publish()
  }

  /** Whether the countdown is currently frozen by the instructor. */
  timerPaused(): boolean {
    return this.status === 'running' && this.paused
  }

  /** Remaining time, frozen while paused. */
  remaining(now: number): number {
    if (this.status !== 'running' || this.endsAt === null) return 0
    return this.paused ? this.remainingMs : Math.max(0, this.endsAt - now)
  }

  /** phone + dashboard payload for a timer change. */
  timePayload(now: number): { endsAt: number; serverTime: number; paused: boolean } {
    // Same stale-endsAt guard as startPayload: while paused the phone derives
    // its countdown from endsAt - serverTime, so send the effective deadline.
    return { endsAt: this.paused ? now + this.remainingMs : this.endsAt!, serverTime: now, paused: this.paused }
  }

  private scheduleTimer(ms: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = ms <= 0 ? null : setTimeout(() => this.end('time'), ms)
  }

  /** Freezes the countdown; the stored remainder resumes it later. */
  pauseTimer(now: number): boolean {
    if (this.status !== 'running' || this.paused || this.endsAt === null) return false
    this.remainingMs = Math.max(0, this.endsAt - now)
    this.paused = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.publish()
    return true
  }

  /** Resumes the countdown from the stored remainder. */
  resumeTimer(now: number): boolean {
    if (this.status !== 'running' || !this.paused) return false
    this.paused = false
    this.endsAt = now + this.remainingMs
    this.scheduleTimer(this.remainingMs)
    this.remainingMs = 0
    this.publish()
    return true
  }

  /**
   * Shifts the countdown by deltaMs, clamped so at least 10 s remain and an
   * adjustment alone can never end the quiz. While paused it edits the
   * stored remainder instead of endsAt.
   */
  adjustTimer(deltaMs: number, now: number): boolean {
    if (this.status !== 'running' || this.endsAt === null) return false
    if (!Number.isFinite(deltaMs) || deltaMs === 0) return false
    if (this.paused) {
      this.remainingMs = Math.max(MIN_REMAINING_MS, this.remainingMs + deltaMs)
    } else {
      const next = Math.max(now + MIN_REMAINING_MS, this.endsAt + deltaMs)
      this.endsAt = next
      this.scheduleTimer(next - now)
    }
    this.publish()
    return true
  }

  end(reason: 'time' | 'instructor'): boolean {
    if (this.status !== 'running') return false
    this.status = 'ended'
    this.endReason = reason
    this.paused = false
    this.remainingMs = 0
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
    this.paused = false
    this.remainingMs = 0
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
      timerPaused: this.paused,
      remainingMs: this.paused ? this.remainingMs : null,
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