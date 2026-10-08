import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
