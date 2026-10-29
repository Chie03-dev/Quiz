import { type QuestionType, type StoredQuestion } from '../../shared/types'
import type {
  AiProvider,
  AiStatus,
  GenerateOptions,
  GenerateResult,
  AutoKeyOptions,
  AutoKeyResult,
  ModelConfig
} from './types'
import { DEFAULT_MODEL_CONFIG } from './types'
import { QUESTION_TYPE_DEFAULTS } from './questionDefaults'

export class StubProvider implements AiProvider {
  private readonly config: ModelConfig

  constructor(config: ModelConfig = DEFAULT_MODEL_CONFIG) {
    this.config = config
  }

  status(): AiStatus {
    return {
      ready: true,
      provider: this.config.provider,
      model: this.config.model
    }
  }

  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const types: QuestionType[] = opts.questionTypes.length > 0 ? opts.questionTypes : ['mcq']
    const questions: Omit<StoredQuestion, 'id' | 'status'>[] = []

    for (let i = 0; i < opts.count; i++) {
      const type = types[i % types.length]
      const template = QUESTION_TYPE_DEFAULTS[type]
      questions.push({
        type,
        body: `${template.body} (Variant ${i + 1})`,
        points: opts.points > 0 ? opts.points : template.points,
        data: template.data,
        key: template.key,
        sourceText: opts.sourceText ? opts.sourceText.substring(0, 200) : ''
      })
    }

    return { questions }
  }
  async autoKey(opts: AutoKeyOptions): Promise<AutoKeyResult> {
    const questions: StoredQuestion[] = opts.questions.map((q) => {
      if (this.keyIsValid(q)) return q

      const filled = { ...q }
      const defaults = QUESTION_TYPE_DEFAULTS[q.type]
      filled.key = defaults.key
      return filled
    })

    return { questions }
  }

  private keyIsValid(q: StoredQuestion): boolean {
    const key = q.key
    switch (q.type) {
      case 'mcq':
        return typeof key === 'string' && key.length > 0
      case 'tf':
        return typeof key === 'boolean'
      case 'identification':
        return Array.isArray(key) && key.some((k) => typeof k === 'string' && k.length > 0)
      case 'fillin':
        return Array.isArray(key) && key.every((blank) => Array.isArray(blank) && blank.some((k) => typeof k === 'string' && k.length > 0))
      case 'enumeration':
        return Array.isArray(key) && key.some((k) => typeof k === 'string' && k.length > 0)
      case 'problem': {
        const k = key as { answer?: string } | null
        return typeof key === 'object' && key !== null && !Array.isArray(key) && typeof k?.answer === 'string' && k.answer.length > 0
      }
      case 'matching':
      case 'connect':
        return typeof key === 'object' && key !== null && !Array.isArray(key) && Object.keys(key).length > 0
      default:
        return false
    }
  }
}

