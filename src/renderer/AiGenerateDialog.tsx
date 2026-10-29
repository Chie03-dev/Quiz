import { useEffect, useMemo, useState } from 'react'
import type {
  AiStatus,
  AiTiming,
  GenerateProgress,
  ImportQuizReport,
  QuestionType
} from '../shared/types'
import { QUESTION_TYPES } from '../shared/types'
import { TYPE_LABELS } from './QuestionForms'
import { Badge } from './components/Badge'
import { Button } from './components/Button'
import { Icon } from './components/Icon'
import { Panel } from './components/Panel'

interface AiGenerateDialogProps {
  open: boolean
  onClose: () => void
  onGenerated: (report: ImportQuizReport) => void
}

const TYPE_OPTIONS = QUESTION_TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] }))

/** How long a run takes, as "45 s" or "2 min 10 s". */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 s'
  if (seconds < 60) return `${Math.round(seconds)} s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`
}

export function AiGenerateDialog({ open, onClose, onGenerated }: AiGenerateDialogProps): React.JSX.Element | null {
  const [sourceText, setSourceText] = useState('')
  // The text of a chosen file. It is far too long for the box, so it is kept
  // apart and only its size is shown.
  const [fileText, setFileText] = useState('')
  const [sourceFile, setSourceFile] = useState<string | null>(null)
  const [selectedTypes, setSelectedTypes] = useState<QuestionType[]>(['mcq', 'tf'])
  const [count, setCount] = useState(5)
  const [points, setPoints] = useState(1)
  const [topic, setTopic] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [error, setError] = useState('')
  const [engine, setEngine] = useState<AiStatus | null>(null)
  // How long the last run took, so the wait can be judged.
  const [timing, setTiming] = useState<AiTiming | null>(null)
  // How far the run that is going on has come.
  const [progress, setProgress] = useState<GenerateProgress | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  // Set when questions were left out: the dialog stays open and says why.
  const [notice, setNotice] = useState<{
    report: ImportQuizReport
    made: number
    asked: number
  } | null>(null)

  // The badge says which engine answers, so it has to be asked each time.
  useEffect(() => {
    if (!open) return
    let active = true
    window.quiz
      .aiStatus()
      .then((s) => {
        if (active) setEngine(s)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [open])

  // The estimate of the wait, and the progress of the run.
  useEffect(() => {
    if (!open) return
    let active = true
    setProgress(null)
    setElapsedMs(0)
    window.quiz
      .aiTiming()
      .then((t) => {
        if (active) setTiming(t)
      })
      .catch(() => undefined)
    const off = window.quiz.onGenerateProgress((p) => {
      if (active) setProgress(p)
    })
    return () => {
      active = false
      off()
    }
  }, [open])

  // The clock of the run: it ticks while the questions are written.
  useEffect(() => {
    if (status !== 'loading') return
    const started = Date.now()
    const timer = setInterval(() => setElapsedMs(Date.now() - started), 500)
    return () => clearInterval(timer)
  }, [status])

  const asked = Math.max(1, Math.min(50, count))

  // How long the run will take: the start-up of the model plus the time the
  // questions themselves take.
  const estimateMs = useMemo(() => {
    const perQuestion = timing?.secondsPerQuestion ?? 6
    const startUp = timing?.startUpSeconds ?? 10
    return (startUp + asked * perQuestion) * 1000
  }, [timing, asked])

  const toggleType = (type: QuestionType): void => {
    const index = selectedTypes.indexOf(type)
    if (index >= 0) {
      setSelectedTypes(selectedTypes.filter((t) => t !== type))
    } else {
      setSelectedTypes([...selectedTypes, type])
    }
  }

  const selectFile = async (): Promise<void> => {
    const path = await window.quiz.aiSelectFile()
    if (!path) return
    setError('')
    setSourceFile(path)
    const text = await window.quiz.aiReadFile(path)
    if (text.trim()) {
      setFileText(text)
      return
    }
    // The file has no text the AI can read; the path is no use as a source.
    setFileText('')
    setError('This file has no readable text. A Word document or a PDF with text in it works.')
  }

  const generate = async (): Promise<void> => {
    if (selectedTypes.length === 0) {
      setError('Select at least one question type.')
      return
    }
    // The file is read by the main process; only the pasted text comes from
    // here. Both are used.
    const text = sourceText.trim()
    if (!text && !sourceFile) {
      setError('Provide source text or select a file.')
      return
    }
    setStatus('loading')
    setError('')
    setNotice(null)
    setProgress(null)
    setElapsedMs(0)

    const result = await window.quiz.aiGenerate({
      sourceText: text,
      filePath: sourceFile ?? undefined,
      topic: topic.trim(),
      questionTypes: selectedTypes,
      count: asked,
      points: Math.max(1, points)
    })

    if (result.ok && 'report' in result && result.report) {
      const report = result.report
      setStatus('idle')
      // Not every question held up: the dialog stays open and says why, so
      // the count is never quietly smaller than what was asked for.
      if (report.questionCount < asked) {
        setNotice({ report, made: report.questionCount, asked })
        return
      }
      onGenerated(report)
      onClose()
    } else if (result.ok && 'quiz' in result) {
      setStatus('idle')
      onGenerated({
        id: result.quiz.id,
        title: result.quiz.title,
        questionCount: result.quiz.questions.length,
        warnings: [],
        questions: result.quiz.questions.map((q) => ({
          id: q.id,
          type: q.type,
          body: q.body,
          sourceText: q.sourceText
        }))
      })
      onClose()
    } else {
      setStatus('error')
      setError(result.ok ? 'Unexpected result.' : result.error)
    }
  }

  const loading = status === 'loading'
  const percent = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.done / progress.total) * 100))
    : 0
  const remainingMs = Math.max(0, estimateMs - elapsedMs)

  if (!open) return null

  return (
    <div className="ai__overlay" onClick={loading ? undefined : onClose}>
      <div className="ai__dialog" onClick={(e) => e.stopPropagation()}>
        <Panel
          title="Generate questions with AI"
          actions={
            <Badge tone={engine?.provider === 'gguf' ? 'ok' : 'neutral'}>
              {engine?.provider === 'gguf' ? engine.model : 'Built-in generator'}
            </Badge>
          }
        >
          <div className="ai__content">
            <div className="ai__source">
              <label className="ui-field">
                <span className="ui-field__label">Source text</span>
                <textarea
                  className="ui-textarea"
                  rows={6}
                  placeholder="Paste chapter text or notes here…"
                  value={sourceText}
                  onChange={(e) => setSourceText(e.target.value)}
                />
              </label>
              <Button variant="secondary" size="sm" icon={<Icon name="upload" />} onClick={selectFile}>
                {sourceFile ? sourceFile : 'Choose a file…'}
              </Button>
              {fileText && (
                <p className="ai__file-note">
                  {fileText.length.toLocaleString()} characters of the file are read and used with your
                  text.
                </p>
              )}
            </div>

            <div className="ai__types">
              <span className="ui-field__label">Question types</span>
              <div className="ai__type-grid">
                {TYPE_OPTIONS.map((opt) => (
                  <label key={opt.value} className="ai__type-check">
                    <input
                      type="checkbox"
                      checked={selectedTypes.includes(opt.value)}
                      onChange={() => toggleType(opt.value)}
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
            </div>

            <label className="ui-field">
              <span className="ui-field__label">What should the questions be about? (optional)</span>
              <input
                className="ui-input"
                type="text"
                data-testid="ai-topic"
                placeholder="Leave empty to spread the questions over the whole text"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
              />
            </label>

            <div className="ai__controls">
              <label className="ui-field">
                <span className="ui-field__label">Number of questions</span>
                <input
                  className="ui-input"
                  type="number"
                  min={1}
                  max={50}
                  data-testid="ai-count"
                  value={count}
                  onChange={(e) => setCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
                />
                <span className="ai__estimate" data-testid="ai-estimate">
                  ≈ {formatDuration(estimateMs / 1000)} for {asked} question{asked === 1 ? '' : 's'}
                </span>
              </label>
              <label className="ui-field">
                <span className="ui-field__label">Points per question</span>
                <input
                  className="ui-input"
                  type="number"
                  min={1}
                  max={99}
                  value={points}
                  onChange={(e) => setPoints(Math.max(1, Math.min(99, Number(e.target.value) || 1)))}
                />
              </label>
            </div>

            {loading && (
              <div className="ai__progress" data-testid="ai-progress">
                <div className="ai__progress-bar">
                  <div className="ai__progress-fill" style={{ width: `${percent}%` }} />
                </div>
                <p className="ai__progress-count" data-testid="ai-progress-count">
                  {progress
                    ? `${progress.done} of ${progress.total} questions`
                    : 'Starting the model…'}
                </p>
                <p className="ai__progress-time" data-testid="ai-progress-time">
                  {formatDuration(elapsedMs / 1000)} elapsed
                  {remainingMs > 0 ? ` · about ${formatDuration(remainingMs / 1000)} left` : ''}
                </p>
              </div>
            )}

            {notice && (
              <div className="ai__notice" data-testid="ai-notice">
                <p className="ai__notice-title">
                  {notice.made} of {notice.asked} questions were made.
                </p>
                {notice.report.warnings[0]?.message && (
                  <p className="ai__notice-body">{notice.report.warnings[0].message}</p>
                )}
                <Button
                  variant="primary"
                  testId="ai-notice-close"
                  onClick={() => {
                    onGenerated(notice.report)
                    onClose()
                  }}
                >
                  Show the questions
                </Button>
              </div>
            )}

            {error && <p className="ui-error">{error}</p>}

            <div className="ai__actions">
              <Button variant="ghost" testId="ai-cancel" onClick={onClose} disabled={loading}>
                Cancel
              </Button>
              {notice ? null : (
                <Button
                  variant="primary"
                  icon={<Icon name="sparkle" />}
                  onClick={generate}
                  disabled={loading}
                  testId="ai-generate"
                >
                  {loading ? 'Generating…' : 'Generate'}
                </Button>
              )}
            </div>
          </div>
        </Panel>
      </div>
    </div>
  )
}

