import { AiManager } from './manager'
import { StubProvider } from './provider'
import { ModelStore } from './modelStore'
import { createProviderForStore } from './providerFactory'

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

/** Creates a manager using the config from a ModelStore (or the stub fallback). */
export function createAiManagerWithStore(store: ModelStore): AiManager {
  return new AiManager(createProviderForStore(store))
}
