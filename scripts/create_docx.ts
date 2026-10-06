import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import JSZip from 'jszip'
import { extractMarkdown } from '../src/main/import/markdown'

async function main(): Promise<void> {
  const mdPath = process.argv[2] ?? 'tests/fixtures/Sample_Quiz_Computer_Basics.md'
  const outPath = process.argv[3] ?? 'tests/fixtures/Sample_Quiz_Computer_Basics.docx'

  const { readFile } = await import('node:fs/promises')
  const text = await readFile(mdPath, 'utf8')
  const blocks = extractMarkdown(text)

  function blockToXml(block: { kind: 'paragraph'; heading?: number; runs: { text: string; bold: boolean; underline: boolean; highlight: boolean }[] } | { kind: 'table'; rows: { runs: { text: string; bold: boolean; underline: boolean; highlight: boolean }[] }[][] }): string {
    if (block.kind === 'paragraph') {
      const parts = block.runs.map((r) => wTap(r))
      return `<w:p>${parts.join('')}</w:p>`
    }
    const rows = block.rows.map((row) =>
      row.map((cell) => `<w:tc>${cell.runs.map((r) => wTap(r)).join('')}</w:tc>`).join('')
    )
    return `<w:tbl>${rows.join('')}</w:tbl>`
  }

  function wTap(r: { text: string; bold: boolean; underline: boolean; highlight: boolean }): string {
    const attrs: string[] = []
    if (r.bold) attrs.push('w:val="1"')
    if (r.underline) attrs.push('w:val="single"')
    if (r.highlight) attrs.push('w:val="yellow"')
    const attrStr = attrs.length ? ` w:rPr="${attrs.join(' ')}"` : ''
    return `<w:r><w:t${attrStr}>${escapeXml(r.text)}</w:t></w:r>`
  }

  function escapeXml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${blocks.map(blockToXml).join('')}
  </w:body>
</w:document>`

  const zip = new JSZip()
  zip.file('word/document.xml', xml)

  const dir = dirname(outPath)
  mkdirSync(dir, { recursive: true })
  writeFileSync(outPath, await zip.generateAsync({ type: 'nodebuffer' }))
  console.log(`wrote ${outPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
