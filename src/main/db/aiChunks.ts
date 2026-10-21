import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { Chunk } from '../ai/types'

export interface AiChunk {
  id: string
  sourceRef: string
  chunkIndex: number
  text: string
  tokens: number
  createdAt: number
}

export class AiChunkStore {
  constructor(private db: Database) {}

  /** Clears all chunks for a source and inserts the new ones in one transaction. */
  replace(sourceRef: string, chunks: Chunk[]): void {
    const now = Date.now()
    const insert = this.db.prepare(
      `INSERT INTO ai_chunks (id, source_ref, chunk_index, text, tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )

    this.db.transaction(() => {
      this.db.prepare('DELETE FROM ai_chunks WHERE source_ref = ?').run(sourceRef)
      let index = 0
      for (const chunk of chunks) {
        insert.run(randomUUID(), sourceRef, index, chunk.text, estimateTokens(chunk.text), now)
        index++
      }
    })()
  }

  /** All chunks for a source, in insertion order. */
  list(sourceRef: string): AiChunk[] {
    return this.db
      .prepare(
        `SELECT id, source_ref AS sourceRef, chunk_index AS chunkIndex, text, tokens, created_at AS createdAt
         FROM ai_chunks WHERE source_ref = ? ORDER BY chunk_index ASC`
      )
      .all(sourceRef) as AiChunk[]
  }

  /** Concatenates all chunk text for a source (the cached context). */
  getSourceText(sourceRef: string): string {
    const rows = this.db
      .prepare(
        `SELECT text FROM ai_chunks WHERE source_ref = ? ORDER BY chunk_index ASC`
      )
      .all(sourceRef) as { text: string }[]
    return rows.map((r) => r.text).join('\n\n')
  }

  /** True when any chunks have been stored for the source. */
  has(sourceRef: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM ai_chunks WHERE source_ref = ? LIMIT 1`)
      .get(sourceRef) as { '1': number } | undefined
    return !!row
  }

  /** Removes all chunks for a source. */
  clear(sourceRef: string): boolean {
    return this.db.prepare('DELETE FROM ai_chunks WHERE source_ref = ?').run(sourceRef).changes > 0
  }
}

function estimateTokens(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return Math.ceil(trimmed.split(/\s+/).length / 4)
}
