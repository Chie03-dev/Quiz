#!/usr/bin/env node
/**
 * Self-contained screenshot capture using Puppeteer (headless Chrome).
 *
 * Builds the renderer, writes a mock HTML page with sample data into out/,
 * serves it, and captures each screen into shots/.
 *
 *   npx tsx scripts/shots-mock.ts
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { join } from 'node:path'
import puppeteer from 'puppeteer'

const ROOT = process.cwd()
const RENDERER_DIR = join(ROOT, 'out', 'renderer')
const SHOTS_DIR = join(ROOT, 'shots')
const MOCK_HTML = join(RENDERER_DIR, 'mock.html')

if (!existsSync(SHOTS_DIR)) mkdirSync(SHOTS_DIR, { recursive: true })

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

// ------------------------------------------------------------------
// Mock HTML content. Self-contained: no external dependency other than
// the built renderer assets sitting next to it.
// ------------------------------------------------------------------

const MOCK_HTML_CONTENT = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Quiz Instructor - Screenshots</title>
    <link rel="stylesheet" href="./assets/index-CrQT5uS0.css" />
    <style>
      body { margin: 0; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script>
      "use strict";
      /* Mock window.quiz for screenshot capture only. NOT shipped with the app. */
      var SAMPLE_PHOTO = { mime: 'image/jpeg', data: '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxAgMGDBEAwf/DQEEAQUFBQUFBf/DQEREQUFBQUFBf/EAB8BAAMBAQEBAQEBAQAAAAAAAAAAARECBiExBkFRYRMicRQygZGh8QVGR8RUjM2Lx/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AAABAwEBAQAAAAAAAAAAAAAAP//2Q==' };
      var memes = [{ id: 'm1', name: 'Sample Meme', mime: 'image/jpeg', width: 1024, height: 768, byteSize: 42000,
        thumb: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        createdAt: 1728000000000 }];
      var aiModels = [
        { id: 'qwen2.5-0.5b', name: 'Qwen2.5 0.5B', description: 'Small model for basic question generation.', sizeBytes: 300000000, fileName: 'qwen2.5-0.5b-q4_0.gguf', downloadUrl: 'https://example.com/qwen2.5-0.5b-q4_0.gguf', downloaded: true, version: '1', kind: 'chat', active: true },
        { id: 'qwen2.5-1.5b', name: 'Qwen2.5 1.5B', description: 'Medium model for broader coverage.', sizeBytes: 900000000, fileName: 'qwen2.5-1.5b-q4_0.gguf', downloadUrl: 'https://example.com/qwen2.5-1.5b-q4_0.gguf', downloaded: false, version: '1', kind: 'chat' },
        { id: 'phi3-mini', name: 'Phi-3 Mini', description: 'Efficient model for fast answering.', sizeBytes: 1200000000, fileName: 'phi3-mini-q4.gguf', downloadUrl: 'https://example.com/phi3-mini-q4.gguf', downloaded: true, version: '1', kind: 'chat' },
        { id: 'bge-small', name: 'BGE Small', description: 'Embedding search model.', sizeBytes: 25000000, fileName: 'bge-small.gguf', downloadUrl: 'https://example.com/bge-small.gguf', downloaded: true, version: '1', kind: 'embedding', active: true }
      ];
      var quizzes = [
        { id: 'q1', title: 'Computer Basics', timeLimitSec: 300, questionCount: 8, createdAt: 1728000000000, updatedAt: 1728000000000 },
        { id: 'q2', title: 'World Capitals', timeLimitSec: 600, questionCount: 12, createdAt: 1728010000000, updatedAt: 1728010000000 },
        { id: 'q3', title: 'Science Trivia', timeLimitSec: 180, questionCount: 5, createdAt: 1728020000000, updatedAt: 1728020000000 }
      ];
      var sampleQuiz = {
        id: 'q1', title: 'Computer Basics', timeLimitSec: 300, createdAt: 1728000000000, updatedAt: 1728000000000,
        questions: [
          { id: 'q1-1', type: 'mcq', body: 'Which planet is known as the Red Planet?', points: 1, sourceText: '', status: 'ready', data: { options: [{id:'a',text:'Venus'},{id:'b',text:'Mars'},{id:'c',text:'Jupiter'}] }, key: 'b' },
          { id: 'q1-2', type: 'tf', body: 'Water boils at 100 °C at sea level.', points: 1, sourceText: '', status: 'ready', data: {}, key: true },
          { id: 'q1-3', type: 'identification', body: 'Identify the capital of Japan.', points: 1, sourceText: '', status: 'ready', data: {}, key: ['Tokyo'] },
          { id: 'q1-4', type: 'fillin', body: 'The chemical symbol for gold is ___ and for silver it is ___.', points: 2, sourceText: '', status: 'ready', data: { blanks: 2 }, key: [['Au'],['Ag']] },
          { id: 'q1-5', type: 'enumeration', body: 'Name three primary colours.', points: 2, sourceText: '', status: 'ready', data: { count: 3 }, key: ['red','green','blue'] },
          { id: 'q1-6', type: 'problem', body: 'A shirt costs 20 € and is discounted by 25 %. What is the final price?', points: 3, sourceText: '', status: 'ready', data: {}, key: { answer: '15 €', tolerance: 0.5 } },
          { id: 'q1-7', type: 'matching', body: 'Match each animal to its food.', points: 3, sourceText: '', status: 'ready', data: { left: [{id:'l1',text:'cat'},{id:'l2',text:'bee'},{id:'l3',text:'cow'}], right: [{id:'r1',text:'grass'},{id:'r2',text:'nectar'},{id:'r3',text:'fish'}] }, key: { l1: 'r3', l2: 'r2', l3: 'r1' } },
          { id: 'q1-8', type: 'connect', body: 'Connect each prompt to its matching answer.', points: 3, sourceText: '', status: 'ready', data: { prompts: [{id:'p1',text:'Square'},{id:'p2',text:'Circle'},{id:'p3',text:'Triangle'}], answers: [{id:'a1',text:'Three sides'},{id:'a2',text:'Four equal sides'},{id:'a3',text:'No corners'},{id:'a4',text:'Decoy'}] }, key: { p1: 'a2', p2: 'a3', p3: 'a1' } }
        ]
      };
      var resultSessions = [
        { id: 'r1', quizId: 'q1', quizTitle: 'Computer Basics', startedAt: 1728100000000, endedAt: 1728102000000, endReason: 'time', totalPoints: 14, studentCount: 3, createdAt: 1728102000000 },
        { id: 'r2', quizId: 'q2', quizTitle: 'World Capitals', startedAt: 1728200000000, endedAt: 1728201500000, endReason: 'instructor', totalPoints: 12, studentCount: 5, createdAt: 1728201500000 }
      ];
      var sampleResultDetail = {
        meta: { id: 'r1', quizId: 'q1', quizTitle: 'Computer Basics', startedAt: 1728100000000, endedAt: 1728102000000, endReason: 'time', totalPoints: 14, studentCount: 3, createdAt: 1728102000000 },
        questions: [
          { id: 'rq1', sessionId: 'r1', questionId: 'q1-1', number: 1, type: 'mcq', body: 'Which planet is known as the Red Planet?', points: 1, data: sampleQuiz.questions[0].data, key: 'b' },
          { id: 'rq2', sessionId: 'r1', questionId: 'q1-2', number: 2, type: 'tf', body: 'Water boils at 100 °C at sea level.', points: 1, data: {}, key: true },
          { id: 'rq3', sessionId: 'r1', questionId: 'q1-3', number: 3, type: 'identification', body: 'Identify the capital of Japan.', points: 1, data: {}, key: ['Tokyo'] },
          { id: 'rq4', sessionId: 'r1', questionId: 'q1-4', number: 4, type: 'fillin', body: 'The chemical symbol for gold is ___ and for silver it is ___.', points: 2, data: { blanks: 2 }, key: [['Au'],['Ag']] }
        ],
        students: [
          { id: 'stu1', sessionId: 'r1', studentName: 'Alice', studentKey: 'tok1', finished: true, totalPointsAwarded: 11, totalPointsPossible: 14, studentPhoto: '',
            answers: [{ id: 'ans1', sessionId: 'r1', studentId: 'stu1', questionId: 'rq1', value: 'b', correct: true, pointsAwarded: 1, pointsPossible: 1, autoGraded: true, notes: null }, { id: 'ans2', sessionId: 'r1', studentId: 'stu1', questionId: 'rq2', value: true, correct: true, pointsAwarded: 1, pointsPossible: 1, autoGraded: true, notes: null }, { id: 'ans3', sessionId: 'r1', studentId: 'stu1', questionId: 'rq3', value: 'Tokyo', correct: true, pointsAwarded: 1, pointsPossible: 1, autoGraded: true, notes: null }, { id: 'ans4', sessionId: 'r1', studentId: 'stu1', questionId: 'rq4', value: ['Au','Ag'], correct: true, pointsAwarded: 2, pointsPossible: 2, autoGraded: true, notes: null }] },
          { id: 'stu2', sessionId: 'r1', studentName: 'Bob', studentKey: 'tok2', finished: true, totalPointsAwarded: 8, totalPointsPossible: 14, studentPhoto: JSON.stringify({mime:'image/jpeg',data:SAMPLE_PHOTO.data}),
            answers: [{ id: 'ans5', sessionId: 'r1', studentId: 'stu2', questionId: 'rq1', value: 'a', correct: false, pointsAwarded: 0, pointsPossible: 1, autoGraded: true, notes: null }, { id: 'ans6', sessionId: 'r1', studentId: 'stu2', questionId: 'rq2', value: false, correct: false, pointsAwarded: 0, pointsPossible: 1, autoGraded: true, notes: null }, { id: 'ans7', sessionId: 'r1', studentId: 'stu2', questionId: 'rq3', value: 'tokyo', correct: true, pointsAwarded: 1, pointsPossible: 1, autoGraded: true, notes: null }, { id: 'ans8', sessionId: 'r1', studentId: 'stu2', questionId: 'rq4', value: ['Au','Silver'], correct: false, pointsAwarded: 1, pointsPossible: 2, autoGraded: true, notes: null }] },
          { id: 'stu3', sessionId: 'r1', studentName: 'Carol', studentKey: 'tok3', finished: false, totalPointsAwarded: 5, totalPointsPossible: 14, studentPhoto: '',
            answers: [{ id: 'ans9', sessionId: 'r1', studentId: 'stu3', questionId: 'rq1', value: 'b', correct: true, pointsAwarded: 1, pointsPossible: 1, autoGraded: true, notes: null }, { id: 'ans10', sessionId: 'r1', studentId: 'stu3', questionId: 'rq2', value: true, correct: true, pointsAwarded: 1, pointsPossible: 1, autoGraded: true, notes: null }, { id: 'ans11', sessionId: 'r1', studentId: 'stu3', questionId: 'rq3', value: 'Kyoto', correct: false, pointsAwarded: 0, pointsPossible: 1, autoGraded: true, notes: null }, { id: 'ans12', sessionId: 'r1', studentId: 'stu3', questionId: 'rq4', value: null, correct: null, pointsAwarded: 0, pointsPossible: 2, autoGraded: false, notes: null }] }
        ]
      };
      var stateSnapshot = {
        server: { pin: '1234', port: 8080, addresses: ['192.168.1.100', '192.168.0.100'], selectedIp: '192.168.1.100' },
        students: [
          { id: 'stu1', name: 'Alice', status: 'connected', paused: false, pauseReason: null, focusLosses: 0, resumeRequested: false, finished: true, finishedAt: Date.now(), events: [{at: Date.now()-10000, type: 'finished'}], photo: SAMPLE_PHOTO },
          { id: 'stu2', name: 'Bob', status: 'connected', paused: true, pauseReason: 'focus', focusLosses: 2, resumeRequested: true, finished: false, finishedAt: null, events: [{at: Date.now()-20000, type: 'paused'}, {at: Date.now()-15000, type: 'focus_lost'}, {at: Date.now()-10000, type: 'resume_request'}], photo: undefined },
          { id: 'stu3', name: 'Carol', status: 'disconnected', paused: false, pauseReason: null, focusLosses: 0, resumeRequested: false, finished: false, finishedAt: null, events: [{at: Date.now()-5000, type: 'disconnect'}], photo: undefined }
        ],
        quiz: { status: 'lobby', title: 'Computer Basics', endsAt: Date.now() + 240000, timerPaused: false, remainingMs: 240000,
          questions: [{ qid: 'q1', type: 'mcq', body: 'Which planet is known as the Red Planet?', answered: 2 }, { qid: 'q2', type: 'tf', body: 'Water boils at 100 °C at sea level.', answered: 3 }, { qid: 'q3', type: 'identification', body: 'Identify the capital of Japan.', answered: 1 }],
          answeredByStudent: { stu1: 3, stu2: 1, stu3: 0 }, endReason: null },
        lockMode: true, meme: null
      };
      var subscribers = [];
      window.quiz = {
        getState: function() { return Promise.resolve(stateSnapshot); },
        newSession: function() { return Promise.resolve(stateSnapshot); },
        kick: function(id) { return Promise.resolve(true); },
        startQuiz: function(id) { return Promise.resolve({ ok: true }); },
        endQuiz: function() { return Promise.resolve(true); },
        setLock: function(on) { return Promise.resolve(true); },
        approveResume: function(id) { return Promise.resolve(true); },
        approveAllResume: function() { return Promise.resolve(1); },
        pauseTimer: function() { return Promise.resolve(true); },
        resumeTimer: function() { return Promise.resolve(true); },
        adjustTimer: function(delta) { return Promise.resolve(true); },
        selectIp: function(ip) { return Promise.resolve(true); },
        firewallStatus: function() { return Promise.resolve({ ok: false, missing: ['Quiz LAN Server','Quiz LAN Discovery'], unknown: [], supported: true }); },
        firewallInstall: function() { return Promise.resolve('installed'); },
        firewallManual: function() { return Promise.resolve([
          'netsh advfirewall firewall add rule name="Quiz LAN Server" dir=in action=allow protocol=TCP localport=8080-8089 profile=any',
          'netsh advfirewall firewall add rule name="Quiz LAN Discovery" dir=in action=allow protocol=UDP localport=5353 profile=any'
        ]); },
        firewallOpenSetup: function() { return Promise.resolve(true); },
        listQuizzes: function() { return Promise.resolve(quizzes); },
        getQuiz: function(id) { return Promise.resolve(sampleQuiz); },
        createQuiz: function(title) { return Promise.resolve({ id: 'new', title: title || 'Untitled Quiz', timeLimitSec: 300, createdAt: Date.now(), updatedAt: Date.now(), questions: [] }); },
        duplicateQuiz: function(id) { return Promise.resolve({ id: 'copy-'+id, title: 'Copy', timeLimitSec: 300, createdAt: Date.now(), updatedAt: Date.now(), questionCount: 8 }); },
        deleteQuiz: function(id) { return Promise.resolve(true); },
        saveQuiz: function(quiz) { return Promise.resolve({ ok: true, quiz: quiz }); },
        exportQuiz: function(id) { return Promise.resolve({ ok: true, path: '~/Quizzes/quiz.json' }); },
        importQuiz: function() { return Promise.resolve({ ok: false, error: 'No file selected', cancelled: true }); },
        listMemes: function() { return Promise.resolve(memes); },
        saveMeme: function(meme) { return Promise.resolve({ ok: true, meme: meme }); },
        deleteMeme: function(id) { return Promise.resolve(true); },
        memeData: function(id) { return Promise.resolve('data:image/jpeg;base64,' + SAMPLE_PHOTO.data); },
        popMeme: function(id) { return Promise.resolve({ ok: true, sent: 0 }); },
        hideMeme: function() { return Promise.resolve({ ok: true, sent: 0 }); },
        listResults: function() { return Promise.resolve(resultSessions); },
        getResult: function(id) { return Promise.resolve(sampleResultDetail); },
        deleteResult: function(id) { return Promise.resolve(true); },
        updateResultAnswer: function(input) { return Promise.resolve({ ok: true }); },
        saveCurrentResult: function() { return Promise.resolve({ id: 'r1', quizId: 'q1', quizTitle: 'Computer Basics', startedAt: 1728100000000, endedAt: 1728102000000, endReason: 'time', totalPoints: 14, studentCount: 3, createdAt: 1728102000000 }); },
        aiStatus: function() { return Promise.resolve({ ready: true, provider: 'stub', model: 'Built-in generator' }); },
        aiSelectFile: function() { return Promise.resolve(null); },
        aiReadFile: function(path) { return Promise.resolve('Chapter text...'); },
        aiGenerate: function(opts) { return Promise.resolve({ ok: false, error: 'Mock: not implemented', cancelled: false }); },
        aiAutoKey: function(questions) { return Promise.resolve({ questions: questions, error: undefined }); },
        aiTiming: function() { return Promise.resolve({ secondsPerQuestion: 6, startUpSeconds: 10, runs: 0 }); },
        onGenerateProgress: function(cb) { return function() {}; },
        aiModels: function() { return Promise.resolve(aiModels); },
        aiInfo: function() { return Promise.resolve({ modelsDir: '%APPDATA%/quiz-instructor/models', enginePath: null }); },
        aiDownloadModel: function(id) { return Promise.resolve({ ok: true, modelId: id }); },
        aiSetModel: function(id) { return Promise.resolve(true); },
        aiSetEmbeddingModel: function(id) { return Promise.resolve(true); },
        aiDeleteModel: function(id) { return Promise.resolve(true); },
        aiSetEngine: function(path) { return Promise.resolve(true); },
        aiSelectEngine: function() { return Promise.resolve(null); },
        onModelProgress: function(cb) { return function() {}; },
        onStateChanged: function(cb) { subscribers.push(cb); return function() { var idx = subscribers.indexOf(cb); if (idx >= 0) subscribers.splice(idx, 1); }; }
      };
    </script>
    <script type="module" src="./assets/index-CxZ5yPHv.js"></script>
  </body>
</html>`

const server = createServer((req, res) => {
  let path = decodeURIComponent(req.url?.split('?')[0] ?? '/mock.html')
  if (path === '/' || path === '') path = '/mock.html'
  const filePath = join(RENDERER_DIR, path)
  try {
    const content = readFileSync(filePath)
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream')
    res.end(content)
  } catch {
    res.statusCode = 404
    res.end('Not found')
  }
})

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function main(): Promise<void> {
  // Build the renderer
  console.log('Building renderer...')
  const build = spawn('npx', ['electron-vite', 'build', 'renderer'], { stdio: 'pipe', cwd: ROOT })
  build.stdout?.on('data', (d: Buffer) => process.stdout.write(d.toString()))
  build.stderr?.on('data', (d: Buffer) => process.stderr.write(d.toString()))
  await new Promise<void>((resolve, reject) => {
    build.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Build failed with code ${code}`)))
  })

  // Write mock HTML
  writeFileSync(MOCK_HTML, MOCK_HTML_CONTENT)
  console.log('Mock HTML written')

  // Start HTTP server
  await new Promise<void>((resolve) => server.listen(8081, resolve))
  console.log('Mock server on http://127.0.0.1:8081')

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })

  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })

  await page.goto('http://127.0.0.1:8081/mock.html', { waitUntil: 'networkidle0', timeout: 10000 })
  console.log('Page loaded, waiting for React to render...')
  await sleep(2000)

  const screenshot = async (name: string) => {
    await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`), fullPage: true })
    console.log(`wrote shots/${name}.png`)
  }

  // 1. Dashboard
  await page.click('[data-testid="nav-dashboard"]')
  await sleep(1000)
  await screenshot('1-dashboard')

  // 2. Quiz Library
  await page.click('[data-testid="nav-quizzes"]')
  await sleep(1000)
  await screenshot('2-library')

  // 3. Quiz Editor — open the first quiz
  await page.click('[data-testid="open-q1"]')
  await sleep(1000)
  await screenshot('3-editor')

  // 4. Results list — navigate to dashboard, then to results
  await page.click('[data-testid="nav-dashboard"]')
  await sleep(500)
  await page.click('[data-testid="nav-results"]')
  await sleep(1000)
  await screenshot('4-results')

  // 5. Score sheet — open the first saved session
  await page.click('[data-testid="open-result-r1"]')
  await sleep(1000)
  await screenshot('5-score-sheet')

  // 6. Settings
  await page.click('[data-testid="nav-settings"]')
  await sleep(1000)
  await screenshot('6-settings')

  await browser.close()
  server.close()
  console.log('Done!')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
