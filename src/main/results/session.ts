import type {
  AnswerValue,
  Quiz,
  ResultEndReason,
  StoredQuiz,
  StudentInfo
} from '../../shared/types'
import type { CreateResultSessionInput, ResultQuestionInput } from '../db/results'
import { runtimeData } from '../quizFormat'

/**
 * Turning a finished session into the snapshot the results store keeps.
 *
 * The questions are copied with their answer keys, so the score sheet still
 * reads correctly after the library question is edited or deleted. The
 * library quiz is the richer source (it keeps every accepted answer and the
 * problem tolerance); the runtime quiz of the run is the fallback.
 */

/** The questions of a session, with their keys, ready to be stored. */
export function snapshotQuestions(
  quiz: StoredQuiz | null,
  runtime: Quiz | null
): ResultQuestionInput[] {
  if (quiz) {
    return quiz.questions.map((q) => ({
      id: q.id,
      type: q.type,
      body: q.body,
      points: q.points,
      data: q.data,
      key: q.key
    }))
  }
  if (!runtime) return []
  return runtime.questions.map((q) => ({
    id: q.qid,
    type: q.type,
    body: q.body,
    points: q.points,
    data: runtimeData(q),
    key: q.key
  }))
}

/** Everything the main process knows about a finished session. */
export interface SessionSnapshot {
  /** The library quiz of the session, when it is still known. */
  quiz: StoredQuiz | null
  /** The runtime quiz of the run, used when the library quiz is gone. */
  runtime: Quiz | null
  /** The title shown in the results list. */
  quizTitle: string
  startedAt: number | null
  endedAt: number
  endReason: ResultEndReason | null
  /** The students of the session, in the order the roster had them. */
  students: StudentInfo[]
  /** studentId -> questionId -> the value the student sent. */
  answers: Record<string, Record<string, AnswerValue | null>>
}

/** The snapshot of a finished session, ready to be stored. */
export function buildSessionSnapshot(snapshot: SessionSnapshot): CreateResultSessionInput {
  return {
    quizId: snapshot.quiz?.id ?? null,
    quizTitle: snapshot.quizTitle,
    startedAt: snapshot.startedAt,
    endedAt: snapshot.endedAt,
    endReason: snapshot.endReason,
    questions: snapshotQuestions(snapshot.quiz, snapshot.runtime),
    students: snapshot.students.map((s) => ({
      id: s.id,
      name: s.name,
      finished: s.finished,
      avatar: s.avatar
    })),
    answers: snapshot.answers
  }
}
