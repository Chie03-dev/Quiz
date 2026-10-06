import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QuestionType } from '../src/shared/types'
import { parseBlocks } from '../src/main/import/parser'
import { extractMarkdown } from '../src/main/import/markdown'
import { importQuizFile } from '../src/main/import'

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

function totalPoints(questions: { points: number }[]): number {
  return questions.reduce((sum, q) => sum + q.points, 0)
}

async function main(): Promise<void> {
  const fixtures = join(__dirname, '..', 'tests', 'fixtures')
  const mdPath = join(fixtures, 'Sample_Quiz_Computer_Basics.md')
  const mdText = readFileSync(mdPath, 'utf8')
  const mdBlocks = extractMarkdown(mdText)
  const mdResult = parseBlocks(mdBlocks, { markStyle: 'auto' })
  const mdQuiz = mdResult.quiz

  ok(mdQuiz.questions.length === 16, 'sample markdown parses into 16 questions')
  ok(totalPoints(mdQuiz.questions) === 37, 'sample markdown totals 37 points')
  ok(countByType(mdQuiz.questions, 'mcq') === 5, 'sample has 5 mcq questions')
  ok(countByType(mdQuiz.questions, 'tf') === 3, 'sample has 3 tf questions')
  ok(countByType(mdQuiz.questions, 'identification') === 2, 'sample has 2 identification questions')
  ok(countByType(mdQuiz.questions, 'fillin') === 2, 'sample has 2 fillin questions')
  ok(countByType(mdQuiz.questions, 'enumeration') === 1, 'sample has 1 enumeration question')
  ok(countByType(mdQuiz.questions, 'problem') === 1, 'sample has 1 problem question')
  ok(countByType(mdQuiz.questions, 'matching') === 1, 'sample has 1 matching question')
  ok(countByType(mdQuiz.questions, 'connect') === 1, 'sample has 1 connect question')
  ok(mdQuiz.questions.every((q) => q.key !== null), 'every sample question has a complete key')
  ok(
    mdQuiz.questions.filter((q) => q.type === 'matching').every((q) =>
      q.data.left?.length === 4 && q.data.right?.length === 5 && (q.key as Record<string, string>).length === 4
    ),
    'matching table yields 4 pairs plus 1 decoy'
  )
  ok(
    mdQuiz.questions.filter((q) => q.type === 'connect').every((q) =>
      q.data.prompts?.length === 4 && q.data.answers?.length === 5 && (q.key as Record<string, string>).length === 4
    ),
    'connect table yields 4 pairs plus 1 decoy'
  )
  ok(mdResult.warnings.length === 0, 'sample has no import warnings')

  const docxPath = join(fixtures, 'Sample_Quiz_Computer_Basics.docx')
  const docxResult = await importQuizFile(docxPath, 'auto')
  ok(docxResult.ok, 'docx import succeeds')
  if (docxResult.ok) {
    ok(docxResult.quiz.questions.length === 16, 'docx import yields 16 questions')
    ok(totalPoints(docxResult.quiz.questions) === 37, 'docx import totals 37 points')
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
  ok(keyResult.warnings.some((w) => w.message.includes('not determined')), 'answer key only warns that key is undetermined')

  const missingTable = `Connect
Match the device with its connection.

Keyboard
Mouse
`
  const missingBlocks = extractMarkdown(missingTable)
  const missingResult = parseBlocks(missingBlocks, { markStyle: 'auto' })
  ok(missingResult.warnings.some((w) => w.message.includes('no table') || w.message.includes('unrecognized')), 'missing table warns')

  const corruptedDir = mkdtempSync(join(tmpdir(), 'quiz-import-'))
  try {
    const corruptedDocx = join(corruptedDir, 'corrupted.docx')
    writeFileSync(corruptedDocx, Buffer.from('this is not a zip file'))
    const corruptedResult = await importQuizFile(corruptedDocx, 'auto')
    ok(!corruptedResult.ok, 'corrupted docx returns an error')
    ok(typeof corruptedResult.error === 'string' && corruptedResult.error.length > 0, 'corrupted docx returns a readable message')
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
