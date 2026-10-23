import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { QuestionType } from '../src/shared/types'
import { parseBlocks } from '../src/main/import/parser'
import { extractMarkdown } from '../src/main/import/markdown'
import { importQuizFile } from '../src/main/import'
import JSZip from 'jszip'

let passed = 0
let failed = 0

function ok(cond: boolean, msg: string): void {
  if (cond) {
    passed += 1
    console.log(`PASS ${msg}`)
  } else {
    failed += 1
    console.error(`FAIL ${msg}`)
  }
}

function countByType(questions: { type: QuestionType }[], type: QuestionType): number {
  return questions.filter((q) => q.type === type).length
}

/**
 * A minimal .docx with the given paragraphs, built here so the file the
 * importer reads is the file the test describes.
 */
async function buildDocx(paragraphs: string[], headings: number[] = []): Promise<Buffer> {
  const esc = (t: string): string =>
    t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const body = paragraphs
    .map((text, i) => {
      const style = headings.includes(i) ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' : ''
      return `<w:p>${style}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`
    })
    .join('')
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>'
  )
  zip.folder('_rels')!.file(
    '.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>'
  )
  zip.folder('word')!.file(
    'document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${body}</w:body></w:document>`
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

/** A minimal PDF with the given lines of text. */
function buildPdf(lines: string[]): Buffer {
  const esc = (t: string): string => t.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  const content = [
    'BT',
    '/F1 12 Tf',
    '72 720 Td',
    ...lines.flatMap((line, i) => [i === 0 ? `(${esc(line)}) Tj` : `0 -18 Td (${esc(line)}) Tj`]),
    'ET'
  ].join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'))
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefAt = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

function totalPoints(questions: { points: number }[]): number {
  return questions.reduce((sum, q) => sum + q.points, 0)
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url))
  const fixtures = join(here, '..', 'tests', 'fixtures')
  const docxPath = join(fixtures, 'Sample_Quiz_Computer_Basics.docx')
  const docxResult = await importQuizFile(docxPath, 'auto')
  ok(docxResult.ok, 'docx import succeeds')
  if (docxResult.ok) {
    const quiz = docxResult.quiz
    ok(quiz.title === 'Sample Quiz: Computer Basics', `docx title is the quiz title (got ${JSON.stringify(quiz.title)})`)
    ok(quiz.timeLimitSec === 20 * 60, `docx time limit is 20 minutes (got ${quiz.timeLimitSec}s)`)
    ok(quiz.questions.length === 16, 'docx import yields 16 questions')
    ok(totalPoints(quiz.questions) === 37, `docx import totals 37 points (got ${totalPoints(quiz.questions)})`)
    ok(countByType(quiz.questions, 'mcq') === 3, 'docx has 3 mcq questions')
    ok(countByType(quiz.questions, 'tf') === 3, 'docx has 3 tf questions')
    ok(countByType(quiz.questions, 'identification') === 2, 'docx has 2 identification questions')
    ok(countByType(quiz.questions, 'fillin') === 2, 'docx has 2 fillin questions')
    ok(countByType(quiz.questions, 'enumeration') === 2, 'docx has 2 enumeration questions')
    ok(countByType(quiz.questions, 'problem') === 2, 'docx has 2 problem questions')
    ok(countByType(quiz.questions, 'matching') === 1, 'docx has 1 matching question')
    ok(countByType(quiz.questions, 'connect') === 1, 'docx has 1 connect question')
    ok(
      quiz.questions.filter((q) => q.type === 'mcq').every((q) => typeof q.key === 'string' && q.key.length > 0),
      'every mcq has a marked option'
    )
    ok(
      quiz.questions.filter((q) => q.type === 'tf').every((q) => typeof q.key === 'boolean'),
      'every tf has a true/false key'
    )
    ok(
      quiz.questions
        .filter((q) => q.type === 'identification')
        .every((q) => Array.isArray(q.key) && (q.key as string[]).some((a) => a.trim().length > 0)),
      'every identification has an accepted answer'
    )
    ok(
      quiz.questions.filter((q) => q.type === 'fillin').every((q) => {
        const key = q.key as string[][]
        return Array.isArray(key) && key.length === 2 && key.every((b) => b.some((a) => a.trim().length > 0))
      }),
      'every fillin has two blanks with accepted answers'
    )
    ok(
      quiz.questions.filter((q) => q.type === 'enumeration').every((q) => q.data.count === 3),
      'every enumeration asks for 3 items'
    )
    const enums = quiz.questions.filter((q) => q.type === 'enumeration')
    ok(
      enums.length === 2 &&
        (enums[0].key as string[]).length === 5 &&
        (enums[1].key as string[]).length === 4,
      'enumeration pools are 5 and 4 accepted items'
    )
    ok(
      quiz.questions
        .filter((q) => q.type === 'problem')
        .every((q) => typeof (q.key as { answer?: unknown }).answer === 'string' && ((q.key as { answer: string }).answer.trim().length > 0)),
      'every problem has a final answer'
    )
    ok(
      quiz.questions.filter((q) => q.type === 'matching').every((q) => {
        const key = q.key as Record<string, string>
        return q.data.left?.length === 4 && q.data.right?.length === 5 && Object.keys(key).length === 4
      }),
      'matching table yields 4 pairs plus 1 extra right item'
    )
    ok(
      quiz.questions.filter((q) => q.type === 'connect').every((q) => {
        const key = q.key as Record<string, string>
        return q.data.prompts?.length === 4 && q.data.answers?.length === 5 && Object.keys(key).length === 4
      }),
      'connect table yields 4 pairs plus 1 decoy answer'
    )
    ok(docxResult.warnings.length === 0, `docx has no import warnings (got ${JSON.stringify(docxResult.warnings)})`)
  }

  // --- Geography College exam: a multi-page PDF that once imported as 69
  // mis-typed questions; it must come back as 45 questions (a matching section is
  // one set with 6 pairs) with every key resolved. ---
  const geoPath = join(here, '..', 'docs', 'geography_college_exam.pdf')
  const geoResult = await importQuizFile(geoPath, 'auto')
  ok(geoResult.ok, 'geography college exam imports')
  if (geoResult.ok) {
    const gq = geoResult.quiz.questions
    ok(gq.length === 45, `geography yields 45 questions (got ${gq.length})`)
    ok(countByType(gq, 'mcq') === 7, 'geography has 7 multiple choice questions')
    ok(countByType(gq, 'tf') === 6, 'geography has 6 true/false questions')
    ok(countByType(gq, 'identification') === 6, 'geography has 6 identification questions')
    ok(countByType(gq, 'fillin') === 6, 'geography has 6 fill-in questions')
    ok(countByType(gq, 'enumeration') === 6, 'geography has 6 enumeration questions')
    ok(countByType(gq, 'problem') === 6, 'geography has 6 problem-solving questions')
    ok(countByType(gq, 'matching') === 1, 'geography has 1 matching question (a 6-pair set)')
    ok(countByType(gq, 'connect') === 7, 'geography has 7 connect questions')
    ok(gq.every((q) => q.key !== null), 'geography has no unanswered keys')
    const mk = gq.find((q) => q.type === 'matching')?.key as Record<string, string> | undefined
    ok(!!mk && Object.keys(mk).length === 6, 'geography matching resolved all 6 pairs')
    const connectQs = gq.filter((q) => q.type === 'connect')
    ok(
      connectQs.length === 7 && connectQs.every((q) => Object.keys(q.key as Record<string, string>).length === 1),
      'each geography connect question resolved its pair'
    )
  }

  const zeroMarks = `Multiple Choice
Q1. What is 2 + 2?
A. 3
B. 4
`
  const zeroBlocks = extractMarkdown(zeroMarks)
  const zeroResult = parseBlocks(zeroBlocks, { markStyle: 'auto' })
  ok(
    zeroResult.warnings.some(
      (w) => w.message.includes('no choice is marked') || w.message.includes('not determined')
    ),
    'zero marks warns about missing answer'
  )

  const twoMarks = `Multiple Choice
Q1. What is 2 + 2?
**A. 3**
**B. 4**
`
  const twoBlocks = extractMarkdown(twoMarks)
  const twoResult = parseBlocks(twoBlocks, { markStyle: 'auto' })
  ok(
    twoResult.warnings.some((w) => w.message.includes('two or more choices are marked')),
    'two marks warns that the key is blank'
  )

  const keyOnly = `Multiple Choice
Q1. Test?

Answers
1. A
2. B
`
  const keyBlocks = extractMarkdown(keyOnly)
  const keyResult = parseBlocks(keyBlocks, { markStyle: 'auto' })
  ok(
    keyResult.quiz.questions[0].key === null || keyResult.quiz.questions[0].key === '',
    'answer key only leaves the mcq key empty'
  )
  ok(keyResult.warnings.some((w) => w.message.includes('not determined') || w.message.includes('no choice is marked')), 'answer key only warns that key is undetermined')

  const missingTable = `Connect
Match the device with its connection.

Keyboard
Mouse
`
  const missingBlocks = extractMarkdown(missingTable)
  const missingResult = parseBlocks(missingBlocks, { markStyle: 'auto' })
  ok(missingResult.warnings.some((w) => w.message.includes('no table') || w.message.includes('unrecognized')), 'missing table warns')

  // --- 2-column plain tables: the common shape real files use ---
  const twoColMatching = `Matching
Match each country with its capital.

| France | Paris |
| ------ | ----- |
| Italy | Rome |
`
  const twoColBlocks = extractMarkdown(twoColMatching)
  const twoColResult = parseBlocks(twoColBlocks, { markStyle: 'auto' })
  const twoColQ = twoColResult.quiz.questions.find((q) => q.type === 'matching')
  ok(!!twoColQ && (twoColQ.data.left?.length ?? 0) === 2, '2-column matching yields 2 left items')
  ok(!!twoColQ && (twoColQ.data.right?.length ?? 0) === 2, '2-column matching yields 2 right items')
  ok(
    !!twoColQ && Object.keys(twoColQ.key as Record<string, string>).length === 2,
    '2-column matching pairs each row by position'
  )

  const twoColConnect = `Connect
Connect the device to its port.

| Keyboard | USB-A |
| -------- | ----- |
| Mouse | USB-C |
`
  const twoColConnectBlocks = extractMarkdown(twoColConnect)
  const twoColConnectResult = parseBlocks(twoColConnectBlocks, { markStyle: 'auto' })
  const twoColConnectQ = twoColConnectResult.quiz.questions.find((q) => q.type === 'connect')
  ok(!!twoColConnectQ && (twoColConnectQ.data.prompts?.length ?? 0) === 2, '2-column connect yields 2 prompts')
  ok(!!twoColConnectQ && (twoColConnectQ.data.answers?.length ?? 0) === 2, '2-column connect yields 2 answers')
  ok(
    !!twoColConnectQ && Object.keys(twoColConnectQ.key as Record<string, string>).length === 2,
    '2-column connect pairs each row by position'
  )

  // --- a printed exam: no question numbers, no letters on the choices ---
  const printedDir = mkdtempSync(join(tmpdir(), 'quiz-printed-'))
  try {
    const printedDocx = join(printedDir, 'printed.docx')
    writeFileSync(
      printedDocx,
      await buildDocx(
        [
          'ADVANCED DATABASE',
          'Name: ____________    Date: ____________',
          'MULTIPLE CHOICE',
          'Which statement best describes data?',
          'Processed results that already have meaning',
          'Raw facts that have not yet been processed',
          'A visual representation of a database',
          'A connection between two tables',
          'What is the main purpose of a database?',
          'To design the appearance of an application',
          'To store, organize and manage related data',
          'To replace every application program'
        ],
        [2]
      )
    )
    const printedResult = await importQuizFile(printedDocx, 'auto')
    ok(printedResult.ok, 'a printed exam imports')
    if (printedResult.ok) {
      const printed = printedResult.quiz
      ok(printed.questions.length === 2, `a printed exam yields 2 questions (got ${printed.questions.length})`)
      const first = printed.questions[0]
      ok(first.type === 'mcq', 'a printed exam yields multiple choice questions')
      ok(
        (first.data.options ?? []).length === 4,
        `a printed exam yields the 4 choices under the question (got ${(first.data.options ?? []).length})`
      )
      ok(
        (first.data.options ?? []).every((o) => o.text.length > 0),
        'the choices of a printed exam carry their text'
      )
      ok(first.key === null, 'a printed exam comes in without a key')
      ok(
        printedResult.warnings.length === 1 &&
          printedResult.warnings[0]?.message.includes('no answer keys'),
        'a printed exam says once that the keys are missing'
      )
    }

    // The same exam as a PDF.
    const printedPdf = join(printedDir, 'printed.pdf')
    writeFileSync(
      printedPdf,
      buildPdf([
        'Database exam',
        'What is a primary key?',
        'It identifies a record uniquely',
        'It is a column of text',
        'It links two tables',
        'It stores the file name',
        'What is a foreign key?',
        'It links a row to a key in another table',
        'It is a column of text',
        'It identifies a record uniquely',
        'It stores the file name'
      ])
    )
    const pdfResult = await importQuizFile(printedPdf, 'auto')
    ok(pdfResult.ok, 'a PDF exam imports')
    if (pdfResult.ok) {
      ok(
        pdfResult.quiz.questions.length === 2,
        `a PDF exam yields 2 questions (got ${pdfResult.quiz.questions.length})`
      )
      ok(
        (pdfResult.quiz.questions[0]?.data.options ?? []).length === 4,
        'a PDF exam yields the 4 choices under the question'
      )
      const lastPdfOptions = pdfResult.quiz.questions[pdfResult.quiz.questions.length - 1]?.data.options ?? []
      ok(
        lastPdfOptions.length === 4,
        `the page marker of the PDF is not read as a choice (got ${lastPdfOptions.length} choices)`
      )
    }

    // A PDF that is not a PDF at all.
    const brokenPdf = join(printedDir, 'broken.pdf')
    writeFileSync(brokenPdf, 'this is not a pdf')
    const brokenResult = await importQuizFile(brokenPdf, 'auto')
    ok(!brokenResult.ok, 'a broken PDF returns an error')
  } finally {
    rmSync(printedDir, { recursive: true, force: true })
  }

  const corruptedDir = mkdtempSync(join(tmpdir(), 'quiz-import-'))
  try {
    const corruptedDocx = join(corruptedDir, 'corrupted.docx')
    writeFileSync(corruptedDocx, Buffer.from('this is not a zip file'))
    const corruptedResult = await importQuizFile(corruptedDocx, 'auto')
    ok(!corruptedResult.ok, 'corrupted docx returns an error')
    ok(corruptedResult.ok === false && typeof corruptedResult.error === 'string' && corruptedResult.error.length > 0, 'corrupted docx returns a readable message')
  } finally {
    rmSync(corruptedDir, { recursive: true, force: true })
  }

  const oversizedDir = mkdtempSync(join(tmpdir(), 'quiz-import-'))
  try {
    const oversizedFile = join(oversizedDir, 'big.md')
    writeFileSync(oversizedFile, 'a'.repeat(21 * 1024 * 1024))
    const oversizedResult = await importQuizFile(oversizedFile, 'auto')
    ok(!oversizedResult.ok, 'oversized md file is rejected')
  } finally {
    rmSync(oversizedDir, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main()
