import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  AiStatus,
  Choice,
  QuestionData,
  QuestionType,
  StoredKey,
  StoredQuestion
} from '../../shared/types'
import { countBlanks, validateQuestion } from '../../shared/validation'
import type {
  AiProvider,
  AutoKeyOptions,
  AutoKeyResult,
  GenerateOptions,
  GenerateResult
} from './types'
import { PROMPT_AUTO_KEY, PROMPT_QUESTION_OF_TYPE, splitFacts } from './prompts'
import { QUESTION_TYPE_DEFAULTS } from './questionDefaults'

export interface GgufProviderOptions {
  /** Where the downloaded model file sits. */
  modelPath: string
  /** The name shown to the instructor. */
  modelName: string
  /** The llama.cpp binary to run; null means "llama-cli from PATH". */
  enginePath?: string | null
  /** Sampling temperature handed to the model. */
  temperature?: number
  /** The random seed, so the same text gives the same questions. */
  seed?: number
}

/** How long a single model run may take before it is stopped. */
const RUN_TIMEOUT_MS = 300_000
/** How long the binary probe may take. */
const PROBE_TIMEOUT_MS = 15_000
/** How many tokens the model may write for one answer. */
const MAX_TOKENS = '2048'
/** A question body longer than this is the passage, not a question. */
const MAX_BODY_LENGTH = 300
/** The seed the model is given, so the same text gives the same questions. */
export const DEFAULT_SEED = 42
/** How long the whole generation may take before it stops asking for more. */
const MAX_GENERATE_MS = 240_000
/** A true/false statement longer than this is a passage, not a statement. */
const MAX_STATEMENT_LENGTH = 160
/** Words that say nothing about the subject. */
const STOP_WORDS = new Set([
  'what',
  'which',
  'who',
  'when',
  'where',
  'why',
  'how',
  'does',
  'this',
  'that',
  'with',
  'from',
  'they',
  'their',
  'them',
  'then',
  'than',
  'there',
  'these',
  'those',
  'have',
  'been',
  'will',
  'would',
  'were',
  'into',
  'more',
  'most',
  'some',
  'such',
  'also',
  'about',
  'after',
  'before',
  'between',
  'during',
  'under',
  'above',
  'below',
  'other',
  'another',
  'please',
  'write',
  'give',
  'tell',
  'using',
  'based',
  'mentioned',
  'source',
  'text',
  'person',
  'example'
])

const QUESTION_TYPES: QuestionType[] = [
  'mcq',
  'tf',
  'identification',
  'fillin',
  'enumeration',
  'problem',
  'matching',
  'connect'
]

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

/** A question the model wrote; the key may still be missing. */
interface DraftQuestion {
  type: QuestionType
  body: string
  points: number
  data: QuestionData
  key: StoredKey | null
  sourceText: string
}

/**
 * Runs a downloaded GGUF model through a local llama.cpp binary.
 *
 * The binary is not bundled: the instructor points the app at `llama-cli.exe`
 * once. When no binary is available the provider reports that it is not ready
 * and the manager falls back to the built-in generator.
 */
export class GgufProvider implements AiProvider {
  private binaryWorks: boolean | null = null
  private binaryError = ''

  constructor(private readonly opts: GgufProviderOptions) {}

  status(): AiStatus {
    const model = this.opts.modelName
    if (!existsSync(this.opts.modelPath)) {
      return {
        ready: false,
        provider: 'gguf',
        model,
        note: 'The model file is missing. Download it again.'
      }
    }
    const binary = this.binary()
    if (!binary) {
      return {
        ready: false,
        provider: 'gguf',
        model,
        note: `The llama.cpp binary was not found at ${this.opts.enginePath}. Set the correct path in the settings screen.`
      }
    }
    if (this.binaryWorks === false) {
      return {
        ready: false,
        provider: 'gguf',
        model,
        note: this.binaryError || 'The llama.cpp binary could not be started.'
      }
    }
    if (this.binaryWorks === null) {
      return {
        ready: false,
        provider: 'gguf',
        model,
        note: 'The llama.cpp binary has not been checked yet.'
      }
    }
    return { ready: true, provider: 'gguf', model }
  }

  /** Runs the binary once so the status tells the truth about the setup. */
  async refresh(): Promise<AiStatus> {
    const binary = this.binary()
    if (!binary) return this.status()
    // A binary that ran once keeps working; no need to start it again.
    if (this.binaryWorks === true) return this.status()
    const probe = await this.run(binary, ['--version'], PROBE_TIMEOUT_MS)
    this.binaryWorks = probe.code === 0
    this.binaryError =
      probe.code === 0
        ? ''
        : `The llama.cpp binary could not be started: ${probe.error.trim() || `exit code ${probe.code}`}`
    return this.status()
  }

  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const types: QuestionType[] = opts.questionTypes.length > 0 ? opts.questionTypes : ['mcq']
    const sourceText = opts.sourceText.slice(0, 6000)

    // With a focus the retrieval has already chosen the sentence: one
    // question is written about it and nothing else is asked.
    if (opts.focus) {
      return this.generateAbout(opts, sourceText, opts.focus)
    }

    // With a list of focuses several questions are written in one call. The
    // model is loaded again for every call, so one call per question is the
    // expensive way to do this.
    if (opts.focuses && opts.focuses.length > 0) {
      return this.generateAboutFacts(opts, opts.focuses)
    }

    // One call per type: a small model mixes the types up when it may choose.
    const base = Math.floor(opts.count / types.length)
    const extra = opts.count % types.length

    const kept: Omit<StoredQuestion, 'id' | 'status'>[] = []
    const reasons = new Map<string, number>()
    // Two questions with the same answer are the same question twice.
    const usedAnswers = new Set<string>()
    const usedBodies: string[] = []
    let lastError = ''
    let written = 0
    const facts = splitFacts(sourceText)
    let factIndex = 0
    const perType = new Map<QuestionType, number>()
    // The instructor should not wait forever for the last question.
    const deadline = Date.now() + MAX_GENERATE_MS

    const drop = (why: string): void => {
      reasons.set(why, (reasons.get(why) ?? 0) + 1)
    }

    /** One ask of the model; returns how many questions were kept. */
    const collectRound = async (
      type: QuestionType,
      needed: number,
      round: number
    ): Promise<number> => {
      // Every question is about another fact of the text, so they do not all
      // ask about the same sentence. One fact per question.
      const roundFacts: string[] = []
      for (let f = 0; f < needed; f++) {
        if (facts.length === 0) break
        roundFacts.push(facts[factIndex % facts.length])
        factIndex++
      }

      const prompt = PROMPT_QUESTION_OF_TYPE({
        sourceText,
        type,
        // One more than needed: the ones that do not hold up are left out, so
        // the spare makes up for them.
        count: needed + 1,
        points: opts.points,
        // Every call picks a different fact, so the questions are not all
        // about the same sentence.
        avoid: kept.map((q) => q.body),
        facts: roundFacts,
        hint:
          round === 0
            ? undefined
            : 'Take a different fact from the source text. Do not write about the example above and do not repeat the source text.'
      })

      const run = await this.runModel(prompt, round === 0 ? undefined : 0.6)
      if (!run.ok) {
        lastError = run.error
        return 0
      }

      const parsed = extractJsonArray(run.output)
      if (!parsed) {
        lastError = `The model did not answer with a JSON list of ${type} questions.`
        return 0
      }

      const drafts: DraftQuestion[] = []
      for (const item of parsed) {
        written++
        if (kept.length + drafts.length >= opts.count) break
        const result = this.buildQuestion(item, type, opts.points, sourceText)
        if (result.draft) drafts.push(result.draft)
        else drop(result.why)
      }

      // A model sometimes writes the question but leaves the key out. Ask
      // for the missing keys in one go.
      await this.fillMissingKeys(drafts, sourceText)

      let added = 0
      for (const draft of drafts) {
        if (kept.length >= opts.count) break
        if (draft.key === null) {
          drop('the answer was not in your text')
          continue
        }
        const answers = answerTexts(draft.type, draft.key, draft.data).map((text) =>
          normalizeText(text)
        )
        if (answers.some((answer) => answer.length > 0 && usedAnswers.has(answer))) {
          drop('it asked about the same thing as another question')
          continue
        }
        // A true/false question has no answer words, so the fact itself is
        // compared: two questions about the same sentence are one question.
        if (usedBodies.some((body) => sameFact(body, draft.body))) {
          drop('it asked about the same thing as another question')
          continue
        }
        answers.forEach((answer) => {
          if (answer.length > 0) usedAnswers.add(answer)
        })
        usedBodies.push(draft.body)

        const candidate = { ...draft, key: draft.key } as Omit<StoredQuestion, 'id' | 'status'>
        if (validateQuestion({ ...candidate, id: 'ai-q', status: 'draft' }).length === 0) {
          kept.push(candidate)
          added++
        } else {
          drop('it was not a complete question')
        }
      }
      return added
    }

    for (let i = 0; i < types.length; i++) {
      const wanted = base + (i < extra ? 1 : 0)
      if (wanted <= 0) continue

      const type = types[i]
      let got = 0
      let misses = 0

      // Keep asking until there are enough questions of this type. A model
      // often writes one instead of the two it was asked for, and one that
      // does not hold up is not worth keeping.
      for (let round = 0; round < 4 && got < wanted; round++) {
        if (Date.now() > deadline) break
        const added = await collectRound(type, wanted - got, round)
        got += added

        // A type the model cannot write is not worth four tries.
        if (added === 0) {
          misses++
          if (misses >= 3) break
        } else {
          misses = 0
        }
      }
      perType.set(type, got)
    }

    // Still too few? Ask the type the model is best at for the rest.
    if (kept.length < opts.count) {
      const best = [...perType.entries()].sort((a, b) => b[1] - a[1])[0]
      const type = best && best[1] > 0 ? best[0] : types[0]
      for (let round = 0; round < 3 && kept.length < opts.count; round++) {
        if (Date.now() > deadline) break
        const added = await collectRound(type, opts.count - kept.length, round + 1)
        if (added === 0) break
      }
    }

    const questions = kept

    if (questions.length === 0) {
      return {
        questions: [],
        error: lastError || 'The model answered, but nothing it wrote was a valid question.'
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

  /** Asks the model for the keys it left out, in one question. */
  private async fillMissingKeys(drafts: DraftQuestion[], sourceText: string): Promise<void> {
    const missing = drafts.filter((q) => q.key === null)
    if (missing.length === 0) return

    const prompt = PROMPT_AUTO_KEY({
      questions: missing.map((q) => ({
        type: q.type,
        body: q.body,
        options: q.data.options
      })),
      sourceText
    })

    const run = await this.runModel(prompt)
    if (!run.ok) return

    const parsed = extractJsonArray(run.output)
    if (!parsed) return

    missing.forEach((question, i) => {
      const raw = parsed[i]
      if (raw === undefined) return
      const key = this.buildKey(question.type, this.readKeyOf(raw), question.data, question.body)
      if (key !== null && groundedAnswer(question.type, key, question.data, sourceText, question.body)) {
        question.key = key
      }
    })
  }

  /**
   * Writes one question about one sentence of a passage.
   *
   * The retrieval has already chosen the sentence, so the model is only
   * asked for the question; the answer has to come from that sentence.
   */
  private async generateAbout(
    opts: GenerateOptions,
    sourceText: string,
    focus: string
  ): Promise<GenerateResult> {
    const type = opts.questionTypes[0] ?? 'mcq'
    const prompt = PROMPT_QUESTION_OF_TYPE({
      sourceText,
      type,
      count: 1,
      points: opts.points,
      focus
    })

    const run = await this.runModel(prompt, undefined, opts.seed)
    if (!run.ok) return { questions: [], error: run.error }

    const parsed = extractJsonArray(run.output)
    if (!parsed) {
      return { questions: [], error: `The model did not answer with a JSON list of ${type} questions.` }
    }

    const kept: Omit<StoredQuestion, 'id' | 'status'>[] = []
    const reasons = new Map<string, number>()

    for (const item of parsed) {
      const result = this.buildQuestion(item, type, opts.points, sourceText)
      if (result.draft) {
        kept.push(result.draft)
        continue
      }
      reasons.set(result.why, (reasons.get(result.why) ?? 0) + 1)
    }

    return {
      questions: kept,
      written: parsed.length,
      dropped: [...reasons.values()].reduce((sum, n) => sum + n, 0),
      reasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count }))
    }
  }

  /**
   * Writes one question per fact, in one call.
   *
   * The retrieval has already chosen the sentences, so the model is only
   * asked for the questions. Every question says which fact it belongs to,
   * so the caller can check it against the passage that fact came from and
   * not against the whole chapter.
   */
  private async generateAboutFacts(
    opts: GenerateOptions,
    focuses: string[]
  ): Promise<GenerateResult> {
    const type = opts.questionTypes[0] ?? 'mcq'
    const prompt = PROMPT_QUESTION_OF_TYPE({
      sourceText: focuses.join('\n\n'),
      type,
      count: focuses.length,
      points: opts.points,
      facts: focuses,
      hint: opts.hint
    })

    const run = await this.runModel(prompt, undefined, opts.seed)
    if (!run.ok) return { questions: [], error: run.error }

    const parsed = extractJsonArray(run.output)
    if (!parsed) {
      return { questions: [], error: `The model did not answer with a JSON list of ${type} questions.` }
    }

    // Which fact every question belongs to: by order first, by the words
    // they share when the model wrote a different number of questions.
    const assignment = assignFacts(parsed.map(bodyOf), focuses)

    const kept: Omit<StoredQuestion, 'id' | 'status'>[] = []
    const factIndexes: number[] = []
    const reasons = new Map<string, number>()

    parsed.forEach((item, index) => {
      const factIndex = assignment[index]
      if (factIndex < 0) {
        const why = 'it did not belong to a fact of the text'
        reasons.set(why, (reasons.get(why) ?? 0) + 1)
        return
      }
      // The question is not grounded here: the caller checks it against the
      // passage the fact came from, which knows more than the sentence.
      const result = this.buildQuestion(item, type, opts.points, focuses[factIndex], false)
      if (result.draft) {
        kept.push(result.draft)
        factIndexes.push(factIndex)
        return
      }
      reasons.set(result.why, (reasons.get(result.why) ?? 0) + 1)
    })

    return {
      questions: kept,
      factIndexes,
      written: parsed.length,
      dropped: [...reasons.values()].reduce((sum, n) => sum + n, 0),
      reasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count }))
    }
  }

  async autoKey(opts: AutoKeyOptions): Promise<AutoKeyResult> {
    const sourceText = opts.sourceText?.slice(0, 6000)
    const questions = opts.questions.map((q) => ({ ...q }))
    const reasons: string[] = []

    const applyKey = (question: StoredQuestion, raw: unknown): void => {
      const value = this.readKeyOf(raw)
      const key = this.buildKey(question.type, value, question.data, question.body)
      if (key === null) {
        reasons.push(`${question.type} question: the model answered ${JSON.stringify(value)}`)
        return
      }
      const merged: StoredQuestion = { ...question, key }
      const problems = validateQuestion(merged)
      if (problems.length === 0) {
        const index = questions.findIndex((q) => q.id === question.id)
        if (index >= 0) questions[index] = merged
      } else {
        reasons.push(`${question.type} question: ${problems.join(', ')}`)
      }
    }

    // First try one call for every question: it is faster and keeps the
    // model loaded once.
    const prompt = PROMPT_AUTO_KEY({
      questions: opts.questions.map((q) => ({
        type: q.type,
        body: q.body,
        options: q.data.options
      })),
      sourceText
    })
    const run = await this.runModel(prompt)
    if (run.ok) {
      let parsed = extractJsonArray(run.output)
      if (!parsed) {
        try {
          const single = JSON.parse(run.output.trim())
          if (single && typeof single === 'object' && !Array.isArray(single)) parsed = [single]
        } catch {
          parsed = null
        }
      }
      if (parsed) {
        opts.questions.forEach((question, i) => {
          if (parsed[i] !== undefined) applyKey(question, parsed[i])
        })
      }
    } else {
      // Keep going with per-question calls below.
    }

    // A small model often answers only the first question. Ask for the
    // missing keys one at a time so the rest are not left empty.
    for (const question of opts.questions) {
      const current = questions.find((q) => q.id === question.id)
      if (current && current.key !== null) continue
      const singlePrompt = PROMPT_AUTO_KEY({
        questions: [{ type: question.type, body: question.body, options: question.data.options }],
        sourceText
      })
      const singleRun = await this.runModel(singlePrompt, 0.4)
      if (!singleRun.ok) continue
      let parsed = extractJsonArray(singleRun.output)
      if (!parsed) {
        try {
          const one = JSON.parse(singleRun.output.trim())
          if (one && typeof one === 'object' && !Array.isArray(one)) parsed = [one]
        } catch {
          parsed = null
        }
      }
      if (parsed && parsed.length > 0) applyKey(question, parsed[0])
    }

    const missing = questions.filter((q) => q.key === null).length
    const detail = reasons.length > 0 ? ` (${reasons.slice(0, 3).join('; ')})` : ''
    return { questions, error: missing > 0 ? `${missing} answer key${missing === 1 ? '' : 's'} could not be found.${detail}` : undefined }
  }

  /**
   * Turns one model answer into a draft question. When it cannot, the reason
   * says why, so the screen can tell the instructor what was left out.
   */
  private buildQuestion(
    item: unknown,
    wanted: QuestionType,
    points: number,
    sourceText: string,
    ground = true
  ): { draft: DraftQuestion | null; why: string } {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { draft: null, why: 'it was not a question at all' }
    }
    const record = item as Record<string, unknown>

    // The model may name another type; its data and key then fit that type,
    // so the question is not the one that was asked for.
    const type = this.readType(record.type) ?? wanted
    if (type !== wanted) {
      return { draft: null, why: 'it was a question of another type' }
    }

    let body = typeof record.body === 'string' ? record.body.trim() : ''
    if (!body) return { draft: null, why: 'the question text was empty' }
    // A model that copies the template leaves the placeholder in the text.
    if (body.includes('<') || body.includes('>')) {
      return { draft: null, why: 'it left a placeholder in the question' }
    }
    // A question that names a section of the document asks about the layout
    // of the text, not about what it says.
    if (namesASection(body)) {
      return { draft: null, why: 'it asked about a section instead of about the text' }
    }
    // A question is a sentence, not the passage it came from.
    if (body.length > MAX_BODY_LENGTH) {
      return { draft: null, why: 'it repeated the whole text' }
    }
    // The app marks a blank with three underscores; a model writes four.
    body = body.replace(/_{2,}/g, '___')
    // A model that repeats the source text has not written a question.
    if (isCopy(body, sourceText)) {
      return { draft: null, why: 'it repeated the text instead of asking about it' }
    }
    // A true/false question needs a statement, not a question.
    if (type === 'tf') {
      if (isQuestion(body)) {
        return { draft: null, why: 'a true or false question has to be a statement' }
      }
      if (body.length > MAX_STATEMENT_LENGTH) {
        return { draft: null, why: 'it repeated the whole text' }
      }
      // The statement has to be about the text, not about the example.
      if (!sharesWithSource(body, sourceText)) {
        return { draft: null, why: 'it was not about your text' }
      }
      // A real statement is a full sentence; a bare phrase copied from the text
      // is not a quiz question on it.
      if (!body.endsWith('.')) {
        return { draft: null, why: 'it was a phrase, not a statement' }
      }
    }

    const built = this.buildData(type, record.data, body)
    if (!built.data) return { draft: null, why: built.why }
    const data = built.data

    // A question with four identical options is not a question, and two
    // options with the same text are not two options.
    if (type === 'mcq') {
      const options = data.options ?? []
      const texts = options.map((o) => o.text.trim().toLowerCase())
      if (options.length < 2 || new Set(texts).size !== texts.length) {
        return { draft: null, why: 'the options were the same or too few' }
      }
    }
    // A multiple choice question has to ask something.
    if (type === 'mcq' && !isQuestion(body)) {
      return { draft: null, why: 'a multiple choice question has to ask something' }
    }
    // An identification question has to ask something.
    if (type === 'identification' && !isQuestion(body)) {
      return { draft: null, why: 'an identification question has to ask something' }
    }
    // So has an enumeration.
    if (type === 'enumeration' && !isQuestion(body)) {
      return { draft: null, why: 'an enumeration question has to ask something' }
    }
    // The question says how many items it wants.
    if (type === 'enumeration') {
      const named = numberInBody(body)
      const count = this.readCount(record.count)
      if (named === null || named !== count) {
        return { draft: null, why: 'the number of items did not match the question' }
      }
    }

    // The key may be missing; a later pass asks the model for it.
    let key = this.buildKey(type, this.readKeyOf(record), data, body)

    // A model that marks the wrong option: when exactly one option is in the
    // text, that one is the answer.
    if (type === 'mcq' && key !== null) {
      const options = data.options ?? []
      const chosen = options.find((o) => o.id === key)
      if (!chosen || !mentionsText(sourceText, chosen.text)) {
        const inText = options.filter((o) => mentionsText(sourceText, o.text))
        if (inText.length === 1) key = inText[0].id
      }
    }

    return {
      draft: {
        type,
        body,
        points: this.readPoints(record.points, points),
        data,
        key: ground && !groundedAnswer(type, key, data, sourceText, body) ? null : key,
        sourceText: sourceText.slice(0, 200)
      },
      why: 'the answer was not in your text'
    }
  }

  /** The type-specific data of a question, or null when it cannot be built. */
  private buildData(
    type: QuestionType,
    raw: unknown,
    body: string
  ): { data: QuestionData | null; why: string } {
    const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}

    switch (type) {
      case 'mcq': {
        const options = this.readChoices(record.options ?? record.choices, 'o')
        if (options.length < 2) return { data: null, why: 'it had no usable options' }
        return { data: { options }, why: '' }
      }
      case 'tf':
        return { data: {}, why: '' }
      case 'identification':
        return { data: {}, why: '' }
      case 'fillin': {
        const blanks = countBlanks(body)
        if (blanks === 0) return { data: null, why: 'it had no blank in the question' }
        return { data: { blanks }, why: '' }
      }
      case 'enumeration':
        return { data: { count: this.readCount(record.count) }, why: '' }
      case 'problem':
        return { data: {}, why: '' }
      case 'matching': {
        const left = this.readChoices(record.left, 'l')
        const right = this.readChoices(record.right, 'r')
        if (left.length === 0 || right.length === 0) {
          return { data: null, why: 'it had no matching pairs' }
        }
        return { data: { left, right }, why: '' }
      }
      case 'connect': {
        const prompts = this.readChoices(record.prompts, 'p')
        const answers = this.readChoices(record.answers, 'a')
        if (prompts.length === 0 || answers.length === 0) {
          return { data: null, why: 'it had no pairs to connect' }
        }
        return { data: { prompts, answers }, why: '' }
      }
    }
  }

  /** The answer key of a question, or null when it cannot be built. */
  private buildKey(type: QuestionType, raw: unknown, data: QuestionData, body: string): StoredKey | null {
    // A model often wraps a single answer in a list.
    const value = unwrapSingle(raw)

    switch (type) {
      case 'mcq': {
        const options = data.options ?? []
        return this.resolveOptionId(value, options)
      }
      case 'tf': {
        if (typeof value === 'boolean') return value
        if (typeof value === 'string') {
          const text = value.trim().toLowerCase()
          if (text === 'true' || text === 'yes') return true
          if (text === 'false' || text === 'no') return false
        }
        return null
      }
      case 'identification': {
        const answers = this.readStringList(value)
        return answers.length > 0 ? answers : null
      }
      case 'fillin': {
        const blanks = countBlanks(body)
        if (blanks === 0) return null
        return this.readBlankList(value, blanks)
      }
      case 'enumeration': {
        const items = this.readStringList(value)
        return items.length > 0 ? items : null
      }
      case 'problem': {
        if (typeof value === 'string' && value.trim()) return { answer: value.trim() }
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const record = value as Record<string, unknown>
          const answer = typeof record.answer === 'string' ? record.answer.trim() : ''
          if (answer) return { answer }
        }
        return null
      }
      case 'matching':
      case 'connect': {
        const from = type === 'matching' ? data.left ?? [] : data.prompts ?? []
        const to = type === 'matching' ? data.right ?? [] : data.answers ?? []
        const map = this.readPairMap(value)
        if (!map) return null
        return alignPairMap(map, from, to)
      }
    }
  }

  /** The answer key of a raw model answer, wherever the model put it. */
  private readKeyOf(raw: unknown): unknown {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>
      if ('key' in record) return record.key
      if ('answer' in record) return record.answer
      // Some models put the key inside the data.
      const data = record.data
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const inner = data as Record<string, unknown>
        if ('key' in inner) return inner.key
        if ('answer' in inner) return inner.answer
      }
      return undefined
    }
    return raw
  }

  private readType(value: unknown): QuestionType | null {
    if (typeof value !== 'string') return null
    const text = value.trim().toLowerCase().replace(/\s+/g, ' ')
    if ((QUESTION_TYPES as string[]).includes(text)) return text as QuestionType
    switch (text) {
      case 'multiple choice':
      case 'multiple-choice':
      case 'multiplechoice':
        return 'mcq'
      case 'true/false':
      case 'true false':
      case 'truefalse':
        return 'tf'
      case 'fill in the blank':
      case 'fill-in':
      case 'fill_in':
        return 'fillin'
      case 'list':
        return 'enumeration'
      case 'connecting':
        return 'connect'
      default:
        return null
    }
  }

  private readPoints(value: unknown, fallback: number): number {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
    return fallback > 0 ? fallback : 1
  }

  private readCount(value: unknown): number {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
    return 1
  }

  /** Normalises a list of options or items into choices with stable ids. */
  private readChoices(value: unknown, prefix: string): Choice[] {
    if (!Array.isArray(value)) return []
    const out: Choice[] = []
    value.forEach((item, index) => {
      if (typeof item === 'string') {
        const text = item.trim()
        if (text) out.push({ id: `${prefix}${index + 1}`, text })
        return
      }
      if (!item || typeof item !== 'object') return
      const record = item as Record<string, unknown>
      const text =
        typeof record.text === 'string'
          ? record.text
          : typeof record.label === 'string'
            ? record.label
            : typeof record.name === 'string'
              ? record.name
              : ''
      if (!text.trim()) return
      const id =
        typeof record.id === 'string' && record.id.trim() ? record.id.trim() : `${prefix}${index + 1}`
      out.push({ id, text: text.trim() })
    })
    return out
  }

  /** Finds the option a model marked as correct. */
  private resolveOptionId(raw: unknown, options: Choice[]): string | null {
    const ids = options.map((o) => o.id)
    if (options.length === 0) return null

    // A small model sometimes returns a list or a boolean for a multiple
    // choice question. Try every element and accept the first that fits.
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const resolved = this.resolveOptionId(item, options)
        if (resolved) return resolved
      }
      return null
    }
    if (typeof raw === 'boolean') {
      return this.resolveOptionId(raw ? 'true' : 'false', options)
    }

    // Unwrap the shapes a small model tends to use.
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>
      for (const key of ['id', 'option', 'optionId', 'answer', 'choice', 'value', 'key']) {
        if (record[key] !== undefined) {
          const resolved = this.resolveOptionId(record[key], options)
          if (resolved) return resolved
        }
      }
      // Fall back to matching the option text, when the model writes the
      // answer instead of its id.
      for (const key of ['text', 'label']) {
        if (typeof record[key] === 'string') {
          const byText = options.find((o) => o.text.toLowerCase() === String(record[key]).trim().toLowerCase())
          if (byText) return byText.id
        }
      }
    }

    if (typeof raw === 'string') {
      const text = raw.trim()
      if (ids.includes(text)) return text
      // "a)" or "a." or "a - text"
      const lead = text.match(/^([A-Za-z0-9]+)/)?.[1] ?? ''
      if (lead && ids.includes(lead)) return lead
      const letter = LETTERS.indexOf(text.toLowerCase().charAt(0))
      if (letter >= 0 && letter < ids.length && text.length <= 3) return ids[letter]
      // 1-based as well as 0-based positions.
      const index = Number(text)
      if (Number.isInteger(index)) {
        if (index >= 0 && index < ids.length) return ids[index]
        if (index >= 1 && index <= ids.length) return ids[index - 1]
      }
      const lowered = text.toLowerCase()
      const exact = options.find((o) => o.text.toLowerCase() === lowered)
      if (exact) return exact.id
      const contains = options.find((o) => lowered.includes(o.text.toLowerCase()) || o.text.toLowerCase().includes(lowered))
      if (contains) return contains.id
      return null
    }
    if (typeof raw === 'number' && Number.isInteger(raw)) {
      if (raw >= 0 && raw < ids.length) return ids[raw]
      if (raw >= 1 && raw <= ids.length) return ids[raw - 1]
    }
    return null
  }

  /** Reads a list of plain answers. */
  private readStringList(raw: unknown): string[] {
    if (typeof raw === 'string') {
      const text = raw.trim()
      return text ? [text] : []
    }
    if (!Array.isArray(raw)) return []
    const out: string[] = []
    for (const item of raw) {
      if (typeof item === 'string' && item.trim()) out.push(item.trim())
      else if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>
        const text = typeof record.text === 'string' ? record.text.trim() : ''
        if (text) out.push(text)
      }
    }
    return out
  }

  /** Reads the accepted answers per blank of a fill-in question. */
  private readBlankList(raw: unknown, blanks: number): string[][] | null {
    if (!Array.isArray(raw)) return null
    const out: string[][] = []
    for (const item of raw) {
      if (typeof item === 'string') {
        const text = item.trim()
        out.push(text ? [text] : [])
      } else if (Array.isArray(item)) {
        out.push(item.filter((v): v is string => typeof v === 'string' && v.trim().length > 0))
      } else {
        out.push([])
      }
    }
    return out.length === blanks ? out : null
  }

  /** Reads a from-id to to-id map. */
  private readPairMap(raw: unknown): Record<string, string> | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value
      else if (typeof value === 'number') out[key] = String(value)
    }
    return Object.keys(out).length > 0 ? out : null
  }

  /** The llama.cpp binary to run, or null when the configured one is missing. */
  private binary(): string | null {
    const configured = this.opts.enginePath?.trim()
    if (configured) return existsSync(configured) ? configured : null
    return 'llama-cli'
  }

  /** Sends one prompt to the model and returns what it wrote. */
  private async runModel(
    prompt: string,
    temperature?: number,
    seed?: number
  ): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
    const binary = this.binary()
    if (!binary) {
      return { ok: false, error: 'No llama.cpp binary is configured for this model.' }
    }

    const folder = mkdtempSync(join(tmpdir(), 'quiz-ai-'))
    const promptFile = join(folder, 'prompt.txt')
    writeFileSync(promptFile, prompt, 'utf8')

    try {
      let result = await this.run(
        binary,
        [
          '-m',
          this.opts.modelPath,
          '-f',
          promptFile,
          '-n',
          MAX_TOKENS,
          '--temp',
          String(temperature ?? this.opts.temperature ?? 0.7),
          // The same text gives the same questions; the second try uses a
          // different temperature, so it comes out differently.
          '--seed',
          String(seed ?? this.opts.seed ?? DEFAULT_SEED),
          '-st',
          '--no-display-prompt'
        ],
        RUN_TIMEOUT_MS
      )
      if (result.code !== 0) {
        // Older builds do not know every flag; retry with the bare minimum.
        result = await this.run(
          binary,
          ['-m', this.opts.modelPath, '-p', prompt.slice(0, 8000), '-n', MAX_TOKENS],
          RUN_TIMEOUT_MS
        )
      }
      if (result.code !== 0) {
        return {
          ok: false,
          error: result.error.trim() || `The model exited with code ${result.code}.`
        }
      }
      const output = result.stdout.trim()
      if (!output) return { ok: false, error: 'The model answered with nothing.' }
      return { ok: true, output }
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  }

  /** Starts the binary and collects what it writes. */
  private run(
    binary: string,
    args: string[],
    timeoutMs: number
  ): Promise<{ code: number; stdout: string; stderr: string; error: string }> {
    return new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null

      const finish = (result: {
        code: number
        stdout: string
        stderr: string
        error: string
      }): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(result)
      }

      let child: ChildProcess
      try {
        child = spawn(binary, args, { windowsHide: true })
      } catch (err) {
        finish({
          code: -1,
          stdout,
          stderr,
          error: err instanceof Error ? err.message : String(err)
        })
        return
      }

      timer = setTimeout(() => {
        child.kill()
        finish({
          code: -1,
          stdout,
          stderr,
          error: 'The model took too long to answer.'
        })
      }, timeoutMs)
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('error', (err: Error) => {
        finish({ code: -1, stdout, stderr, error: err.message })
      })
      child.on('close', (code) => {
        finish({ code: code ?? -1, stdout, stderr, error: stderr })
      })
    })
  }
}

/**
 * Lines a model map up with the items it wrote, by position when needed.
 *
 * A pair that answers itself is refused: the prompt and the answer are the
 * same words, so the question asks nothing. One pair is not a matching
 * question either.
 */
export function alignPairMap(
  map: Record<string, string>,
  from: Choice[],
  to: Choice[]
): Record<string, string> | null {
  const toIds = to.map((c) => c.id)
  const known = new Set(toIds)
  const mapKeys = Object.keys(map)

  const resolve = (value: string): string | null => {
    if (known.has(value)) return value
    const index = Number(value)
    if (Number.isInteger(index) && index >= 0 && index < toIds.length) return toIds[index]
    const letter = LETTERS.indexOf(value.toLowerCase())
    if (letter >= 0 && letter < toIds.length) return toIds[letter]
    return null
  }

  const aligned: Record<string, string> = {}
  const keysMatch = from.every((c) => map[c.id] !== undefined)
  from.forEach((item, index) => {
    const raw = keysMatch ? map[item.id] : map[mapKeys[index]]
    if (raw === undefined) return
    const resolved = resolve(raw)
    if (!resolved) return
    const target = to.find((choice) => choice.id === resolved)
    if (!target) return
    // A pair that answers itself is not a question.
    if (normalizeText(item.text) === normalizeText(target.text)) return
    aligned[item.id] = resolved
  })

  // Every item has to be paired, and one pair is not a matching question.
  if (Object.keys(aligned).length !== from.length) return null
  if (Object.keys(aligned).length < 2) return null
  return aligned
}

/** A list with one entry is the entry itself, as far as a key is concerned. */
function unwrapSingle(value: unknown): unknown {
  if (Array.isArray(value) && value.length === 1) return value[0]
  return value
}

/**
 * The text as plain words, so a phrase can be found in it however the model
 * spaced and punctuated it.
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9%\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** True when the text asks something rather than stating something. */
export function isQuestion(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.endsWith('?')) return true
  return /^(what|which|who|whose|whom|when|where|why|how|is|are|was|were|do|does|did|can|could|will|would|should|name|list)\b/i.test(
    trimmed
  )
}

/**
 * True when the body repeats the source text instead of asking about it.
 */
export function isCopy(body: string, sourceText: string): boolean {
  const text = normalizeText(body)
  const source = normalizeText(sourceText)
  if (text.length < 40) return false
  if (source.includes(text)) return text.length >= source.length * 0.5
  return false
}

/**
 * True when the body says something the source text also says. A model
 * that copied the example in the prompt fails this.
 */export function sharesWithSource(body: string, sourceText: string): boolean {
  const sourceWords = new Set(normalizeText(sourceText).split(' '))
  const words = body
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w))
  if (words.some((w) => sourceWords.has(w))) return true
  const numbers = body.match(/\d+(?:\.\d+)?/g) ?? []
  return numbers.some((n) => sourceWords.has(n))
}

/**
 * True when the words of the phrase stand next to each other in the text.
 * "alch" is not in "my name is alchie", but "alchie" is.
 */
export function containsPhrase(words: string[], phrase: string[]): boolean {
  if (phrase.length === 0) return false
  if (phrase.length > words.length) return false
  for (let i = 0; i + phrase.length <= words.length; i++) {
    let same = true
    for (let j = 0; j < phrase.length; j++) {
      if (words[i + j] !== phrase[j]) {
        same = false
        break
      }
    }
    if (same) return true
  }
  return false
}

/**
 * True when the text says the phrase, word for word.
 */
export function mentionsText(sourceText: string, phrase: string): boolean {
  const needle = normalizeText(phrase)
  if (needle.length < 2) return false
  const words = normalizeText(sourceText).split(' ').filter((w) => w.length > 0)
  return containsPhrase(words, needle.split(' '))
}

/** The numbers a question names, in words or in digits. */
const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12
}

/**
 * The number a question names, or null when it names none.
 */
export function numberInBody(body: string): number | null {
  const digits = body.match(/\b(\d{1,2})\b/)
  if (digits) return Number(digits[1])
  const words = body.toLowerCase().match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/)
  if (words) return NUMBER_WORDS[words[1]]
  return null
}

/**
 * True when the answer is a phrase and not a whole sentence. A student is
 * asked for a word or two, not for the passage again.
 */
export function isShortAnswer(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  if (trimmed.length > 80) return false
  if (/[.!?]/.test(trimmed)) return false
  if (trimmed.split(/\s+/).length > 12) return false
  return true
}

/**
 * True when the body names a section of the document, like "the 'Large
 * Gametes (Ova)' section". Such a question is about the layout of the text
 * and not about what the text says, so it is left out.
 */
export function namesASection(body: string): boolean {
  // "the 'Large Gametes (Ova)' section", "the 'Meiosis' chapter"
  if (/['"“][^'"”]{2,60}['"”]\s+(section|chapter|part|heading|paragraph|title)\b/i.test(body)) {
    return true
  }
  // "section 'Meiosis'"
  if (/\b(section|chapter|heading)\s+['"“][^'"”]{2,60}['"”]/i.test(body)) return true
  return false
}

/**
 * True when the answer only repeats the words of the question instead of
 * filling the blank.
 */
export function repeatsTheQuestion(answer: string, body: string): boolean {
  const frame = new Set(
    body
      .split('___')
      .join(' ')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 0)
  )
  const words = answer
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0)
  return words.some((word) => frame.has(word))
}

/**
 * True when two questions are about the same fact, even when they are worded
 * differently.
 */
export function sameFact(a: string, b: string): boolean {
  const words = contentWords(a)
  const other = contentWords(b)
  if (words.size === 0 || other.size === 0) return false
  let shared = 0
  for (const word of words) {
    if (other.has(word)) shared++
  }
  // The same sentence twice, or the same thing said another way.
  const smaller = Math.min(words.size, other.size)
  return shared >= 2 && shared >= Math.ceil(smaller * 0.6)
}

/** The words of a text that say something about the subject. */
function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
  )
}

/** The body of a raw model answer. */
function bodyOf(item: unknown): string {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return ''
  const body = (item as Record<string, unknown>).body
  return typeof body === 'string' ? body : ''
}

/**
 * The fact every question belongs to.
 *
 * The model is asked for one question per fact, in this order, so the order
 * is the first guess. When the model wrote a different number of questions,
 * or wrote them in another order, the words a question shares with a fact
 * decide.
 */
export function assignFacts(bodies: string[], focuses: string[]): number[] {
  const assignment = new Array<number>(bodies.length).fill(-1)
  if (focuses.length === 0) return assignment
  const used = new Set<number>()

  bodies.forEach((body, index) => {
    let best = -1
    let bestScore = 0
    focuses.forEach((focus, focusIndex) => {
      if (used.has(focusIndex)) return
      const score = factOverlap(body, focus)
      if (score > bestScore) {
        bestScore = score
        best = focusIndex
      }
    })
    // No words in common: the order is the best guess there is.
    if (best < 0) {
      for (let focusIndex = 0; focusIndex < focuses.length; focusIndex++) {
        if (used.has(focusIndex)) continue
        best = focusIndex
        break
      }
    }
    if (best < 0) return
    used.add(best)
    assignment[index] = best
  })

  return assignment
}

/** How many words a question and a fact have in common. */
function factOverlap(a: string, b: string): number {
  const words = contentWords(a)
  const other = contentWords(b)
  let shared = 0
  for (const word of words) {
    if (other.has(word)) shared++
  }
  return shared
}

/**
 * True when the answer can be found in the source text. A model that
 * invents an answer is worse than no answer at all.
 */
export function groundedAnswer(
  type: QuestionType,
  key: StoredKey | null,
  data: QuestionData,
  sourceText: string,
  body = ''
): boolean {
  if (key === null) return false
  const sourceWords = normalizeText(sourceText).split(' ').filter((w) => w.length > 0)
  const inText = (value: string): boolean => {
    const needle = normalizeText(value)
    if (needle.length < 2) return false
    return containsPhrase(sourceWords, needle.split(' '))
  }
  switch (type) {
    case 'mcq': {
      // The correct option has to be something the text says.
      const options = data.options ?? []
      const chosen = options.find((o) => o.id === key)
      if (!chosen) return false
      return inText(chosen.text)
    }
    case 'identification':
      return answerStrings(key).every((answer) => inText(answer) && isShortAnswer(answer))
    case 'enumeration': {
      const items = answerStrings(key)
      if (items.length === 0) return false
      // The same answer three times is not an enumeration.
      const unique = new Set(items.map((item) => item.trim().toLowerCase()))
      if (unique.size !== items.length) return false
      if (data.count !== undefined && data.count !== items.length) return false
      if (!items.every((item) => inText(item) && isShortAnswer(item))) return false
      // The items are the answer, not the question again.
      return items.every((item) => !repeatsTheQuestion(item, body))
    }
    case 'fillin': {
      const groups = blankAnswers(key)
      if (groups.length === 0) return false
      if (!groups.every((group) => group.every(inText))) return false
      // The answer fills the blank; it is not the whole sentence.
      return groups.every((group) => group.every((answer) => !repeatsTheQuestion(answer, body)))
    }
    case 'problem': {
      const answer = typeof key === 'object' && key !== null && !Array.isArray(key) ? key.answer : ''
      if (answer.trim().length === 0) return false
      // A solved problem has a number the text never wrote.
      if (/\d/.test(answer)) return true
      // An answer that is a whole sentence is the passage again.
      if (!isShortAnswer(answer)) return false
      return inText(answer)
    }
    case 'tf':
      return true
    case 'matching':
    case 'connect': {
      // The items of a pair question are words of the text, so a pair that
      // invents them is not a question about the text at all.
      const left = type === 'matching' ? data.left ?? [] : data.prompts ?? []
      const right = type === 'matching' ? data.right ?? [] : data.answers ?? []
      if (left.length === 0 || right.length === 0) return false
      const pairs = pairEntries(key)
      // One pair is not a matching question.
      if (pairs.length < 2) return false
      const leftById = new Map(left.map((choice) => [choice.id, choice]))
      const rightById = new Map(right.map((choice) => [choice.id, choice]))
      for (const [leftId, rightId] of pairs) {
        const prompt = leftById.get(leftId)
        const answer = rightById.get(rightId)
        if (!prompt || !answer) return false
        if (!inText(prompt.text) || !inText(answer.text)) return false
        if (!isShortItem(prompt.text) || !isShortItem(answer.text)) return false
      }
      return true
    }
  }
}

/** The pairs of a matching or connect key. */
function pairEntries(key: StoredKey): [string, string][] {
  if (!key || typeof key !== 'object' || Array.isArray(key)) return []
  return Object.entries(key as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
}

/**
 * An item of a pair question is a phrase and not a whole sentence. A number
 * is allowed, because a computed value such as "15 EUR" is a real answer.
 */
function isShortItem(text: string): boolean {
  if (/\d/.test(text)) return true
  return isShortAnswer(text)
}

/** The accepted answers of an identification or enumeration key. */
function answerStrings(key: StoredKey): string[] {
  if (typeof key === 'string') return [key]
  if (Array.isArray(key)) {
    return key.filter((entry): entry is string => typeof entry === 'string')
  }
  return []
}

/** The accepted answers per blank of a fill-in key. */
function blankAnswers(key: StoredKey): string[][] {
  if (!Array.isArray(key)) return []
  return key
    .filter((entry): entry is string[] => Array.isArray(entry))
    .map((group) => group.filter((entry): entry is string => typeof entry === 'string'))
}

/**
 * The words of the answer, so two questions with the same answer can be
 * spotted.
 */
export function answerTexts(
  type: QuestionType,
  key: StoredKey | null,
  data: QuestionData
): string[] {
  if (key === null) return []
  switch (type) {
    case 'mcq': {
      const options = data.options ?? []
      const chosen = options.find((o) => o.id === key)
      return chosen ? [chosen.text] : []
    }
    case 'identification':
    case 'enumeration':
      return answerStrings(key)
    case 'fillin':
      return blankAnswers(key).flat()
    case 'problem': {
      const answer = typeof key === 'object' && key !== null && !Array.isArray(key) ? key.answer : ''
      return typeof answer === 'string' ? [answer] : []
    }
    case 'tf':
    case 'matching':
    case 'connect':
      return []
  }
}

/**
 * Pulls the model's answer out of whatever the binary wrote.
 *
 * The binary echoes the prompt and prints a banner, so the answer is the
 * last JSON list in the output - and the one inside the code fence when the
 * model used one.
 */
export function extractJsonArray(text: string): unknown[] | null {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
  for (let i = fences.length - 1; i >= 0; i--) {
    const parsed = parseArray(fences[i][1])
    if (parsed) return parsed
  }

  // Without a fence the answer is the last list that parses. Only the lists
  // that stand on their own count: an inner list of a list is not the answer.
  const lists = topLevelLists(text)
  for (let i = lists.length - 1; i >= 0; i--) {
    const parsed = parseArray(lists[i])
    if (parsed) return parsed
  }

  return null
}

/** Parses a string as a JSON list, or null when it is not one. */
function parseArray(text: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(text.trim())
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Every list in the text that stands on its own, in the order they appear. */
function topLevelLists(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let braces = 0
  let start = -1
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      braces++
      continue
    }
    if (char === '}') {
      braces--
      continue
    }
    if (char === '[') {
      // A list inside an object is part of that object, not the answer.
      if (depth === 0 && braces === 0) start = i
      depth++
    } else if (char === ']') {
      depth--
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1))
        start = -1
      }
    }
  }
  return out
}
