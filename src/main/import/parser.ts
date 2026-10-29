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
/** A whole answer-key line that packs several "N. X" tokens, e.g. "1. B 2. C 3. A". */
const COMPACT_KEY_LINE = /^\s*\d+\s*[.:]\s*\S+(?:\s+\d+\s*[.:]\s*\S+)+\s*$/u
/** One "N. X" token inside a compact answer-key line. */
const KEY_TOKEN = /(\d+)\s*[.:]\s*(\S+)/g

const TIME_LIMIT_RE = /^time\s+limit\b\s*[:\-]?\s*(\d+)\s*(minutes?|mins?|seconds?|secs?)/i

/**
 * The form fields a paper carries: "Name:", "Date:", "Instructions:".
 *
 * The keyword has to be the whole word and be followed by a colon, or the
 * line is a sentence: "Names are always numbers" is a choice in a question
 * about databases, not a form field.
 */
const META_RE =
  /^(?:time\s+limit|general\s+instructions?|name|section|date|score|instructions?|directions?|general)\b\s*(?:[:\-]|$)/i

/**
 * A stem in a printed exam: no number and no letter, but it asks something.
 *
 * Printed exam papers often leave the numbering out and print the question on
 * a line of its own with the choices under it, so the shape has to be found
 * rather than a marker. A question mark at the end of the line is the signal
 * that works: choices rarely end with one.
 */
const PLAIN_STEM = /\?\s*$/u

/**
 * A stem that ends with a colon: "These listed system needs are examples of:".
 *
 * It has to be a sentence, not a label, so that "Date:" or "Name:" - which the
 * paper uses for its own form fields - are not mistaken for a question.
 */
const PLAIN_STEM_COLON = /:\s*$/u
const PLAIN_STEM_MIN_LEN = 25

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

/**
 * Section names, matched at the start of the line.
 *
 * They are anchored on purpose. An unanchored "connect" matched "A connection
 * between two tables", which is a choice in an exam, and turned the rest of
 * the paper into a connect section.
 */
const SECTION_PATTERNS: { type: QuestionType; patterns: RegExp[] }[] = [
  { type: 'mcq', patterns: [/(?:^|\s)(multiple[-\s\u2013\u2014]*choice|mcq|objective(?:\s*type)?|selected\s*response)(?:\s|$)/i] },
  { type: 'tf', patterns: [/(?:^|\s)(true\s*or\s*false|true\s*\/\s*false|true\s+false|t\s*\/\s*f|boolean)(?:\s|$)/i] },
  { type: 'identification', patterns: [/(?:^|\s)(identification|identify|short\s*answers?)(?:\s|$)/i] },
  { type: 'fillin', patterns: [/(?:^|\s)(fill\s*in\s*the\s*blanks?|fill\s*up|cloze|completion)(?:\s|$)/i] },
  { type: 'enumeration', patterns: [/(?:^|\s)(enumeration|enumerate)(?:\s|$)/i] },
  { type: 'problem', patterns: [/(?:^|\s)(problem\s*solving|problems?|solve|computation|calculation)(?:\s|$)/i] },
  { type: 'matching', patterns: [/(?:^|\s)(matching|match\s+the\s+following|column\s*[ab])(?:\s|$)/i] },
  { type: 'connect', patterns: [/(?:^|\s)(connect|pairing|associate)(?:\s|$)/i] },
  { type: 'connect', patterns: [/(?:^|\s)(activity|exercise)(?:\s|$)/i] }
]

/** A section header is short. A long line is a sentence, not a header. */
const SECTION_MAX_LEN = 60

/** A roman-numeral section header ("V. Enumeration") starts with a single-letter
 * choice-looking token only when it is a one-letter roman (I. or V. or X.), so
 * such headers must not be mistaken for "A. ..." choices mid-question. */
const ROMAN_PREFIX = /^\s*[IVXivx]+\s*[.)]\s+/u

interface SectionHit {
  type: QuestionType
  points: number | null
}

/** Recognises a section header ("I. Multiple Choice (2 points each)"). */
function matchSection(raw: string, isHeading = false): SectionHit | null {
  if (/^multiple[-\s]*choice/i.test(raw.trim())) return { type: 'mcq', points: null }
  if (/^column\s+[ab]$/i.test(raw.trim())) return null
  if (PLAIN_STEM.test(raw)) return null // a question is not a header either
  let t = raw.trim()
  let hadPrefix = false
  // Roman numeral prefix: I., II., V., X.
  if (/^[IVXLCivxlc]{1,6}\s*[.)]\s*/u.test(t)) { hadPrefix = true; t = t.replace(/^[IVXLCivxlc]{1,6}\s*[.)]\s*/u, '') }
  // Letter prefix: A., B:
  if (/^[A-Za-z]\s*[.)]\s*/u.test(t)) { hadPrefix = true; t = t.replace(/^[A-Za-z]\s*[.)]\s*/u, '') }
  // Part / Section / Activity / Exercise / Chapter / Unit / Module / Topic / Group
  if (/^(?:part|section|activity|exercise|chapter|unit|module|topic|group)\s+[A-Za-z0-9IVXLC]+\s*[:\-]?\s*/i.test(t)) {
    hadPrefix = true
    t = t.replace(/^(?:part|section|activity|exercise|chapter|unit|module|topic|group)\s+[A-Za-z0-9IVXLC]+\s*[:\-]?\s*/i, '')
  }
  if (/^(?:part|section|activity|exercise|chapter|unit|module|topic|group)\s*[:\-]\s*/i.test(t)) {
    hadPrefix = true
    t = t.replace(/^(?:part|section|activity|exercise|chapter|unit|module|topic|group)\s*[:\-]\s*/i, '')
  }
  const points = t.match(POINTS_RE)
  const name = t.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  if (!name) return null
  const compact = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const header = isHeading || hadPrefix
  // A header-like line carries only header vocabulary; sentences (choices) do not.
  const headerWords = new Set(['multiple','choice','mcq','objective','type','selected','response','true','false','or','boolean','identification','identify','short','answer','answers','fill','in','the','blank','blanks','fillup','cloze','completion','enumeration','enumerate','problem','problems','solve','solving','computation','calculation','matching','match','following','column','a','b','connect','pairing','associate','activity','exercise','questions','question','quiz','exam','test','section','part','items','item'])
  const tokens = compact.split(/\s+/).filter(Boolean)
  const headerLike = tokens.length > 0 && tokens.every((tok) => headerWords.has(tok) || /^\d+$/.test(tok))
  for (const s of SECTION_PATTERNS) {
    if (!s.patterns.some((p) => p.test(compact))) continue
    if (!isHeading && name.length > SECTION_MAX_LEN) continue
    if (s.type === 'tf' && !header) continue
    // Sentences that happen to contain a keyword are not headers unless they are
    // headings, prefixed, all caps, or made only of header words.
    if (!header && !isAllCaps(raw) && !headerLike) continue
    return { type: s.type, points: points ? Number(points[1]) : null }
  }
  return null
}

/** True when the line is written in capitals, the way a header is. */
function isAllCaps(text: string): boolean {
  const letters = text.replace(/[^A-Za-z]/g, '')
  return letters.length > 0 && letters === letters.toUpperCase()
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
 * Whether a line is the stem of a question in a printed exam.
 *
 * It must not carry a number or a choice letter - those are handled
 * elsewhere - and it has to end with a question mark, which is what
 * separates a question from the choices under it.
 */
function isPlainStem(text: string): boolean {
  if (QUESTION_START.test(text) || CHOICE_START.test(text)) return false
  if (ANSWER_LINE.test(text)) return false
  if (PLAIN_STEM.test(text)) return true
  return PLAIN_STEM_COLON.test(text) && text.length >= PLAIN_STEM_MIN_LEN
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
  const lower = cells.map((c) => c.toLowerCase())
  if (lower.length >= 3) {
    const mid = lower[1] ?? ''
    const first = (lower[0] ?? '').replace(/[^a-z]/g, '')
    if (mid.includes('answer') || mid.includes('connect') || first === 'columna') return true
  }
  const norm = lower.map((c) => c.replace(/[^a-z]/g, ''))
  const headerWords = new Set(['left', 'right', 'columna', 'columnb', 'prompt', 'prompts', 'answer', 'answers', 'match', 'matches', 'connect', 'item', 'items', 'question', 'response', 'pair', 'pairs'])
  const nonEmpty = norm.filter((c) => c.length > 0)
  return nonEmpty.length > 0 && nonEmpty.every((c) => headerWords.has(c))
}

const RIGHT_LABEL = /^\(?([A-Za-z])\)?\s*[.)]\s+/

/**
 * Strips a choice label ("A.", "1)", "(B)") and returns the letter or digit,
 * or null when the cell carries no label. Digits count positionally too, so
 * "1. Rome" in a table whose right column reads 1, 2, 3 can be matched by a
 * middle-column "2".
 */
function rightCellLabel(text: string): string | null {
  const stripped = text.trim().replace(/^\(([^)]*)\)\s*/, '$1 ').trim()
  const m = stripped.match(/^([A-Za-z0-9])\s*[.)]\s+/)
  if (m) return (m[1] ?? '').toUpperCase()
  // Bare "C" / "2" in the middle column names the item with no trailing mark.
  const bare = stripped.match(/^([A-Za-z0-9])$/)
  return bare ? (bare[1] ?? '').toUpperCase() : null
}

/** Pair-wise binding when the middle column names a right item verbatim. */
function verbatimIndex(rightTexts: string[], mid: string): number {
  const want = mid.trim().toLowerCase()
  if (!want) return -1
  return rightTexts.findIndex((t) => t.trim().toLowerCase() === want)
}

interface PairTable {
  left: Choice[]
  right: Choice[]
  key: Record<string, string>
  warnings: string[]
  /** Source question numbers for each left item (line-based matching only). */
  leftNumbers?: number[]
  /** The letter id of each right item (line-based matching only). */
  rightLetters?: string[]
}

/**
 * Reads a pair table in either shape: three columns (Column A, letter in the
 * middle, Column B) or two plain columns where each row is already a pair.
 * Rows with an empty Column A are decoys. The middle column can name the
 * right item by letter ("B", "b.", "(A)"), by number ("2"), or verbatim
 * ("Paris"), so imports do not force letter-prefixed right cells.
 */
function parsePairTable(table: Table, type: QuestionType): PairTable {
  const leftName = type === 'matching' ? 'l' : 'p'
  const rightName = type === 'matching' ? 'r' : 'a'
  const warnings: string[] = []
  const rows = table.rows
  if (rows.length === 0) {
    return { left: [], right: [], key: {}, warnings: ['the table has no rows'] }
  }
  const first = rows[0].map(cellText)
  const start = rows.length > 1 && isHeaderRow(first) ? 1 : 0
  const colCount = Math.max(...rows.slice(start).map((r) => r.length), 0)

  // Two columns: every row is already a pair, no letters needed.
  if (colCount <= 2) {
    const left: Choice[] = []
    const right: Choice[] = []
    const key: Record<string, string> = {}
    for (let i = start; i < rows.length; i++) {
      const cells = rows[i].map(cellText)
      const a = cells[0] ?? ''
      const b = cells[1] ?? ''
      if (!a && !b) continue
      if (!a || !b) {
        if (a) left.push({ id: `${leftName}${left.length + 1}`, text: a })
        warnings.push(`row ${i - start + 1} has a left item but no right item`)
        continue
      }
      left.push({ id: `${leftName}${left.length + 1}`, text: a })
      right.push({ id: `${rightName}${right.length + 1}`, text: b })
      key[left[left.length - 1].id] = right[right.length - 1].id
    }
    if (left.length === 0 && right.length === 0) warnings.push('the table has no rows')
    if (right.length === 0 && left.length > 0) warnings.push('the table has no right items')
    return { left, right, key, warnings }
  }

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
  // Digits can also label the right column ("1. Rome"); they count the same
  // positionally, so a middle-column "2" picks the second right item.
  const digitLabels = rightRaw.map((t, i) => {
    const m = t.trim().match(/^\(?([0-9]{1,2})\)?\s*[.)]\s+/)
    return m ? Number(m[1]) : i + 1
  })

  const left: Choice[] = leftRaw.map((text, i) => ({ id: `${leftName}${i + 1}`, text }))
  const right: Choice[] = rightTexts.map((text, i) => ({ id: `${rightName}${i + 1}`, text }))
  const key: Record<string, string> = {}
  const used = new Set<string>()
  for (const p of pairs) {
    // A middle cell can name the right item three ways: letter ("B", "(A)"),
    // number ("2"), or the verbatim right text ("Paris"). First unused wins.
    const label = rightCellLabel(`${p.mid} `)
    const num = /^\d{1,2}$/.test(p.mid.trim()) ? Number(p.mid.trim()) : -1
    let target = -1
    if (label) target = labels.findIndex((lab, i) => lab === label && !used.has(right[i].id))
    if (target < 0 && num > 0) {
      target = digitLabels.findIndex((n, i) => n === num && !used.has(right[i].id))
    }
    if (target < 0 && p.mid) {
      const vi = verbatimIndex(rightTexts, p.mid)
      if (vi >= 0 && !used.has(right[vi].id)) target = vi
    }
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

// --- line-based matching (PDFs give lines, not tables) -----------------------

/**
 * A matching row printed on one line: "____ 38. Wegener A. World-systems..."
 * or, without the answer box, "38. Wegener A. World-systems...".
 * The left number runs first; the right item is a single letter followed by a dot.
 */
const MATCHING_ROW = /^\s*(?:_{2,}\s*)?(\d+)\.\s+(.+?)\s+([A-H])\.\s+(.+)$/su
/** A right-column label on its own line, e.g. "G. Population grows geometrically". */
const RIGHT_LABEL_LINE = /^\s*([A-H])\.\s+(.+)$/su

/**
 * Rebuilds a matching pair table from the paragraph lines of a matching section
 * that came through as text (typically a PDF), since PDFs do not yield table
 * blocks. Returns the left/right items plus the letter and number each was
 * aligned with, so the answer key can supply the mapping.
 */
function parseMatchingFromLines(lines: Line[]): PairTable | null {
  const left: Choice[] = []
  const leftNumbers: number[] = []
  const rightByLetter = new Map<string, { id: string; text: string }>()
  const rightOrder: string[] = []
  let lastName = ''
  let lastLetter: string | null = null

  const addRight = (letter: string, text: string): void => {
    if (!rightByLetter.has(letter)) {
      rightByLetter.set(letter, { id: `r${rightByLetter.size + 1}`, text })
      rightOrder.push(letter)
    } else if (text.trim()) {
      rightByLetter.get(letter)!.text += ' ' + text.trim()
    }
    lastLetter = letter
  }

  for (const line of lines) {
    const t = line.text.trim()
    if (!t) continue
    const row = t.match(MATCHING_ROW)
    if (row) {
      left.push({ id: `l${left.length + 1}`, text: row[2]!.trim() })
      leftNumbers.push(Number(row[1]))
      addRight((row[3] ?? '').toUpperCase(), (row[4] ?? '').trim())
    } else {
      const lab = t.match(RIGHT_LABEL_LINE)
      if (lab) {
        addRight((lab[1] ?? '').toUpperCase(), (lab[2] ?? '').trim())
    } else if (lastLetter && /\S/.test(t) && !/\bpage\s*\d+\b/i.test(t)) {
      // A wrapped continuation of the previous right item. Page markers and the
      // exam title are skipped here so they do not pollute a right item.
      rightByLetter.get(lastLetter)!.text += ' ' + t
    }
      // Directive / "Column A Column B" / page markers carry no pairs and are
      // left where they are; they simply do not add an item here.
    }
  }

  if (left.length === 0) return null
  const right = rightOrder.map((letter) => rightByLetter.get(letter)!)
  const rightLetters = rightOrder
  const key: Record<string, string> = {}
  return { left, right, key, warnings: [], leftNumbers, rightLetters }
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
  /**
   * True when the question was found by its shape (a printed exam with no
   * numbering) instead of by a number. Such a question takes the lines under
   * it as its choices, letters or not.
   */
  plain: boolean
}

interface DraftItem {
  section: QuestionType
  number: number
  question: StoredQuestionInput
  hasMarks: boolean
  markKey: StoredKey | null
  explicitKey: StoredKey | null
  tableKey: Record<string, string> | null
  /** Line-derived matching pairs need their source numbers/letters at key time. */
  matchLeftNumbers: number[]
  matchRightLetters: string[]
  /** Structural problems, always reported (missing count, missing table). */
  immediate: string[]
  /** Answer-not-determined problems, reported only if the key stays empty. */
  deferred: string[]
  /**
   * The key could not be read. Reported per question, unless the whole file
   * has no keys at all - then one summary says so instead.
   */
  missingKey: string[]
}

/** The first letter not used yet, so choices keep their order without letters. */
function nextChoiceId(options: Choice[]): string {
  const used = new Set(options.map((o) => o.id))
  for (let i = 0; i < 26; i++) {
    const id = String.fromCharCode(97 + i)
    if (!used.has(id)) return id
  }
  return `o${options.length}`
}

/**
 * The correct choice named on an "Answer:" line under the question.
 *
 * The value is normally the letter of the choice ("Answer: B"), but the text
 * of the choice is accepted too ("Answer: To store, organize, access...").
 */
function findExplicitChoice(lines: Line[], options: Choice[]): string | null {
  for (const line of lines) {
    const fa = findAnswer(line.text)
    if (!fa) continue
    const value = line.text.slice(fa.valueStart).trim().replace(/[.;,]\s*$/u, '')
    if (!value) continue
    const letter = value.toLowerCase()
    const byLetter = options.find((o) => o.id === letter)
    if (byLetter) return byLetter.id
    const byText = options.find(
      (o) => o.text.trim().toLowerCase() === value.toLowerCase()
    )
    if (byText) return byText.id
  }
  return null
}

/** Turns one finished question (its lines + optional table) into a draft item. */
function finalize(b: Builder, mark: ResolvedMark): DraftItem {
  const immediate: string[] = []
  const deferred: string[] = []
  const missingKey: string[] = []
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
  let matchLeftNumbers: number[] = []
  let matchRightLetters: string[] = []

  switch (b.section) {
    case 'mcq': {
      body = stemText
      const options: Choice[] = []
      const marked: number[] = []
      for (const line of others) {
        // "Answer: B" is the key, never a choice.
        if (ANSWER_LINE.test(line.text)) continue
        const cm = line.text.match(CHOICE_START)
        if (!cm && !b.plain) continue
        const runs = cm ? stripPrefixRuns(line.runs, CHOICE_START) : line.runs
        const text = runsText(runs).trim()
        if (!text) continue
        // A printed exam leaves the letters out; the ones that are printed
        // still win, so a paper that mixes both reads right.
        let id = cm ? (cm[1] ?? '').toLowerCase() : ''
        if (!id || options.some((o) => o.id === id)) id = nextChoiceId(options)
        options.push({ id, text })
        if (markedRange(charsOf(runs, mark))) marked.push(options.length - 1)
      }
      data = { options }
      hasMarks = marked.length > 0
      if (marked.length === 1) markKey = options[marked[0]].id
      else if (marked.length >= 2)
        deferred.push('two or more choices are marked, so the correct answer was left blank')
      else {
        // "Answer: B" under the question names the correct choice.
        const answer = findExplicitChoice(b.lines, options)
        if (answer) {
          explicitKey = answer
        } else {
          missingKey.push('no choice is marked as the correct answer')
        }
      }
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
        if (bothMarked) {
          deferred.push('both True and False are marked, so the answer was left blank')
        } else {
          missingKey.push('the correct answer (True or False) was not determined')
        }
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
      if (markKey === null) missingKey.push('the accepted answer for this item was not determined')
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
        if (markKey === null) missingKey.push('the answers for the blanks were not determined')
      }
      data = { blanks: countBlanks(body) }
      break
    }
    case 'enumeration': {
      body = stemText
      const countMatch = stemText.match(COUNT_RE)
      const count = countMatch ? Number(countMatch[1]) : 0
      // A missing count is not fatal here: a printed exam may say "List four"
      // in words, and the answer key below can still supply the item count.
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
      if (markKey === null) missingKey.push('the accepted items for this enumeration were not determined')
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
      if (markKey === null) missingKey.push('the final answer for this problem was not determined')
      break
    }
    case 'matching':
    case 'connect': {
      body = stemText
      const perPair = Math.max(1, b.sectionPoints ?? 1)
      const table = b.tables[0]
      if (table) {
        const parsed = parsePairTable(table, b.section)
        immediate.push(...parsed.warnings)
        const pairs = Object.keys(parsed.key).length
        points = pairs > 0 ? pairs * perPair : perPair
        data =
          b.section === 'matching'
            ? { left: parsed.left, right: parsed.right }
            : { prompts: parsed.left, answers: parsed.right }
        tableKey = parsed.key
      } else if (b.section === 'matching') {
        // No table block (e.g. a PDF that only yields lines): rebuild the pair
        // table from the section's paragraph lines. The answer key supplies the
        // mapping, so the key starts empty and is filled in during resolution.
        const ml = parseMatchingFromLines(b.lines)
        if (ml) {
          const left = ml.left
          const right = ml.right
          data = { left, right }
          tableKey = {}
          matchLeftNumbers = ml.leftNumbers ?? []
          matchRightLetters = ml.rightLetters ?? []
          points = Math.max(1, (matchLeftNumbers.length || 1) * perPair)
        } else {
          immediate.push('no table was found for this item')
          data = { left: [], right: [] }
          tableKey = {}
          points = perPair
        }
      } else {
        // connect without a table: the answer key may still name the pairs.
        const prompts = []
        const answers = []
        let side = 'left'
        const letters = 'abcdefghijklmnopqrstuvwxyz'
        for (const ln of b.lines) {
          const t = ln.text.trim()
          if (!t) continue
          if (/^column\s*a\b/i.test(t)) { side = 'left'; continue }
          if (/^column\s*b\b/i.test(t)) { side = 'right'; continue }
          const leftMatch = t.match(/^(\d+)\.\s*(.+)$/)
          if (leftMatch && side === 'left' && !/connect each/i.test(t)) {
            prompts.push({ id: 'p' + (prompts.length + 1), text: leftMatch[2].trim() })
            continue
          }
          const rightMatch = t.match(/^([a-z])\.\s*(.+)$/i)
          if (rightMatch && side === 'right') {
            answers.push({ id: letters[answers.length] || ('a' + (answers.length + 1)), text: rightMatch[2].trim() })
            continue
          }
        }
        data = { prompts, answers }
        tableKey = {}
        points = perPair
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
    deferred,
    missingKey,
    matchLeftNumbers,
    matchRightLetters
  }
}

// --- key resolution -------------------------------------------------------

/** Matches the leading "1." / "Q12." number of a question, without trailing space. */
const QSTART_PREFIX = /^\s*(?:(?:q(?:uestion)?|item|no\.?)\s*(\d+)\s*[.):\-]|(\d+)\s*[.):\-])/i

/**
 * The number and kind of the question a line starts, or null when the line is
 * not a question start.
 *
 * A line that only holds a number followed by blank space ("6.5°C per 1,000 m")
 * is a fragment of the previous question's text, not a new question; a line
 * that is a number followed by nothing but underscores and dashes ("1. ____")
 * is an answer box the student writes in, not a question either. Both would
 * otherwise match the number prefix above, so they are rejected here.
 */
/**
 * The number and kind of the question a line starts, or null when the line is
 * not a question start.
 *
 * A line that only holds a number followed by blank space ("6.5°C per 1,000 m")
 * is a fragment of the previous question's text, not a new question; a line
 * that is a number followed by nothing but underscores and dashes ("1. ____")
 * is an answer box the student writes in, not a question either. Both would
 * otherwise match the number prefix above, so they are rejected here.
 */
function matchQuestionStart(text: string): number | null {
  const m = text.match(QSTART_PREFIX)
  if (!m) return null
  const after = text.slice(m[0].length)
  if (/^\d/u.test(after)) return null
  const rest = after.trim()
  if (rest === '' || /^[._\-– —]*$/u.test(rest)) return null
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
      const m = v.match(/^(true|false)\b/)
      return m ? m[1] === 'true' : null
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
  let previousWasMeta = false

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
          current = { section: sectionType, sectionPoints, number: lastNumberInSection, lines: [], tables: [], plain: false }
        }
        current.tables.push(block)
      }
      continue
    }

    const text = runsText(block.runs)
    const trimmed = text.trim()
    if (!trimmed) continue
    const isHeading = block.heading !== undefined
    const pageMarked = /^.+\s*[|\-]\s*page\s*\d+\s*$/i.test(trimmed)
    if (firstNonEmpty === null && !isMeta(trimmed) && !pageMarked &&
        !QUESTION_START.test(trimmed) && !CHOICE_START.test(trimmed) &&
        !ANSWER_LINE.test(trimmed) && !TF_INLINE.test(trimmed) &&
        matchSection(trimmed, isHeading) === null) {
      firstNonEmpty = trimmed.replace(/\s*[|\-]\s*page\s*\d+\s*$/i, '').trim()
    }

    if (mode === 'body' && isAnswerKeyHeading(trimmed)) {
      finalizeCurrent()
      mode = 'key'
      continue
    }
    if (mode === 'key') {
      const km = trimmed.match(KEY_LINE)
      if (km) {
        // A compact one-line answer key: "1. B 2. C 3. A ..." packs several
        // answers onto one line instead of one-per-line.
        if (COMPACT_KEY_LINE.test(trimmed)) {
          for (const m of trimmed.matchAll(KEY_TOKEN)) {
            keyEntries.push({ type: keyType, number: Number(m[1]), value: (m[2] ?? '').trim() })
          }
          continue
        }
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
    if (isMeta(trimmed)) { previousWasMeta = true; continue }
    // A line that directly follows an instruction/form-field line and is
    // not itself a question, choice, section header or answer key is a
    // continuation of that instruction ("worth 1 point."). Skip it so it
    // does not become an unrecognized line or a stray choice.
    if (previousWasMeta && !QUESTION_START.test(trimmed) && !CHOICE_START.test(trimmed) &&
        matchSection(trimmed, isHeading) === null && !isAnswerKeyHeading(trimmed)) {
      previousWasMeta = true
      continue
    }
    previousWasMeta = false

    // A section header may be a heading or a plain line; a line that looks like
    // a choice ("A. ...") inside a question is a choice, never a section header.
    // Inside a printed question the choices have no letters, so only a real
    // header - a heading, or a line in capitals - can end the question.
    const insidePlain: boolean = current !== null && current.plain
    const headerish = isHeading || (isAllCaps(trimmed) && trimmed.length <= SECTION_MAX_LEN)
    const isRomanHeader = ROMAN_PREFIX.test(trimmed)
    const sec: SectionHit | null =
      (!insidePlain || headerish) &&
      (isHeading || current === null || !CHOICE_START.test(trimmed) || isRomanHeader)
        ? matchSection(trimmed, headerish)
        : null
    if (sec) {
      finalizeCurrent()
      sectionType = sec.type
      sectionPoints = sec.points
      lastNumberInSection = 0
      // A matching section is a single question (with several pairs) even when
      // it is printed as lines without table blocks, so open it here and let the
      // rows attach to it. docx tables still append to this same question below.
      if (sec.type === 'matching') {
        current = {
          section: 'matching',
          sectionPoints,
          number: 1,
          lines: [],
          tables: [],
          plain: false
        }
      }
      continue
    }

    if (title === null && !QUESTION_START.test(trimmed) && !CHOICE_START.test(trimmed) &&
        matchSection(trimmed, isHeading) === null && !isMeta(trimmed) &&
        (isHeading || isAllCaps(trimmed)) && trimmed.length <= 80) {
      title = trimmed
      continue
    }

    const num = matchQuestionStart(trimmed)
    if ((sectionType === 'connect' || sectionType === 'matching') && current &&
        !/\?/.test(trimmed) && !/(?:connect|match|pair)/i.test(trimmed)) {
      current.lines.push({ runs: block.runs, text })
      continue
    }
    if (num !== null) {
      finalizeCurrent()
      if (sectionType === null) {
        warnings.push({ questionIndex: null, message: `a question appeared before any section header: "${trimmed}"` })
        continue
      }
      lastNumberInSection = num
      current = {
        section: sectionType,
        sectionPoints,
        number: num,
        lines: [{ runs: block.runs, text }],
        tables: [],
        plain: false
      }
      continue
    }

    // A printed exam may leave the numbering out: the question is the line
    // that asks something and the choices are the lines under it. Only a
    // question that was itself found this way can be followed by another one,
    // so a choice is never mistaken for the next question.
    if (isPlainStem(trimmed) && (current === null || current.plain)) {
      finalizeCurrent()
      // Without a section header a stem with choices under it is a multiple
      // choice question, which is what a printed exam is.
      const section = sectionType ?? 'mcq'
      lastNumberInSection += 1
      current = {
        section,
        sectionPoints,
        number: lastNumberInSection,
        lines: [{ runs: block.runs, text }],
        tables: [],
        plain: true
      }
      continue
    }

    if (current) {
      current.lines.push({ runs: block.runs, text })
      continue
    }

    // A direction line right under a section header ("(2 points each)") sets
    // the per-question default for the section and is otherwise skipped.
    if (sectionType !== null) {
      const pm = trimmed.match(POINTS_RE)
      if (pm) {
        sectionPoints = Number(pm[1])
        continue
      }
    }

    if (sectionType) {
      warnings.push({ questionIndex: null, message: `${SECTION_LABELS[sectionType]}: unrecognized line "${trimmed}"` })
    }
  }
  finalizeCurrent()

  const questions: StoredQuestionInput[] = items.map((item) => ({ ...item.question }))
  const keyed: boolean[] = items.map(() => false)
  items.forEach((item, index) => {
    const q = questions[index]
    if (item.section === 'matching' || item.section === 'connect') {
      const tk = item.tableKey ?? {}
      if (Object.keys(tk).length > 0) {
        q.key = tk
        keyed[index] = true
        return
      }
      // No table pairs (a PDF that only yielded lines): let the answer key name
      // them. Matching rows are numbered, so each left item is matched by its
      // source number and the right item by its letter; connect rows are each
      // their own question, so they match by question number.
      if (item.section === 'matching' && item.matchLeftNumbers.length > 0) {
        const leftChoices = (q.data.left as Choice[] | undefined) ?? []
        const rightChoices = (q.data.right as Choice[] | undefined) ?? []
        const mk: Record<string, string> = {}
        for (const e of keyEntries) {
          if (e.type !== 'matching') continue
          const li = item.matchLeftNumbers.indexOf(e.number)
          const ri = item.matchRightLetters.indexOf(e.value.trim().toUpperCase())
          if (li >= 0 && ri >= 0 && leftChoices[li] && rightChoices[ri]) {
            mk[leftChoices[li].id] = rightChoices[ri].id
          }
        }
        q.key = mk
        keyed[index] = Object.keys(mk).length > 0
        if (!keyed[index]) item.immediate.push('the matching pairs were not found in the answer key')
        return
      }
      if (item.section === 'connect') {
        const entry = keyEntries.find((e) => e.type === 'connect' && e.number === item.number)
        if (entry) {
          const parts = entry.value.split(/ - /)
          if (parts.length >= 2 && parts[0]!.trim() && parts[1]!.trim()) {
            q.data = { prompts: [{ id: 'p1', text: parts[0]!.trim() }], answers: [{ id: 'a1', text: parts.slice(1).join(' - ').trim() }] }
            q.key = { p1: 'a1' }
            keyed[index] = true
            return
          }
        }
        item.immediate.push('no table was found for this item')
        q.key = {}
        return
      }
      q.key = {}
      return
    }
    if (item.markKey !== null) {
      q.key = item.markKey
      keyed[index] = true
      return
    }
    if (!item.hasMarks) {
      const entry = findKeyEntry(item, keyEntries)
      const applied = entry === null ? null : applyKeyEntry(item, entry)
      if (applied !== null) {
        q.key = applied
        keyed[index] = true
        if (item.section === 'enumeration') {
          const d = q.data as { count?: number }
          if (typeof d.count === 'number' && d.count === 0 && Array.isArray(applied)) {
            d.count = applied.length
          }
        }
        return
      }
      if (item.explicitKey !== null) {
        q.key = item.explicitKey
        keyed[index] = true
        return
      }
    }
    q.key = null
  })

  // A file with no answer key at all is a printed exam waiting for its keys.
  // Saying that once is enough; repeating it per question would bury the
  // questions that did come out right.
  const noKeysAnywhere = items.length > 0 && !keyed.some(Boolean)
  items.forEach((item, index) => {
    for (const msg of item.deferred) {
      warnings.push({ questionIndex: index, message: `${SECTION_LABELS[item.section]} ${item.number}: ${msg}` })
    }
  })
  if (noKeysAnywhere) {
    const anyMarks = items.some((item) => item.hasMarks)
    warnings.push({
      questionIndex: null,
      message: anyMarks
        ? `The correct answer was not determined for any of the ${items.length} questions, so they were imported without a key. ` +
          'Set the correct answer in the editor before running the quiz.'
        : `This file holds no answer keys, so the correct answer was not determined for any of the ${items.length} questions. ` +
          'They were imported without one - set the correct answer in the editor before running the quiz.'
    })
  } else {
    items.forEach((item, index) => {
      for (const msg of item.missingKey) {
        warnings.push({ questionIndex: index, message: `${SECTION_LABELS[item.section]} ${item.number}: ${msg}` })
      }
    })
  }

  const quiz: QuizImport = {
    title: title ?? firstNonEmpty ?? 'Untitled quiz',
    timeLimitSec: timeLimitSec ?? 5 * 60,
    questions
  }
  return { quiz, warnings }
}
