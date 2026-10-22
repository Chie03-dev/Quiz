/**
 * Structure-aware chunking.
 *
 * A chapter is not a wall of text: it has headings, paragraphs, lists and
 * tables. Cutting it at those marks keeps every chunk with one subject, so
 * the model never sees half a paragraph and the search finds whole ideas.
 *
 * Each block becomes a **parent** chunk (the unit that is read) and one or
 * more **child** chunks (single sentences, the unit that is searched).
 */
import { randomUUID } from 'node:crypto'

import type { Block } from '../../import/types'
import { runsText } from '../../import/types'
import type { RagChunk } from './types'

/** A parent chunk is at most this many tokens. */
export const MAX_PARENT_TOKENS = 220
/** A child chunk is at most this many tokens. */
export const MAX_CHILD_TOKENS = 60
/** A child chunk is at least this many tokens, so tiny fragments are merged. */
const MIN_CHILD_TOKENS = 8

/** The words that carry no meaning when they are alone. */
const STOP_WORDS = new Set([
  'the',
  'and',
  'that',
  'this',
  'with',
  'from',
  'they',
  'their',
  'them',
  'then',
  'than',
  'there',
  'these',
  'those',
  'have',
  'been',
  'will',
  'would',
  'were',
  'into',
  'more',
  'most',
  'some',
  'such',
  'also',
  'about',
  'after',
  'before',
  'between',
  'during',
  'under',
  'above',
  'below',
  'other',
  'another',
  'which',
  'what',
  'while',
  'however',
  'therefore',
  'thus',
  'hence',
  'our',
  'their',
  'its',
  'his',
  'her'
])

/** Estimates how many tokens a text is. */
export function estimateTokens(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return Math.ceil(trimmed.length / 4)
}

/** The content words of a text, for a search query. */
export function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && w.length < 30 && !STOP_WORDS.has(w))
}

/** One block of a document: a paragraph, a heading or a table row. */
export interface DocBlock {
  text: string
  heading: string
  kind: 'paragraph' | 'heading' | 'table'
}

/**
 * The blocks of a document, with the heading each one sits under.
 *
 * The importers already know what a heading is, so the structure survives.
 */
export function blocksToDocBlocks(blocks: Block[]): DocBlock[] {
  const out: DocBlock[] = []
  let heading = ''

  for (const block of blocks) {
    if (block.kind === 'paragraph') {
      const text = runsText(block.runs).trim()
      if (!text) continue
      if (block.heading !== undefined) {
        heading = text
        out.push({ text, heading, kind: 'heading' })
        continue
      }
      out.push({ text, heading, kind: 'paragraph' })
      continue
    }
    // A table becomes one block per row, so a row can be searched on its own.
    for (const row of block.rows) {
      const cells = row.map((cell) => runsText(cell.runs).trim())
      const text = cells.filter((cell) => cell.length > 0).join(' | ')
      if (text) out.push({ text, heading, kind: 'table' })
    }
  }

  return out
}

/** Splits a text into sentences that keep their punctuation. */
export function splitSentences(text: string): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (!cleaned) return []
  const parts = cleaned.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
  return parts.map((part) => part.trim()).filter((part) => part.length > 0)
}

/**
 * Cuts a document into parent and child chunks.
 */
export function chunkDocument(blocks: DocBlock[]): RagChunk[] {
  const chunks: RagChunk[] = []
  let index = 0

  // --- the parents: a heading and the paragraphs under it ---
  const groups: { heading: string; parts: string[] }[] = []
  let current: { heading: string; parts: string[] } | null = null

  for (const block of blocks) {
    if (block.kind === 'heading') {
      if (current) groups.push(current)
      current = { heading: block.text, parts: [] }
      continue
    }
    if (!current) current = { heading: '', parts: [] }
    current.parts.push(block.text)
  }
  if (current) groups.push(current)

  for (const group of groups) {
    let buffer: string[] = []
    let tokens = 0

    const flush = (): void => {
      if (buffer.length === 0) return
      const text = buffer.join('\n')
      const parentId = randomUUID()
      chunks.push({
        id: parentId,
        parentId: '',
        kind: 'parent',
        index,
        text,
        heading: group.heading,
        tokens: estimateTokens(text)
      })
      index++

      // The children: the sentences of the parent.
      let sentenceBuffer: string[] = []
      let sentenceTokens = 0
      const flushSentences = (): void => {
        if (sentenceBuffer.length === 0) return
        const sentenceText = sentenceBuffer.join(' ')
        chunks.push({
          id: randomUUID(),
          parentId,
          kind: 'child',
          index,
          text: sentenceText,
          heading: group.heading,
          tokens: estimateTokens(sentenceText)
        })
        index++
        sentenceBuffer = []
        sentenceTokens = 0
      }

      for (const part of buffer) {
        for (const sentence of splitSentences(part)) {
          const sentenceEstimate = estimateTokens(sentence)
          if (
            sentenceTokens > 0 &&
            sentenceTokens + sentenceEstimate > MAX_CHILD_TOKENS
          ) {
            flushSentences()
          }
          sentenceBuffer.push(sentence)
          sentenceTokens += sentenceEstimate
        }
      }
      flushSentences()

      buffer = []
      tokens = 0
    }

    for (const part of group.parts) {
      const partTokens = estimateTokens(part)
      if (tokens > 0 && tokens + partTokens > MAX_PARENT_TOKENS) flush()
      buffer.push(part)
      tokens += partTokens
    }
    flush()
  }

  return chunks
}

/**
 * The passages of a source, in reading order, one per child chunk.
 *
 * A source that is too short for a child chunk still gives one passage.
 */
export function passagesFromChunks(chunks: RagChunk[]): { chunk: RagChunk; parent: RagChunk }[] {
  const parents = new Map(chunks.filter((c) => c.kind === 'parent').map((c) => [c.id, c]))
  const out: { chunk: RagChunk; parent: RagChunk }[] = []

  for (const chunk of chunks) {
    if (chunk.kind !== 'child') continue
    const parent = parents.get(chunk.parentId)
    if (!parent) continue
    out.push({ chunk, parent })
  }

  return out
}

/**
 * The number of tokens a passage takes up: the parent that is read plus the
 * sentence that is in focus.
 */
export function passageTokens(parent: RagChunk, focus: string): number {
  return estimateTokens(parent.text) + estimateTokens(focus)
}
