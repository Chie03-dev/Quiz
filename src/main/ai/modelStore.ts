import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { get as httpGet, type ClientRequest, type IncomingMessage } from 'node:http'
import { get as httpsGet } from 'node:https'
import { URL } from 'node:url'
import JSZip from 'jszip'

import type { AiTiming, DownloadProgress, DownloadResult, ModelInfo } from '../../shared/types'
import type { ModelConfig } from './types'

/** The seconds a question takes before anything was measured. */
export const DEFAULT_SECONDS_PER_QUESTION = 6
/** The seconds the model needs before it answers the first question. */
export const DEFAULT_START_UP_SECONDS = 10

/** The catalog of models the app knows how to download. */
export const AVAILABLE_MODELS: Omit<ModelInfo, 'downloaded'>[] = [
  {
    id: 'golden-generate-qwen-0.6b-q4',
    name: 'Golden Generate Qwen 0.6B (Q4_K_M)',
    description:
      'A 0.6B model fine-tuned to emit grounded question/answer pairs as JSON. Small and fast; best for the answer-key and question generation tasks.',
    sizeBytes: 397_000_000,
    fileName: 'Qwen3-0.6B.Q4_K_M.gguf',
    downloadUrl:
      'https://huggingface.co/mburaksayici/golden_generate_qwen_0.6b_v2_gguf/resolve/main/Qwen3-0.6B.Q4_K_M.gguf',
    version: 'q4_k_m'
  },
  {
    id: 'qwen2.5-1.5b-instruct-q4',
    name: 'Qwen2.5 1.5B Instruct (Q4_K_M)',
    description:
      'About 1.0 GB. It writes good questions you can mostly trust - still worth a read before the quiz.',
    sizeBytes: 1_117_320_736,
    fileName: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    downloadUrl:
      'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf',
    version: 'q4_k_m'
  },
  {
    id: 'phi-3-mini-4k-instruct-q4',
    name: 'Phi-3 Mini 4K Instruct (Q4)',
    description:
      'About 2.2 GB. The strongest of the three, but the slowest on a laptop.',
    sizeBytes: 2_393_231_072,
    fileName: 'Phi-3-mini-4k-instruct-q4.gguf',
    downloadUrl:
      'https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf/resolve/main/Phi-3-mini-4k-instruct-q4.gguf',
    version: 'q4'
  },
  {
    id: 'bge-small-en-v1.5-q4',
    name: 'BGE small English v1.5 (Q4_K_M)',
    description:
      'About 25 MB. The search model: it reads the chapter and finds the passages that mean the same as the question. Optional; the app searches by words without it.',
    sizeBytes: 24_808_576,
    fileName: 'bge-small-en-v1.5-q4_k_m.gguf',
    downloadUrl:
      'https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/main/bge-small-en-v1.5-q4_k_m.gguf',
    version: 'q4_k_m',
    kind: 'embedding'
  },
  {
    id: 'bge-m3-q4',
    name: 'BGE M3 (multilingual, Q4_K_M)',
    description:
      'About 438 MB. The multilingual search model: it also finds the passages that mean the same as the question in languages other than English, including Tagalog. Optional; the app searches by words without it.',
    sizeBytes: 438_000_000,
    fileName: 'bge-m3-q4_k_m.gguf',
    downloadUrl:
      'https://huggingface.co/groonga/bge-m3-Q4_K_M-GGUF/resolve/main/bge-m3-q4_k_m.gguf',
    version: 'q4_k_m',
    kind: 'embedding'
  }
]

/** How many redirects a download may follow before it gives up. */
const MAX_REDIRECTS = 5

/** The pinned llama.cpp release used for the automatic engine download. */
const LLAMA_CPP_TAG = 'b11960'
const LLAMA_CPP_ASSET = 'llama-b11960-bin-win-cpu-x64.zip'
const LLAMA_CPP_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_TAG}/${LLAMA_CPP_ASSET}`

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

  /** The llama.cpp binary the app should use, or null for the auto-detected one. */
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
        // Fall through to the bundled engine.
      }
    }
    const bundled = this.bundledEnginePath()
    return bundled && existsSync(bundled) ? bundled : null
  }

  /** Remembers the llama.cpp binary to run. An empty path clears it. */
  setEnginePath(enginePath: string | null): boolean {
    this.ensureDir()
    const value = enginePath && enginePath.trim().length > 0 ? enginePath.trim() : null
    writeFileSync(this.engineFile(), JSON.stringify({ enginePath: value }, null, 2), 'utf8')
    return true
  }

  /** Where the automatically downloaded llama.cpp build is unpacked. */
  private engineDir(): string {
    return join(this.modelsDir, '..', 'llama-cpp', LLAMA_CPP_TAG)
  }

  /** The binary inside the unpacked build, when present. */
  private bundledEnginePath(): string {
    return join(this.engineDir(), 'llama-cli.exe')
  }

  /** Downloads and unpacks the llama.cpp Windows CPU build. */
  async downloadEngine(onProgress: (percent: number) => void = () => {}): Promise<{ ok: boolean; error?: string }> {
    this.ensureDir()
    const dir = this.engineDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    if (existsSync(this.bundledEnginePath())) return { ok: true }

    try {
      onProgress(0)
      const response = await fetch(LLAMA_CPP_URL)
      if (!response.ok) return { ok: false, error: `Download failed: HTTP ${response.status}` }
      const total = Number(response.headers.get('content-length') ?? 0)
      const reader = response.body?.getReader()
      if (!reader) return { ok: false, error: 'The download stream is unavailable.' }
      const chunks: Uint8Array[] = []
      let received = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          chunks.push(value)
          received += value.byteLength
          if (total > 0) onProgress(Math.min(95, Math.round((received / total) * 100)))
        }
      }
      const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)))
      onProgress(96)
      const zip = await JSZip.loadAsync(buffer)
      const entries = Object.keys(zip.files)
      let written = 0
      for (const name of entries) {
        const file = zip.files[name]
        if (file.dir) continue
        // Guard against path traversal in the archive.
        const relative = name.replace(/^[/\\]+/, '')
        if (relative.includes('..')) continue
        const target = join(dir, relative)
        const parent = join(target, '..')
        if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
        const data = await file.async('nodebuffer')
        writeFileSync(target, data)
        written++
        onProgress(96 + Math.round((written / Math.max(1, entries.length)) * 4))
      }
      if (!existsSync(this.bundledEnginePath())) {
        return { ok: false, error: 'The downloaded archive did not contain llama-cli.exe.' }
      }
      onProgress(100)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Downloads a model. Calls onProgress with 0..100. */
  async downloadModel(
    modelId: string,
    onProgress: (p: DownloadProgress) => void
  ): Promise<DownloadResult> {
    const model = AVAILABLE_MODELS.find((m) => m.id === modelId)
    if (!model) return { ok: false, error: `Unknown model ${modelId}` }
    if (this.isDownloaded(modelId)) return { ok: true, modelId }

    this.ensureDir()
    const dest = join(this.modelsDir, model.fileName)
    onProgress({ loaded: 0, total: model.sizeBytes, percent: 0 })

    return this.fetchModel(new URL(model.downloadUrl), dest, model, onProgress, MAX_REDIRECTS)
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

  /**
   * Downloads one file, following the redirects the model hosts use.
   */
  private fetchModel(
    url: URL,
    dest: string,
    model: Omit<ModelInfo, 'downloaded'>,
    onProgress: (p: DownloadProgress) => void,
    redirectsLeft: number
  ): Promise<DownloadResult> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (result: DownloadResult): void => {
        if (settled) return
        settled = true
        resolve(result)
      }

      const request: ClientRequest = this.open(url, (res: IncomingMessage) => {
        const status = res.statusCode ?? 0
        const location = res.headers.location

        if (status >= 300 && status < 400 && location) {
          res.resume()
          if (redirectsLeft <= 0) {
            finish({ ok: false, error: 'The download followed too many redirects.' })
            return
          }
          let next: URL
          try {
            next = new URL(location, url)
          } catch {
            finish({ ok: false, error: 'The download redirected to an invalid address.' })
            return
          }
          this.fetchModel(next, dest, model, onProgress, redirectsLeft - 1).then(finish)
          return
        }

        if (status >= 400) {
          res.resume()
          this.removeFile(dest)
          finish({ ok: false, error: `The download failed (HTTP ${status}).` })
          return
        }

        const header = res.headers['content-length']
        const total = header ? Number(header) : 0
        let loaded = 0
        const file = createWriteStream(dest)

        file.on('error', (err: Error) => {
          this.removeFile(dest)
          finish({ ok: false, error: err.message })
        })

        file.on('close', () => {
          if (settled) return
          let actual = 0
          try {
            actual = statSync(dest).size
          } catch {
            actual = 0
          }
          if (actual === 0) {
            this.removeFile(dest)
            finish({ ok: false, error: 'The download produced an empty file.' })
            return
          }
          if (total > 0 && actual < total * 0.99) {
            this.removeFile(dest)
            finish({ ok: false, error: 'The downloaded file is incomplete.' })
            return
          }
          finish({ ok: true, modelId: model.id })
        })

        res.on('data', (chunk: Buffer) => {
          loaded += chunk.length
          const known = total > 0 ? total : model.sizeBytes
          onProgress({
            loaded,
            total: known,
            percent: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0
          })
        })

        res.on('error', () => {
          file.destroy()
          this.removeFile(dest)
          finish({ ok: false, error: 'The connection dropped while downloading.' })
        })

        res.on('end', () => {
          file.end()
        })

        res.pipe(file)
      })

      request.on('error', (err: Error) => {
        this.removeFile(dest)
        finish({ ok: false, error: err.message })
      })
    })
  }

  /** Opens a request for either protocol the model hosts use. */
  private open(url: URL, onResponse: (res: IncomingMessage) => void): ClientRequest {
    if (url.protocol === 'http:') return httpGet(url, onResponse)
    return httpsGet(url, onResponse)
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
