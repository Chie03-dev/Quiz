import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { AiTiming, ModelInfo } from '../../shared/types'
import type { ModelConfig } from './types'

/** The seconds a question takes before anything was measured. */
export const DEFAULT_SECONDS_PER_QUESTION = 6
/** The seconds the model needs before it answers the first question. */
export const DEFAULT_START_UP_SECONDS = 10

/** The catalog of models the app knows about. The app never downloads models;
 * an instructor who wants a GGUF model places the file in the models folder
 * (or points the app at it) by other means, keeping the app fully offline. */
export const AVAILABLE_MODELS: Omit<ModelInfo, 'downloaded'>[] = [
  {
    id: 'qwen2.5-1.5b-instruct-q4',
    name: 'Qwen2.5 1.5B Instruct (Q4_K_M)',
    description:
      'About 1.0 GB. It writes good questions you can mostly trust - still worth a read before the quiz.',
    sizeBytes: 1_117_320_736,
    fileName: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    version: 'q4_k_m'
  },
  {
    id: 'phi-3-mini-4k-instruct-q4',
    name: 'Phi-3 Mini 4K Instruct (Q4)',
    description:
      'About 2.2 GB. The strongest of the three, but the slowest on a laptop.',
    sizeBytes: 2_393_231_072,
    fileName: 'Phi-3-mini-4k-instruct-q4.gguf',
    version: 'q4'
  }
]

/**
 * Where the downloaded models live and which one the AI layer uses.
 *
 * The models themselves sit next to a small JSON file that remembers the
 * active model, so the choice survives a restart.
 */
export class ModelStore {
  constructor(private modelsDir: string) {}

  /** All known models with their download status. */
  listModels(): ModelInfo[] {
    const active = this.getActiveModel()
    const activeEmbedPath = this.embeddingModelPath()
    return AVAILABLE_MODELS.map((m) => ({
      ...m,
      downloaded: this.isDownloaded(m.id),
      active:
        m.kind === 'embedding'
          ? activeEmbedPath
            ? join(this.modelsDir, m.fileName) === activeEmbedPath
            : false
          : active === m.id
    }))
  }

  /** The currently active model id, or null for the stub. */
  getActiveModel(): string | null {
    const path = this.activeModelFile()
    if (!existsSync(path)) return null
    try {
      const raw = statSync(path)
      if (raw.size === 0) return null
      const { activeModel } = JSON.parse(readFileSync(path, 'utf8')) as { activeModel?: unknown }
      return typeof activeModel === 'string' ? activeModel : null
    } catch {
      return null
    }
  }

  /** Sets the active model (must be downloaded). */
  setActiveModel(modelId: string | null): boolean {
    if (modelId !== null && !this.isDownloaded(modelId)) return false
    this.ensureDir()
    writeFileSync(this.activeModelFile(), JSON.stringify({ activeModel: modelId }, null, 2), 'utf8')
    return true
  }

  /** The id of the search model the user picked, or null for the default. */
  getActiveEmbeddingModel(): string | null {
    const path = this.activeEmbeddingFile()
    if (!existsSync(path)) return null
    try {
      const raw = statSync(path)
      if (raw.size === 0) return null
      const { activeEmbeddingModel } = JSON.parse(readFileSync(path, 'utf8')) as {
        activeEmbeddingModel?: unknown
      }
      return typeof activeEmbeddingModel === 'string' ? activeEmbeddingModel : null
    } catch {
      return null
    }
  }

  /** Remembers which search model to use (pass null to use the default). */
  setActiveEmbeddingModel(modelId: string | null): boolean {
    if (modelId !== null && !this.isDownloaded(modelId)) return false
    this.ensureDir()
    writeFileSync(
      this.activeEmbeddingFile(),
      JSON.stringify({ activeEmbeddingModel: modelId }, null, 2),
      'utf8'
    )
    return true
  }

  /** True when the model file exists on disk. */
  isDownloaded(modelId: string): boolean {
    const model = AVAILABLE_MODELS.find((m) => m.id === modelId)
    if (!model) return false
    return existsSync(join(this.modelsDir, model.fileName))
  }

  /** The full path of a downloaded model, or null when it is not on disk. */
  modelPath(modelId: string): string | null {
    const model = AVAILABLE_MODELS.find((m) => m.id === modelId)
    if (!model) return null
    return join(this.modelsDir, model.fileName)
  }

  /** The full path of the active model, or null when the stub is used. */
  activeModelPath(): string | null {
    const active = this.getActiveModel()
    if (!active) return null
    return this.modelPath(active)
  }

  /** The name of the active model, or null when the stub is used. */
  activeModelName(): string | null {
    const active = this.getActiveModel()
    if (!active) return null
    const model = AVAILABLE_MODELS.find((m) => m.id === active)
    return model ? model.name : null
  }

  /** Returns the config of the active model, or the stub config. */
  activeConfig(): ModelConfig {
    const active = this.getActiveModel()
    if (!active) return { provider: 'stub', model: 'stub-v1', temperature: 0.7 }
    const model = AVAILABLE_MODELS.find((m) => m.id === active)
    if (!model) return { provider: 'stub', model: 'stub-v1', temperature: 0.7 }
    return { provider: 'gguf', model: model.name, temperature: 0.7 }
  }

  /** The llama.cpp binary the app should use, or null when none is configured. */
  getEnginePath(): string | null {
    const path = this.engineFile()
    if (existsSync(path)) {
      try {
        const raw = statSync(path)
        if (raw.size > 0) {
          const { enginePath } = JSON.parse(readFileSync(path, 'utf8')) as { enginePath?: unknown }
          if (typeof enginePath === 'string' && enginePath.length > 0 && existsSync(enginePath)) {
            return enginePath
          }
        }
      } catch {
        // Fall through to null.
      }
    }
    return null
  }

  /** Remembers the llama.cpp binary to run. An empty path clears it. */
  setEnginePath(enginePath: string | null): boolean {
    this.ensureDir()
    const value = enginePath && enginePath.trim().length > 0 ? enginePath.trim() : null
    writeFileSync(this.engineFile(), JSON.stringify({ enginePath: value }, null, 2), 'utf8')
    return true
  }

  /** Deletes a downloaded model file. */
  deleteModel(modelId: string): boolean {
    const model = AVAILABLE_MODELS.find((m) => m.id === modelId)
    if (!model) return false
    this.removeFile(join(this.modelsDir, model.fileName))
    if (this.getActiveModel() === modelId) {
      this.setActiveModel(null)
    }
    if (this.getActiveEmbeddingModel() === modelId) {
      this.setActiveEmbeddingModel(null)
    }
    return true
  }

  /** The folder the models live in; the settings screen shows it. */
  getModelsDir(): string {
    return this.modelsDir
  }

  /**
   * The path of the model that turns text into vectors, or null when there is
   * none. The user's choice is preferred; otherwise the downloaded search model
   * is used. The app searches by words alone without it.
   */
  embeddingModelPath(): string | null {
    const ordered = AVAILABLE_MODELS.filter((m) => m.kind === 'embedding')
    const active = this.getActiveEmbeddingModel()
    const preferred = [
      ...ordered.filter((m) => m.id === active),
      ...ordered.filter((m) => m.id !== active)
    ]
    for (const model of preferred) {
      const path = join(this.modelsDir, model.fileName)
      if (existsSync(path)) return path
    }
    return null
  }

  /**
   * How long a run of questions takes, as it was measured so far.
   *
   * The first run uses the defaults: six seconds per question and ten
   * seconds of start-up for the model.
   */
  getTiming(): AiTiming {
    const fallback: AiTiming = {
      secondsPerQuestion: DEFAULT_SECONDS_PER_QUESTION,
      startUpSeconds: DEFAULT_START_UP_SECONDS,
      runs: 0
    }
    const path = this.timingFile()
    if (!existsSync(path)) return fallback
    try {
      const raw = statSync(path)
      if (raw.size === 0) return fallback
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
        secondsPerQuestion?: unknown
        startUpSeconds?: unknown
        runs?: unknown
      }
      return {
        secondsPerQuestion:
          typeof parsed.secondsPerQuestion === 'number' && parsed.secondsPerQuestion > 0
            ? parsed.secondsPerQuestion
            : fallback.secondsPerQuestion,
        startUpSeconds:
          typeof parsed.startUpSeconds === 'number' && parsed.startUpSeconds >= 0
            ? parsed.startUpSeconds
            : fallback.startUpSeconds,
        runs: typeof parsed.runs === 'number' && parsed.runs > 0 ? Math.floor(parsed.runs) : 0
      }
    } catch {
      return fallback
    }
  }

  /**
   * Remembers how long the last run took, so the next estimate is closer to
   * the truth. The average of all the runs so far is kept.
   */
  recordTiming(startUpSeconds: number, secondsPerQuestion: number): void {
    if (!Number.isFinite(startUpSeconds) || !Number.isFinite(secondsPerQuestion)) return
    if (secondsPerQuestion <= 0) return
    const current = this.getTiming()
    const runs = current.runs + 1
    const seconds = (current.secondsPerQuestion * current.runs + secondsPerQuestion) / runs
    const startUp = (current.startUpSeconds * current.runs + startUpSeconds) / runs
    this.ensureDir()
    writeFileSync(
      this.timingFile(),
      JSON.stringify({ secondsPerQuestion: seconds, startUpSeconds: startUp, runs }, null, 2),
      'utf8'
    )
  }

    private ensureDir(): void {
    if (!existsSync(this.modelsDir)) mkdirSync(this.modelsDir, { recursive: true })
  }

  private activeModelFile(): string {
    return join(this.modelsDir, 'active-model.json')
  }

  private activeEmbeddingFile(): string {
    return join(this.modelsDir, 'active-embedding-model.json')
  }

  private engineFile(): string {
    return join(this.modelsDir, 'engine.json')
  }

  private timingFile(): string {
    return join(this.modelsDir, 'timing.json')
  }

  private removeFile(path: string): void {
    try {
      unlinkSync(path)
    } catch {
      // The file was not there; nothing to clean up.
    }
  }
}
