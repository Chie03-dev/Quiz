import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'

import type { RagChunk, ScoredChunk } from '../ai/rag/types'
import { contentWords, estimateTokens } from '../ai/rag/chunking'

/** How many chunks a search returns at most. */
const MAX_HITS = 40

export interface AiChunkRow {
  id: string
  sourceRef: string
  parentId: string
  kind: 'parent' | 'child'
  chunkIndex: number
  heading: string
  text: string
  tokens: number
}

/**
 * The retrieval index of a source.
 *
 * Three things live here: the chunks themselves (parents to read, children
 * to search), a word index over the children for BM25, and the vectors of
 * the children for the search by meaning.
 */
export class AiChunkStore {
  constructor(private db: Database) {}

  /** Puts a source into the index, replacing what was there. */
  replace(sourceRef: string, chunks: RagChunk[]): void {
    const now = Date.now()
    const insert = this.db.prepare(
      `INSERT INTO ai_chunks (id, source_ref, parent_id, kind, chunk_index, heading, text, tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insertFts = this.hasFts()
      ? this.db.prepare('INSERT INTO ai_fts (text, source_ref, chunk_id) VALUES (?, ?, ?)')
      : null

    this.db.transaction(() => {
      this.clear(sourceRef)
      chunks.forEach((chunk, index) => {
        insert.run(
          chunk.id,
          sourceRef,
          chunk.parentId,
          chunk.kind,
          index,
          chunk.heading,
          chunk.text,
          estimateTokens(chunk.text),
          now
        )
        // Only the children go into the word index; the parents are read, not
        // searched.
        if (insertFts && chunk.kind === 'child') {
          insertFts.run(chunk.text, sourceRef, chunk.id)
        }
      })
    })()
  }

  /** True when this build can search by words. */
  hasFts(): boolean {
    try {
      this.db.prepare('SELECT chunk_id FROM ai_fts LIMIT 1').all()
      return true
    } catch {
      return false
    }
  }

  /** Every chunk of a source, in reading order. */
  list(sourceRef: string): RagChunk[] {
    const rows = this.db
      .prepare(
        `SELECT id, source_ref AS sourceRef, parent_id AS parentId, kind, chunk_index AS chunkIndex,
                heading, text, tokens
         FROM ai_chunks WHERE source_ref = ? ORDER BY chunk_index ASC`
      )
      .all(sourceRef) as AiChunkRow[]
    return rows.map(toChunk)
  }

  /** True when the source is in the index. */
  has(sourceRef: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM ai_chunks WHERE source_ref = ? LIMIT 1')
      .get(sourceRef) as { '1': number } | undefined
    return !!row
  }

  /**
   * The chunks that match the words of the query, best first.
   *
   * The words are ranked by BM25, the ranking SQLite itself computes.
   */
  searchWords(sourceRef: string, query: string, limit = MAX_HITS): ScoredChunk[] {
    const terms = contentWords(query).slice(0, 24)
    if (terms.length === 0) return []

    if (this.hasFts()) {
      const match = terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ')
      try {
        const rows = this.db
          .prepare(
            `SELECT f.chunk_id AS chunkId, bm25(ai_fts) AS rank
             FROM ai_fts f
             WHERE f.source_ref = ? AND ai_fts MATCH ?
             ORDER BY rank
             LIMIT ?`
          )
          .all(sourceRef, match, limit) as { chunkId: string; rank: number }[]
        return this.withChunks(rows.map((row, i) => ({ id: row.chunkId, rank: i + 1 })))
      } catch {
        // A query FTS5 does not like falls through to the plain search.
      }
    }

    return this.searchWordsPlain(sourceRef, terms, limit)
  }

  /** The search without the word index: every chunk is read and counted. */
  private searchWordsPlain(sourceRef: string, terms: string[], limit: number): ScoredChunk[] {
    const children = this.list(sourceRef).filter((chunk) => chunk.kind === 'child')
    const scored = children
      .map((chunk) => {
        const words = new Set(contentWords(chunk.text))
        let hits = 0
        for (const term of terms) {
          if (words.has(term)) hits++
        }
        return { chunk, hits }
      })
      .filter((entry) => entry.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, limit)

    return scored.map((entry, i) => ({
      chunk: entry.chunk,
      score: entry.hits / terms.length,
      rank: i + 1,
      source: 'bm25' as const
    }))
  }

  /** Stores the vectors of the children of a source. */
  replaceVectors(sourceRef: string, vectors: Map<string, number[]>): void {
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO ai_vectors (chunk_id, source_ref, dims, vector) VALUES (?, ?, ?, ?)'
    )
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM ai_vectors WHERE source_ref = ?').run(sourceRef)
      for (const [chunkId, vector] of vectors) {
        insert.run(chunkId, sourceRef, vector.length, toBlob(vector))
      }
    })()
  }

  /** The vectors of a source, with the chunk they belong to. */
  vectors(sourceRef: string): { chunkId: string; vector: number[] }[] {
    const rows = this.db
      .prepare('SELECT chunk_id AS chunkId, vector FROM ai_vectors WHERE source_ref = ?')
      .all(sourceRef) as { chunkId: string; vector: Buffer }[]
    return rows.map((row) => ({ chunkId: row.chunkId, vector: fromBlob(row.vector) }))
  }

  /** True when the source has vectors, so the search by meaning can be used. */
  hasVectors(sourceRef: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM ai_vectors WHERE source_ref = ? LIMIT 1')
      .get(sourceRef) as { '1': number } | undefined
    return !!row
  }

  /** Removes a source from the index. */
  clear(sourceRef: string): boolean {
    let removed = false
    this.db.transaction(() => {
      if (this.hasFts()) {
        removed =
          this.db.prepare('DELETE FROM ai_fts WHERE source_ref = ?').run(sourceRef).changes > 0
      }
      const chunks = this.db
        .prepare('DELETE FROM ai_chunks WHERE source_ref = ?')
        .run(sourceRef).changes
      this.db.prepare('DELETE FROM ai_vectors WHERE source_ref = ?').run(sourceRef)
      removed = removed || chunks > 0
    })()
    return removed
  }

  /** The chunks of a source, in the order the search found them. */
  private withChunks(entries: { id: string; rank: number }[]): ScoredChunk[] {
    if (entries.length === 0) return []
    const rows = this.db
      .prepare(
        `SELECT id, source_ref AS sourceRef, parent_id AS parentId, kind, chunk_index AS chunkIndex,
                heading, text, tokens
         FROM ai_chunks WHERE id IN (${entries.map(() => '?').join(',')})`
      )
      .all(...entries.map((entry) => entry.id)) as AiChunkRow[]
    const byId = new Map(rows.map((row) => [row.id, row]))

    return entries
      .map((entry) => {
        const row = byId.get(entry.id)
        if (!row) return null
        const scored: ScoredChunk = {
          chunk: toChunk(row),
          score: 1 / entry.rank,
          rank: entry.rank,
          source: 'bm25'
        }
        return scored
      })
      .filter((entry): entry is ScoredChunk => entry !== null)
  }
}

/** A row of the chunk table as a chunk. */
export function toChunk(row: AiChunkRow): RagChunk {
  return {
    id: row.id,
    parentId: row.parentId,
    kind: row.kind,
    index: row.chunkIndex,
    text: row.text,
    heading: row.heading,
    tokens: row.tokens
  }
}

/** A vector as bytes. */
export function toBlob(vector: number[]): Buffer {
  const buffer = Buffer.alloc(vector.length * 4)
  vector.forEach((value, i) => buffer.writeFloatLE(value, i * 4))
  return buffer
}

/** Bytes as a vector. */
export function fromBlob(buffer: Buffer): number[] {
  const out: number[] = []
  for (let i = 0; i + 4 <= buffer.length; i += 4) out.push(buffer.readFloatLE(i))
  return out
}

/** The dot product of two vectors of the same length. */
export function dotProduct(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  let sum = 0
  for (let i = 0; i < n; i++) sum += a[i] * b[i]
  return sum
}

/** The cosine similarity of two vectors; zero when one of them is empty. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** A new id for a chunk. */
export function newChunkId(): string {
  return randomUUID()
}
