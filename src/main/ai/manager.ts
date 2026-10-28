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
import { answerTexts, groundedAnswer, normalizeText, sameFact, DEFAULT_SEED } from './ggufProvider'
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
  /** The engine that answers: the chosen model, or the built-in generator. */
  async autoKey(opts: AutoKeyOptions): Promise<AutoKeyResult> {
    await this.probe()
    return this.engine().autoKey(opts)
  }

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
