/**
 * The corpus of a source: the blocks a source is made of.
 *
 * A file is read with the readers the quiz importer uses, so a Word
 * document keeps its headings and a PDF keeps its lines. Pasted text is
 * cut into paragraphs itself.
 */
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

import { extractDocx } from '../import/docx'
import { extractPdf } from '../import/pdf'
import { extractMarkdown } from '../import/markdown'
import { blocksToDocBlocks, type DocBlock } from './rag/chunking'

/** The blocks of a file on disk. */
export async function fileBlocks(filePath: string): Promise<DocBlock[]> {
  const ext = extname(filePath).toLowerCase()

  switch (ext) {
    case '.docx':
      return blocksToDocBlocks(await extractDocx(filePath))
    case '.pdf':
      return blocksToDocBlocks(await extractPdf(filePath))
    case '.md':
    case '.markdown':
      return blocksToDocBlocks(await extractMarkdown(filePath))
    default: {
      const buffer = await readFile(filePath)
      return textBlocks(buffer.toString('utf-8'))
    }
  }
}

/** The blocks of pasted text: the paragraphs and the lines of a list. */
export function textBlocks(text: string): DocBlock[] {
  const lines = text.split(/\r?\n/)
  const blocks: DocBlock[] = []
  let heading = ''

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // A markdown heading is a heading; a line that is only a label is too.
    const markdown = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (markdown) {
      heading = markdown[2].trim()
      blocks.push({ text: heading, heading, kind: 'heading' })
      continue
    }
    blocks.push({ text: trimmed, heading, kind: 'paragraph' })
  }

  return blocks
}
