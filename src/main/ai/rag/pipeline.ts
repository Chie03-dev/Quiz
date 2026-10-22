/**
 * The RAG pipeline: index a source, choose the passages to ask about, and
 * check the questions that come back.
 *
 * The order is the one that is used today:
 *
 * 1. **Index.** The document is cut into parents and children, the children
 *    go into the word index and (when an embedding model is there) their
 *    vectors are stored too.
 * 2. **Plan.** The passages the questions should come from are chosen with
 *    the two searches put together and with diversity, so the questions
 *    cover the chapter instead of only its first pages.
 * 3. **Generate.** One question at a time, with only that passage in front
 *    of the model.
 * 4. **Check.** The question has to hold up: the answer has to be in the
 *    passage, the question has to be a question, and it may not be a copy of
 *    the passage or of another question.
 */
import type { QuestionType } from '../../../shared/types'
import type { ChunkIndex, Embedder, Passage, RagChunk } from './types'
import { blocksToDocBlocks, chunkDocument, estimateTokens } from './chunking'
import { assembleContext, retrievePassages, spread, toPassage } from './retrieval'
import type { DocBlock } from './chunking'

/** The question the model is asked for one passage. */
export interface PassageQuestion {
  passage: Passage
  type: QuestionType
  points: number
  /** The text the model reads. */
  context: string
}

/** The result of a check. */
export interface CheckResult {
  ok: boolean
  why: string
}

/**
 * Puts a source into the index and gives back the chunks.
 *
 * A source that is already indexed is left alone: the chunks and their
 * vectors stay, so a second run does not pay for the search model again.
 */
export async function indexSource(
  store: ChunkIndex,
  sourceRef: string,
  blocks: DocBlock[],
  embedder?: Embedder
): Promise<RagChunk[]> {
  const chunks = chunkDocument(blocks)
  const existing = store.list(sourceRef)
  // The same source when it has the same pieces and about the same text.
  const sameSource =
    existing.length === chunks.length &&
    existing.reduce((sum, chunk) => sum + chunk.text.length, 0) ===
      chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)

  if (!sameSource) {
    store.replace(sourceRef, chunks)
    store.replaceVectors(sourceRef, new Map())
  }

  if (embedder && embedder.ready() && !store.hasVectors(sourceRef)) {
    const children = chunks.filter((chunk) => chunk.kind === 'child')
    if (children.length > 0) {
      const vectors = await embedder.embed(children.map((chunk) => chunk.text))
      const map = new Map<string, number[]>()
      children.forEach((child, i) => {
        const vector = vectors[i]
        if (vector && vector.length > 0) map.set(child.id, vector)
      })
      if (map.size > 0) store.replaceVectors(sourceRef, map)
    }
  }

  return chunks
}

/**
 * The passages to ask about.
 *
 * With a topic the two searches find the passages that are about it. Without
 * one the passages are spread over the whole source, so the questions come
 * from all over the chapter.
 */
export async function choosePassages(
  store: ChunkIndex,
  sourceRef: string,
  topic: string,
  count: number,
  embedder?: Embedder
): Promise<Passage[]> {
  const rows = store.list(sourceRef)
  const parents = new Map(rows.filter((row) => row.kind === 'parent').map((row) => [row.id, row]))
  const children = rows.filter((row) => row.kind === 'child')

  if (children.length === 0) return []

  const words = contentWordsOf(topic)
  if (words.length === 0) {
    return spread(children, count, parents)
  }

  const wordHits = store.searchWords(sourceRef, topic)
  const vectors = new Map(store.vectors(sourceRef).map((entry) => [entry.chunkId, entry.vector]))

  return retrievePassages({
    children,
    parents,
    query: topic,
    count,
    wordHits,
    embedder,
    vectors
  })
}

/**
 * The passages that support a question that was written.
 *
 * This is the check of the answer: the passages that talk about the same
 * thing are found, and the answer has to be in one of them.
 */
export async function supportPassages(
  store: ChunkIndex,
  sourceRef: string,
  question: string,
  embedder?: Embedder
): Promise<Passage[]> {
  const rows = store.list(sourceRef)
  const parents = new Map(rows.filter((row) => row.kind === 'parent').map((row) => [row.id, row]))
  const children = rows.filter((row) => row.kind === 'child')

  const wordHits = store.searchWords(sourceRef, question)
  const vectors = new Map(store.vectors(sourceRef).map((entry) => [entry.chunkId, entry.vector]))

  return retrievePassages({
    children,
    parents,
    query: question,
    count: 3,
    wordHits,
    embedder,
    vectors
  })
}

/** The text of a passage, as the model reads it. */
export function contextFor(passage: Passage): string {
  return assembleContext(passage)
}

/** The blocks of a document, ready to be chunked. */
export function documentBlocks(blocks: DocBlock[]): DocBlock[] {
  return blocks
}

export { blocksToDocBlocks, estimateTokens, toPassage }

/** The words of a topic that are worth searching for. */
function contentWordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && w.length < 30)
}
