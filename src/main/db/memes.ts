import type { Database } from 'better-sqlite3'
import type { MemeInfo, MemeMime } from '../../shared/types'

/** The two image types the app stores. */
export const MEME_MIMES: readonly MemeMime[] = ['image/jpeg', 'image/png']

interface MemeRow {
  id: string
  name: string
  fileName: string
  mime: string
  width: number
  height: number
  byteSize: number
  thumb: string
  createdAt: number
}

/** A meme row plus the file name it is stored under. */
export interface StoredMeme extends MemeInfo {
  fileName: string
}

/** The store row, with the file name kept apart from the public shape. */
function toStored(row: MemeRow): StoredMeme {
  return {
    id: row.id,
    name: row.name,
    fileName: row.fileName,
    mime: row.mime as MemeMime,
    width: row.width,
    height: row.height,
    byteSize: row.byteSize,
    thumb: row.thumb,
    createdAt: row.createdAt
  }
}

/**
 * The meme tray. Like the quiz library, every SQL statement of the app lives
 * in the main process; the renderer only ever sees MemeInfo.
 */
export class MemeStore {
  constructor(private db: Database) {}

  /** All memes, oldest first. */
  list(): MemeInfo[] {
    return this.db
      .prepare(
        `SELECT id, name, file_name AS fileName, mime, width, height,
                byte_size AS byteSize, thumb, created_at AS createdAt
         FROM memes ORDER BY created_at ASC, id ASC`
      )
      .all()
      .map((row) => {
        const stored = toStored(row as MemeRow)
        return {
          id: stored.id,
          name: stored.name,
          mime: stored.mime,
          width: stored.width,
          height: stored.height,
          byteSize: stored.byteSize,
          thumb: stored.thumb,
          createdAt: stored.createdAt
        }
      })
  }

  /** One meme with its file name, or null when unknown. */
  get(id: string): StoredMeme | null {
    const row = this.db
      .prepare(
        `SELECT id, name, file_name AS fileName, mime, width, height,
                byte_size AS byteSize, thumb, created_at AS createdAt
         FROM memes WHERE id = ?`
      )
      .get(id) as MemeRow | undefined
    return row ? toStored(row) : null
  }

  /** One meme by its file name; the HTTP asset route looks memes up this way. */
  getByFileName(fileName: string): StoredMeme | null {
    const row = this.db
      .prepare(
        `SELECT id, name, file_name AS fileName, mime, width, height,
                byte_size AS byteSize, thumb, created_at AS createdAt
         FROM memes WHERE file_name = ?`
      )
      .get(fileName) as MemeRow | undefined
    return row ? toStored(row) : null
  }

  /** Inserts a meme row and returns it. */
  insert(meme: {
    id: string
    name: string
    fileName: string
    mime: MemeMime
    width: number
    height: number
    byteSize: number
    thumb: string
  }): StoredMeme {
    const createdAt = Date.now()
    this.db
      .prepare(
        `INSERT INTO memes
           (id, name, file_name, mime, width, height, byte_size, thumb, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        meme.id,
        meme.name,
        meme.fileName,
        meme.mime,
        meme.width,
        meme.height,
        meme.byteSize,
        meme.thumb,
        createdAt
      )
    const stored = this.get(meme.id)
    if (!stored) throw new Error('The meme could not be stored.')
    return stored
  }

  /** Deletes a meme row; the file on disk is removed by the caller. */
  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM memes WHERE id = ?').run(id).changes > 0
  }

  close(): void {
    this.db.close()
  }
}
