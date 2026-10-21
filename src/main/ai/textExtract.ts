import { readFile } from 'fs/promises'
import { extname } from 'path'

export async function extractTextFromPath(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase()
  const buffer = await readFile(filePath)

  switch (ext) {
    case '.docx':
      return extractDocxText(buffer)
    case '.pdf':
      return extractPdfText(buffer)
    case '.txt':
      return buffer.toString('utf-8')
    case '.md':
      return buffer.toString('utf-8')
    default:
      return buffer.toString('utf-8')
  }
}

function extractDocxText(buffer: Buffer): string {
  const text: string[] = []
  const str = buffer.toString('latin1')

  const paragraphRegex = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g
  let match: RegExpExecArray | null
  while ((match = paragraphRegex.exec(str)) !== null) {
    const inner = match[1]
    const textMatch = /<w:t\b[^>]*>([^<]*)<\/w:t>/g
    let tm: RegExpExecArray | null
    while ((tm = textMatch.exec(inner)) !== null) {
      if (tm[1]) text.push(tm[1])
    }
    if (text.length > 0 && !text[text.length - 1].endsWith('\n')) {
      text.push('\n')
    }
  }

  return text.join('').replace(/\n{3,}/g, '\n\n').trim()
}

function extractPdfText(buffer: Buffer): string {
  const str = buffer.toString('latin1')
  const textRegex = /BT\s*(?:.*?)\s*Tj\s*(?:Tj\s*)*/g
  const texts: string[] = []
  let m: RegExpExecArray | null

  while ((m = textRegex.exec(str)) !== null) {
    const segment = m[0]
    const innerRegex = /\(([^)]*)\)/g
    let im: RegExpExecArray | null
    while ((im = innerRegex.exec(segment)) !== null) {
      const decoded = im[1].replace(/\\(\d{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
      texts.push(decoded)
    }
  }

  if (texts.length > 0) {
    return texts.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  }

  const fallback = str.match(/[A-Za-z0-9\s\.\,\?!;'":\(\)\-]+/g)
  if (fallback) {
    return fallback.join(' ').substring(0, 10000)
  }

  return ''
}
