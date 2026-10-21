import { useState } from 'react'
import type { ImportQuizReport, QuestionType } from '../shared/types'
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

export function AiGenerateDialog({ open, onClose, onGenerated }: AiGenerateDialogProps): React.JSX.Element | null {
  const [sourceText, setSourceText] = useState('')
  const [sourceFile, setSourceFile] = useState<string | null>(null)
  const [selectedTypes, setSelectedTypes] = useState<QuestionType[]>(['mcq', 'tf'])
  const [count, setCount] = useState(5)
  const [points, setPoints] = useState(1)
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [error, setError] = useState('')

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
    if (path) {
      setSourceFile(path)
      const text = await window.quiz.aiReadFile(path)
      if (text) setSourceText(text)
    }
  }

  const generate = async (): Promise<void> => {
    if (selectedTypes.length === 0) {
      setError('Select at least one question type.')
      return
    }
    if (!sourceText.trim() && !sourceFile) {
      setError('Provide source text or select a file.')
      return
    }
    setStatus('loading')
    setError('')

    const result = await window.quiz.aiGenerate({
      sourceText: sourceText || (sourceFile ? `Source: ${sourceFile}` : ''),
      questionTypes: selectedTypes,
      count: Math.max(1, Math.min(50, count)),
      points: Math.max(1, points)
    })

    if (result.ok && 'report' in result && result.report) {
      setStatus('idle')
      onGenerated(result.report)
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

  if (!open) return null

  return (
    <div className="ai__overlay" onClick={onClose}>
      <div className="ai__dialog" onClick={(e) => e.stopPropagation()}>
        <Panel
          title="Generate questions with AI"
          actions={<Badge tone="neutral">Stub provider</Badge>}
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

            <div className="ai__controls">
              <label className="ui-field">
                <span className="ui-field__label">Number of questions</span>
                <input
                  className="ui-input"
                  type="number"
                  min={1}
                  max={50}
                  value={count}
                  onChange={(e) => setCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
                />
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

            {error && <p className="ui-error">{error}</p>}

            <div className="ai__actions">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" icon={<Icon name="sparkle" />} onClick={generate} disabled={status === 'loading'}>
                {status === 'loading' ? 'Generating…' : 'Generate'}
              </Button>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  )
}
