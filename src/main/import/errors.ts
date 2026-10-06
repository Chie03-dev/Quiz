/** Limits and the error type every importer throws for an unreadable file. */

/** Largest source file the importers accept (20 MB). */
export const MAX_FILE_BYTES = 20 * 1024 * 1024
/** Most entries a .docx zip may contain before we call it a bomb. */
export const MAX_ZIP_ENTRIES = 512
/** Total uncompressed bytes a .docx zip may claim before we call it a bomb. */
export const MAX_TOTAL_UNCOMPRESSED = 200 * 1024 * 1024
/** Parsed document.xml must stay below this many characters. */
export const MAX_DOC_XML_CHARS = MAX_TOTAL_UNCOMPRESSED

/**
 * A readable import failure. The main process turns it into the message the
 * instructor sees; nothing here ever escapes as a crash.
 */
export class ImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportError'
  }
}

/** Extracts the readable part of an unknown throwable. */
export function describeError(err: unknown): string {
  if (err instanceof ImportError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}
