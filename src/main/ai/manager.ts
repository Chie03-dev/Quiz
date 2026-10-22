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
  AiDependencies,
  GenerateProgress
} from './types'
import { chunkText } from './chunker'
import { extractTextFromPath } from './textExtract'
import { StubProvider } from './provider'
import { choosePassages, indexSource } from './rag/pipeline'
import { answerTexts, groundedAnswer, normalizeText, sameFact, DEFAULT_SEED } from './ggufProvider'
import type { Passage } from './rag/types'
import { createHash } from 'node:crypto'

/** How long the whole run may take before it stops asking for more. */
const MAX_RUN_MS = 360_000
/** How many questions one model call may write. */
const MAX_BATCH = 8
/**
 * The seed the first ask uses: the same text gives the same questions. The
 * later tries shift it, so a retry may come out differently.
 */
const seedBase = DEFAULT_SEED

/**
 * The id of a source in the index: the path of the file, or a hash of the
 * pasted text.
 */
export function sourceRefFor(opts: GenerateOptions): string {
  if (opts.filePath) return `file:${opts.filePath}`
  const hash = createHash('sha1').update(opts.sourceText).digest('hex').slice(0, 16)
  return `text:${hash}`
}

/**
 * How many questions of each type, so the total is the count that was asked
 * for. The first types get the extra ones.
 */
function distribute(total: number, parts: number): number[] {
  const out = new Array<number>(Math.max(0, parts)).fill(0)
  if (out.length === 0) return out
  const base = Math.floor(total / out.length)
  const extra = total % out.length
  for (let i = 0; i < out.length; i++) out[i] = base + (i < extra ? 1 : 0)
  return out
}

/**
 * The nudge for the second try: what the first question of this type did
 * wrong.
 */
function repairHint(type: QuestionType): string {
  switch (type) {
    case 'fillin':
      return 'The body must have ___ exactly where the answer goes, and nothing else.'
    case 'enumeration':
      return 'The number of items must be the number the question names.'
    case 'matching':
    case 'connect':
      return 'Every item must be a short phrase from the text, and there must be at least two pairs.'
    case 'problem':
      return 'The answer must be a short phrase from the text, not a whole sentence.'
    case 'tf':
      return 'The statement must be about the text, and it must not be a question.'
    default:
      return 'The answer must be a phrase that is in the text, word for word.'
  }
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

  /** Told how far the generation has come, so the screen can show a bar. */
  setProgress(onProgress: (progress: GenerateProgress) => void): void {
    this.deps.onProgress = onProgress
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

    this.deps.onProgress?.({
      done: validQuestions.length,
      total: opts.count,
      made: result.written ?? result.questions.length,
      elapsedMs: 0
    })

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
   * when a topic is given), and the questions are written in batches: one
   * model call per question type, with a couple of passages in it. A model
   * call loads the model again, so a call per question would be slow.
   *
   * The questions that come back are checked against the passage they came
   * from and against each other, so the same question is not asked twice.
   * A slot that is left empty is filled again: first with a second try on
   * the same passages, then with the passages that were not used yet.
   */
  private async generateFromPassages(opts: GenerateOptions): Promise<GenerateResult> {
    const rag = this.deps.rag
    if (!rag) return { questions: [], error: 'The retrieval index is not available.' }

    const sourceRef = sourceRefFor(opts)
    const blocks = await rag.corpus(opts)
    if (blocks.length === 0) {
      return { questions: [], error: 'There is no text to make questions from.' }
    }

    const chunks = await indexSource(rag.index, sourceRef, blocks, rag.embedder)
    const childCount = chunks.filter((chunk) => chunk.kind === 'child').length

    const types = opts.questionTypes.length > 0 ? opts.questionTypes : (['mcq'] as QuestionType[])
    // More passages than questions, so there is something to fall back on.
    const wanted = Math.min(childCount, Math.max(opts.count, types.length) * 3)
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

    const startedAt = Date.now()
    const deadline = startedAt + MAX_RUN_MS

    const questions: Omit<StoredQuestion, 'id' | 'status'>[] = []
    const usedAnswers = new Set<string>()
    const usedBodies: string[] = []
    const usedPassages = new Set<string>()
    const reasons = new Map<string, number>()
    let written = 0

    const drop = (why: string): void => {
      reasons.set(why, (reasons.get(why) ?? 0) + 1)
    }

    const report = (): void => {
      this.deps.onProgress?.({
        done: questions.length,
        total: opts.count,
        made: written,
        elapsedMs: Date.now() - startedAt
      })
    }

    /**
     * Keeps a question that came back, when it holds up.
     *
     * The answer has to be in the passage the question came from, and the
     * question may not ask what another question asks.
     */
    const accept = (
      question: Omit<StoredQuestion, 'id' | 'status'>,
      passage: Passage
    ): boolean => {
      // The count is met: the rest is not needed.
      if (questions.length >= opts.count) return false
      if (question.key === null) {
        drop('the answer was not in the passage')
        return false
      }
      // The question is checked against its own passage and not against the
      // whole chapter, so an answer from another part of the document does
      // not count. The built-in generator writes template questions, and its
      // answers are placeholders that are nowhere in the text.
      if (
        this.engine().status().provider !== 'stub' &&
        !groundedAnswer(question.type, question.key, question.data, passage.text, question.body)
      ) {
        drop('the answer was not in the passage')
        return false
      }
      const answers = answerTexts(question.type, question.key, question.data).map((text) =>
        normalizeText(text)
      )
      if (answers.some((answer) => answer.length > 0 && usedAnswers.has(answer))) {
        drop('it asked about the same thing as another question')
        return false
      }
      if (usedBodies.some((body) => sameFact(body, question.body))) {
        drop('it asked about the same thing as another question')
        return false
      }
      const candidate = { ...question, key: question.key } as Omit<StoredQuestion, 'id' | 'status'>
      if (validateQuestion({ ...candidate, id: 'ai-q', status: 'draft' }).length > 0) {
        drop('it was not a complete question')
        return false
      }
      answers.forEach((answer) => {
        if (answer.length > 0) usedAnswers.add(answer)
      })
      usedBodies.push(question.body)
      questions.push(candidate)
      return true
    }

    // --- the questions, one batch of facts per model call ---
    const quotas = distribute(opts.count, types.length)
    // Which types actually produced questions: a type that yields nothing is
    // not worth asking for again, so the remaining slots go to the others.
    const producedByType = new Map<QuestionType, number>()
    // The passages are handed to the types in turn.
    const groups = new Map<QuestionType, Passage[]>()
    passages.forEach((passage, index) => {
      const type = types[index % types.length]
      const group = groups.get(type)
      if (group) group.push(passage)
      else groups.set(type, [passage])
    })

    for (let t = 0; t < types.length; t++) {
      const type = types[t]
      const quota = quotas[t]
      if (quota <= 0) continue
      const group = groups.get(type) ?? []
      // The passages this type may use: enough for the quota, with spares
      // for the questions that do not hold up.
      const budget = Math.min(group.length, quota * 2)
      const failed: Passage[] = []
      // The seed is shifted for every try, so a retry may come out differently.
      let repairSeed = seedBase + t * 31 + 1
      let made = 0

      for (let i = 0; i < budget && made < quota && questions.length < opts.count; i += MAX_BATCH) {
        if (Date.now() > deadline) break
        // The call asks for no more facts than the type still needs.
        const size = Math.min(MAX_BATCH, quota - made)
        const batch = group.slice(i, i + size)
        batch.forEach((passage) => usedPassages.add(passage.chunkId))

        const result = await this.engine().generate({
          ...opts,
          sourceText: batch.map((passage) => passage.focus).join('\n\n'),
          focuses: batch.map((passage) => passage.focus),
          focus: undefined,
          questionTypes: [type],
          count: batch.length,
          points: opts.points
        })

        written += result.written ?? result.questions.length
        for (const why of result.reasons ?? []) {
          reasons.set(why.reason, (reasons.get(why.reason) ?? 0) + why.count)
        }
        if (result.error) {
          // The call failed: the passages of this batch are asked again.
          failed.push(...batch)
          continue
        }

        const indexes = result.factIndexes ?? result.questions.map((_, index) => index)
        const covered = new Set<number>()
        result.questions.forEach((question, index) => {
          const factIndex = indexes[index]
          if (factIndex === undefined || factIndex < 0 || factIndex >= batch.length) {
            drop('it did not belong to a passage')
            return
          }
          covered.add(factIndex)
          if (accept(question, batch[factIndex])) made++
          else failed.push(batch[factIndex])
        })
        // The passages that got no question at all.
        batch.forEach((passage, index) => {
          if (!covered.has(index)) failed.push(passage)
        })
        report()
      }

      // The second try: the questions that did not hold up are asked again,
      // with a nudge about what was wrong.
      if (made < quota && failed.length > 0 && Date.now() <= deadline && questions.length < opts.count) {
        // The second try: the questions that did not hold up are asked again,
        // with a nudge about what was wrong and a different seed so the model
        // may come up with something else.
        const repair = failed.slice(0, Math.min(MAX_BATCH, quota - made))
        const result = await this.engine().generate({
          ...opts,
          sourceText: repair.map((passage) => passage.focus).join('\n\n'),
          focuses: repair.map((passage) => passage.focus),
          focus: undefined,
          questionTypes: [type],
          count: repair.length,
          points: opts.points,
          hint: repairHint(type),
          seed: repairSeed
        })

        written += result.written ?? result.questions.length
        for (const why of result.reasons ?? []) {
          reasons.set(why.reason, (reasons.get(why.reason) ?? 0) + why.count)
        }
        if (!result.error) {
          const indexes = result.factIndexes ?? result.questions.map((_, index) => index)
          result.questions.forEach((question, index) => {
            const factIndex = indexes[index]
            if (factIndex === undefined || factIndex < 0 || factIndex >= repair.length) {
              drop('it did not belong to a passage')
              return
            }
            if (accept(question, repair[factIndex])) made++
          })
        }
        report()
      }
      producedByType.set(type, (producedByType.get(type) ?? 0) + made)
    }

    // Still too few? The passages that were not used yet are asked one at a
    // time, so a long chapter still fills the request and the last slots are
    // always met: a focused call is the model's most reliable question.
    if (questions.length < opts.count) {
      // Only the types that already worked are asked again: a type the model
      // cannot write (small model, two-option MCQs...) only wastes a model load.
      const working = [...producedByType.entries()].filter(([, n]) => n > 0).map(([t]) => t)
      const topupTypes = working.length > 0 ? working : types
      let pass = 0
      for (const passage of passages) {
        if (questions.length >= opts.count) break
        if (Date.now() > deadline) break
        if (usedPassages.has(passage.chunkId)) continue
        usedPassages.add(passage.chunkId)
        pass++
        const type = topupTypes[(questions.length) % topupTypes.length]

        const result = await this.engine().generate({
          ...opts,
          sourceText: passage.text,
          focus: passage.focus,
          focuses: undefined,
          questionTypes: [type],
          count: 1,
          points: opts.points,
          seed: seedBase + pass
        })

        written += result.written ?? result.questions.length
        for (const why of result.reasons ?? []) {
          reasons.set(why.reason, (reasons.get(why.reason) ?? 0) + why.count)
        }
        if (result.error) continue
        for (const question of result.questions) {
          if (questions.length >= opts.count) break
          accept(question, passage)
        }
        report()
      }
    }

    report()

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
