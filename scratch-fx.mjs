import { XMLParser } from 'fast-xml-parser'

const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
 <w:body>
  <w:p w:rsidR="abc"><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Sample Quiz: Computer Basics</w:t></w:r></w:p>
  <w:p><w:r><w:rPr><w:b/><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">Q1. </w:t></w:r><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>Mars</w:t></w:r></w:p>
  <w:tbl>
   <w:tr><w:tc><w:p><w:r><w:t>Column A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Answer or Connects to</w:t></w:r></w:p></w:tc></w:tr>
   <w:tr><w:tc><w:p><w:r><w:t>CPU</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>
  <w:p><w:r><w:t>plain</w:t></w:r></w:p>
 </w:body>
</w:document>`

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', preserveOrder: true, trimValues: false, parseTagValue: false })
const doc = parser.parse(xml)
console.log(JSON.stringify(doc, null, 2))
