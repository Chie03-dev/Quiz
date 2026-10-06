/**
 * Import entry point: picks the extractor by extension and runs the shared
 * parser, so every file (or the interchange JSON) ends in the same draft-quiz
 * shape the library's create-quiz path already consumes.
 */
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import type { QuizImport } from '../quizFormat'
import { parseQuizJson } from '../quizFormat'
import { extractDocx } from './docx'
import { extractMarkdown } from './markdown'
import type { AnswerMarking, ParseWarning } from './parser'
import { parseBlocks } from './parser'
import { describeError, ImportError, MAX_FILE_BYTES } from './errors'

export type { AnswerMarking, ParseWarning } from './parser'
export { ImportError, describeError, MAX_FILE_BYTES } from './errors'

export interface ImportOutcome {
  ok: true
  quiz: QuizImport
  warnings: ParseWarning[]
}

export type ImportResult = ImportOutcome | { ok: false; error: string }

/** Reads a text file, refusing anything over the 20 MB limit before loading. */
async function readTextBounded(filePath: string): Promise<string> {
  const info = await stat(filePath).catch(() => null)
  if (!info) throw new ImportError('the file could not be found')
  if (info.size > MAX_FILE_BYTES) {
    throw new ImportError(
      `the file is ${(info.size / (1024 * 1024)).toFixed(1)} MB, larger than the 20 MB limit`
    )
  }
  return readFile(filePath, 'utf8')
}

/**
 * Imports a quiz file of any supported type. Never throws: a malformed file
 * comes back as a readable error so the dialog can show it and the app keeps
 * running.
 */
export async function importQuizFile(filePath: string, markStyle: AnswerMarking = 'auto'): Promise<ImportResult> {
  try {
    const ext = extname(filePath).toLowerCase()
    if (ext === '.json') {
      const text = await readTextBounded(filePath)
      const parsed = parseQuizJson(text)
      if (!parsed.ok) return { ok: false, error: parsed.error }
      return { ok: true, quiz: parsed.quiz, warnings: [] }
    }
    if (ext === '.docx') {
      const blocks = await extractDocx(filePath)
      const { quiz, warnings } = parseBlocks(blocks, { markStyle })
      return { ok: true, quiz, warnings }
    }
    if (ext === '.md' || ext === '.markdown') {
      const text = await readTextBounded(filePath)
      const blocks = extractMarkdown(text)
      const { quiz, warnings } = parseBlocks(blocks, { markStyle })
      return { ok: true, quiz, warnings }
    }
    return {
      ok: false,
      error: `unsupported file type${ext ? ` ${ext}` : ''}; use .docx, .md, .markdown or .json`
    }
  } catch (err) {
    return { ok: false, error: describeError(err) }
  }
}
