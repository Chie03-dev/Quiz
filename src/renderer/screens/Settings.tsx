import { useCallback, useEffect, useState } from 'react'
import type { AiStatus, ModelInfo } from '../../shared/types'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Field } from '../components/Field'
import { Icon } from '../components/Icon'

/** A download in flight, with how far it got. */
interface Progress {
  modelId: string
  percent: number
}

/** Human-readable file size. */
function formatSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`
  return `${Math.round(bytes / 1000)} kB`
}

export function Settings(): React.JSX.Element {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [modelsDir, setModelsDir] = useState('')
  const [enginePath, setEnginePath] = useState('')

  const loadModels = useCallback(async (): Promise<void> => {
    try {
      const list = await window.quiz.aiModels()
      setModels(list)
      setError('')
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      setStatus(await window.quiz.aiStatus())
    } catch {
      setStatus(null)
    }
  }, [])

  useEffect(() => {
    void loadModels()
    void loadStatus()
    window.quiz.aiInfo().then((info) => {
      setModelsDir(info.modelsDir)
      setEnginePath(info.enginePath ?? '')
    })
  }, [loadModels, loadStatus])

  // The download reports its progress over IPC; the screen follows it.
  useEffect(
    () =>
      window.quiz.onModelProgress((p) => {
        setProgress({ modelId: p.modelId, percent: p.percent })
      }),
    []
  )

  const download = async (id: string): Promise<void> => {
    setBusy(id)
    setError('')
    setProgress({ modelId: id, percent: 0 })
    try {
      const result = await window.quiz.aiDownloadModel(id)
      if (!result.ok) setError(result.error)
      await loadModels()
      await loadStatus()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  const activate = async (id: string | null): Promise<void> => {
    setError('')
    try {
      const ok = await window.quiz.aiSetModel(id)
      if (!ok) setError('That model could not be selected.')
      await loadModels()
      await loadStatus()
    } catch (err) {
      setError(String(err))
    }
  }

  const remove = async (model: ModelInfo): Promise<void> => {
    if (!window.confirm(`Delete ${model.name}? The downloaded file is removed.`)) return
    setError('')
    try {
      const ok = await window.quiz.aiDeleteModel(model.id)
      if (!ok) setError('That model could not be deleted.')
      await loadModels()
      await loadStatus()
    } catch (err) {
      setError(String(err))
    }
  }

  const saveEngine = async (): Promise<void> => {
    setError('')
    try {
      await window.quiz.aiSetEngine(enginePath.trim() === '' ? null : enginePath.trim())
      await loadStatus()
    } catch (err) {
      setError(String(err))
    }
  }

  const browseEngine = async (): Promise<void> => {
    const picked = await window.quiz.aiSelectEngine()
    if (!picked) return
    setEnginePath(picked)
    await window.quiz.aiSetEngine(picked)
    await loadStatus()
  }

  const activeModel = models.find((m) => m.active) ?? null

  return (
    <div className="settings-page">
      <section className="settings-section">
        <h2>AI models</h2>
        <p className="settings-subtitle">
          Download a model once and it stays on this machine. Nothing is sent anywhere. The chosen
          model answers every generated question and every answer key.
        </p>

        <div className="settings-status" data-testid="settings-status">
          {status ? (
            <>
              <Badge tone={status.ready ? 'ok' : 'warn'}>
                {status.provider === 'gguf' ? status.model : 'Built-in generator'}
              </Badge>
              {status.note && <span className="settings-note">{status.note}</span>}
            </>
          ) : (
            <Badge tone="neutral">Checking the AI engine…</Badge>
          )}
        </div>

        {loading && <p className="settings-loading">Loading model list…</p>}

        {error && <p className="settings-error">{error}</p>}

        <div className="settings-models">
          {models.map((model) => (
            <div key={model.id} className="settings-model-card" data-testid={`settings-model-${model.id}`}>
              <div className="settings-model-info">
                <h3>{model.name}</h3>
                <p className="settings-model-desc">{model.description}</p>
                <div className="settings-model-meta">
                  <Badge tone="neutral">{formatSize(model.sizeBytes)}</Badge>
                  {model.downloaded && <Badge tone="ok">Downloaded</Badge>}
                  {model.active && <Badge tone="accent">Active</Badge>}
                </div>
                {busy === model.id && progress && (
                  <div className="settings-progress">
                    <div className="settings-progress-bar">
                      <div className="settings-progress-fill" style={{ width: `${progress.percent}%` }} />
                    </div>
                    <span className="settings-progress-label">{progress.percent}%</span>
                  </div>
                )}
              </div>

              <div className="settings-model-actions">
                {model.downloaded && !model.active && (
                  <Button
                    size="sm"
                    variant="primary"
                    testId={`settings-use-${model.id}`}
                    onClick={() => void activate(model.id)}
                  >
                    Use this model
                  </Button>
                )}
                {!model.downloaded && (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Icon name="download" />}
                    testId={`settings-download-${model.id}`}
                    disabled={busy !== null}
                    onClick={() => void download(model.id)}
                  >
                    {busy === model.id ? 'Downloading…' : 'Download'}
                  </Button>
                )}
                {model.downloaded && (
                  <Button
                    size="sm"
                    variant="danger"
                    icon={<Icon name="trash" />}
                    testId={`settings-delete-${model.id}`}
                    disabled={busy !== null}
                    onClick={() => void remove(model)}
                  >
                    Delete
                  </Button>
                )}
              </div>
            </div>
          ))}

          <div className="settings-stub-model" data-testid="settings-builtin">
            <div className="settings-model-info">
              <h3>Built-in generator</h3>
              <p className="settings-model-desc">
                A deterministic generator that always works offline. It writes template questions, so
                it is a safe fallback when no model is selected.
              </p>
              <div className="settings-model-meta">
                <Badge tone="neutral">Always available</Badge>
                {!activeModel && <Badge tone="accent">Active</Badge>}
              </div>
            </div>
            <div className="settings-model-actions">
              {activeModel && (
                <Button size="sm" variant="secondary" onClick={() => void activate(null)}>
                  Use the built-in generator
                </Button>
              )}
            </div>
          </div>
        </div>

        {modelsDir && <p className="settings-path">Models are stored in {modelsDir}</p>}
      </section>

      <section className="settings-section">
        <h2>Inference engine</h2>
        <p className="settings-subtitle">
          A downloaded model runs through llama.cpp. Point the app at your <code>llama-cli</code>{' '}
          executable; leave the field empty to use <code>llama-cli</code> from the system path.
        </p>

        <div className="settings-engine">
          <Field label="llama.cpp binary" className="settings-engine-field">
            <input
              className="ui-input"
              type="text"
              data-testid="settings-engine-input"
              placeholder="C:\\llama\\llama-cli.exe"
              value={enginePath}
              onChange={(e) => setEnginePath(e.target.value)}
            />
          </Field>
          <div className="settings-model-actions">
            <Button size="sm" variant="secondary" testId="settings-engine-browse" onClick={() => void browseEngine()}>
              Browse…
            </Button>
            <Button size="sm" variant="primary" testId="settings-engine-save" onClick={() => void saveEngine()}>
              Save
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}
