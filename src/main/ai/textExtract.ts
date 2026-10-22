/**
 * Reads the plain text of a source file for the AI: a Word document, a PDF,
 * a Markdown or a plain text file.
 *
 * The Word and PDF readers are the ones the quiz importer uses, so a file
 * that can be imported can also be used as a source for generated questions.
 */
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

import { extractDocx } from '../import/docx'
import { extractPdf } from '../import/pdf'
import { extractMarkdown } from '../import/markdown'
import type { Block } from '../import/types'
import { runsText } from '../import/types'

/** How much text the AI gets; a model does not read a whole book. */
export const MAX_SOURCE_CHARS = 60_000

export async function extractTextFromPath(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase()

  switch (ext) {
    case '.docx': {
      const blocks = await extractDocx(filePath)
      return blocksToText(blocks)
    }
    case '.pdf': {
      const blocks = await extractPdf(filePath)
      return blocksToText(blocks)
    }
    case '.md':
    case '.markdown': {
      const blocks = await extractMarkdown(filePath)
      return blocksToText(blocks)
    }
    case '.txt': {
      const buffer = await readFile(filePath)
      return buffer.toString('utf-8')
    }
    default: {
      const buffer = await readFile(filePath)
      return buffer.toString('utf-8')
    }
  }
}

/** The text of the blocks, one line per block. */
export function blocksToText(blocks: Block[]): string {
  const lines: string[] = []
  for (const block of blocks) {
    if (block.kind === 'paragraph') {
      const text = runsText(block.runs).trim()
      if (text) lines.push(text)
      continue
    }
    // A table becomes one line per row, with the cells separated by a tab.
    for (const row of block.rows) {
      const cells = row.map((cell) => runsText(cell.runs).trim())
      const text = cells.filter((cell) => cell.length > 0).join('\t')
      if (text) lines.push(text)
    }
  }
  return reflow(lines).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_SOURCE_CHARS)
}

/**
 * Puts the lines of a PDF back into sentences. A PDF keeps the lines of the
 * page, so one sentence arrives as three lines.
 */
export function reflow(lines: string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    const last = out[out.length - 1]
    // A line that ends without a full stop and is followed by a word that
    // starts small is the same sentence.
    if (last !== undefined && !/[.!?:;]$/.test(last) && /^[a-z(]/.test(line)) {
      out[out.length - 1] = `${last} ${line}`
      continue
    }
    out.push(line)
  }
  return out
}
