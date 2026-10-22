/**
 * The shapes the retrieval layer works with.
 *
 * A source (a chapter, a set of notes) is cut into **parent** chunks - a
 * paragraph or a small window of paragraphs, the unit that is read - and
 * **child** chunks - single sentences, the unit that is searched. This is
 * the "small to big" pattern: the search is precise, the answer has room.
 */
import type { QuestionType } from '../../../shared/types'

/** A piece of a source: a parent (to read) or a child (to search). */
export interface RagChunk {
  id: string
  /** The id of the parent chunk; empty for a parent itself. */
  parentId: string
  /** 'parent' is read, 'child' is searched. */
  kind: 'parent' | 'child'
  /** Where the chunk sits in the source, in reading order. */
  index: number
  /** The text of the chunk. */
  text: string
  /** The heading the chunk sits under, e.g. "2. Meiosis". */
  heading: string
  /** Roughly how many tokens the text is. */
  tokens: number
}

/** A chunk with a score from a search. */
export interface ScoredChunk {
  chunk: RagChunk
  score: number
  /** The rank the chunk had in that search, counted from 1. */
  rank: number
  /** Which search found it. */
  source: 'bm25' | 'dense' | 'fused'
}

/** A passage that is put in front of the model. */
export interface Passage {
  /** The text the model reads. */
  text: string
  /** The heading of the passage, when it has one. */
  heading: string
  /** The id of the child chunk the passage was found with. */
  chunkId: string
  /** The sentence of the child chunk, the most relevant part. */
  focus: string
  /** How relevant the passage is, 0..1. */
  score: number
}

/**
 * Turns text into vectors. The app can do this with a small embedding model;
 * without one the search falls back to words alone.
 */
export interface Embedder {
  /** True when the embedder can work right now. */
  ready(): boolean
  /** The vectors of the texts, in the same order. */
  embed(texts: string[]): Promise<number[][]>
  /** Stops whatever the embedder started. */
  stop?(): void
}

/** What the retrieval needs to know about the request. */
export interface RagRequest {
  /** The id of the source in the store. */
  sourceRef: string
  /** What the questions should be about; empty means "the whole source". */
  topic?: string
  /** How many questions are wanted. */
  count: number
  /** The question types that are wanted. */
  types: QuestionType[]
  /** The points every question is worth. */
  points: number
}

/**
 * What the pipeline needs from the index. The store in the database
 * satisfies it; the app can also use another one.
 */
export interface ChunkIndex {
  /** Puts a source into the index, replacing what was there. */
  replace(sourceRef: string, chunks: RagChunk[]): void
  /** Every chunk of a source, in reading order. */
  list(sourceRef: string): RagChunk[]
  /** The chunks that match the words of the query, best first. */
  searchWords(sourceRef: string, query: string, limit?: number): ScoredChunk[]
  /** Stores the vectors of the chunks. */
  replaceVectors(sourceRef: string, vectors: Map<string, number[]>): void
  /** The vectors of a source. */
  vectors(sourceRef: string): { chunkId: string; vector: number[] }[]
  /** True when the source has vectors. */
  hasVectors(sourceRef: string): boolean
}
