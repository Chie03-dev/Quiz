import { AiManager } from './manager'
import { StubProvider } from './provider'

export { AiManager } from './manager'
export { StubProvider } from './provider'
export { chunkText } from './chunker'
export { extractTextFromPath } from './textExtract'

export { DEFAULT_CHUNK_TOKENS, DEFAULT_OVERLAP_TOKENS, DEFAULT_MODEL_CONFIG } from './types'
export type {
  AiProvider,
  ModelConfig,
  AiStatus,
  GenerateOptions,
  GenerateResult,
  AutoKeyOptions,
  AutoKeyResult,
  Chunk,
  AiDependencies
} from './types'

export function createAiManager(): AiManager {
  return new AiManager(new StubProvider())
}
