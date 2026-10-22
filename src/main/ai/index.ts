import { AiManager } from './manager'
import { StubProvider } from './provider'
import { ModelStore } from './modelStore'
import { createProviderForStore } from './providerFactory'
import type { ChunkIndex, Embedder } from './rag/types'
import type { DocBlock } from './rag/chunking'
import type { GenerateOptions } from './types'

export { AiManager } from './manager'
export { StubProvider } from './provider'
export { GgufProvider } from './ggufProvider'
export { createProviderForStore } from './providerFactory'
export { chunkText } from './chunker'
export { extractTextFromPath } from './textExtract'
export { ModelStore, AVAILABLE_MODELS } from './modelStore'

export { DEFAULT_CHUNK_TOKENS, DEFAULT_OVERLAP_TOKENS, DEFAULT_MODEL_CONFIG } from './types'
export type {
  AiProvider,
  ModelConfig,
  GenerateOptions,
  GenerateResult,
  AutoKeyOptions,
  AutoKeyResult,
  Chunk,
  AiDependencies,
  ModelInfo,
  DownloadResult,
  DownloadProgress,
  AiStatus
} from './types'

export function createAiManager(): AiManager {
  return new AiManager(new StubProvider())
}

/**
 * Creates a manager for the chosen model.
 *
 * The retrieval is part of it: the index of the sources, the blocks of a
 * source and the embedding model that makes the search by meaning work.
 */
export function createAiManagerWithStore(
  store: ModelStore,
  rag?: {
    index: ChunkIndex
    embedder?: Embedder
    corpus: (opts: GenerateOptions) => Promise<DocBlock[]>
  }
): AiManager {
  const manager = new AiManager(createProviderForStore(store))
  if (rag) manager.setRetrieval(rag)
  return manager
}
