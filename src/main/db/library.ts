import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type {
  QuestionData,
  QuestionStatus,
  QuestionType,
  QuizMeta,
  StoredKey,
  StoredQuestion,
  StoredQuiz
} from '../../shared/types'
import { QUESTION_TYPES } from '../../shared/types'
import { countBlanks, statusFor } from '../../shared/validation'
import { SAMPLE_QUIZ } from '../sampleQuiz'
import { fromRuntimeQuiz, type QuizImport } from '../quizFormat'

/** Default length of a brand-new quiz: five minutes, like the sample. */
const DEFAULT_TIME_LIMIT_SEC = 5 * 60

interface QuizRow {
  id: string
  title: string
  timeLimitSec: number
  createdAt: number
  updatedAt: number
}

interface QuestionRow {
  id: string
  quiz_id: string
  position: number
  type: string
  body: string
  points: number
  data_json: string
  key_json: string
  source_text: string
  status: string
}

function parseQuestion(row: QuestionRow): StoredQuestion {
  return {
    id: row.id,
    type: row.type as QuestionType,
    body: row.body,
    points: row.points,
    data: JSON.parse(row.data_json) as QuestionData,
    key: JSON.parse(row.key_json) as StoredKey,
    sourceText: row.source_text,
    status: row.status as QuestionStatus
  }
}

/**
 * The quiz library. Every SQL statement of the app lives in this file; it is
 * only ever used from the main process (see src/main/index.ts for the IPC).
 */
export class QuizLibrary {
  constructor(private db: Database) {}

  /** All quizzes, oldest first, with their question counts. */
  list(): QuizMeta[] {
    return this.db
      .prepare(
        `SELECT q.id AS id, q.title AS title, q.time_limit_sec AS timeLimitSec,
                q.created_at AS createdAt, q.updated_at AS updatedAt,
                COUNT(qs.id) AS questionCount
         FROM quizzes q
         LEFT JOIN questions qs ON qs.quiz_id = q.id
         GROUP BY q.id
         ORDER BY q.created_at ASC, q.id ASC`
      )
      .all() as QuizMeta[]
  }

  /** One quiz with its questions in position order, or null when unknown. */
  get(id: string): StoredQuiz | null {
    const quiz = this.db
      .prepare(
        `SELECT id, title, time_limit_sec AS timeLimitSec,
                created_at AS createdAt, updated_at AS updatedAt
         FROM quizzes WHERE id = ?`
      )
      .get(id) as QuizRow | undefined
    if (!quiz) return null
    const rows = this.db
      .prepare(
        `SELECT id, quiz_id, position, type, body, points, data_json, key_json, source_text, status
         FROM questions WHERE quiz_id = ? ORDER BY position ASC`
      )
      .all(id) as QuestionRow[]
    return {
      id: quiz.id,
      title: quiz.title,
      timeLimitSec: quiz.timeLimitSec,
      createdAt: quiz.createdAt,
      updatedAt: quiz.updatedAt,
      questions: rows.map(parseQuestion)
    }
  }

  /** A new empty quiz. */
  create(title = 'Untitled quiz'): StoredQuiz {
    const now = Date.now()
    const quiz: StoredQuiz = {
      id: randomUUID(),
      title: title.trim() || 'Untitled quiz',
      timeLimitSec: DEFAULT_TIME_LIMIT_SEC,
      createdAt: now,
      updatedAt: now,
      questions: []
    }
    this.insertQuiz(quiz)
    return quiz
  }

  /**
   * Saves title, time limit and the full question list (replacing the old
   * one). Statuses are recomputed from validation, so a question with problems
   * is stored as 'draft'. Fill-in blank counts are re-derived from the body.
   */
  save(quiz: StoredQuiz): StoredQuiz {
    const title = quiz.title.trim() || 'Untitled quiz'
    const timeLimitSec = Math.max(1, Math.round(quiz.timeLimitSec))
    const questions = quiz.questions.map((q) => {
      if (!QUESTION_TYPES.includes(q.type)) throw new Error(`Unknown question type ${q.type}`)
      const data: QuestionData = { ...q.data }
      if (q.type === 'fillin') data.blanks = countBlanks(q.body)
      const normalized = { ...q, data }
      return { ...normalized, status: statusFor(normalized) }
    })

    this.db.transaction(() => {
      const updated = this.db
        .prepare('UPDATE quizzes SET title = ?, time_limit_sec = ?, updated_at = ? WHERE id = ?')
        .run(title, timeLimitSec, Date.now(), quiz.id)
      if (updated.changes === 0) throw new Error(`Quiz ${quiz.id} not found`)
      this.db.prepare('DELETE FROM questions WHERE quiz_id = ?').run(quiz.id)
      const insert = this.db.prepare(
        `INSERT INTO questions
           (id, quiz_id, position, type, body, points, data_json, key_json, source_text, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      questions.forEach((q, position) => {
        insert.run(
          q.id, quiz.id, position, q.type, q.body, q.points,
          JSON.stringify(q.data), JSON.stringify(q.key), q.sourceText, q.status
        )
      })
    })()

    return this.get(quiz.id) ?? { ...quiz, title, timeLimitSec, questions }
  }

  /** A copy of a quiz with fresh ids, titled "<title> copy". */
  duplicate(id: string): StoredQuiz | null {
    const source = this.get(id)
    if (!source) return null
    const now = Date.now()
    const copy: StoredQuiz = {
      id: randomUUID(),
      title: `${source.title} copy`,
      timeLimitSec: source.timeLimitSec,
      createdAt: now,
      updatedAt: now,
      questions: source.questions.map((q) => ({ ...q, id: randomUUID() }))
    }
    this.insertQuiz(copy)
    return copy
  }

  /** Deletes a quiz; its questions go with it (ON DELETE CASCADE). */
  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM quizzes WHERE id = ?').run(id).changes > 0
  }

  /** Inserts a validated export file as a new quiz; statuses come from save(). */
  importQuiz(input: QuizImport): StoredQuiz {
    const now = Date.now()
    const quiz: StoredQuiz = {
      id: randomUUID(),
      title: input.title,
      timeLimitSec: input.timeLimitSec,
      createdAt: now,
      updatedAt: now,
      questions: input.questions.map((q) => ({ ...q, id: randomUUID(), status: 'draft' as const }))
    }
    this.insertQuiz(quiz)
    return this.save(quiz)
  }

  /** Fresh databases only (a brand-new file): seed the step-2 sample quiz. */
  seedSampleQuiz(): void {
    this.insertQuiz(fromRuntimeQuiz(SAMPLE_QUIZ))
  }

  close(): void {
    this.db.close()
  }

  /** Inserts a quiz row plus its question rows in one transaction. */
  private insertQuiz(quiz: StoredQuiz): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO quizzes (id, title, time_limit_sec, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(quiz.id, quiz.title, quiz.timeLimitSec, quiz.createdAt, quiz.updatedAt)
      const insert = this.db.prepare(
        `INSERT INTO questions
           (id, quiz_id, position, type, body, points, data_json, key_json, source_text, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      quiz.questions.forEach((q, position) => {
        insert.run(
          q.id, quiz.id, position, q.type, q.body, q.points,
          JSON.stringify(q.data), JSON.stringify(q.key), q.sourceText, q.status
        )
      })
    })()
  }
}