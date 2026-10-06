/**
 * The shared quiz parser: turns the neutral blocks both extractors produce into
 * draft questions plus warnings. It is pure and unit-testable and knows nothing
 * about files — only about the shapes in ./types.
 *
 * Answers are read from one mark style (bold / underline / highlight, or a
 * combination), auto-detected across the choice and answer lines unless the
 * import dialog pins it. When a key cannot be determined the question is kept
 * with an empty key and a warning; the optional Answer Key section is used only
 * for items that carry no marks.
 */
import type { Choice, QuestionData, QuestionType, StoredKey } from '../../shared/types'
import { countBlanks } from '../../shared/validation'
import type { QuizImport, StoredQuestionInput } from '../quizFormat'
import type { Block, Run, Table } from './types'
import { runsText } from './types'

export type AnswerMarking = 'auto' | 'bold' | 'underline' | 'highlight' | 'none'
export type ResolvedMark = 'bold' | 'underline' | 'highlight' | 'bold-underline' | 'none'

export interface ParseWarning {
  /** Index into quiz.questions, or null for a whole-quiz issue. */
  questionIndex: number | null
  message: string
}

export interface ParseOptions {
  /** How answer marks are read. Default 'auto' (detect). */
  markStyle?: AnswerMarking
}

export interface ParseResult {
  quiz: QuizImport
  warnings: ParseWarning[]
}

// --- patterns -------------------------------------------------------------

const QUESTION_START = /^\s*(?:Q\s*\d+\s*[.)]|\d+\s*[.)])\s*/i
const CHOICE_START = /^\s*([A-Za-z])\s*[.)]\s*/
const ANSWER_LINE = /^\s*(?:correct\s+)?answers?\s*[:\-]\s*/i
const ENUM_ANSWERS = /^\s*answers?\s*\(\s*any\s+(\d+)\s*\)\s*[:\-]\s*/i
const TF_INLINE = /\b(true)\s*(?:\/|or|\|)\s*(false)\b/i
const POINTS_RE = /\((\d+)\s*(?:points?|pts?)\b[^)]*\)/i
const COUNT_RE = /\(\s*(\d+)\s*\)/
const KEY_LINE = /^\s*(\d+)\s*[.:\-]\s*(.+)$/

const TIME_LIMIT_RE = /^time\s+limit\b\s*[:\-]?\s*(\d+)\s*(minutes?|mins?|seconds?|secs?)/i
const META_RE = /^(?:time\s+limit|name|section|date|instructions?|directions?|general\b)/i

export const SECTION_LABELS: Record<QuestionType, string> = {
  mcq: 'Multiple Choice',
  tf: 'True or False',
  identification: 'Identification',
  fillin: 'Fill in the Blank(s)',
  enumeration: 'Enumeration',
  problem: 'Problem Solving',
  matching: 'Matching',
  connect: 'Connect'
}

const SECTION_TYPES: { re: RegExp; type: QuestionType }[] = [
  { re: /multiple\s+choice/i, type: 'mcq' },
  { re: /true\s+or\s+false/i, type: 'tf' },
  { re: /identification/i, type: 'identification' },
  { re: /fill\s+in\s+the\s+blank/i, type: 'fillin' },
  { re: /enumeration/i, type: 'enumeration' },
  { re: /problem\s+solving/i, type: 'problem' },
  { re: /matching/i, type: 'matching' },
  { re: /connect/i, type: 'connect' },
  { re: /activity/i, type: 'connect' }
]

interface SectionHit {
  type: QuestionType
  points: number | null
}

/** Recognises a section header ("I. Multiple Choice (2 points each)"). */
function matchSection(raw: string): SectionHit | null {
  if (QUESTION_START.test(raw)) return null // "1. ..." is a question, not a header
  let t = raw.trim().replace(/[:\s]+$/, '')
  t = t.replace(/^[IVXivx]{1,6}\s*[.)]\s*/, '') // optional roman prefix
  t = t.replace(/^[A-Za-z]\s*[.)]\s*/, '') // optional letter prefix
  const points = t.match(POINTS_RE)
  const name = t.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  if (!name) return null
  for (const s of SECTION_TYPES) {
    if (s.re.test(name)) return { type: s.type, points: points ? Number(points[1]) : null }
  }
  return null
}

/** "Answer Key" / "Answers" (exact) starts the trailing key section. */
function isAnswerKeyHeading(text: string): boolean {
  const norm = text.toLowerCase().replace(/[^a-z]+/g, ' ').trim()
  return norm === 'answer key' || norm === 'answers'
}

/** General instruction lines are ignored, never warned about. */
function isMeta(text: string): boolean {
  return META_RE.test(text.trim())
}

function parseTimeLimit(text: string): number | null {
  const m = text.match(TIME_LIMIT_RE)
  if (!m) return null
  const value = Number(m[1])
  const unit = m[2].toLowerCase()
  return unit.startsWith('s') ? value : value * 60
}

// --- marks ----------------------------------------------------------------

function isMarked(r: Run, mark: ResolvedMark): boolean {
  switch (mark) {
    case 'none':
      return false
    case 'bold':
      return r.bold
    case 'underline':
      return r.underline
    case 'highlight':
      return r.highlight
    case 'bold-underline':
      return r.bold && r.underline
  }
}

function styleKey(r: Run): ResolvedMark | null {
  const { bold, underline, highlight } = r
  if (!bold && !underline && !highlight) return null
  if (bold && underline && !highlight) return 'bold-underline'
  if (bold && !underline && !highlight) return 'bold'
  if (!bold && underline && !highlight) return 'underline'
  if (!bold && !underline && highlight) return 'highlight'
  if (bold) return 'bold'
  if (underline) return 'underline'
  return 'highlight'
}

interface Char {
  ch: string
  marked: boolean
}

function charsOf(runs: Run[], mark: ResolvedMark): Char[] {
  const out: Char[] = []
  for (const r of runs) {
    const m = isMarked(r, mark)
    for (const ch of r.text) out.push({ ch, marked: m })
  }
  return out
}

function stripPrefixRuns(runs: Run[], re: RegExp): Run[] {
  const text = runsText(runs)
  const m = text.match(re)
  if (!m) return runs
  let drop = m[0].length
  const out: Run[] = []
  for (const r of runs) {
    if (drop >= r.text.length) {
      drop -= r.text.length
      continue
    }
    out.push(drop > 0 ? { ...r, text: r.text.slice(drop) } : { ...r })
    drop = 0
  }
  return out
}

/** First..last marked character (keeps interior separators, drops outer text). */
function markedRange(chars: Char[]): { start: number; end: number } | null {
  let start = -1
  let end = -1
  chars.forEach((c, i) => {
    if (c.marked) {
      if (start < 0) start = i
      end = i
    }
  })
  return start < 0 ? null : { start, end: end + 1 }
}

/** Contiguous marked groups (used for fill-in blanks and enumeration items). */
function markedSegments(chars: Char[]): { start: number; end: number }[] {
  const segs: { start: number; end: number }[] = []
  let i = 0
  while (i < chars.length) {
    if (chars[i].marked) {
      let j = i
      while (j < chars.length && chars[j].marked) j++
      segs.push({ start: i, end: j })
      i = j
    } else {
      i++
    }
  }
  return segs
}

/** Splits an answer into accepted alternates ("Paris / City of Light"). */
function splitAlternates(text: string): string[] {
  return text
    .split(/\s*[\/|]\s*|\s+\bor\b\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Splits a comma/semicolon list into items (fill-in blanks, enum pools). */
function splitList(text: string): string[] {
  return text
    .split(/\s*[;,]\s*/)
    .map((s) => s.replace(/^[\s,;/|]+|[\s,;/|]+$/g, '').trim())
    .filter((s) => s.length > 0)
}

// --- mark auto-detection --------------------------------------------------

const STYLE_ORDER: ResolvedMark[] = ['bold', 'underline', 'highlight', 'bold-underline']

interface TextLine {
  runs: Run[]
  text: string
  heading: boolean
}

function paragraphLines(blocks: Block[]): TextLine[] {
  const out: TextLine[] = []
  for (const b of blocks) {
    if (b.kind !== 'paragraph') continue
    const text = runsText(b.runs)
    if (!text.trim()) continue
    out.push({ runs: b.runs, text, heading: b.heading !== undefined })
  }
  return out
}

/** Drops the question number / choice letter / "Answer:" prefix before counting. */
function stripForDetection(runs: Run[]): Run[] {
  let out = stripPrefixRuns(runs, QUESTION_START)
  out = stripPrefixRuns(out, CHOICE_START)
  out = stripPrefixRuns(out, ANSWER_LINE)
  out = stripPrefixRuns(out, ENUM_ANSWERS)
  return out
}

function isCandidateLine(text: string): boolean {
  return CHOICE_START.test(text) || ANSWER_LINE.test(text) || ENUM_ANSWERS.test(text) || TF_INLINE.test(text)
}

/**
 * Picks the mark style used for answers. With `forced` set (the import dialog's
 * Bold/Underline/Highlight/None) detection is skipped; otherwise the marks on
 * choice and answer lines decide, falling back to every non-heading line.
 */
export function detectMark(blocks: Block[], forced: Exclude<AnswerMarking, 'auto'> | null): ResolvedMark {
  if (forced) return forced
  const tally = new Map<ResolvedMark, number>()
  const add = (runs: Run[]): void => {
    for (const r of runs) {
      const k = styleKey(r)
      if (k) tally.set(k, (tally.get(k) ?? 0) + 1)
    }
  }
  const lines = paragraphLines(blocks)
  for (const line of lines) {
    if (line.heading || !isCandidateLine(line.text)) continue
    add(stripForDetection(line.runs))
  }
  if (tally.size === 0) {
    for (const line of lines) {
      if (line.heading) continue
      add(stripForDetection(line.runs))
    }
  }
  if (tally.size === 0) return 'none'
  let best: ResolvedMark = 'none'
  let bestCount = -1
  for (const k of STYLE_ORDER) {
    const c = tally.get(k) ?? 0
    if (c > bestCount) {
      best = k
      bestCount = c
    }
  }
  return best
}

/** Finds an "Answer:" / "Answers:" value anywhere in a line. */
function findAnswer(text: string): { valueStart: number } | null {
  const re = /(?:^|\s)(?:correct\s+)?answers?\s*[:\-]\s*/gi
  const m = re.exec(text)
  if (!m) return null
  return { valueStart: m.index + m[0].length }
}

// --- matching / connect tables -------------------------------------------

function cellText(cell: { runs: Run[] }): string {
  return runsText(cell.runs).trim()
}

/** Positional label for the n-th right item (A, B, ... Z, AA, ...). */
function letterFor(index: number): string {
  let n = index
  let s = ''
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

function isHeaderRow(cells: string[]): boolean {
  const mid = (cells[1] ?? '').toLowerCase()
  const first = (cells[0] ?? '').toLowerCase().replace(/[^a-z]/g, '')
  return mid.includes('answer') || mid.includes('connect') || first === 'columna'
}

const RIGHT_LABEL = /^([A-Za-z])\s*[.)]\s+/

interface PairTable {
  left: Choice[]
  right: Choice[]
  key: Record<string, string>
  warnings: string[]
}

/**
 * Reads a three-column table: Column A = left items/prompts, Column B = right
 * items/answers (optionally letter-prefixed), and the middle column holds the
 * letter of the matching right item. Rows with an empty Column A are decoys.
 */
function parsePairTable(table: Table, type: QuestionType): PairTable {
  const leftName = type === 'matching' ? 'l' : 'p'
  const rightName = type === 'matching' ? 'r' : 'a'
  const warnings: string[] = []
  const rows = table.rows
  if (rows.length === 0) {
    return { left: [], right: [], key: {}, warnings: ['the table has no rows'] }
  }
  const start = rows.length > 1 && isHeaderRow(rows[0].map(cellText)) ? 1 : 0

  const leftRaw: string[] = []
  const rightRaw: string[] = []
  const pairs: { leftIndex: number; mid: string }[] = []
  for (let i = start; i < rows.length; i++) {
    const cells = rows[i].map(cellText)
    const a = cells[0] ?? ''
    const mid = (cells[1] ?? '').trim()
    const b = cells[2] ?? ''
    if (!a && !b) continue
    if (b) rightRaw.push(b)
    else if (a) warnings.push(`row ${i - start + 1} has a left item but no right item`)
    if (a) {
      leftRaw.push(a)
      pairs.push({ leftIndex: leftRaw.length - 1, mid })
    }
  }
  if (leftRaw.length === 0) warnings.push('the table has no left items')
  if (rightRaw.length === 0) warnings.push('the table has no right items')

  // Right items are labelled by their own letter prefix when every cell has one,
  // otherwise positionally (A = first row, B = second, ...).
  const allLabelled = rightRaw.length > 0 && rightRaw.every((t) => RIGHT_LABEL.test(t))
  const rightTexts = allLabelled ? rightRaw.map((t) => t.replace(RIGHT_LABEL, '').trim()) : rightRaw
  const labels = rightRaw.map((t, i) =>
    allLabelled ? (t.match(RIGHT_LABEL)?.[1] ?? '').toUpperCase() : letterFor(i)
  )

  const left: Choice[] = leftRaw.map((text, i) => ({ id: `${leftName}${i + 1}`, text }))
  const right: Choice[] = rightTexts.map((text, i) => ({ id: `${rightName}${i + 1}`, text }))
  const key: Record<string, string> = {}
  const used = new Set<string>()
  for (const p of pairs) {
    const want = p.mid.toUpperCase()
    const target = want ? labels.findIndex((lab, i) => lab === want && !used.has(right[i].id)) : -1
    if (target < 0) {
      warnings.push(
        `the left item #${p.leftIndex + 1} has no matching right item (${p.mid || 'the letter is missing'})`
      )
      continue
    }
    used.add(right[target].id)
    key[left[p.leftIndex].id] = right[target].id
  }
  return { left, right, key, warnings }
}

/** The table's text, appended to a matching/connect question's source_text. */
function tableSourceText(table: Table): string {
  return table.rows.map((row) => row.map(cellText).join(' | ')).join('\n')
}

// --- question assembly ----------------------------------------------------

interface Line {
  runs: Run[]
  text: string
}

interface Builder {
  section: QuestionType
  sectionPoints: number | null
  number: number
  lines: Line[]
  tables: Table[]
}

interface DraftItem {
  section: QuestionType
  number: number
  question: StoredQuestionInput
  hasMarks: boolean
  markKey: StoredKey | null
  explicitKey: StoredKey | null
  tableKey: Record<string, string> | null
  /** Structural problems, always reported (missing count, missing table). */
  immediate: string[]
  /** Answer-not-determined problems, reported only if the key stays empty. */
  deferred: string[]
}

/** Turns one finished question (its lines + optional table) into a draft item. */
function finalize(b: Builder, mark: ResolvedMark): DraftItem {
  const immediate: string[] = []
  const deferred: string[] = []
  const stem = b.lines[0] ?? { runs: [], text: '' }
  const stemRuns = stripPrefixRuns(stem.runs, QUESTION_START)
  const stemText = runsText(stemRuns).trim()
  const others = b.lines.slice(1)

  const sourceParts = b.lines.map((l) => l.text.trim()).filter((t) => t.length > 0)
  for (const t of b.tables) sourceParts.push(tableSourceText(t))
  const sourceText = sourceParts.join('\n')

  let body = stemText
  let data: QuestionData = {}
  const stemPointsMatch = stemText.match(POINTS_RE)
  const stemPoints = stemPointsMatch ? Number(stemPointsMatch[1]) : null
  let points = Math.max(1, stemPoints ?? b.sectionPoints ?? 1)
  let hasMarks = false
  let markKey: StoredKey | null = null
  let explicitKey: StoredKey | null = null
  let tableKey: Record<string, string> | null = null

  switch (b.section) {
    case 'mcq': {
      body = stemText
      const options: Choice[] = []
      const marked: number[] = []
      for (const line of others) {
        const cm = line.text.match(CHOICE_START)
        if (!cm) continue
        const runs = stripPrefixRuns(line.runs, CHOICE_START)
        const text = runsText(runs).trim()
        if (!text) continue
        let id = (cm[1] ?? '').toLowerCase() || `o${options.length}`
        if (options.some((o) => o.id === id)) id = `${id}${options.length}`
        options.push({ id, text })
        if (markedRange(charsOf(runs, mark))) marked.push(options.length - 1)
      }
      data = { options }
      hasMarks = marked.length > 0
      if (marked.length === 1) markKey = options[marked[0]].id
      else if (marked.length >= 2)
        deferred.push('two or more choices are marked, so the correct answer was left blank')
      else deferred.push('no choice is marked as the correct answer')
      break
    }
    case 'tf': {
      body = stemText
      data = {}
      let bothMarked = false
      for (const line of b.lines) {
        const tfm = line.text.match(TF_INLINE)
        if (tfm && markKey === null) {
          const lower = line.text.toLowerCase()
          const at = tfm.index ?? 0
          const ti = lower.indexOf('true', at)
          const fi = ti >= 0 ? lower.indexOf('false', ti + 4) : -1
          const chars = charsOf(line.runs, mark)
          const trueMarked = ti >= 0 && chars.slice(ti, ti + 4).some((c) => c.marked)
          const falseMarked = fi >= 0 && chars.slice(fi, fi + 5).some((c) => c.marked)
          if (trueMarked && !falseMarked) {
            markKey = true
            hasMarks = true
          } else if (falseMarked && !trueMarked) {
            markKey = false
            hasMarks = true
          } else if (trueMarked && falseMarked) {
            bothMarked = true
            hasMarks = true
          }
        }
        const fa = findAnswer(line.text)
        if (fa && explicitKey === null && markKey === null) {
          const v = line.text.slice(fa.valueStart).trim().toLowerCase()
          if (v === 'true' || v === 'false') explicitKey = v === 'true'
        }
      }
      if (markKey === null) {
        deferred.push(
          bothMarked
            ? 'both True and False are marked, so the answer was left blank'
            : 'the correct answer (True or False) was not determined'
        )
      }
      break
    }
    case 'identification': {
      body = stemText
      data = {}
      for (const line of b.lines) {
        const fa = findAnswer(line.text)
        if (!fa) continue
        const value = line.text.slice(fa.valueStart)
        const chars = charsOf(line.runs, mark)
        const vchars = chars.slice(fa.valueStart, fa.valueStart + value.length)
        const range = markedRange(vchars)
        const text = range ? value.slice(range.start, range.end).trim() : value.trim()
        const parts = splitAlternates(text)
        if (range && parts.length) {
          markKey = parts
          hasMarks = true
        } else if (!range && parts.length) {
          explicitKey = parts
        }
        break
      }
      if (markKey === null) deferred.push('the accepted answer for this item was not determined')
      break
    }
    case 'fillin': {
      const stemChars = charsOf(stemRuns, mark)
      const segs = markedSegments(stemChars).filter(
        (s) => stemChars.slice(s.start, s.end).map((c) => c.ch).join('').trim().length > 0
      )
      if (segs.length > 0) {
        hasMarks = true
        let out = ''
        const answers: string[][] = []
        let i = 0
        let si = 0
        while (i < stemChars.length) {
          if (si < segs.length && segs[si].start === i) {
            const ans = stemChars.slice(segs[si].start, segs[si].end).map((c) => c.ch).join('').trim()
            out += '___'
            answers.push([ans])
            i = segs[si].end
            si++
          } else {
            out += stemChars[i].ch
            i++
          }
        }
        body = out.trim()
        markKey = answers
      } else {
        body = stemText
        for (const line of others) {
          const fa = findAnswer(line.text)
          if (!fa) continue
          const value = line.text.slice(fa.valueStart)
          const chars = charsOf(line.runs, mark)
          const vchars = chars.slice(fa.valueStart, fa.valueStart + value.length)
          const range = markedRange(vchars)
          const text = range ? value.slice(range.start, range.end).trim() : value.trim()
          const parts = splitList(text)
          if (range && parts.length) {
            markKey = parts.map((p) => [p])
            hasMarks = true
          } else if (!range && parts.length) {
            explicitKey = parts.map((p) => [p])
          }
          break
        }
        if (markKey === null) deferred.push('the answers for the blanks were not determined')
      }
      data = { blanks: countBlanks(body) }
      break
    }
    case 'enumeration': {
      body = stemText
      const countMatch = stemText.match(COUNT_RE)
      const count = countMatch ? Number(countMatch[1]) : 0
      if (!countMatch) immediate.push('the item count (for example "(3)") was not found in the question')
      data = { count }
      for (const line of others) {
        let vs = -1
        const em = line.text.match(ENUM_ANSWERS)
        if (em) vs = em[0].length
        else {
          const fa = findAnswer(line.text)
          if (fa) vs = fa.valueStart
        }
        if (vs < 0) continue
        const value = line.text.slice(vs)
        const chars = charsOf(line.runs, mark)
        const vchars = chars.slice(vs, vs + value.length)
        const segs = markedSegments(vchars)
        if (segs.length) {
          const items = segs.flatMap((s) => splitList(value.slice(s.start, s.end)))
          if (items.length) {
            markKey = items
            hasMarks = true
          }
        } else if (value.trim()) {
          const items = splitList(value.trim())
          if (items.length) explicitKey = items
        }
        break
      }
      if (markKey === null) deferred.push('the accepted items for this enumeration were not determined')
      break
    }
    case 'problem': {
      body = stemText
      data = {}
      for (const line of b.lines) {
        const fa = findAnswer(line.text)
        if (!fa) continue
        const value = line.text.slice(fa.valueStart)
        const chars = charsOf(line.runs, mark)
        const vchars = chars.slice(fa.valueStart, fa.valueStart + value.length)
        const range = markedRange(vchars)
        if (range) {
          const ans = value.slice(range.start, range.end).trim()
          if (ans) {
            markKey = { answer: ans }
            hasMarks = true
          }
        } else if (value.trim()) {
          explicitKey = { answer: value.trim() }
        }
        break
      }
      if (markKey === null) deferred.push('the final answer for this problem was not determined')
      break
    }
    case 'matching':
    case 'connect': {
      body = stemText
      const perPair = Math.max(1, b.sectionPoints ?? 1)
      const table = b.tables[0]
      if (!table) {
        immediate.push('no table was found for this item')
        data = b.section === 'matching' ? { left: [], right: [] } : { prompts: [], answers: [] }
        tableKey = {}
        points = perPair
      } else {
        const parsed = parsePairTable(table, b.section)
        immediate.push(...parsed.warnings)
        const pairs = Object.keys(parsed.key).length
        points = pairs > 0 ? pairs * perPair : perPair
        data =
          b.section === 'matching'
            ? { left: parsed.left, right: parsed.right }
            : { prompts: parsed.left, answers: parsed.right }
        tableKey = parsed.key
      }
      break
    }
  }

  return {
    section: b.section,
    number: b.number,
    question: { type: b.section, body, points, data, key: null, sourceText },
    hasMarks,
    markKey,
    explicitKey,
    tableKey,
    immediate,
    deferred
  }
}

// --- key resolution -------------------------------------------------------

function matchQuestionStart(text: string): number | null {
  const m = text.match(/^\s*(?:Q\s*(\d+)\s*[.)]|(\d+)\s*[.)])\s*/i)
  if (!m) return null
  return Number(m[1] ?? m[2])
}

interface KeyEntry {
  type: QuestionType | null
  number: number
  value: string
}

function findKeyEntry(item: DraftItem, keyEntries: KeyEntry[]): string | null {
  const bySection = keyEntries.find((e) => e.type === item.section && e.number === item.number)
  if (bySection) return bySection.value
  const global = keyEntries.find((e) => e.type === null && e.number === item.number)
  return global ? global.value : null
}

function applyKeyEntry(item: DraftItem, entry: string): StoredKey | null {
  switch (item.section) {
    case 'mcq': {
      const letter = entry.trim().toLowerCase()
      const opt = (item.question.data.options ?? []).find((o) => o.id === letter)
      return opt ? opt.id : null
    }
    case 'tf': {
      const v = entry.trim().toLowerCase()
      return v === 'true' ? true : v === 'false' ? false : null
    }
    case 'identification': {
      const parts = splitAlternates(entry)
      return parts.length ? parts : null
    }
    case 'fillin': {
      const parts = splitList(entry)
      return parts.length ? parts.map((p) => [p]) : null
    }
    case 'enumeration': {
      const parts = splitList(entry)
      return parts.length ? parts : null
    }
    case 'problem': {
      const v = entry.trim()
      return v ? { answer: v } : null
    }
    default:
      return null
  }
}

/**
 * Parses ordered blocks into a draft quiz plus warnings. Pure: no file, no I/O.
 * The result uses the existing interchange shape, so it feeds the same
 * create-quiz path as a JSON import.
 */
export function parseBlocks(blocks: Block[], options: ParseOptions = {}): ParseResult {

  const markStyle = options.markStyle ?? 'auto'
  const mark = detectMark(blocks, markStyle === 'auto' ? null : markStyle)

  let title: string | null = null
  let firstNonEmpty: string | null = null
  let timeLimitSec: number | null = null
  let sectionType: QuestionType | null = null
  let sectionPoints: number | null = null
  let lastNumberInSection = 0
  let current: Builder | null = null
  const items: DraftItem[] = []
  const warnings: ParseWarning[] = []
  let mode: 'body' | 'key' = 'body'
  let keyType: QuestionType | null = null
  const keyEntries: KeyEntry[] = []

  const finalizeCurrent = (): void => {
    if (!current) return
    const item = finalize(current, mark)
    const index = items.length
    items.push(item)
    for (const msg of item.immediate) {
      warnings.push({ questionIndex: index, message: `${SECTION_LABELS[item.section]} ${item.number}: ${msg}` })
    }
    current = null
  }

  for (const block of blocks) {
    if (block.kind === 'table') {
      if (mode === 'body' && (sectionType === 'matching' || sectionType === 'connect')) {
        if (!current) {
          lastNumberInSection += 1
          current = { section: sectionType, sectionPoints, number: lastNumberInSection, lines: [], tables: [] }
        }
        current.tables.push(block)
      }
      continue
    }

    const text = runsText(block.runs)
    const trimmed = text.trim()
    if (!trimmed) continue
    const isHeading = block.heading !== undefined
    if (firstNonEmpty === null && !isMeta(trimmed)) firstNonEmpty = trimmed

    if (mode === 'body' && isAnswerKeyHeading(trimmed)) {
      finalizeCurrent()
      mode = 'key'
      continue
    }
    if (mode === 'key') {
      const km = trimmed.match(KEY_LINE)
      if (km) {
        keyEntries.push({ type: keyType, number: Number(km[1]), value: km[2].trim() })
        continue
      }
      const ksec = matchSection(trimmed)
      if (ksec) keyType = ksec.type
      continue
    }

    // body mode
    const tl = parseTimeLimit(trimmed)
    if (tl !== null) {
      timeLimitSec = tl
      continue
    }
    if (isMeta(trimmed)) continue

    // A section header may be a heading or a plain line; a line that looks like
    // a choice ("A. ...") inside a question is a choice, never a section header.
    const sec: SectionHit | null = isHeading || current === null || !CHOICE_START.test(trimmed) ? matchSection(trimmed) : null
    if (sec) {
      finalizeCurrent()
      sectionType = sec.type
      sectionPoints = sec.points
      lastNumberInSection = 0
      continue
    }

    if (title === null && isHeading && !QUESTION_START.test(trimmed)) {
      title = trimmed
      continue
    }

    const num = matchQuestionStart(trimmed)
    if (num !== null) {
      finalizeCurrent()
      if (sectionType === null) {
        warnings.push({ questionIndex: null, message: `a question appeared before any section header: "${trimmed}"` })
        continue
      }
      lastNumberInSection = num
      current = { section: sectionType, sectionPoints, number: num, lines: [{ runs: block.runs, text }], tables: [] }
      continue
    }

    if (current) {
      current.lines.push({ runs: block.runs, text })
      continue
    }

    if (sectionType) {
      warnings.push({ questionIndex: null, message: `${SECTION_LABELS[sectionType]}: unrecognized line "${trimmed}"` })
    }
  }
  finalizeCurrent()

  const questions: StoredQuestionInput[] = items.map((item) => ({ ...item.question }))
  items.forEach((item, index) => {
    const q = questions[index]
    if (item.section === 'matching' || item.section === 'connect') {
      q.key = item.tableKey ?? {}
      return
    }
    if (item.markKey !== null) {
      q.key = item.markKey
      return
    }
    if (!item.hasMarks) {
      const entry = findKeyEntry(item, keyEntries)
      const applied = entry === null ? null : applyKeyEntry(item, entry)
      if (applied !== null) {
        q.key = applied
        return
      }
      if (item.explicitKey !== null) {
        q.key = item.explicitKey
        return
      }
    }
    for (const msg of item.deferred) {
      warnings.push({ questionIndex: index, message: `${SECTION_LABELS[item.section]} ${item.number}: ${msg}` })
    }
  })

  const quiz: QuizImport = {
    title: title ?? firstNonEmpty ?? 'Untitled quiz',
    timeLimitSec: timeLimitSec ?? 5 * 60,
    questions
  }
  return { quiz, warnings }
}
