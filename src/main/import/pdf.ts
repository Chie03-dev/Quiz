/**
 * .pdf extractor: reads the text of a PDF and produces the neutral blocks the
 * shared parser consumes.
 *
 * A PDF has no paragraphs, only positioned pieces of text, so the lines are
 * put back together from the text the reader returns. A scanned PDF holds
 * images instead of text; there is nothing to read there, and the import says
 * so instead of returning an empty quiz.
 */
import { readFile, stat } from 'node:fs/promises'
import type { Block } from './types'
import { makeRun, tidyRuns } from './types'
import { ImportError, MAX_FILE_BYTES, MAX_PDF_PAGES } from './errors'

/** One text line of a page becomes one paragraph block. */
function lineBlock(text: string): Block {
  return { kind: 'paragraph', runs: tidyRuns([makeRun(text)]) }
}

/**
 * The reader marks the end of a page with "-- 2 of 7 --". That is not part of
 * the paper, and left in it would be read as a choice of the last question.
 */
const PAGE_MARKER = /^--\s*\d+\s+of\s+\d+\s*--$/u

/**
 * Reads a .pdf file into ordered blocks, one per line of text.
 *
 * Never throws for a file it cannot read: the error is a message the dialog
 * can show.
 */
export async function extractPdf(filePath: string): Promise<Block[]> {
  const info = await stat(filePath).catch(() => null)
  if (!info) throw new ImportError('the file could not be found')
  if (info.size > MAX_FILE_BYTES) {
    throw new ImportError(
      `the file is ${(info.size / (1024 * 1024)).toFixed(1)} MB, larger than the 20 MB limit`
    )
  }

  let buffer: Buffer
  try {
    buffer = await readFile(filePath)
  } catch (err) {
    throw new ImportError(`the file could not be read (${err instanceof Error ? err.message : String(err)})`)
  }

  // The reader is loaded only when a PDF is actually imported: it is a big
  // library and the app has no reason to carry it in memory otherwise.
  const { PDFParse } = await import('pdf-parse')

  let parser: InstanceType<typeof PDFParse>
  try {
    parser = new PDFParse({ data: new Uint8Array(buffer) })
  } catch (err) {
    throw new ImportError(
      `this file is not a readable PDF (${err instanceof Error ? err.message : String(err)})`
    )
  }

   let pages: { num: number; text: string }[]
  try {
    const result = await parser.getText({
      lineEnforce: true,
      lineThreshold: 4.6,
      cellSeparator: '\t',
      cellThreshold: 7
    })
     pages = result.pages
   } catch (err) {
    throw new ImportError(
      `this PDF could not be read (${err instanceof Error ? err.message : String(err)})`
    )
  } finally {
    await parser.destroy().catch(() => undefined)
  }

  if (pages.length > MAX_PDF_PAGES) {
    throw new ImportError(`this PDF has ${pages.length} pages, which is more than the app reads`)
  }

  const blocks: Block[] = []
  for (const page of pages) {
    for (const line of page.text.split(/\r\n|\r|\n/u)) {
      const text = line.replace(/\t+/g, ' ').trim()
      if (!text) continue
      if (PAGE_MARKER.test(text)) continue
      blocks.push(lineBlock(text))
    }
  }

  if (blocks.length === 0) {
    throw new ImportError(
      'this PDF holds no text - it is probably a scan or a picture, and there is nothing to read in it'
    )
  }
  return blocks
}
