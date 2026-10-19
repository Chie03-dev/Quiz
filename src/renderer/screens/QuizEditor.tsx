import { useCallback, useEffect, useState } from 'react'
import type { ImportQuizReport, QuestionType, StoredQuestion, StoredQuiz } from '../../shared/types'
import { QUESTION_TYPES } from '../../shared/types'
import { validateQuestion } from '../../shared/validation'
import { QuestionForm, TYPE_LABELS, newQuestion } from '../QuestionForms'
import { Badge } from '../components/Badge'
import { Button, IconButton } from '../components/Button'
import { EmptyState } from '../components/EmptyState'
import { Icon } from '../components/Icon'
import { Panel } from '../components/Panel'

/** One question card: status badge, problems, move/delete, and its form. */
function QuestionCard({
  question,
  index,
  total,
  onChange,
  onMove,
  onDelete
}: {
  question: StoredQuestion
  index: number
  total: number
  onChange: (next: StoredQuestion) => void
  onMove: (delta: number) => void
  onDelete: () => void
}): React.JSX.Element {
  // Live validation; save() recomputes the same list on the main side.
  const problems = validateQuestion(question)
  const ready = problems.length === 0

  return (
    <section className="ed__card">
      <div className="ed__card-head">
        <span className="ed__card-num">#{index + 1}</span>
        <Badge tone="neutral">{TYPE_LABELS[question.type]}</Badge>
        <Badge tone={ready ? 'ok' : 'warn'}>{ready ? 'ready' : 'draft'}</Badge>
        <span className="ed__card-actions">
          <IconButton
            label={`Move question ${index + 1} up`}
            icon={<Icon name="arrow-up" />}
            size="sm"
            disabled={index === 0}
            onClick={() => onMove(-1)}
          />
          <IconButton
            label={`Move question ${index + 1} down`}
            icon={<Icon name="arrow-down" />}
            size="sm"
            disabled={index === total - 1}
            onClick={() => onMove(1)}
          />
          <IconButton
            label={`Delete question ${index + 1}`}
            icon={<Icon name="trash" />}
            size="sm"
            variant="danger"
            onClick={onDelete}
          />
        </span>
      </div>
      {problems.length > 0 && (
        <ul className="ed__problems">
          {problems.map((problem, i) => (
            <li key={i}>{problem}</li>
          ))}
        </ul>
      )}
      <QuestionForm question={question} onChange={onChange} />
    </section>
  )
}

/** The quiz editor: title, time limit, ordered questions, add by type, save. */
export function QuizEditor({
  quizId,
  onBack,
  importReport = null
}: {
  quizId: string
  onBack: () => void
  importReport?: ImportQuizReport | null
}): React.JSX.Element {
  const [quiz, setQuiz] = useState<StoredQuiz | null>(null)
  const [missing, setMissing] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setQuiz(null)
    setMissing(false)
    setDirty(false)
    setError('')
    void window.quiz.getQuiz(quizId).then((loaded) => {
      if (!active) return
      if (loaded) {
        setQuiz(loaded)
        setMissing(false)
      } else {
        setMissing(true)
      }
    })
    return () => {
      active = false
    }
  }, [quizId])

  const update = useCallback((next: StoredQuiz) => {
    setQuiz(next)
    setDirty(true)
    setSaved(false)
  }, [])

  if (missing) {
    return (
      <EmptyState
        title="This quiz is no longer in the library"
        body="It may have been deleted in another window."
        icon={<Icon name="quizzes" />}
        action={
          <Button variant="secondary" onClick={onBack}>
            Back to library
          </Button>
        }
      />
    )
  }
  if (!quiz) {
    return <EmptyState title="Loading…" />
  }

  const patch = (change: (q: StoredQuiz) => StoredQuiz): void => update(change(quiz))

  const moveQuestion = (index: number, delta: number): void => {
    const target = index + delta
    if (target < 0 || target >= quiz.questions.length) return
    patch((q) => {
      const questions = [...q.questions]
      ;[questions[index], questions[target]] = [questions[target], questions[index]]
      return { ...q, questions }
    })
  }

  const changeQuestion = (index: number, next: StoredQuestion): void => {
    patch((q) => ({ ...q, questions: q.questions.map((item, i) => (i === index ? next : item)) }))
  }

  const deleteQuestion = (index: number): void => {
    patch((q) => ({ ...q, questions: q.questions.filter((_, i) => i !== index) }))
  }

  const addQuestion = (type: QuestionType): void => {
    patch((q) => ({ ...q, questions: [...q.questions, newQuestion(type)] }))
  }

  const save = (): void => {
    void window.quiz.saveQuiz(quiz).then((result) => {
      if (result.ok) {
        setQuiz(result.quiz)
        setDirty(false)
        setSaved(true)
        setError('')
      } else {
        setError(result.error)
      }
    })
  }

  const back = (): void => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return
    onBack()
  }

  const changeTimeLimit = (raw: string): void => {
    const minutes = Number(raw)
    if (!Number.isFinite(minutes)) return
    patch((q) => ({ ...q, timeLimitSec: Math.max(1, Math.round(minutes * 60)) }))
  }

  return (
    <div className="ed">
      {importReport && (
        <Panel title="Import complete" actions={<Badge tone="ok">{importReport.questionCount} questions</Badge>}>
          <div className="import">
            <p>
              <strong>Title:</strong> {importReport.title}
            </p>
            {importReport.warnings.length > 0 && (
              <ul className="ed__problems">
                {importReport.warnings.map((w) => (
                  <li key={`${w.questionIndex ?? 'quiz'}-${w.message}`}>{w.message}</li>
                ))}
              </ul>
            )}
            <div className="import__list">
              {importReport.questions.map((q) => (
                <div key={q.id} className="import__item">
                  <div className="import__item-head">
                    <Badge tone="accent">{q.type}</Badge>
                    <strong>#{q.id}</strong>
                  </div>
                  <pre className="import__source">{q.sourceText}</pre>
                </div>
              ))}
            </div>
          </div>
        </Panel>
      )}

      {error && <p className="ui-error">{error}</p>}

      <div className="ed__meta">
        <label className="ui-field">
          <span className="ui-field__label">Title</span>
          <input
            className="ui-input"
            type="text"
            data-testid="quiz-title"
            value={quiz.title}
            onChange={(e) => patch((q) => ({ ...q, title: e.target.value }))}
          />
        </label>
        <label className="ui-field">
          <span className="ui-field__label">Time limit (minutes)</span>
          <input
            className="ui-input"
            type="number"
            min={1}
            step={1}
            data-testid="time-limit"
            value={quiz.timeLimitSec / 60}
            onChange={(e) => changeTimeLimit(e.target.value)}
          />
        </label>
      </div>


      <div className="ed__cards">
        {quiz.questions.length === 0 ? (
          <EmptyState
            title="No questions yet"
            body="Add a question using the buttons below."
            icon={<Icon name="quizzes" />}
          />
        ) : (
          quiz.questions.map((question, i) => (
            <QuestionCard
              key={question.id}
              question={question}
              index={i}
              total={quiz.questions.length}
              onChange={(next) => changeQuestion(i, next)}
              onMove={(delta) => moveQuestion(i, delta)}
              onDelete={() => deleteQuestion(i)}
            />
          ))
        )}
      </div>

      <div className="ed__add">
        <span className="ui-field__label">Add question</span>
        {QUESTION_TYPES.map((type) => (
          <Button
            key={type}
            variant="secondary"
            size="sm"
            icon={<Icon name="plus" />}
            onClick={() => addQuestion(type)}
          >
            {TYPE_LABELS[type]}
          </Button>
        ))}
      </div>

      <div className="live__controls">
        <Button variant="ghost" onClick={back}>
          Back to library
        </Button>
        {dirty ? <Badge tone="warn">Unsaved changes</Badge> : saved ? <Badge tone="ok">Saved</Badge> : null}
        <Button variant="primary" testId="save-quiz" onClick={save}>
          Save
        </Button>
      </div>
    </div>
  )
}

