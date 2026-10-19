import { useCallback, useEffect, useState } from 'react'
import type { ImportQuizReport, QuizMeta } from '../shared/types'

/** Minutes shown for a time limit stored in seconds. */
const minutes = (sec: number): string => {
  const m = sec / 60
  return Number.isInteger(m) ? `${m} min` : `${m.toFixed(1)} min`
}

/** One row of the library list. */
function QuizRow({
  quiz,
  onOpen,
  onChanged
}: {
  quiz: QuizMeta
  onOpen: (id: string) => void
  onChanged: () => void
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [notice, setNotice] = useState('')

  // Back to the plain button if the instructor hesitates.
  useEffect(() => {
    if (!confirming) return
    const t = setTimeout(() => setConfirming(false), 5000)
    return () => clearTimeout(t)
  }, [confirming])

  const duplicate = (): void => {
    void window.quiz.duplicateQuiz(quiz.id).then((copy) => {
      if (copy) onChanged()
    })
  }

  const remove = (): void => {
    void window.quiz.deleteQuiz(quiz.id).then(() => onChanged())
  }

  const exportQuiz = (): void => {
    void window.quiz.exportQuiz(quiz.id).then((result) => {
      setNotice(result.ok ? `Exported to ${result.path}` : result.error)
    })
  }

  return (
    <li className="lib-row">
      <span className="name">{quiz.title}</span>
      <span className="tag">
        {quiz.questionCount} question{quiz.questionCount === 1 ? '' : 's'}
      </span>
      <span className="tag">{minutes(quiz.timeLimitSec)}</span>
      {notice && <span className="lib-notice">{notice}</span>}
      <span className="row-actions">
        <button className="primary" onClick={() => onOpen(quiz.id)}>
          Open
        </button>
        <button className="secondary" onClick={duplicate}>
          Duplicate
        </button>
        <button className="secondary" onClick={exportQuiz}>
          Export
        </button>
        {confirming ? (
          <span className="confirm">
            <button className="danger" onClick={remove}>
              Yes, delete
            </button>
            <button className="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button className="danger" onClick={() => setConfirming(true)}>
            Delete
          </button>
        )}
      </span>
    </li>
  )
}

/** The quiz library: list, create, duplicate, delete, import, open. */
export function QuizLibrary({
  onBack,
  onOpen
}: {
  onBack: () => void
  onOpen: (id: string) => void
}): React.JSX.Element {
  const [quizzes, setQuizzes] = useState<QuizMeta[] | null>(null)
  const [error, setError] = useState('')

  const refresh = useCallback(() => {
    void window.quiz.listQuizzes().then(setQuizzes)
  }, [])
  useEffect(refresh, [refresh])

  const create = (): void => {
    void window.quiz.createQuiz().then((quiz) => {
      if (quiz) onOpen(quiz.id)
    })
  }

  const [importReport, setImportReport] = useState<ImportQuizReport | null>(null)

  const importQuiz = (): void => {
    void window.quiz.importQuiz().then((result) => {
      if (result.ok) {
        setError('')
        setImportReport(null)
        if ('report' in result && result.report) {
          setImportReport(result.report)
          onOpen(result.report.id)
        } else if ('quiz' in result && result.quiz) {
          onOpen(result.quiz.id)
        }
        refresh()
      } else if (!result.cancelled) {
        setError(result.error)
      }
    })
  }

  return (
    <div className="lobby">
      <header className="topbar">
        <h1>Quiz library</h1>
        <span className="topbar-actions">
          <button className="secondary" onClick={importQuiz}>
            Import…
          </button>
          <button className="primary" onClick={create}>
            New quiz
          </button>
          <button className="secondary" onClick={onBack}>
            Back to lobby
          </button>
        </span>
      </header>

      {error && <p className="error lib-error">{error}</p>}

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

      {quizzes === null ? (
        <p className="empty">Loading…</p>
      ) : quizzes.length === 0 ? (
        <p className="empty">No quizzes yet. Create one or import a quiz file.</p>
      ) : (
        <ul className="lib-list">
          {quizzes.map((q) => (
            <QuizRow key={q.id} quiz={q} onOpen={onOpen} onChanged={refresh} />
          ))}
        </ul>
      )}
    </div>
  )
}