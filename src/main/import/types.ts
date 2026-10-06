/**
 * The neutral intermediate form both extractors produce and the shared parser
 * consumes. Blocks appear in document order and are either a paragraph of runs
 * or a table of run-cells; a heading is a paragraph that carries a level. The
 * parser never sees a file, only this shape.
 */

/** One formatted span of text. The three flags are the marks importers carry. */
export interface Run {
  text: string
  bold: boolean
  underline: boolean
  highlight: boolean
}

/** A table cell: a list of runs, exactly like a paragraph's content. */
export interface Cell {
  runs: Run[]
}

export interface Paragraph {
  kind: 'paragraph'
  /** Heading level 1..9 when this paragraph is a title/section heading. */
  heading?: number
  runs: Run[]
}

export interface Table {
  kind: 'table'
  /** Row 0 is the column-header row; every row is a list of cells. */
  rows: Cell[][]
}

export type Block = Paragraph | Table

/** Builds a run, defaulting every mark to off. */
export function makeRun(text: string, marks?: Partial<Omit<Run, 'text'>>): Run {
  return {
    text,
    bold: marks?.bold ?? false,
    underline: marks?.underline ?? false,
    highlight: marks?.highlight ?? false
  }
}

/** The plain text of a run list. */
export function runsText(runs: Run[]): string {
  return runs.map((r) => r.text).join('')
}

/** Drops empty runs and merges neighbours that share the same marks. */
export function tidyRuns(runs: Run[]): Run[] {
  const out: Run[] = []
  for (const r of runs) {
    if (r.text === '') continue
    const last = out[out.length - 1]
    if (last && last.bold === r.bold && last.underline === r.underline && last.highlight === r.highlight) {
      out[out.length - 1] = { ...last, text: last.text + r.text }
    } else {
      out.push({ ...r })
    }
  }
  return out
}

/**
 * Splits run lists at a newline, so every paragraph block holds exactly one
 * visual line. Word uses `w:br` and Markdown can wrap, so this is how both
 * extractors keep "one block = one line" for the parser.
 */
export function splitRunsAtNewlines(runs: Run[]): Run[][] {
  const lines: Run[][] = [[]]
  for (const r of runs) {
    const parts = r.text.split('\n')
    parts.forEach((part, i) => {
      if (i > 0) lines.push([])
      if (part !== '') lines[lines.length - 1].push(makeRun(part, r))
    })
  }
  return lines.map(tidyRuns).filter((line) => line.some((r) => r.text.trim() !== ''))
}
