import type { AiStatus, GenerateProgress, QuestionType, StoredQuestion } from '../../shared/types'
import type { ChunkIndex, Embedder } from './rag/types'
import type { DocBlock } from './rag/chunking'

export type { QuestionType as AiQuestionType }

// The model DTOs live in shared/types so the preload bridge and the renderer
// can use them without pulling in main-process code.
export type { ModelInfo, DownloadProgress, DownloadResult, AiStatus, GenerateProgress, AiTiming } from '../../shared/types'

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
  /** The text the question is written from: a passage of the source. */
  sourceText: string
  /** The sentence of the passage the question should be about. */
  focus?: string
  /**
   * The sentences the questions should be about, one question per sentence.
   * A model call that writes several questions at once is much cheaper than
   * one call per question, because the model is loaded again every time.
   */
  focuses?: string[]
  /** A nudge for the second try, when the first one did not hold up. */
  hint?: string
  /**
   * The random seed for this call. The first ask leaves it open so the same
   * text always gives the same questions; the repair ask passes a different
   * one so the retry may come out differently.
   */
  seed?: number
  /** The file the questions are written from; empty when the text is pasted. */
  filePath?: string
  /** What the questions should be about; empty means the whole source. */
  topic?: string
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
  /**
   * Which focus every question belongs to, in the order of the questions.
   * The index points into the focuses that were asked for.
   */
  factIndexes?: number[]
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
  /**
   * The retrieval part. Without it the manager works on the whole text, the
   * way it did before; with it the text is indexed and the questions are
   * written from single passages.
   */
  rag?: {
    /** The index of the sources. */
    index: ChunkIndex
    /** The embedding model, when there is one. */
    embedder?: Embedder
    /** The blocks of a source: a file that is read, or the pasted text. */
    corpus: (opts: GenerateOptions) => Promise<DocBlock[]>
  }
  /** Told how far the generation has come, so the screen can show a bar. */
  onProgress?: (progress: GenerateProgress) => void
}

export const DEFAULT_CHUNK_TOKENS = 200
export const DEFAULT_OVERLAP_TOKENS = 60
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  provider: 'stub',
  model: 'stub-v1',
  temperature: 0.7
}
