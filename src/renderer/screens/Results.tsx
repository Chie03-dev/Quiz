import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ResultAnswerDetail,
  ResultQuestionDetail,
  ResultSessionDetail,
  ResultSessionMeta
} from '../../shared/types'
import { answerText, keyText } from '../../shared/answers'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { ConfirmButton } from '../components/ConfirmButton'
import { EmptyState } from '../components/EmptyState'
import { Icon } from '../components/Icon'
import { Panel } from '../components/Panel'

/** The moment a session ended, in the instructor's own time zone. */
const when = (at: number): string =>
  new Date(at).toLocaleString([], {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })

/** Why the session ended, in words. */
const reasonLabel = (reason: ResultSessionMeta['endReason']): string => {
  if (reason === 'time') return 'Time ran out'
  if (reason === 'instructor') return 'Ended by the instructor'
  return 'Saved during the quiz'
}

/** The grade of one answer: right, wrong, partly right or unmarked. */
type CellState = 'ok' | 'bad' | 'partial' | 'none'

/** How a cell is shown: the mark, the colour and the text of the badge. */
function cellState(answer: ResultAnswerDetail | undefined): { state: CellState; mark: string } {
  if (!answer || answer.correct === null) return { state: 'none', mark: '–' }
  if (answer.correct) return { state: 'ok', mark: '✓' }
  if (answer.pointsAwarded > 0) return { state: 'partial', mark: '~' }
  return { state: 'bad', mark: '✗' }
}

/** One saved session in the list. */
function SessionRow({
  session,
  onOpen,
  onChanged
}: {
  session: ResultSessionMeta
  onOpen: (id: string) => void
  onChanged: () => void
}): React.JSX.Element {
  const remove = (): void => {
    void window.quiz.deleteResult(session.id).then(() => onChanged())
  }

  return (
    <li className="res__row" data-testid={`result-${session.id}`}>
      <span className="res__title">{session.quizTitle}</span>
      <span className="res__meta">
        <Badge tone="neutral">{when(session.endedAt)}</Badge>
        <Badge tone={session.endReason === 'time' ? 'warn' : 'accent'}>
          {reasonLabel(session.endReason)}
        </Badge>
        <Badge tone="teal">
          {session.studentCount} student{session.studentCount === 1 ? '' : 's'}
        </Badge>
        <Badge>{session.totalPoints} points</Badge>
      </span>
      <span className="res__actions">
        <Button
          variant="primary"
          size="sm"
          testId={`open-result-${session.id}`}
          onClick={() => onOpen(session.id)}
        >
          Open
        </Button>
        <ConfirmButton
          label="Delete"
          confirmLabel="Yes, delete these results"
          variant="ghost"
          confirmVariant="danger"
          size="sm"
          testId={`delete-result-${session.id}`}
          confirmTestId={`delete-result-confirm-${session.id}`}
          onConfirm={remove}
        />
      </span>
    </li>
  )
}

/**
 * The results list: every session that was saved, newest first. The list is
 * the way back into the score sheet of a session.
 */
export function Results({
  onOpen,
  onBack
}: {
  onOpen: (id: string) => void
  onBack: () => void
}): React.JSX.Element {
  const [sessions, setSessions] = useState<ResultSessionMeta[] | null>(null)

  const refresh = useCallback(() => {
    void window.quiz.listResults().then(setSessions)
  }, [])
  useEffect(refresh, [refresh])

  return (
    <div className="res">
      <Panel
        title="Saved sessions"
        actions={
          sessions && sessions.length > 0 ? <Badge tone="neutral">{sessions.length}</Badge> : undefined
        }
      >
        {sessions === null ? (
          <EmptyState title="Loading…" />
        ) : sessions.length === 0 ? (
          <EmptyState
            title="No results yet"
            body="Every finished session is saved here with its score sheet."
            icon={<Icon name="results" />}
          />
        ) : (
          <ul className="res__list">
            {sessions.map((s) => (
              <SessionRow key={s.id} session={s} onOpen={onOpen} onChanged={refresh} />
            ))}
          </ul>
        )}
      </Panel>

      <div className="live__controls">
        <Button variant="ghost" onClick={onBack}>
          Back to dashboard
        </Button>
      </div>
    </div>
  )
}

/** One question with the right answer and how many students got it. */
function QuestionOverview({
  question,
  index,
  rightCount,
  total
}: {
  question: ResultQuestionDetail
  index: number
  rightCount: number
  total: number
}): React.JSX.Element {
  const pct = total > 0 ? Math.round((rightCount / total) * 100) : 0
  return (
    <li className="res__question">
      <div className="res__question-head">
        <Badge tone="accent">Q{index + 1}</Badge>
        <Badge>{question.type}</Badge>
        <Badge tone="teal">{question.points} points</Badge>
        <span className="res__question-body">{question.body}</span>
      </div>
      <div className="res__question-meta">
        <span className="res__question-key">
          Right answer: <strong>{keyText(question)}</strong>
        </span>
        <span className="res__question-stat">
          {rightCount} of {total} right ({pct}%)
        </span>
      </div>
      <div className="live__bar live__bar--sm">
        <div className="live__bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </li>
  )
}

/** The editor for one answer: the points, the mark and a note. */
function AnswerEditor({
  answer,
  question,
  onSave,
  onCancel,
  busy,
  error
}: {
  answer: ResultAnswerDetail
  question: ResultQuestionDetail | undefined
  onSave: (points: number, correct: boolean | null, notes: string) => void
  onCancel: () => void
  busy: boolean
  error: string
}): React.JSX.Element {
  const [points, setPoints] = useState(String(answer.pointsAwarded))
  const [mark, setMark] = useState(answer.correct === null ? 'none' : answer.correct ? 'yes' : 'no')
  const [notes, setNotes] = useState(answer.notes ?? '')

  // The selected answer changes when another cell is clicked.
  useEffect(() => {
    setPoints(String(answer.pointsAwarded))
    setMark(answer.correct === null ? 'none' : answer.correct ? 'yes' : 'no')
    setNotes(answer.notes ?? '')
  }, [answer.id, answer.pointsAwarded, answer.correct, answer.notes])

  const submit = (): void => {
    const value = Number(points)
    if (!Number.isFinite(value)) return
    onSave(value, mark === 'none' ? null : mark === 'yes', notes)
  }

  return (
    <div className="res__editor">
      {question && (
        <>
          <div className="res__editor-body">{question.body}</div>
          <div className="res__editor-row">
            <span className="res__editor-label">Student answered</span>
            <span className="res__editor-value">{answerText(question, answer.value)}</span>
          </div>
          <div className="res__editor-row">
            <span className="res__editor-label">Right answer</span>
            <span className="res__editor-value">{keyText(question)}</span>
          </div>
        </>
      )}

      <label className="ui-field">
        <span className="ui-field__label">Points awarded (of {answer.pointsPossible})</span>
        <input
          className="ui-input"
          type="number"
          min={0}
          max={answer.pointsPossible}
          step={0.5}
          value={points}
          data-testid="answer-points"
          onChange={(e) => setPoints(e.target.value)}
        />
      </label>

      <label className="ui-field">
        <span className="ui-field__label">Mark</span>
        <select
          className="ui-select"
          value={mark}
          data-testid="answer-mark"
          onChange={(e) => setMark(e.target.value)}
        >
          <option value="yes">Correct</option>
          <option value="no">Wrong</option>
          <option value="none">Not graded</option>
        </select>
      </label>

      <label className="ui-field">
        <span className="ui-field__label">Note</span>
        <input
          className="ui-input"
          type="text"
          value={notes}
          placeholder="Why this mark?"
          data-testid="answer-notes"
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>

      {error && <p className="ui-error">{error}</p>}

      <div className="live__controls">
        <Button
          variant="primary"
          size="sm"
          testId="answer-save"
          disabled={busy}
          onClick={submit}
        >
          Save mark
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

/**
 * The score sheet of one session: the questions, the students and a cell
 * per answer. Clicking a cell opens it in the editor next to the sheet.
 */
export function ResultDetail({
  sessionId,
  onBack
}: {
  sessionId: string
  onBack: () => void
}): React.JSX.Element {
  const [detail, setDetail] = useState<ResultSessionDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    void window.quiz.getResult(sessionId).then((found) => {
      if (found) {
        setDetail(found)
        setMissing(false)
      } else {
        setDetail(null)
        setMissing(true)
      }
    })
  }, [sessionId])

  useEffect(load, [load])

  /** The answers of every student, by question id. */
  const answersByStudent = useMemo(() => {
    const map = new Map<string, Map<string, ResultAnswerDetail>>()
    for (const student of detail?.students ?? []) {
      const byQuestion = new Map<string, ResultAnswerDetail>()
      for (const answer of student.answers) byQuestion.set(answer.questionId, answer)
      map.set(student.id, byQuestion)
    }
    return map
  }, [detail])

  const selectedAnswer = useMemo(() => {
    if (!detail || !selected) return null
    for (const student of detail.students) {
      const found = student.answers.find((a) => a.id === selected)
      if (found) return found
    }
    return null
  }, [detail, selected])

  const selectedQuestion = useMemo(() => {
    if (!detail || !selectedAnswer) return undefined
    return detail.questions.find((q) => q.id === selectedAnswer.questionId)
  }, [detail, selectedAnswer])

  const save = useCallback(
    (points: number, correct: boolean | null, notes: string) => {
      if (!selectedAnswer) return
      setBusy(true)
      setError('')
      void window.quiz
        .updateResultAnswer({ answerId: selectedAnswer.id, pointsAwarded: points, correct, notes })
        .then((result) => {
          setBusy(false)
          if (result.ok) {
            setSelected(null)
            load()
          } else {
            setError(result.error)
          }
        })
        .catch(() => {
          setBusy(false)
          setError('The mark could not be saved.')
        })
    },
    [selectedAnswer, load]
  )

  if (missing) {
    return (
      <div className="res">
        <EmptyState
          title="These results are gone"
          body="The session was deleted."
          icon={<Icon name="results" />}
          action={
            <Button variant="secondary" onClick={onBack}>
              Back to results
            </Button>
          }
        />
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="res">
        <EmptyState title="Loading…" />
      </div>
    )
  }

  const { meta, questions, students } = detail

  return (
    <div className="res">
      <Panel
        title={meta.quizTitle}
        actions={
          <>
            <Badge tone="neutral">{when(meta.endedAt)}</Badge>
            <Badge tone={meta.endReason === 'time' ? 'warn' : 'accent'}>
              {reasonLabel(meta.endReason)}
            </Badge>
          </>
        }
      >
        <div className="res__summary">
          <span>
            <strong>{students.length}</strong> student{students.length === 1 ? '' : 's'}
          </span>
          <span>
            <strong>{questions.length}</strong> question{questions.length === 1 ? '' : 's'}
          </span>
          <span>
            <strong>{meta.totalPoints}</strong> points in total
          </span>
          {meta.startedAt !== null && (
            <span>
              started <strong>{when(meta.startedAt)}</strong>
            </span>
          )}
        </div>
      </Panel>

      <div className="res__columns">
        <div className="ed">
          <Panel title="Questions" actions={<Badge tone="neutral">{questions.length}</Badge>}>
            {questions.length === 0 ? (
              <EmptyState title="This session had no questions" icon={<Icon name="quizzes" />} />
            ) : (
              <ul className="res__questions">
                {questions.map((question, index) => {
                  const right = students.filter((student) => {
                    const answer = answersByStudent.get(student.id)?.get(question.id)
                    return answer?.correct === true
                  }).length
                  return (
                    <QuestionOverview
                      key={question.id}
                      question={question}
                      index={index}
                      rightCount={right}
                      total={students.length}
                    />
                  )
                })}
              </ul>
            )}
          </Panel>

          <Panel title="Score sheet" actions={<Badge tone="neutral">{students.length} students</Badge>}>
            {students.length === 0 ? (
              <EmptyState title="Nobody was in this session" icon={<Icon name="users" />} />
            ) : (
              <div className="res__sheet-scroll">
                <table className="res__sheet">
                  <thead>
                    <tr>
                      <th scope="col" className="res__sheet-student">
                        Student
                      </th>
                      {questions.map((question, index) => (
                        <th key={question.id} scope="col">
                          <span className="res__sheet-q">Q{index + 1}</span>
                          <span className="res__sheet-p">{question.points}p</span>
                        </th>
                      ))}
                      <th scope="col">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {students.map((student) => (
                      <tr key={student.id}>
                        <th scope="row" className="res__sheet-student" data-testid={`student-${student.id}`}>
                          {student.studentName}
                          {student.finished && <span className="res__sheet-flag">finished</span>}
                        </th>
                        {questions.map((question) => {
                          const answer = answersByStudent.get(student.id)?.get(question.id)
                          const { state, mark } = cellState(answer)
                          const text = question ? answerText(question, answer?.value ?? null) : ''
                          return (
                            <td key={question.id}>
                              <button
                                type="button"
                                className={`res__cell res__cell--${state}${
                                  selected === answer?.id ? ' is-selected' : ''
                                }`}
                                title={text}
                                data-testid={`cell-${student.id}-${question.id}`}
                                onClick={() => setSelected(answer?.id ?? null)}
                              >
                                <span className="res__cell-mark">{mark}</span>
                                <span className="res__cell-text">{text}</span>
                                <span className="res__cell-points">
                                  {answer ? answer.pointsAwarded : 0}/{answer?.pointsPossible ?? question.points}
                                </span>
                              </button>
                            </td>
                          )
                        })}
                        <td className="res__sheet-total" data-testid={`total-${student.id}`}>
                          {student.totalPointsAwarded}/{student.totalPointsPossible}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>

        <div className="ed">
          <Panel title="Mark an answer" actions={<Badge tone="neutral">instructor</Badge>}>
            {selectedAnswer ? (
              <AnswerEditor
                answer={selectedAnswer}
                question={selectedQuestion}
                onSave={save}
                onCancel={() => setSelected(null)}
                busy={busy}
                error={error}
              />
            ) : (
              <EmptyState
                title="Pick an answer"
                body="Click any cell of the score sheet to change the mark."
                icon={<Icon name="edit" />}
              />
            )}
          </Panel>
        </div>
      </div>

      <div className="live__controls">
        <Button variant="ghost" onClick={onBack}>
          Back to results
        </Button>
      </div>
    </div>
  )
}
