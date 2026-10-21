import type { Chunk } from './types'
import { DEFAULT_CHUNK_TOKENS, DEFAULT_OVERLAP_TOKENS } from './types'

export { DEFAULT_CHUNK_TOKENS, DEFAULT_OVERLAP_TOKENS }

function splitMarkdownHeadings(text: string): { heading: string; content: string }[] {
  const lines = text.split(/\r?\n/)
  const sections: { heading: string; content: string }[] = []
  let currentHeading = 'Root'
  let currentContent: string[] = []

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line)
    if (match) {
      if (currentContent.length > 0) {
        sections.push({ heading: currentHeading, content: currentContent.join('\n') })
      }
      currentHeading = match[2].trim()
      currentContent = []
    } else {
      currentContent.push(line)
    }
  }
  if (currentContent.length > 0 || sections.length === 0) {
    sections.push({ heading: currentHeading, content: currentContent.join('\n') })
  }
  return sections
}

function splitIntoSentences(text: string): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (!cleaned) return []
  const sentences = cleaned.split(/(?<=[.?!])\s+/)
  return sentences.filter((s) => s.length > 0)
}

function countTokens(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return Math.ceil(trimmed.split(/\s+/).length / 4)
}

function chunkTextWithOverlap(
  text: string,
  maxTokens: number,
  overlapTokens: number
): Chunk[] {
  const sentences = splitIntoSentences(text)
  if (sentences.length === 0) return []

  const chunks: Chunk[] = []
  let currentSentences: string[] = []
  let currentTokens = 0

  for (const sentence of sentences) {
    const sentTokens = countTokens(sentence)
    if (currentTokens + sentTokens > maxTokens && currentSentences.length > 0) {
      chunks.push({
        text: currentSentences.join(' ').trim(),
        headingPath: []
      })
      const overlapSentences: string[] = []
      let overlapTokens = 0
      for (let i = currentSentences.length - 1; i >= 0; i--) {
        const sTokens = countTokens(currentSentences[i])
        if (overlapTokens + sTokens > overlapTokens) break
        overlapSentences.unshift(currentSentences[i])
        overlapTokens += sTokens
      }
      currentSentences = overlapSentences
      currentTokens = overlapTokens
    }
    currentSentences.push(sentence)
    currentTokens += sentTokens
  }

  if (currentSentences.length > 0) {
    chunks.push({
      text: currentSentences.join(' ').trim(),
      headingPath: []
    })
  }

  return chunks
}

export function chunkText(
  text: string,
  maxTokens: number = DEFAULT_CHUNK_TOKENS,
  overlapTokens: number = DEFAULT_OVERLAP_TOKENS
): Chunk[] {
  const sections = splitMarkdownHeadings(text)
  const chunks: Chunk[] = []

  for (const section of sections) {
    const sectionChunks = chunkTextWithOverlap(section.content, maxTokens, overlapTokens)
    if (sectionChunks.length === 0 && section.content.trim()) {
      chunks.push({
        text: section.content.trim(),
        headingPath: [section.heading]
      })
    } else {
      for (const chunk of sectionChunks) {
        chunk.headingPath = [section.heading]
        chunks.push(chunk)
      }
    }
  }

  if (chunks.length === 0 && text.trim()) {
    chunks.push({
      text: text.trim(),
      headingPath: ['Root']
    })
  }

  return chunks
}
