import { validateQuestion } from '../../shared/validation'
import type { QuestionType, StoredQuestion } from '../../shared/types'
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
import { choosePassages, indexSource } from './rag/pipeline'
import { answerTexts, normalizeText, sameFact } from './ggufProvider'
import { createHash } from 'node:crypto'

/**
 * The id of a source in the index: the path of the file, or a hash of the
 * pasted text.
 */
export function sourceRefFor(opts: GenerateOptions): string {
  if (opts.filePath) return `file:${opts.filePath}`
  const hash = createHash('sha1').update(opts.sourceText).digest('hex').slice(0, 16)
  return `text:${hash}`
}

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

  /**
   * Gives the manager the retrieval: the index of the sources, the blocks of
   * a source and the embedding model.
   */
  setRetrieval(rag: NonNullable<AiDependencies['rag']>): void {
    this.deps.rag = rag
  }

  async extractText(filePath: string): Promise<string> {
    return this.deps.extract.extractText(filePath)
  }

  async chunkText(text: string): Promise<Chunk[]> {
    return this.deps.chunker.chunkText(text)
  }

  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    await this.probe()

    // With an index the questions are written from single passages that are
    // fetched from the source; without one the whole text is used.
    if (this.deps.rag) {
      return this.generateFromPassages(opts)
    }

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

  /**
   * Writes the questions from the passages of a source.
   *
   * The source is indexed, the passages the questions should come from are
   * chosen (spread over the whole document, or found by the two searches
   * when a topic is given), and one question is written per passage. The
   * questions that come back are checked against each other, so the same
   * question is not asked twice.
   */
  private async generateFromPassages(opts: GenerateOptions): Promise<GenerateResult> {
    const rag = this.deps.rag
    if (!rag) return { questions: [], error: 'The retrieval index is not available.' }

    const sourceRef = sourceRefFor(opts)
    const blocks = await rag.corpus(opts)
    if (blocks.length === 0) {
      return { questions: [], error: 'There is no text to make questions from.' }
    }

    await indexSource(rag.index, sourceRef, blocks, rag.embedder)

    const types = opts.questionTypes.length > 0 ? opts.questionTypes : (['mcq'] as QuestionType[])
    // More passages than questions, so there is something to fall back on.
    const wanted = Math.max(opts.count, types.length)
    const passages = await choosePassages(
      rag.index,
      sourceRef,
      opts.topic ?? '',
      wanted,
      rag.embedder
    )

    if (passages.length === 0) {
      return { questions: [], error: 'The text is too short to make questions from.' }
    }

    const questions: Omit<StoredQuestion, 'id' | 'status'>[] = []
    const usedAnswers = new Set<string>()
    const usedBodies: string[] = []
    const reasons = new Map<string, number>()
    let written = 0

    const drop = (why: string): void => {
      reasons.set(why, (reasons.get(why) ?? 0) + 1)
    }

    for (let i = 0; i < passages.length && questions.length < opts.count; i++) {
      const passage = passages[i]
      const type = types[i % types.length]

      const result = await this.engine().generate({
        ...opts,
        sourceText: passage.text,
        focus: passage.focus,
        questionTypes: [type],
        count: 1
      })

      written += result.written ?? result.questions.length
      for (const why of result.reasons ?? []) {
        reasons.set(why.reason, (reasons.get(why.reason) ?? 0) + why.count)
      }
      if (result.error) continue

      for (const question of result.questions) {
        if (questions.length >= opts.count) break
        if (question.key === null) {
          drop('the answer was not in the passage')
          continue
        }
        const answers = answerTexts(question.type, question.key, question.data).map((text) =>
          normalizeText(text)
        )
        if (answers.some((answer) => answer.length > 0 && usedAnswers.has(answer))) {
          drop('it asked about the same thing as another question')
          continue
        }
        if (usedBodies.some((body) => sameFact(body, question.body))) {
          drop('it asked about the same thing as another question')
          continue
        }
        answers.forEach((answer) => {
          if (answer.length > 0) usedAnswers.add(answer)
        })
        usedBodies.push(question.body)

        const candidate = { ...question, key: question.key } as Omit<StoredQuestion, 'id' | 'status'>
        if (validateQuestion({ ...candidate, id: 'ai-q', status: 'draft' }).length === 0) {
          questions.push(candidate)
        } else {
          drop('it was not a complete question')
        }
      }
    }

    if (questions.length === 0) {
      return {
        questions: [],
        error: 'The model answered, but nothing it wrote was a valid question.'
      }
    }

    const dropped = [...reasons.values()].reduce((sum, n) => sum + n, 0)
    return {
      questions,
      written,
      dropped,
      reasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count }))
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
