import { useCallback, useEffect, useState } from 'react'
import type { ImportQuizReport, QuizMeta } from '../../shared/types'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { ConfirmButton } from '../components/ConfirmButton'
import { EmptyState } from '../components/EmptyState'
import { Icon } from '../components/Icon'
import { Panel } from '../components/Panel'

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
  const [notice, setNotice] = useState('')

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
    <li className="lib__row" data-testid={`quiz-${quiz.id}`}>
      <span className="lib__title">{quiz.title}</span>
      <span className="lib__meta">
        <Badge>
          {quiz.questionCount} question{quiz.questionCount === 1 ? '' : 's'}
        </Badge>
        <Badge tone="teal">{minutes(quiz.timeLimitSec)}</Badge>
      </span>
      {notice && <span className="lib__notice">{notice}</span>}
      <span className="lib__actions">
        <Button
          variant="primary"
          size="sm"
          testId={`open-${quiz.id}`}
          onClick={() => onOpen(quiz.id)}
        >
          Open
        </Button>
        <Button variant="secondary" size="sm" onClick={duplicate}>
          Duplicate
        </Button>
        <Button variant="secondary" size="sm" onClick={exportQuiz}>
          Export
        </Button>
        <ConfirmButton
          label="Delete"
          confirmLabel="Yes, delete"
          variant="ghost"
          confirmVariant="danger"
          size="sm"
          testId={`delete-${quiz.id}`}
          confirmTestId={`delete-confirm-${quiz.id}`}
          onConfirm={remove}
        />
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
    <div className="lib">
      {error && <p className="ui-error">{error}</p>}

      {importReport && (
        <Panel title="Import complete" actions={<Badge tone="ok">Added to library</Badge>}>
          <div className="import">
            <p>
              <strong>Title:</strong> {importReport.title}
            </p>
            <p>
              <strong>Questions:</strong> {importReport.questionCount}
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

      <Panel
        title="Your quizzes"
        actions={
          <>
            <Button variant="secondary" icon={<Icon name="upload" />} onClick={importQuiz}>
              Import…
            </Button>
            <Button variant="primary" icon={<Icon name="plus" />} onClick={create}>
              New quiz
            </Button>
          </>
        }
      >
        {quizzes === null ? (
          <EmptyState title="Loading…" />
        ) : quizzes.length === 0 ? (
          <EmptyState
            title="No quizzes yet"
            body="Create a quiz from scratch, or import a quiz file you already have."
            icon={<Icon name="quizzes" />}
            action={
              <div className="live__controls">
                <Button variant="primary" icon={<Icon name="plus" />} onClick={create}>
                  New quiz
                </Button>
                <Button variant="secondary" icon={<Icon name="upload" />} onClick={importQuiz}>
                  Import…
                </Button>
              </div>
            }
          />
        ) : (
          <ul className="lib__list">
            {quizzes.map((q) => (
              <QuizRow key={q.id} quiz={q} onOpen={onOpen} onChanged={refresh} />
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