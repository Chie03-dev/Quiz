/**
 * The retrieval part of the RAG pipeline.
 *
 * Three ideas do the work here:
 *
 * - **Two searches, one ranking.** A word search (BM25) finds the passages
 *   that use the same words; a meaning search (vectors) finds the passages
 *   that mean the same thing. The two rankings are put together with
 *   reciprocal rank fusion, which is the standard way to combine them
 *   without having to make the two scores comparable.
 * - **Diversity.** A chapter has hundreds of sentences; the questions must
 *   not all come from the same corner of it. Maximal marginal relevance
 *   picks passages that are relevant but not the same as the ones already
 *   picked.
 * - **Room to answer.** The passage that is read is the parent - the whole
 *   paragraph - and the sentence that was matched is put last, because a
 *   model reads the end of a passage best.
 */
import type { Embedder, Passage, RagChunk, ScoredChunk } from './types'
import { contentWords, estimateTokens } from './chunking'
import { cosineSimilarity } from '../../db/aiChunks'

/** The constant of reciprocal rank fusion; the usual value is 60. */
const RRF_K = 60
/** How much of the pick is relevance and how much is difference, 0..1. */
const MMR_LAMBDA = 0.72
/** How many passages a search looks at. */
const CANDIDATES = 24
/** How many tokens a passage may take up. */
const MAX_PASSAGE_TOKENS = 320

/**
 * Puts the two rankings together.
 *
 * A chunk that both searches found ranks higher than one that only one of
 * them found, and the order inside a ranking is kept.
 */
export function reciprocalRankFusion(
  rankings: ScoredChunk[][],
  k = RRF_K
): ScoredChunk[] {
  const scores = new Map<string, { chunk: RagChunk; score: number; rank: number }>()

  rankings.forEach((ranking) => {
    ranking.forEach((entry, index) => {
      const rank = index + 1
      const score = 1 / (k + rank)
      const existing = scores.get(entry.chunk.id)
      if (existing) {
        existing.score += score
        if (rank < existing.rank) existing.rank = rank
      } else {
        scores.set(entry.chunk.id, { chunk: entry.chunk, score, rank })
      }
    })
  })

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map((entry) => ({
      chunk: entry.chunk,
      score: entry.score,
      rank: entry.rank,
      source: 'fused' as const
    }))
}

/**
 * Picks passages that are relevant and not the same as each other.
 *
 * The first pick is the most relevant one. Every pick after that is judged
 * by its relevance minus how much it repeats what was already picked.
 */
export function maximalMarginalRelevance(
  candidates: ScoredChunk[],
  count: number,
  lambda = MMR_LAMBDA
): ScoredChunk[] {
  if (candidates.length === 0) return []

  const picked: ScoredChunk[] = []
  const rest = [...candidates]

  while (picked.length < count && rest.length > 0) {
    let bestIndex = 0
    let bestValue = -Infinity

    rest.forEach((candidate, index) => {
      const relevance = candidate.score
      let similarity = 0
      for (const chosen of picked) {
        similarity = Math.max(similarity, chunkSimilarity(candidate.chunk, chosen.chunk))
      }
      const value = lambda * relevance - (1 - lambda) * similarity
      if (value > bestValue) {
        bestValue = value
        bestIndex = index
      }
    })

    picked.push(rest[bestIndex])
    rest.splice(bestIndex, 1)
  }

  return picked
}

/** How alike two chunks are, 0..1. Words first, meaning when there are vectors. */
export function chunkSimilarity(a: RagChunk, b: RagChunk): number {
  const wordsA = new Set(contentWords(a.text))
  const wordsB = new Set(contentWords(b.text))
  if (wordsA.size === 0 || wordsB.size === 0) return 0

  let shared = 0
  for (const word of wordsA) {
    if (wordsB.has(word)) shared++
  }
  return shared / Math.min(wordsA.size, wordsB.size)
}

/**
 * The passages of a source, spread over the whole source.
 *
 * The document is read in order and every n-th passage is taken, so the
 * questions are about different parts of the chapter. Two questions do not
 * come from the same paragraph, unless the document has fewer paragraphs
 * than questions.
 */
export function spread(
  children: RagChunk[],
  count: number,
  parents: Map<string, RagChunk>
): Passage[] {
  if (children.length === 0) return []
  const step = Math.max(1, Math.floor(children.length / Math.max(1, count)))
  const picked: Passage[] = []
  const usedChildren = new Set<string>()
  const usedParents = new Set<string>()

  const take = (child: RagChunk): void => {
    const parent = parents.get(child.parentId)
    if (!parent) return
    picked.push(toPassage(child, parent, 1))
    usedChildren.add(child.id)
    usedParents.add(child.parentId)
  }

  for (let i = 0; i < children.length && picked.length < count; i += step) {
    const child = children[i]
    if (usedChildren.has(child.id)) continue
    if (usedParents.has(child.parentId)) {
      // The paragraph is used already: the next paragraph that is not used
      // yet takes its place, so the questions are not all about one corner
      // of the chapter.
      const next = children.find(
        (candidate, index) =>
          index > i && !usedParents.has(candidate.parentId) && !usedChildren.has(candidate.id)
      )
      if (!next) continue
      take(next)
      continue
    }
    take(child)
  }

  // The document has fewer paragraphs than questions: then a paragraph gives
  // more than one question, and its next sentence is used.
  if (picked.length < count) {
    for (const child of children) {
      if (picked.length >= count) break
      if (usedChildren.has(child.id)) continue
      take(child)
    }
  }

  return picked
}

/** The passage of a child chunk: the parent to read, the child in focus. */
export function toPassage(child: RagChunk, parent: RagChunk, score: number): Passage {
  return {
    text: parent.text,
    heading: parent.heading,
    chunkId: child.id,
    focus: child.text,
    score
  }
}

/**
 * The passage for a query, found with the two searches and put together.
 */
export async function retrievePassages(input: {
  children: RagChunk[]
  parents: Map<string, RagChunk>
  query: string
  count: number
  wordHits: ScoredChunk[]
  embedder?: Embedder
  vectors?: Map<string, number[]>
}): Promise<Passage[]> {
  const { children, parents, query, count, wordHits, embedder, vectors } = input

  let ranking = wordHits
  if (embedder && vectors && vectors.size > 0) {
    const meaning = await searchByMeaning(embedder, query, children, vectors)
    if (meaning.length > 0) {
      ranking = reciprocalRankFusion([wordHits, meaning])
    }
  }

  const picked = maximalMarginalRelevance(ranking.slice(0, CANDIDATES), count)
  const passages: Passage[] = []

  for (const entry of picked) {
    const parent = parents.get(entry.chunk.parentId)
    if (!parent) continue
    passages.push(toPassage(entry.chunk, parent, entry.score))
  }

  return passages
}

/** The chunks that mean the same as the query. */
export async function searchByMeaning(
  embedder: Embedder,
  query: string,
  children: RagChunk[],
  vectors: Map<string, number[]>
): Promise<ScoredChunk[]> {
  const queryVectors = await embedder.embed([query])
  const queryVector = queryVectors[0]
  if (!queryVector || queryVector.length === 0) return []

  const scored: ScoredChunk[] = []
  for (const child of children) {
    const vector = vectors.get(child.id)
    if (!vector) continue
    const similarity = cosineSimilarity(queryVector, vector)
    if (similarity <= 0.35) continue
    scored.push({ chunk: child, score: similarity, rank: scored.length + 1, source: 'dense' })
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, CANDIDATES)
}

/**
 * The text of a passage, as the model reads it.
 *
 * The matched sentence goes last: a model reads the end of a passage best.
 */
export function assembleContext(passage: Passage): string {
  const parts: string[] = []
  if (passage.heading) parts.push(passage.heading)
  parts.push(passage.text)
  if (passage.focus && !passage.text.includes(passage.focus)) parts.push(passage.focus)
  return parts.join('\n\n')
}

/** How many tokens a passage takes up. */
export function passageSize(passage: Passage): number {
  return estimateTokens(assembleContext(passage))
}

/** A passage may not take up more than this many tokens. */
export const MAX_CONTEXT_TOKENS = MAX_PASSAGE_TOKENS
