import { useCallback, useEffect, useState } from 'react'
import type { ImportQuizReport, QuestionType, StoredQuestion, StoredQuiz } from '../shared/types'
import { QUESTION_TYPES } from '../shared/types'
import { validateQuestion } from '../shared/validation'
import { QuestionForm, TYPE_LABELS, newQuestion } from './QuestionForms'

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
    <section className="question-card">
      <div className="q-head">
        <span className="q-num">#{index + 1}</span>
        <span className="tag">{TYPE_LABELS[question.type]}</span>
        <span className={`badge ${ready ? 'ready' : 'draft'}`}>{ready ? 'ready' : 'draft'}</span>
        <span className="q-actions">
          <button className="mini" title="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
            ↑
          </button>
          <button
            className="mini"
            title="Move down"
            disabled={index === total - 1}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
          <button className="mini danger" title="Delete question" onClick={onDelete}>
            ✕
          </button>
        </span>
      </div>
      {problems.length > 0 && (
        <ul className="q-problems">
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
      <div className="lobby">
        <header className="topbar">
          <h1>Quiz editor</h1>
        </header>
        <p className="empty">This quiz is no longer in the library.</p>
        <button className="secondary" onClick={onBack}>
          Back to library
        </button>
      </div>
    )
  }
  if (!quiz) {
    return (
      <div className="lobby">
        <p className="empty">Loading…</p>
      </div>
    )
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
    <div className="lobby editor">
      <header className="topbar">
        <h1>{quiz.title.trim() || 'Untitled quiz'}</h1>
        <span className="topbar-actions">
          {dirty ? (
            <span className="tag">unsaved changes</span>
          ) : saved ? (
            <span className="tag ready-tag">saved</span>
          ) : null}
          <button className="secondary" onClick={back}>
            Back to library
          </button>
          <button className="primary" onClick={save}>
            Save
          </button>
        </span>
      </header>

      {importReport && (
        <section className="import-report">
          <h2>Import complete</h2>
          <p><strong>Title:</strong> {importReport.title}</p>
          <p><strong>Questions:</strong> {importReport.questionCount}</p>
          {importReport.warnings.length > 0 && (
            <ul>
              {importReport.warnings.map((w) => (
                <li key={`${w.questionIndex ?? 'quiz'}-${w.message}`}>{w.message}</li>
              ))}
            </ul>
          )}
          {importReport.questions.map((q) => (
            <div key={q.id} className="import-question">
              <div className="import-question-head">
                <span className="tag">{q.type}</span>
                <strong>#{q.id}</strong>
              </div>
              <pre className="source-text">{q.sourceText}</pre>
            </div>
          ))}
        </section>
      )}

      {error && <p className="error">{error}</p>}

      <div className="editor-meta">
        <label className="field grow">
          <span>Title</span>
          <input
            type="text"
            value={quiz.title}
            onChange={(e) => patch((q) => ({ ...q, title: e.target.value }))}
          />
        </label>
        <label className="field narrow">
          <span>Time limit (minutes)</span>
          <input
            type="number"
            min={1}
            step={1}
            value={quiz.timeLimitSec / 60}
            onChange={(e) => changeTimeLimit(e.target.value)}
          />
        </label>
      </div>

      <div className="question-list">
        {quiz.questions.length === 0 && <p className="empty">No questions yet — add one below.</p>}
        {quiz.questions.map((question, i) => (
          <QuestionCard
            key={question.id}
            question={question}
            index={i}
            total={quiz.questions.length}
            onChange={(next) => changeQuestion(i, next)}
            onMove={(delta) => moveQuestion(i, delta)}
            onDelete={() => deleteQuestion(i)}
          />
        ))}
      </div>

      <div className="add-row">
        <span className="muted">Add question:</span>
        {QUESTION_TYPES.map((type) => (
          <button key={type} className="secondary" onClick={() => addQuestion(type)}>
            + {TYPE_LABELS[type]}
          </button>
        ))}
      </div>
    </div>
  )
}