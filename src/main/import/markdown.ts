/**
 * Markdown extractor: headings, paragraphs and pipe tables become the same
 * neutral blocks the docx reader produces. `**bold**`, `<u>underline</u>`,
 * `==highlight==` and `<mark>` all count as marks.
 */
import type { Block, Cell, Run } from './types'
import { makeRun, runsText, tidyRuns } from './types'

/** Parses inline marks into runs; unmatched markers stay literal text. */
export function parseInline(text: string): Run[] {
  const runs: Run[] = []
  let plain = ''
  const flush = (): void => {
    if (plain) {
      runs.push(makeRun(plain))
      plain = ''
    }
  }
  let i = 0
  while (i < text.length) {
    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2)
      if (end > i + 1) {
        flush()
        runs.push(makeRun(text.slice(i + 2, end), { bold: true }))
        i = end + 2
        continue
      }
    }
    if (text.startsWith('==', i)) {
      const end = text.indexOf('==', i + 2)
      if (end > i + 1) {
        flush()
        runs.push(makeRun(text.slice(i + 2, end), { highlight: true }))
        i = end + 2
        continue
      }
    }
    if (text[i] === '<') {
      const open = /^<(u|mark)\b[^>]*>/i.exec(text.slice(i))
      if (open) {
        const tag = open[1].toLowerCase()
        const close = `</${tag}>`
        const end = text.toLowerCase().indexOf(close, i + open[0].length)
        if (end > -1) {
          flush()
          const inner = text.slice(i + open[0].length, end)
          runs.push(makeRun(inner, tag === 'u' ? { underline: true } : { highlight: true }))
          i = end + close.length
          continue
        }
      }
    }
    plain += text[i]
    i++
  }
  flush()
  return tidyRuns(runs)
}

function splitTableRow(line: string): Cell[] {
  const raw = line.split('|')
  if (raw.length >= 2) {
    if (raw[0].trim() === '') raw.shift()
    if (raw.length > 0 && raw[raw.length - 1].trim() === '') raw.pop()
  }
  return raw.map((cell) => ({ runs: parseInline(cell.trim()) }))
}

function isSeparatorRow(cells: Cell[]): boolean {
  const texts = cells.map((c) => runsText(c.runs))
  return texts.length > 0 && texts.every((t) => /^[-:\s]*$/.test(t)) && texts.some((t) => t.includes('-'))
}

/** Reads Markdown text into ordered blocks (one paragraph per non-empty line). */
export function extractMarkdown(text: string): Block[] {
  const lines = text.split(/\r\n|\r|\n/)
  const blocks: Block[] = []
  let rows: Cell[][] | null = null
  const flushTable = (): void => {
    if (rows && rows.length > 0) blocks.push({ kind: 'table', rows })
    rows = null
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line === '') {
      flushTable()
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushTable()
      blocks.push({ kind: 'paragraph', heading: heading[1].length, runs: parseInline(heading[2].trim()) })
      continue
    }
    if (line.includes('|')) {
      const cells = splitTableRow(line)
      if (cells.length <= 1) {
        flushTable()
        blocks.push({ kind: 'paragraph', runs: parseInline(line) })
        continue
      }
      if (isSeparatorRow(cells)) continue // the header/data divider
      if (!rows) rows = []
      rows.push(cells)
      continue
    }
    if (/^\s*[-*_]{3,}\s*$/.test(line)) {
      flushTable() // horizontal rule
      continue
    }
    flushTable()
    blocks.push({ kind: 'paragraph', runs: parseInline(line) })
  }
  flushTable()
  return blocks
}
