/**
 * .docx extractor: reads word/document.xml with jszip + fast-xml-parser and
 * produces the neutral blocks the shared parser consumes.
 *
 * We walk the raw OOXML ourselves instead of using a high-level docx library
 * because those tend to collapse underline and highlight, which are exactly the
 * marks the parser needs to find answer keys.
 */
import { readFile, stat } from 'node:fs/promises'
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import type { Block, Cell, Paragraph, Run, Table } from './types'
import { makeRun, splitRunsAtNewlines, tidyRuns } from './types'
import {
  ImportError,
  MAX_DOC_XML_CHARS,
  MAX_FILE_BYTES,
  MAX_TOTAL_UNCOMPRESSED,
  MAX_ZIP_ENTRIES
} from './errors'

/** preserveOrder keeps document order (paragraphs and tables interleaved). */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
  trimValues: false,
  parseTagValue: false,
  processEntities: false,
  ignoreDeclaration: false
})

type XmlNode = Record<string, unknown>

const isText = (n: XmlNode): boolean => typeof n['#text'] === 'string'
const textOf = (n: XmlNode): string => (n['#text'] as string) ?? ''

/** Children of the element `tag` inside `n`, or null when absent. */
function tagChildren(n: XmlNode, tag: string): XmlNode[] | null {
  const v = n[tag]
  return Array.isArray(v) ? (v as XmlNode[]) : null
}

/** Attribute value by local name; OOXML keeps the `w:` namespace prefix. */
function attr(n: XmlNode, local: string): string | undefined {
  const attrs = n[':@'] as Record<string, unknown> | undefined
  if (!attrs) return undefined
  const v = attrs[`@_w:${local}`] ?? attrs[`@_${local}`]
  if (v === undefined || v === null) return undefined
  return typeof v === 'string' ? v : String(v)
}

/** `w:val` attributes are "off" only for these explicit negative values. */
function propOn(n: XmlNode): boolean {
  const val = attr(n, 'val')
  return !(val !== undefined && /^(0|false|none|off)$/i.test(val))
}

interface Marks {
  bold: boolean
  underline: boolean
  highlight: boolean
}

function readRunProperties(rPr: XmlNode[]): Marks {
  const marks: Marks = { bold: false, underline: false, highlight: false }
  for (const child of rPr) {
    if (isText(child)) continue
    if ('w:b' in child) marks.bold = propOn(child)
    else if ('w:bCs' in child) marks.bold = marks.bold || propOn(child)
    else if ('w:u' in child) marks.underline = propOn(child)
    else if ('w:uCs' in child) marks.underline = marks.underline || propOn(child)
    else if ('w:highlight' in child) marks.highlight = propOn(child)
  }
  return marks
}

/** Collects the runs of one `w:r`, resolving its formatting first. */
function readRun(rChildren: XmlNode[], out: Run[]): void {
  let marks: Marks = { bold: false, underline: false, highlight: false }
  for (const child of rChildren) {
    if (isText(child)) continue
    if ('w:rPr' in child) {
      const rPr = tagChildren(child, 'w:rPr')
      if (rPr) marks = readRunProperties(rPr)
    }
  }
  for (const child of rChildren) {
    if (isText(child)) continue
    if ('w:t' in child) {
      const t = tagChildren(child, 'w:t')
      if (t) out.push(makeRun(t.filter(isText).map(textOf).join(''), marks))
    } else if ('w:tab' in child) {
      out.push(makeRun(' ', marks))
    } else if ('w:br' in child || 'w:cr' in child) {
      out.push(makeRun('\n', marks))
    } else if ('w:softHyphen' in child || 'w:noBreakHyphen' in child) {
      out.push(makeRun('-', marks))
    }
    // w:instrText, w:delText, proofing marks and the like contribute nothing.
  }
}

/** Walks a paragraph's children, recursing through wrappers that hold runs. */
function walkRuns(nodes: XmlNode[], out: Run[]): void {
  for (const node of nodes) {
    if (isText(node)) continue // raw whitespace between elements
    if ('w:r' in node) {
      const kids = tagChildren(node, 'w:r')
      if (kids) readRun(kids, out)
    } else if ('w:hyperlink' in node || 'w:smartTag' in node || 'w:ins' in node || 'w:fldSimple' in node) {
      const tag = ['w:hyperlink', 'w:smartTag', 'w:ins', 'w:fldSimple'].find((t) => t in node)
      const kids = tag ? tagChildren(node, tag) : null
      if (kids) walkRuns(kids, out)
    }
    // w:pPr, bookmarks, proofing errors and everything else are skipped.
  }
}
/** Heading level from `w:pPr/w:pStyle`, or undefined for a normal paragraph. */
function paragraphHeading(pChildren: XmlNode[]): number | undefined {
  for (const node of pChildren) {
    if (isText(node) || !('w:pPr' in node)) continue
    const pPr = tagChildren(node, 'w:pPr')
    if (!pPr) continue
    for (const child of pPr) {
      if (isText(child) || !('w:pStyle' in child)) continue
      const val = attr(child, 'val')
      if (!val) continue
      const level = headingLevel(val)
      if (level !== undefined) return level
    }
  }
  return undefined
}

/** Maps a Word style id ("Title", "Heading 1", ...) to a heading level. */
function headingLevel(style: string): number | undefined {
  const s = style.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (s === 'title' || s === 'subtitle' || s === 'subtitlecharacter') return 0
  const m = s.match(/^heading([1-9])$/)
  if (m) return Number(m[1])
  return undefined
}

function paragraphBlock(pChildren: XmlNode[]): Block[] {
  const runs: Run[] = []
  walkRuns(pChildren, runs)
  const heading = paragraphHeading(pChildren)
  const tidy = tidyRuns(runs)
  // One paragraph can hold `w:br` line breaks; split so a block is one line.
  return splitRunsAtNewlines(tidy).map((line): Paragraph => {
    const block: Paragraph = { kind: 'paragraph', runs: line }
    if (heading !== undefined) block.heading = heading
    return block
  })
}

function cellBlock(tcChildren: XmlNode[]): Cell {
  const runs: Run[] = []
  for (const node of tcChildren) {
    if (isText(node)) continue
    if ('w:p' in node) {
      const kids = tagChildren(node, 'w:p')
      if (kids) walkRuns(kids, runs)
    } else if ('w:r' in node) {
      const kids = tagChildren(node, 'w:r')
      if (kids) readRun(kids, runs)
    }
  }
  // A cell rarely spans lines; if it does, join with a space.
  return { runs: tidyRuns(runs.map((r) => makeRun(r.text.replace(/\n/g, ' '), r))) }
}

function tableBlock(tblChildren: XmlNode[]): Block {
  const rows: Cell[][] = []
  for (const node of tblChildren) {
    if (isText(node) || !('w:tr' in node)) continue
    const tr = tagChildren(node, 'w:tr')
    if (!tr) continue
    const cells: Cell[] = []
    for (const row of tr) {
      if (isText(row) || !('w:tc' in row)) continue
      const tc = tagChildren(row, 'w:tc')
      if (tc) cells.push(cellBlock(tc))
    }
    if (cells.length > 0) rows.push(cells)
  }
  const table: Table = { kind: 'table', rows }
  return table
}

/** Parses word/document.xml text into ordered blocks. */
export function parseDocumentXml(xml: string): Block[] {
  if (xml.length > MAX_DOC_XML_CHARS) {
    throw new ImportError('this .docx contains far too much text to import')
  }
  let doc: XmlNode[]
  try {
    doc = parser.parse(xml) as XmlNode[]
  } catch (err) {
    throw new ImportError(
      `this .docx has unreadable document.xml (${err instanceof Error ? err.message : String(err)})`
    )
  }
  const document = doc.find((n) => 'w:document' in n)
  const body = document ? tagChildren(document, 'w:document')?.find((n) => 'w:body' in n) : null
  const bodyChildren = body ? tagChildren(body, 'w:body') : null
  if (!bodyChildren) throw new ImportError('this .docx has no document body')

  const blocks: Block[] = []
  for (const node of bodyChildren) {
    if (isText(node)) continue
    if ('w:p' in node) {
      const kids = tagChildren(node, 'w:p')
      if (kids) blocks.push(...paragraphBlock(kids))
    } else if ('w:tbl' in node) {
      const kids = tagChildren(node, 'w:tbl')
      if (kids) blocks.push(tableBlock(kids))
    }
    // w:sectPr and friends are ignored.
  }
  return blocks
}
function zipBombCheck(zip: JSZip): void {
  const entries = Object.entries(zip.files)
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new ImportError(`this .docx holds ${entries.length} entries, which is too many to open safely`)
  }
  // uncompressedSize comes from the zip directory, so this never inflates.
  let total = 0
  for (const [, file] of entries) {
    const size = (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize
    if (typeof size === 'number') total += size
  }
  if (total > MAX_TOTAL_UNCOMPRESSED) {
    throw new ImportError(
      `this .docx claims ${Math.round(total / (1024 * 1024))} MB uncompressed, which is too large to open safely`
    )
  }
}

/** Reads a .docx buffer into ordered blocks. Never follows external resources. */
export async function blocksFromDocxBuffer(buffer: Buffer): Promise<Block[]> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buffer, { checkCRC32: false, createFolders: false })
  } catch (err) {
    throw new ImportError(
      `this file is not a readable .docx package (${err instanceof Error ? err.message : String(err)})`
    )
  }
  zipBombCheck(zip)
  const entry = zip.file('word/document.xml')
  if (!entry) throw new ImportError('this .docx has no word/document.xml part')
  const xml = await entry.async('string')
  if (xml.length > MAX_DOC_XML_CHARS) {
    throw new ImportError('this .docx contains far too much text to import')
  }
  return parseDocumentXml(xml)
}

/** Reads a .docx file from disk into ordered blocks. */
export async function extractDocx(filePath: string): Promise<Block[]> {
  // stat first, so an oversized file is never loaded into memory.
  const info = await stat(filePath).catch(() => null)
  if (!info) throw new ImportError('the file could not be found')
  if (info.size > MAX_FILE_BYTES) {
    throw new ImportError(
      `the file is ${(info.size / (1024 * 1024)).toFixed(1)} MB, larger than the 20 MB limit`
    )
  }
  let buffer: Buffer
  try {
    buffer = await readFile(filePath)
  } catch (err) {
    throw new ImportError(`the file could not be read (${err instanceof Error ? err.message : String(err)})`)
  }
  return blocksFromDocxBuffer(buffer)
}


