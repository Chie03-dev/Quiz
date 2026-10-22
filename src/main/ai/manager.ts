import { validateQuestion } from '../../shared/validation'
import type { StoredQuestion } from '../../shared/types'
import type {
  Chunk,
  AiProvider,
  AiStatus,
  GenerateOptions,
  GenerateResult,
  AutoKeyOptions,
  AutoKeyResult,
  AiDependencies
} from './types'
import { chunkText } from './chunker'
import { extractTextFromPath } from './textExtract'
import { StubProvider } from './provider'

export class AiManager {
  private provider: AiProvider
  private readonly fallback: AiProvider
  private probed = false

  constructor(
    provider: AiProvider = new StubProvider(),
    private deps: AiDependencies = {
      chunker: { chunkText },
      extract: { extractText: extractTextFromPath }
    },
    fallback: AiProvider = new StubProvider()
  ) {
    this.provider = provider
    this.fallback = fallback
  }

  status(): AiStatus {
    const status = this.provider.status()
    if (status.ready) return status
    // The chosen model cannot answer; the built-in generator takes over and
    // the status says why.
    const fallback = this.fallback.status()
    return { ...fallback, note: status.note }
  }

  /** Asks the engine whether it really works, then reports the status. */
  async refreshStatus(): Promise<AiStatus> {
    await this.probe()
    return this.status()
  }

  /** Swaps the active provider (called when the user selects a model). */
  setProvider(provider: AiProvider): void {
    this.provider = provider
    this.probed = false
  }

  async extractText(filePath: string): Promise<string> {
    return this.deps.extract.extractText(filePath)
  }

  async chunkText(text: string): Promise<Chunk[]> {
    return this.deps.chunker.chunkText(text)
  }

  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    await this.probe()

    const chunks = opts.sourceText ? this.deps.chunker.chunkText(opts.sourceText) : []
    const contextText = chunks.map((c) => c.text).join('\n\n')

    const result = await this.engine().generate({
      ...opts,
      sourceText: contextText || opts.sourceText
    })

    if (result.error) {
      return { questions: [], error: result.error }
    }

    const validQuestions: Omit<StoredQuestion, 'id' | 'status'>[] = []
    const errors: string[] = []

    result.questions.forEach((q, i) => {
      const stub = { ...q, id: `ai-q-${i + 1}`, status: 'ready' as const }
      const problems = validateQuestion(stub)
      if (problems.length === 0) {
        validQuestions.push(q)
      } else {
        errors.push(`Question ${i + 1}: ${problems.join('; ')}`)
      }
    })

    if (errors.length > 0) {
      console.warn('AI generated some invalid questions:', errors.join('\n'))
    }

    return {
      questions: validQuestions,
      written: result.written,
      dropped: (result.dropped ?? 0) + errors.length,
      reasons: result.reasons
    }
  }

  async autoKey(opts: AutoKeyOptions): Promise<AutoKeyResult> {
    await this.probe()

    const result = await this.engine().autoKey(opts)

    if (result.error) {
      return { questions: [], error: result.error }
    }

    const validQuestions: StoredQuestion[] = []
    const errors: string[] = []

    result.questions.forEach((q, i) => {
      const problems = validateQuestion(q)
      if (problems.length === 0) {
        validQuestions.push(q)
      } else {
        errors.push(`Question ${i + 1}: ${problems.join('; ')}`)
      }
    })

    if (errors.length > 0) {
      console.warn('AI auto-key produced some invalid questions:', errors.join('\n'))
    }

    return { questions: validQuestions }
  }

  /** The engine that answers: the chosen model, or the built-in generator. */
  private engine(): AiProvider {
    return this.provider.status().ready ? this.provider : this.fallback
  }

  /** Checks the engine once, so a model is only used when it really runs. */
  private async probe(): Promise<void> {
    if (this.probed || !this.provider.refresh) return
    this.probed = true
    try {
      await this.provider.refresh()
    } catch {
      // The provider keeps its last known state.
    }
  }
}
