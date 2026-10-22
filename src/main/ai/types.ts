import type { AiStatus, QuestionType, StoredQuestion } from '../../shared/types'

export type { QuestionType as AiQuestionType }

// The model DTOs live in shared/types so the preload bridge and the renderer
// can use them without pulling in main-process code.
export type { ModelInfo, DownloadProgress, DownloadResult, AiStatus } from '../../shared/types'

export interface Chunk {
  text: string
  headingPath: string[]
}

export interface ModelConfig {
  provider: string
  model: string
  temperature: number
}

export interface GenerateOptions {
  sourceText: string
  questionTypes: QuestionType[]
  count: number
  points: number
}

export interface GenerateResult {
  questions: Omit<StoredQuestion, 'id' | 'status'>[]
  /** Why nothing could be generated, when the engine failed. */
  error?: string
  /** How many questions the model wrote. */
  written?: number
  /** How many of them were left out because they were not about the text. */
  dropped?: number
  /** Why the questions were left out, and how many of each. */
  reasons?: { reason: string; count: number }[]
}

export interface AutoKeyOptions {
  questions: StoredQuestion[]
  sourceText?: string
}

export interface AutoKeyResult {
  questions: StoredQuestion[]
  /** Why no key could be filled in, when the engine failed. */
  error?: string
}

export interface AiProvider {
  status(): AiStatus
  /** Checks the engine for real; the manager calls it before reporting status. */
  refresh?(): Promise<AiStatus>
  generate(opts: GenerateOptions): Promise<GenerateResult>
  autoKey(opts: AutoKeyOptions): Promise<AutoKeyResult>
}

export interface AiDependencies {
  chunker: {
    chunkText: (text: string) => Chunk[]
  }
  extract: {
    extractText: (filePath: string) => Promise<string>
  }
}

export const DEFAULT_CHUNK_TOKENS = 200
export const DEFAULT_OVERLAP_TOKENS = 60
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  provider: 'stub',
  model: 'stub-v1',
  temperature: 0.7
}
