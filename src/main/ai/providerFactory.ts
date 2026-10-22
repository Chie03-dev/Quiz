import { GgufProvider } from './ggufProvider'
import type { ModelStore } from './modelStore'
import { StubProvider } from './provider'
import type { AiProvider } from './types'

/**
 * Builds the provider the app should use for the current model choice.
 *
 * Without a downloaded model the built-in generator answers. With one, the
 * provider runs the local llama.cpp binary; when that binary is missing the
 * provider reports that it is not ready and the manager falls back.
 */
export function createProviderForStore(store: ModelStore): AiProvider {
  const active = store.getActiveModel()
  if (!active) return new StubProvider()

  const modelPath = store.modelPath(active)
  if (!modelPath) return new StubProvider()

  return new GgufProvider({
    modelPath,
    modelName: store.activeModelName() ?? active,
    enginePath: store.getEnginePath(),
    temperature: store.activeConfig().temperature
  })
}
