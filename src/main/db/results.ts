import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type {
  AnswerValue,
  AvatarSpec,
  QuestionData,
  QuestionType,
  ResultAnswerDetail,
  ResultEndReason,
  ResultOperationResult,
  ResultQuestionDetail,
  ResultSessionDetail,
  ResultSessionMeta,
  ResultStudentDetail,
  SaveResultAnswerInput,
  StoredKey
} from '../../shared/types'
import {
  asAcceptedList,
  asBlankList,
  asNumber,
  asPairMap,
  asProblemKey,
  answersMatch,
  compareAnswers
} from '../../shared/answers'

/**
 * The results of finished sessions: the instructor's score sheet.
 *
 * Like the quiz library, every SQL statement of the app lives in the main
 * process. A session is a snapshot: the questions are copied with their
 * answer keys, so the sheet still reads correctly after the library question
 * is edited or deleted.
 */

// --- grading ---------------------------------------------------------------

/** A question as the grader sees it. */
export interface GradableQuestion {
  type: QuestionType
  points: number
  data: QuestionData
  key: StoredKey
}

/** What the grader decided about one answer. */
export interface GradeOutcome {
  /** null when the answer could not be graded (no answer, or no key). */
  correct: boolean | null
  pointsAwarded: number
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Two decimals is enough for a mark; it keeps the totals tidy. */
const round2 = (value: number): number => Math.round(value * 100) / 100

const UNGRADED: GradeOutcome = { correct: null, pointsAwarded: 0 }

/**
 * Grades one answer against the question key.
 *
 * Multi-part questions (fill-in, enumeration, matching, connect) get partial
 * credit: the points are split evenly over the parts that are right. The
 * `correct` flag is only true when every part is right, so a half-right
 * answer shows up as wrong with points on it.
 *
 * A written answer is compared without its case, its spacing and its dashes,
 * so "E Mail" is right for a key of "e-mail" and "PARIS" is right for "Paris".
 * The instructor sees the mark in the score sheet and can change it by hand.
 */
export function gradeAnswer(question: GradableQuestion, value: AnswerValue | null): GradeOutcome {
  const points = question.points
  if (value === null || value === undefined) return UNGRADED

  switch (question.type) {
    case 'mcq': {
      if (typeof value !== 'string' || typeof question.key !== 'string') return UNGRADED
      const correct = value === question.key
      return { correct, pointsAwarded: correct ? points : 0 }
    }
    case 'tf': {
      if (typeof value !== 'boolean' || typeof question.key !== 'boolean') return UNGRADED
      const correct = value === question.key
      return { correct, pointsAwarded: correct ? points : 0 }
    }
    case 'identification': {
      const accepted = asAcceptedList(question.key)
      if (accepted.length === 0 || typeof value !== 'string') return UNGRADED
      // The case, the spacing and the dashes do not count: a student who
      // writes "E Mail" for a key of "e-mail" has the right answer.
      const correct = answersMatch(accepted, value)
      return { correct, pointsAwarded: correct ? points : 0 }
    }
    case 'fillin': {
      const blanks = asBlankList(question.key)
      if (blanks.length === 0 || !Array.isArray(value)) return UNGRADED
      let hits = 0
      blanks.forEach((accepted, i) => {
        const given = typeof value[i] === 'string' ? (value[i] as string) : ''
        if (answersMatch(accepted, given)) hits++
      })
      return {
        correct: hits === blanks.length,
        pointsAwarded: round2((points * hits) / blanks.length)
      }
    }
    case 'enumeration': {
      const accepted = asAcceptedList(question.key)
      if (accepted.length === 0 || !Array.isArray(value)) return UNGRADED
      const expected = typeof question.data.count === 'number' && question.data.count > 0
        ? question.data.count
        : accepted.length
      // Every accepted answer can only be claimed once. A student who types
      // "red, red, red" for three colours has named one colour, and without
      // this the same answer would be counted three times.
      const pool = [...accepted]
      let hits = 0
      for (const given of value) {
        if (typeof given !== 'string') continue
        const index = pool.findIndex((a) => compareAnswers(given, a) !== 'none')
        if (index < 0) continue
        pool.splice(index, 1)
        hits++
      }
      const earned = Math.min(hits, expected)
      return {
        correct: earned >= expected,
        pointsAwarded: round2((points * earned) / expected)
      }
    }
    case 'matching':
    case 'connect': {
      const pairs = asPairMap(question.key)
      const total = Object.keys(pairs).length
      if (total === 0 || !isPlainObject(value)) return UNGRADED
      let hits = 0
      for (const [from, to] of Object.entries(pairs)) {
        if (value[from] === to) hits++
      }
      return {
        correct: hits === total,
        pointsAwarded: round2((points * hits) / total)
      }
    }
    case 'problem': {
      const key = asProblemKey(question.key)
      if (!key || typeof value !== 'string') return UNGRADED
      const expected = asNumber(key.answer)
      const given = asNumber(value)
      if (expected !== null && given !== null) {
        const tolerance = key.tolerance ?? 0
        const correct = Math.abs(given - expected) <= tolerance
        return { correct, pointsAwarded: correct ? points : 0 }
      }
      const correct = answersMatch([key.answer], value)
      return { correct, pointsAwarded: correct ? points : 0 }
    }
    default:
      return UNGRADED
  }
}

// --- the store -------------------------------------------------------------

/** One question of the snapshot that becomes a result session. */
export interface ResultQuestionInput {
  id: string
  type: QuestionType
  body: string
  points: number
  data: QuestionData
  key: StoredKey
}

/** One student of the snapshot that becomes a result session. */
export interface ResultStudentInput {
  /** The session student id; kept as the identity of the row. */
  id: string
  name: string
  finished: boolean
  /** The avatar this student picked, as a parsed spec or null. */
  avatar?: AvatarSpec | null
}

/** Everything one session snapshot needs. */
export interface CreateResultSessionInput {
  quizId: string | null
  quizTitle: string
  startedAt: number | null
  endedAt: number
  endReason: ResultEndReason | null
  questions: ResultQuestionInput[]
  students: ResultStudentInput[]
  /** studentId -> questionId -> the value the student sent. */
  answers: Record<string, Record<string, AnswerValue | null>>
}

/** One row of the session list, with the student count added. */
interface MetaRow {
  id: string
  quizId: string | null
  quizTitle: string
  startedAt: number | null
  endedAt: number
  endReason: string | null
  totalPoints: number
  createdAt: number
  studentCount?: number
}

interface QuestionRow {
  id: string
  sessionId: string
  questionId: string | null
  position: number
  type: string
  body: string
  points: number
  dataJson: string
  keyJson: string
}

interface StudentRow {
  id: string
  sessionId: string
  studentName: string
  studentKey: string | null
  finished: number
  totalPointsAwarded: number
  totalPointsPossible: number
  studentAvatar: string
}

interface AnswerRow {
  id: string
  sessionId: string
  studentId: string
  questionId: string
  valueJson: string | null
  correct: number | null
  pointsAwarded: number
  pointsPossible: number
  autoGraded: number
  notes: string | null
}

const SESSION_SELECT = `
  SELECT s.id AS id, s.quiz_id AS quizId, s.quiz_title AS quizTitle,
         s.started_at AS startedAt, s.ended_at AS endedAt,
         s.end_reason AS endReason, s.total_points AS totalPoints,
         s.created_at AS createdAt,
         (SELECT COUNT(*) FROM result_students st WHERE st.session_id = s.id) AS studentCount
  FROM result_sessions s
`

/**
 * The results store: the persisted score sheets of finished sessions.
 */
export class ResultsStore {
  constructor(private db: Database) {}

  /** Every session, newest first. */
  list(): ResultSessionMeta[] {
    const rows = this.db
      .prepare(`${SESSION_SELECT} ORDER BY s.ended_at DESC, s.id DESC`)
      .all() as MetaRow[]
    return rows.map((row) => toMeta(row))
  }

  /** One session with its questions, students and answers, or null. */
  get(sessionId: string): ResultSessionDetail | null {
    const session = this.db
      .prepare(`${SESSION_SELECT} WHERE s.id = ?`)
      .get(sessionId) as MetaRow | undefined
    if (!session) return null

    const questionRows = this.db
      .prepare(
        `SELECT id, session_id AS sessionId, question_id AS questionId, position, type,
                body, points, data_json AS dataJson, key_json AS keyJson
         FROM result_questions WHERE session_id = ? ORDER BY position ASC`
      )
      .all(sessionId) as QuestionRow[]
    const studentRows = this.db
      .prepare(
        `SELECT id, session_id AS sessionId, student_name AS studentName,
                student_key AS studentKey, finished,
                total_points_awarded AS totalPointsAwarded,
                total_points_possible AS totalPointsPossible,
                student_avatar AS studentAvatar
         FROM result_students WHERE session_id = ?
         ORDER BY student_name COLLATE NOCASE ASC, id ASC`
      )
      .all(sessionId) as StudentRow[]
    const answerRows = this.db
      .prepare(
        `SELECT id, session_id AS sessionId, student_id AS studentId,
                question_id AS questionId, value_json AS valueJson, correct,
                points_awarded AS pointsAwarded, points_possible AS pointsPossible,
                auto_graded AS autoGraded, notes
         FROM result_answers WHERE session_id = ?`
      )
      .all(sessionId) as AnswerRow[]

    const questions: ResultQuestionDetail[] = questionRows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      questionId: row.questionId,
      // The row keeps the order counted from zero; the instructor counts the
      // questions from one, and that count is made here so every screen
      // shows the same number.
      number: row.position + 1,
      type: row.type as QuestionType,
      body: row.body,
      points: row.points,
      data: JSON.parse(row.dataJson) as QuestionData,
      key: JSON.parse(row.keyJson) as StoredKey
    }))

    const byStudent = new Map<string, ResultAnswerDetail[]>()
    for (const row of answerRows) {
      const list = byStudent.get(row.studentId) ?? []
      list.push({
        id: row.id,
        sessionId: row.sessionId,
        studentId: row.studentId,
        questionId: row.questionId,
        value: row.valueJson === null ? null : (JSON.parse(row.valueJson) as AnswerValue),
        correct: row.correct === null ? null : row.correct !== 0,
        pointsAwarded: row.pointsAwarded,
        pointsPossible: row.pointsPossible,
        autoGraded: row.autoGraded !== 0,
        notes: row.notes
      })
      byStudent.set(row.studentId, list)
    }

    const students: ResultStudentDetail[] = studentRows.map((row) => ({
       id: row.id,
       sessionId: row.sessionId,
       studentName: row.studentName,
       studentKey: row.studentKey,
       finished: row.finished !== 0,
       totalPointsAwarded: row.totalPointsAwarded,
       totalPointsPossible: row.totalPointsPossible,
       studentAvatar: row.studentAvatar ?? '',
       answers: byStudent.get(row.id) ?? []
     }))

    return {
      meta: toMeta(session),
      questions,
      students
    }
  }

  /**
   * Stores a snapshot of a finished session. Every student gets a row for
   * every question, so the sheet has no holes and an unanswered question can
   * still be given credit.
   */
  createFromSession(input: CreateResultSessionInput): ResultSessionMeta {
    const sessionId = randomUUID()
    const createdAt = Date.now()
    const totalPoints = input.questions.reduce((acc, q) => acc + q.points, 0)

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO result_sessions
             (id, quiz_id, quiz_title, started_at, ended_at, end_reason, total_points, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          sessionId,
          input.quizId,
          input.quizTitle,
          input.startedAt,
          input.endedAt,
          input.endReason,
          totalPoints,
          createdAt
        )

      const insertQuestion = this.db.prepare(
        `INSERT INTO result_questions
           (id, session_id, question_id, position, type, body, points, data_json, key_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      // The snapshot rows get their own ids; the library id is kept aside.
      const questionRowIds = new Map<string, string>()
      input.questions.forEach((question, position) => {
        const rowId = randomUUID()
        questionRowIds.set(question.id, rowId)
        insertQuestion.run(
          rowId,
          sessionId,
          question.id,
          position,
          question.type,
          question.body,
          question.points,
          JSON.stringify(question.data),
          JSON.stringify(question.key),
          createdAt
        )
      })

      const insertStudent = this.db.prepare(
        `INSERT INTO result_students
           (id, session_id, student_name, student_key, finished, total_points_awarded, total_points_possible, student_avatar)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
      )
      const insertAnswer = this.db.prepare(
        `INSERT INTO result_answers
           (id, session_id, student_id, question_id, value_json, correct,
            points_awarded, points_possible, auto_graded, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)`
      )

      input.students.forEach((student) => {
        const studentRowId = randomUUID()
        const answers = input.answers[student.id] ?? {}
        const avatarJson = student.avatar ? JSON.stringify(student.avatar) : ''
        insertStudent.run(
          studentRowId,
          sessionId,
          student.name,
          student.id,
          student.finished ? 1 : 0,
          totalPoints,
          avatarJson
        )
        input.questions.forEach((question) => {
          const value = answers[question.id] ?? null
          const outcome = gradeAnswer(question, value)
          insertAnswer.run(
            randomUUID(),
            sessionId,
            studentRowId,
            questionRowIds.get(question.id)!,
            value === null ? null : JSON.stringify(value),
            outcome.correct === null ? null : outcome.correct ? 1 : 0,
            outcome.pointsAwarded,
            question.points
          )
        })
      })

      this.recomputeTotals(sessionId)
    })()

    const stored = this.db
      .prepare(`${SESSION_SELECT} WHERE s.id = ?`)
      .get(sessionId) as MetaRow
    return toMeta(stored)
  }

  /**
   * Applies an instructor's change to one answer and recomputes the totals of
   * the student it belongs to. The points are clamped to what the question is
   * worth, so the sheet can never show more than the quiz is worth.
   */
  updateAnswer(input: SaveResultAnswerInput): ResultOperationResult {
    const answer = this.db
      .prepare(
        `SELECT id, session_id AS sessionId, student_id AS studentId,
                question_id AS questionId, correct, notes,
                points_possible AS pointsPossible
         FROM result_answers WHERE id = ?`
      )
      .get(input.answerId) as
      | {
          id: string
          sessionId: string
          studentId: string
          questionId: string
          correct: number | null
          notes: string | null
          pointsPossible: number
        }
      | undefined
    if (!answer) return { ok: false, error: 'That answer is no longer in the results.' }

    const points = Number(input.pointsAwarded)
    if (!Number.isFinite(points)) return { ok: false, error: 'The points must be a number.' }
    const awarded = round2(Math.min(Math.max(points, 0), answer.pointsPossible))

    let correct: number | null
    if (input.correct === undefined) {
      correct = answer.correct
    } else if (input.correct === null) {
      correct = null
    } else {
      correct = input.correct ? 1 : 0
    }

    // An omitted note leaves the old one alone; an empty note clears it.
    const notes = input.notes === undefined ? answer.notes : input.notes

    this.db
      .prepare(
        `UPDATE result_answers
         SET points_awarded = ?, correct = ?, auto_graded = 0, notes = ?
         WHERE id = ?`
      )
      .run(awarded, correct, notes, input.answerId)

    this.recomputeTotals(answer.sessionId)
    return { ok: true }
  }

  /** Recalculates the awarded and possible points of every student. */
  recomputeTotals(sessionId: string): void {
    this.db
      .prepare(
        `UPDATE result_students
         SET total_points_awarded = (
               SELECT COALESCE(SUM(a.points_awarded), 0) FROM result_answers a
               WHERE a.student_id = result_students.id
             ),
             total_points_possible = (
               SELECT COALESCE(SUM(a.points_possible), 0) FROM result_answers a
               WHERE a.student_id = result_students.id
             )
         WHERE session_id = ?`
      )
      .run(sessionId)
  }

  /** Deletes a session; its students, questions and answers go with it. */
  delete(sessionId: string): boolean {
    return this.db.prepare('DELETE FROM result_sessions WHERE id = ?').run(sessionId).changes > 0
  }
}

/** The stored end reason, or null when the session ended for another reason. */
function toEndReason(value: string | null): ResultEndReason | null {
  return value === 'time' || value === 'instructor' ? value : null
}

/** A stored row as the shape the renderer gets. */
function toMeta(row: MetaRow): ResultSessionMeta {
  return {
    id: row.id,
    quizId: row.quizId,
    quizTitle: row.quizTitle,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    endReason: toEndReason(row.endReason),
    totalPoints: row.totalPoints,
    studentCount: row.studentCount ?? 0,
    createdAt: row.createdAt
  }
}
