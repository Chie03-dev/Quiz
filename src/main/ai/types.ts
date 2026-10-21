import type { QuestionType, StoredQuestion } from '../../shared/types'

export type { QuestionType as AiQuestionType }

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
}

export interface AutoKeyOptions {
  questions: StoredQuestion[]
  sourceText?: string
}

export interface AutoKeyResult {
  questions: StoredQuestion[]
}

export interface AiStatus {
  ready: boolean
  provider: string
  model: string
}

export interface AiProvider {
  status(): AiStatus
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
