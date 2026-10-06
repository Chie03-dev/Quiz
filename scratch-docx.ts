import JSZip from 'jszip'
import { blocksFromDocxBuffer, parseDocumentXml } from './src/main/import/docx'
import { runsText } from './src/main/import/types'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

function p(text: string, opts: { style?: string; u?: boolean; b?: boolean; hl?: boolean } = {}): string {
  const pPr = opts.style ? `<w:pPr><w:pStyle w:val="${opts.style}"/></w:pPr>` : ''
  const rPr =
    opts.u || opts.b || opts.hl
      ? `<w:rPr>${opts.b ? '<w:b/>' : ''}${opts.u ? '<w:u w:val="single"/>' : ''}${
          opts.hl ? '<w:highlight w:val="yellow"/>' : ''
        }</w:rPr>`
      : ''
  return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
}

// two runs in one paragraph: plain stem + underlined answer
function pTwoRuns(a: string, b: string, uB: boolean): string {
  const rPrB = uB ? '<w:rPr><w:u w:val="single"/></w:rPr>' : ''
  return `<w:p><w:r><w:t xml:space="preserve">${a}</w:t></w:r><w:r>${rPrB}<w:t xml:space="preserve">${b}</w:t></w:r></w:p>`
}

const table = `<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>Column A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Answer or Connects to</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Column B</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>CPU</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>A. brain</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t> </w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>C</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>C. decoy</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>`

const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
${p('Sample Quiz: Computer Basics', { style: 'Title' })}
${p('Time limit: 20 minutes')}
${p('Multiple Choice (2 points each)', { style: 'Heading1' })}
${p('1. What does CPU stand for?', { b: true })}
${p('A. Central Processing Unit', { u: true })}
${p('B. Computer Personal Unit')}
${pTwoRuns('2. The brain of the computer is the ', 'CPU.', true)}
${p('True or False (1 point each)', { style: 'Heading1' })}
${pTwoRuns('3. Water boils at 100 C. ', 'True', true)}
${p('Identification (2 points each)', { style: 'Heading1' })}
${pTwoRuns('4. Capital of France? Answer: ', 'Paris', true)}
${table}
</w:body></w:document>`

async function main(): Promise<void> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>')
  zip.file('word/document.xml', xml)
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0"?><Relationships/>')
  const buf = await zip.generateAsync({ type: 'nodebuffer' })
  console.log('zip bytes', buf.byteLength)
  const blocks = await blocksFromDocxBuffer(buf)
  for (const b of blocks) {
    if (b.kind === 'paragraph') {
      console.log(`P${b.heading ?? '-'} | ${JSON.stringify(runsText(b.runs))} | runs=${b.runs.length}` , b.runs.map(r=>`${JSON.stringify(r.text)}${r.bold?'B':''}${r.underline?'U':''}${r.highlight?'H':''}`).join(' '))
    } else {
      console.log(`T rows=${b.rows.length} | ` + b.rows.map(r=>r.map(c=>runsText(c.runs)).join(' | ')).join(' // '))
    }
  }
  // direct parse too
  console.log('--- direct ---')
  const direct = parseDocumentXml(xml)
  console.log('blocks', direct.length)
}

main().catch((e) => { console.error(e); process.exit(1) })
