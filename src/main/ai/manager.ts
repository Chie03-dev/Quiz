import { validateQuestion } from '../../shared/validation'
import type { StoredQuestion } from '../../shared/types'
import type { Chunk, AiProvider, AiStatus, GenerateOptions, GenerateResult, AutoKeyOptions, AutoKeyResult, AiDependencies } from './types'
import { chunkText } from './chunker'
import { extractTextFromPath } from './textExtract'
import { StubProvider } from './provider'

export class AiManager {
  private provider: AiProvider

  constructor(
    provider: AiProvider = new StubProvider(),
    private deps: AiDependencies = {
      chunker: { chunkText },
      extract: { extractText: extractTextFromPath }
    }
  ) {
    this.provider = provider
  }

  status(): AiStatus {
    return this.provider.status()
  }

  async extractText(filePath: string): Promise<string> {
    return this.deps.extract.extractText(filePath)
  }

  async chunkText(text: string): Promise<Chunk[]> {
    return this.deps.chunker.chunkText(text)
  }

  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const chunks = opts.sourceText ? this.deps.chunker.chunkText(opts.sourceText) : []
    const contextText = chunks.map((c) => c.text).join('\n\n')

    const result = await this.provider.generate({
      ...opts,
      sourceText: contextText || opts.sourceText
    })

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

    return { questions: validQuestions }
  }

  async autoKey(opts: AutoKeyOptions): Promise<AutoKeyResult> {
    const result = await this.provider.autoKey(opts)

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
}
