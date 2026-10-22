/**
 * End-to-end check of the step-1 protocol against a real Fastify + WebSocket server.
 *
 *   npm run check
 *
 * Not part of the app; it only imports the server module.
 */
import WebSocket from 'ws'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import JSZip from 'jszip'
import { startServer } from '../src/main/server'
import { isValidAnswer, toPublicQuestions } from '../src/main/server/quizRun'
import { SAMPLE_QUIZ } from '../src/main/sampleQuiz'
import { openAppData, openQuizLibrary, runtimeQuizForStart, type MemeStore, type QuizLibrary, type ResultsStore } from '../src/main/db'
import { gradeAnswer, type ResultQuestionInput } from '../src/main/db/results'
import { buildSessionSnapshot, snapshotQuestions } from '../src/main/results/session'
import { buildPopPayload, MemeAssets, MEME_FILE_PATTERN, seedSampleMeme } from '../src/main/memes/store'
import { parseQuizJson, serializeQuiz, toRuntimeQuiz } from '../src/main/quizFormat'
import { createAiManager, AVAILABLE_MODELS, ModelStore } from '../src/main/ai'
import { AiManager } from '../src/main/ai/manager'
import { extractTextFromPath } from '../src/main/ai/textExtract'
import {
  GgufProvider,
  extractJsonArray,
  isQuestion,
  isCopy,
  sharesWithSource,
  groundedAnswer,
  sameFact,
  containsPhrase,
  mentionsText,
  repeatsTheQuestion,
  numberInBody
} from '../src/main/ai/ggufProvider'
import { splitFacts } from '../src/main/ai/prompts'
import {
  chunkDocument,
  blocksToDocBlocks,
  contentWords,
  estimateTokens,
  splitSentences,
  MAX_CHILD_TOKENS
} from '../src/main/ai/rag/chunking'
import {
  maximalMarginalRelevance,
  reciprocalRankFusion,
  assembleContext,
  spread
} from '../src/main/ai/rag/retrieval'
import { cosineSimilarity, toBlob, fromBlob } from '../src/main/db/aiChunks'
import {
  adviseAnswer,
  answersMatch,
  compareAnswers,
  editDistance,
  normalizeAnswer,
  normalizeAnswerTight,
  suggestAnswer
} from '../src/shared/answers'
import { quizStartError, validateQuestion } from '../src/shared/validation'
import { buildCheckArgs, buildCheckScript, buildInstallCommand, buildInstallCommands, CHECK_OPTIONS, classifyCheckOutput, encodePowerShell, FIREWALL_RULES, FIREWALL_PROFILE, parseCheckOutput } from '../src/main/firewall'
import { FIRST_PORT, MAX_PORT, PORT_RANGE, QUESTION_TYPES, type QuestionType, type Quiz, type ResultSessionMeta, type StoredQuestion, type StoredQuiz, type StudentInfo } from '../src/shared/types'


/**
 * On Windows, SQLite files are not always released immediately after a
 * Database.close(); swallow EPERM so the check suite can keep going, since
 * the OS cleans up temp files eventually.
 */
function safeRmSync(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
  } catch {
    // non-fatal: temp directory will be cleaned up by the OS
  }
}

/** The reasons the sessions of the live server ended, in order. */
const endedReasons: string[] = []

/** The result session of the last finished run of the live server. */
let liveResult: ResultSessionMeta | null = null

/** The store the live server's sessions are saved into. */
let liveResults: ResultsStore

/**
 * The main process's own step when a quiz ends: snapshot the session into
 * the results store. Mirrors persistResults() in src/main/index.ts.
 */
function saveLiveResult(
  store: ResultsStore,
  server: any,
  reason: 'time' | 'instructor'
): ResultSessionMeta | null {
  const snapshot = buildSessionSnapshot({
    quiz: null,
    runtime: server.session.quizSnapshot(),
    quizTitle: server.session.quizState().title ?? 'Quiz',
    startedAt: null,
    endedAt: Date.now(),
    endReason: reason,
    students: server.session.list(),
    answers: server.session.answersSnapshot()
  })
  if (!snapshot.questions.length) return null
  return store.createFromSession(snapshot)
}

/**
 * Firewall command building. Pure string work only: these tests never run
 * netsh and never trigger an elevation prompt.
 */
function checkFirewallCommands(): void {
  const server = FIREWALL_RULES.find((r) => r.name === 'Quiz LAN Server')
  const discovery = FIREWALL_RULES.find((r) => r.name === 'Quiz LAN Discovery')

  log(!!server, 'a "Quiz LAN Server" rule is defined')
  log(!!discovery, 'a "Quiz LAN Discovery" rule is defined')
  log(server?.protocol === 'TCP', 'the server rule allows TCP')
  log(discovery?.protocol === 'UDP', 'the discovery rule allows UDP')
  log(discovery?.port === '5353', 'the discovery rule uses mDNS port 5353')

  // The firewall range must cover every port the server can ever bind.
  log(
    server?.port === PORT_RANGE && PORT_RANGE === `${FIRST_PORT}-${MAX_PORT}`,
    `the server rule covers the shared port range (${PORT_RANGE})`
  )
  log(
    MAX_PORT >= FIRST_PORT && server!.port === `${FIRST_PORT}-${MAX_PORT}`,
    'the firewall range matches the ports the server tries'
  )

  // The command itself.
  const cmd = buildInstallCommand(FIREWALL_RULES)
  log(cmd.includes('name="Quiz LAN Server"'), 'install command names the server rule')
  log(cmd.includes('name="Quiz LAN Discovery"'), 'install command names the discovery rule')
  log(cmd.includes('localport=8080-8089'), 'install command uses the shared port range')
  log(cmd.includes('localport=5353'), 'install command opens UDP 5353')
  log(cmd.includes(`profile=${FIREWALL_PROFILE}`), `install command applies profile=${FIREWALL_PROFILE}`)
  log(cmd.includes('dir=in') && cmd.includes('action=allow'), 'rules are inbound allow')

  // ";" is the separator because Windows PowerShell 5.1 rejects "&&" outright
  // ("The token '&&' is not a valid statement separator in this version"), which
  // would abort the whole command before a single netsh ran.
  log(!cmd.includes('&&'), 'the install command contains no &&, which PS 5.1 cannot parse')
  log(cmd.includes('; '), 'rules are separated by ; so one failure does not skip the rest')
  log(cmd.split('; ').length === FIREWALL_RULES.length, 'both rules are present as separate commands')
  log(
    cmd.split('; ').every((c) => c.trim().startsWith('& netsh')),
    'each netsh runs through the call operator'
  )
  // No delete: the caller passes only rules just found missing, so there is
  // nothing to delete and netsh exits non-zero when no rule matches.
  log(!cmd.includes('delete'), 'the install command contains no delete step')
  log(cmd.split('add rule').length - 1 === FIREWALL_RULES.length, 'every missing rule gets an add')

  // Checking needs no admin, so it uses the same rules without elevation.
  const checkArgs = buildCheckArgs(server!)
  log(checkArgs[0] === 'advfirewall', 'check uses advfirewall')
  log(checkArgs.includes('name="Quiz LAN Server"'), 'check queries by rule name')
  log(!checkArgs.some((a) => a.includes('add')), 'check never adds a rule')

  // Regression guard for the check bug: without windowsVerbatimArguments Node
  // escapes the inner quote, netsh answers "A specified value is not valid",
  // and a rule that plainly exists was reported missing.
  log(CHECK_OPTIONS.windowsVerbatimArguments === true, 'the check passes arguments verbatim')
  log(
    buildCheckArgs(server!)[4] === 'name="Quiz LAN Server"',
    'the check quotes the rule name with real double quotes'
  )
  log(
    !buildCheckArgs(server!).some((a) => a.includes('\\')),
    'no backslash is introduced into the check arguments'
  )

  // Only a definite "no rules match" counts as missing; anything else is unknown.
  log(
    classifyCheckOutput('Rule Name:                            Quiz LAN Server') === 'present',
    'a rule name line reads as present'
  )
  log(
    classifyCheckOutput('No rules match the specified criteria.') === 'missing',
    '"no rules match" reads as missing'
  )
  log(
    classifyCheckOutput('\r\nA specified value is not valid.\r\n\r\nUsage: show rule name=<string>') ===
      'unknown',
    'a quoting or usage error reads as unknown, not missing'
  )
  log(classifyCheckOutput('') === 'unknown', 'empty output reads as unknown')
  log(
    classifyCheckOutput('rule name: quiz lan server') === 'present',
    'classification ignores case'
  )

  // Only missing rules get installed, and the builder is not given anything else.
  const single = buildInstallCommand([discovery!])
  log(!single.includes('Quiz LAN Server'), 'building for a subset only includes that subset')

  // Quoting survives because the command is shipped base64-encoded. Regression
  // guard for the original bug: Start-Process re-split the -ArgumentList string
  // on the space inside the name, so netsh got name=Quiz LAN Server and failed.
  log(!/name=Quiz LAN(?!")/u.test(cmd), 'no rule name is left unquoted in the command')

  // Base64 of UTF-16LE, free of anything Start-Process could re-split.
  const encoded = encodePowerShell(cmd)
  log(encoded === Buffer.from(cmd, 'utf16le').toString('base64'), 'the command is base64-encoded')
  log(
    Buffer.from(encoded, 'base64').toString('utf16le') === cmd,
    'the encoding round-trips back to the exact command'
  )
  log(
    !/[\s"'`]/u.test(encoded),
    'the encoded command holds no whitespace or quotes, so Start-Process cannot split it'
  )
  log(buildInstallCommand([]) === '', 'an empty rule list builds nothing')

  // The primary check must not depend on the language of Windows. netsh prints
  // "No rules match the specified criteria" in the system language, so parsing
  // it meant every rule read as "unknown" on a non-English PC - the app could
  // then never tell that the firewall was ready and never offered the fix.
  const script = buildCheckScript(FIREWALL_RULES)
  log(script.includes('Get-NetFirewallRule'), 'the check asks the firewall cmdlets')
  log(!/netsh/u.test(script), 'the check does not parse netsh output')
  log(
    script.includes("'Quiz LAN Server'") && script.includes("'Quiz LAN Discovery'"),
    'the check looks up both rules by name'
  )
  log(
    script.includes('-DisplayName'),
    'the check looks up by display name, because -Name matches the instance id'
  )
  log(
    !/rule name:/iu.test(script),
    'the check does not look for a translated label in the output'
  )

  // The output is read in our own format, so it does not depend on the
  // language either.
  const parsed = parseCheckOutput(
    'PRESENT Quiz LAN Server\r\nMISSING Quiz LAN Discovery\r\nnoise from powershell\r\n'
  )
  log(
    parsed.present.length === 1 && parsed.present[0] === 'Quiz LAN Server',
    'a present rule is read back'
  )
  log(
    parsed.missing.length === 1 && parsed.missing[0] === 'Quiz LAN Discovery',
    'a missing rule is read back'
  )
  log(
    parseCheckOutput('UNSUPPORTED').present.length === 0 &&
      parseCheckOutput('UNSUPPORTED').missing.length === 0,
    'an unsupported platform says nothing about the rules'
  )
  log(
    parseCheckOutput('UNKNOWN Quiz LAN Server').unknown[0] === 'Quiz LAN Server',
    'an unknown rule is read back as unknown'
  )
  log(
    parseCheckOutput('').present.length === 0 &&
      parseCheckOutput('').missing.length === 0 &&
      parseCheckOutput('').unknown.length === 0,
    'empty output says nothing about the rules'
  )

  // The manual fallback has to be runnable as typed, one command per line.
  const manual = buildInstallCommands(FIREWALL_RULES)
  log(manual.length === FIREWALL_RULES.length, 'there is one manual command per rule')
  log(
    manual.every((line) => line.startsWith('netsh advfirewall firewall add rule name="')),
    'every manual command is a complete netsh add'
  )
  log(
    manual.every((line) => !line.includes('&') && !line.includes(';')),
    'the manual commands carry no shell operators'
  )
  log(
    manual.some((line) => line.includes('localport=8080-8089') && line.includes('protocol=TCP')),
    'the manual server command opens the shared port range'
  )
  log(
    manual.some((line) => line.includes('localport=5353') && line.includes('protocol=UDP')),
    'the manual discovery command opens the mDNS port'
  )
  log(
    buildInstallCommands([]).length === 0,
    'no rules build no manual commands'
  )
}

const log = (ok: boolean, msg: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`)
  if (!ok) process.exitCode = 1
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Structural equality for the JSON-shaped objects these checks compare. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const keys = Object.keys(ra)
  return keys.length === Object.keys(rb).length && keys.every((k) => deepEqual(ra[k], rb[k]))
}

/** No key material of any kind may appear in a phone-facing payload. */
function assertNoKeys(payload: unknown, label: string): void {
  for (const forbidden of ['key', 'accepted', 'tolerance', 'correct', 'answer']) {
    log(!findField(payload, forbidden), `${label} contains no "${forbidden}" field`)
  }
}

interface Client {
  ws: WebSocket
  msgs: any[]
  open(): Promise<void>
  send(t: string, d: any): void
  /** Waits for the next message of a type. */
  wait(t: string, ms?: number): Promise<any>
  close(): void
}

function client(port: number, host = '127.0.0.1'): Client {
  const ws = new WebSocket(`ws://${host}:${port}/ws`)
  const msgs: any[] = []
  ws.on('message', (raw) => msgs.push(JSON.parse(raw.toString())))
  const c: Client = {
    ws,
    msgs,
    open: () => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) }),
    send: (t, d) => ws.send(JSON.stringify({ t, d })),
    wait: (t, ms = 3000) =>
      new Promise((res, rej) => {
        const found = msgs.find((m) => m.t === t)
        if (found) return res(found)
        const timer = setTimeout(() => rej(new Error(`timeout waiting for ${t}`)), ms)
        const iv = setInterval(() => {
          const hit = msgs.find((m) => m.t === t)
          if (hit) { clearInterval(iv); clearTimeout(timer); res(hit) }
        }, 25)
      }),
    close: () => ws.close()
  }
  return c
}

/**
 * Waits for the next message of a type, ignoring ones already received. Used by
 * the step-3 checks, where the same message type arrives several times.
 */
function waitFresh(c: Client, t: string, ms = 3000, from = c.msgs.length): Promise<any> {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`timeout waiting for a fresh ${t}`)), ms)
    const iv = setInterval(() => {
      const hit = c.msgs.slice(from).find((m) => m.t === t)
      if (hit) {
        clearInterval(iv)
        clearTimeout(timer)
        res(hit)
      }
    }, 25)
  })
}

/** Recursively looks for a forbidden field name anywhere in a payload. */
function findField(value: unknown, name: string): boolean {
  if (Array.isArray(value)) return value.some((v) => findField(v, name))
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([k, v]) => k.toLowerCase() === name || findField(v, name)
    )
  }
  return false
}

/** One correct-looking answer per question type. */
const TYPE_ANSWERS: Record<string, unknown> = {
  q1: 'b',
  q2: true,
  q3: 'Tokyo',
  q4: ['Au', 'Ag'],
  q5: ['red', 'green', 'blue'],
  q6: '15 €',
  q7: { l1: 'r3', l2: 'r2', l3: 'r1' },
  q8: { p1: 'a2', p2: 'a3', p3: 'a1' }
}

/** One CSS rule: the selectors it applies to and the properties it sets. */
interface CssRule {
  selectors: string[]
  properties: string[]
  where: string
}

/**
 * Reads the rules of a stylesheet.
 *
 * The rules inside a media query are left out: a narrow screen is meant to
 * set things differently, and that is not a conflict. Comments are taken out
 * first, so a comment never ends up as part of a selector.
 */
function parseCssRules(css: string, file: string): CssRule[] {
  const rules: CssRule[] = []
  // The comments are blanked out, not removed, so the line numbers still
  // point at the rule in the file.
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
  let depth = 0
  let buffer = ''
  let selector = ''
  let body = ''
  let line = 1
  let selectorStart = 1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\n') {
      line++
      continue
    }
    if (ch === '{') {
      if (depth === 0) {
        // The selector is what came before the brace.
        selector = buffer.trim()
        buffer = ''
        body = ''
      }
      depth++
      continue
    }
    if (ch === '}') {
      depth--
      if (depth === 0) {
        if (selector && !selector.startsWith('@')) {
          const properties = body
            .split(';')
            .map((part) => part.split(':')[0]?.trim() ?? '')
            .filter((name) => name.length > 0 && !name.startsWith('--'))
          rules.push({
            selectors: selector.split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean),
            properties,
            where: `${file}:${selectorStart}`
          })
        }
        selector = ''
        buffer = ''
        body = ''
        continue
      }
      body += ch
      continue
    }
    if (depth === 0) {
      if (!buffer.trim() && ch.trim()) selectorStart = line
      buffer += ch
    } else body += ch
  }
  return rules
}

/**
 * The stylesheets must not set the same property on the same selector twice.
 *
 * A property that is set in two places is a trap: the later one wins, and
 * nothing says so. It cost a rebuild once - a grid that was set up in two
 * places, and the older flex rule kept winning, so the drawer came out as
 * one tall column instead of two.
 *
 * Grouping is fine - `h1, h2, h3 { margin: 0 }` and then `h1 { font-size }`
 * set different properties, and that is how CSS is meant to be written.
 * Setting the *same* property twice for the same selector is not.
 */
function checkStylesheets(): void {
  console.log('--- stylesheets ---')
  const dir = join(projectRoot(), 'src', 'renderer')
  const files = ['tokens.css', 'ui.css', 'shell.css', 'screens.css']
  const known = new Map<string, Map<string, string>>()
  const clashes: string[] = []
  for (const file of files) {
    const css = readFileSync(join(dir, file), 'utf8')
    for (const rule of parseCssRules(css, file)) {
      for (const selector of rule.selectors) {
        const set = known.get(selector) ?? new Map<string, string>()
        for (const property of rule.properties) {
          const where = set.get(property)
          if (where) clashes.push(`${selector} sets ${property} again (${where} and ${rule.where})`)
          else set.set(property, rule.where)
        }
        known.set(selector, set)
      }
    }
  }
  log(
    clashes.length === 0,
    clashes.length === 0
      ? 'no stylesheet sets the same property on the same selector twice'
      : `no stylesheet sets the same property on the same selector twice: ${clashes.join(', ')}`
  )
}

async function main(): Promise<void> {
  // --- quiz library (step 4): exercised offline against a temp database ---
  console.log('--- quiz library ---')
  const seededQuiz = checkLibrary()

  // --- results: the score sheets of finished sessions ---
  console.log('\n--- results ---')
  checkResults()

   // --- the stylesheets ---
   console.log('\n--- stylesheets ---')
   checkStylesheets()

    // --- AI question generation (stub provider) ---
    console.log('\n--- AI ---')
    await checkAi()

    // --- AI model registry ---
    console.log('\n--- AI models ---')
    await checkAiModels()

    // --- the retrieval ---
    console.log('\n--- retrieval ---')
    await checkRag()


  const seen: any[] = []
  let lastInfo: any = null
  // The meme tray gets its own temp database and folder, like the library.
  const memeDir = mkdtempSync(join(tmpdir(), 'quiz-memes-'))
  const memeData = openAppData(join(memeDir, 'memes.db'))
  const memeAssets = new MemeAssets(memeData.memes, join(memeDir, 'files'))
  memeAssets.ensure()
  liveResults = memeData.results
  let liveServer: any = null
  const server = await startServer({
    onStudentsChanged: (s) => seen.push(JSON.parse(JSON.stringify(s))),
    onServerChanged: (i) => (lastInfo = i),
    onQuizChanged: () => {},
    onLockChanged: () => {},
    onQuizEnded: (reason) => {
      endedReasons.push(reason)
      liveResult = saveLiveResult(liveResults, liveServer, reason)
    },
    memes: memeAssets
  })
  liveServer = server
  const port = server.info().port
  const pin = server.session.pin
  console.log(`server on port ${port}, PIN ${pin}, ip ${server.info().selectedIp}`)

  // 1. correct PIN -> joined
  const a = client(port)
  await a.open()
  a.send('join', { pin, name: 'Alice', deviceToken: 'tok-alice' })
  const joined = await a.wait('joined')
  log(!!joined.d.studentId, 'join with correct PIN returns joined')
  log(joined.d.deviceToken === 'tok-alice', 'server echoes the supplied deviceToken')
  const aliceId = joined.d.studentId

  // 2. name taken, case-insensitive, different token
  const b = client(port)
  await b.open()
  b.send('join', { pin, name: 'aLiCe', deviceToken: 'tok-other' })
  const taken = await b.wait('error')
  log(taken.d.code === 'NAME_TAKEN', 'duplicate name (different case) returns NAME_TAKEN')

  // 3. heartbeat keeps it connected
  for (let i = 0; i < 4; i++) { a.send('hb', {}); await sleep(1000) }
  const stillConnected = server.session.list()[0].status === 'connected'
  log(stillConnected, 'hb every 1 s keeps the student connected')

  // 4. stop heartbeats -> disconnected after 10 s
  const t0 = Date.now()
  while (server.session.list()[0].status === 'connected' && Date.now() - t0 < 14_000) await sleep(250)
  log(server.session.list()[0].status === 'disconnected', 'no hb for 10 s marks the student disconnected')
  log(Date.now() - t0 < 13_000, `disconnect detected in ${((Date.now() - t0) / 1000).toFixed(1)} s`)

  // 5. same deviceToken -> same studentId
  const a2 = client(port)
  await a2.open()
  a2.send('join', { pin, name: 'Alice', deviceToken: 'tok-alice' })
  const rejoined = await a2.wait('joined')
  log(rejoined.d.studentId === aliceId, 'rejoin with same deviceToken restores the same studentId')
  log(server.session.list().length === 1, 'identity restore does not create a second student')

  // 6. kick
  a2.send('hb', {})
  const kicked = server.session.kick(aliceId)
  await a2.wait('kick')
  log(kicked, 'kick() returns true')
  log(a2.msgs.some((m) => m.t === 'kick'), 'kicked client receives the kick message')
  log(server.session.list().length === 0, 'kick removes the student from the list')

  // --- quiz run (step 2), before the rate-limit tests block the IP ---
  console.log('\n--- quiz run ---')
  await checkQuizRun(server, port, seededQuiz)

  // --- meme pops (the jumpscare tray), also before the rate limit ---
  console.log('\n--- memes ---')
  await checkMemes(server, port, memeData.memes, memeAssets)

  // 7. five wrong PINs then RATE_LIMITED on the 6th (per IP, so run last)
  for (let i = 0; i < 5; i++) {
    const c = client(port)
    await c.open()
    c.send('join', { pin: '9999', name: `Bad${i}` })
    const m = await c.wait('error')
    log(m.d.code === 'BAD_PIN', `wrong PIN #${i + 1} returns BAD_PIN`)
    c.close()
    await sleep(60)
  }

  // 8. 6th *wrong* PIN also gets RATE_LIMITED
  const w = client(port)
  await w.open()
  w.send('join', { pin: '9999', name: 'WrongAgain' })
  const wrongSixth = await w.wait('error')
  log(wrongSixth.d.code === 'RATE_LIMITED', '6th wrong PIN returns RATE_LIMITED')
  w.close()

  // 9. UI notifications reached the renderer
  log(seen.length > 0, 'student list changes are pushed to the renderer')
  log(!!lastInfo && Array.isArray(lastInfo.addresses), 'server info with LAN addresses is pushed to the renderer')

  // 10. alternate address selection
  const other = lastInfo.addresses.find((ip: string) => ip !== lastInfo.selectedIp)
  if (other) {
    log(server.selectIp(other), 'selectIp() accepts another LAN address')
    log(lastInfo.selectedIp === other, 'renderer receives the newly selected address')
    log(server.selectIp('203.0.113.9') === false, 'selectIp() rejects an unknown address')
  } else {
    log(true, 'only one LAN address on this machine; selection skipped')
  }

  // 11. new session: new PIN, empty lobby, clients closed
  const before = server.session.pin
  const after = server.newSession()
  log(after.pin !== before, `new session issues a new PIN (${before} -> ${after.pin})`)
  log(after.port === port, 'new session keeps the same port')
  log(server.session.list().length === 0, 'new session empties the lobby')

  const r = client(port)
  await r.open()
  r.send('join', { pin: after.pin, name: 'Latecomer' })
  log(!!(await r.wait('joined')).d.studentId, 'a client can join with the new PIN')
  const final = server.newSession()
  log(final.pin !== after.pin, 'a second new session issues yet another PIN')
  await sleep(200)
  log(r.ws.readyState !== WebSocket.OPEN, 'starting a new session disconnects joined clients')

  // 11b. repeated new sessions must keep advertising without registry clashes
  let clashes = 0
  for (let i = 0; i < 5; i++) {
    server.newSession()
    await sleep(150)
    if (server.advertisementError()) clashes++
  }
  log(clashes === 0, `5 rapid new sessions advertise cleanly${server.advertisementError() ? ` (${server.advertisementError()})` : ''}`)

  await server.close()

  // 12. port fallback when 8080 is already taken
  const blocker = createServer()
  await new Promise<void>((res, rej) => blocker.listen(8080, '0.0.0.0', () => res()).once('error', rej))
  const fallback = await startServer({
    onStudentsChanged: () => {},
    onServerChanged: () => {},
    onQuizChanged: () => {},
    onLockChanged: () => {}
  })
  log(fallback.info().port !== 8080, `falls back to port ${fallback.info().port} when 8080 is taken`)
  const fc = client(fallback.info().port)
  await fc.open()
  fc.send('join', { pin: fallback.session.pin, name: 'Fallback' })
  log(!!(await fc.wait('joined')).d.studentId, 'the fallback port accepts joins')
  fc.close()
  await fallback.close()
  await new Promise<void>((res) => blocker.close(() => res()))

  // 13. firewall command building (pure; no netsh, no elevation)
  console.log('\n--- firewall ---')
  checkFirewallCommands()

  memeData.quizzes.close()
  safeRmSync(memeDir)

  console.log('done')
  process.exit(process.exitCode ?? 0)
}

main().catch((e) => { console.error(e); process.exit(1) })

/** One valid question of every type, shaped the way the editor submits them. */
function validQuestions(): StoredQuestion[] {
  return [
    {
      id: 't-mcq', type: 'mcq', body: 'Which is even?', points: 1,
      data: { options: [{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }] },
      key: 'b', sourceText: '', status: 'draft'
    },
    {
      id: 't-tf', type: 'tf', body: 'The sky is blue.', points: 1,
      data: {}, key: true, sourceText: '', status: 'draft'
    },
    {
      id: 't-id', type: 'identification', body: 'Capital of France?', points: 1,
      data: {}, key: ['Paris'], sourceText: '', status: 'draft'
    },
    {
      id: 't-fillin', type: 'fillin', body: 'A ___ then a ___.', points: 2,
      data: { blanks: 2 }, key: [['x'], ['y', 'why']], sourceText: '', status: 'draft'
    },
    {
      id: 't-enum', type: 'enumeration', body: 'Name two colours.', points: 2,
      data: { count: 2 }, key: ['red', 'blue'], sourceText: '', status: 'draft'
    },
    {
      id: 't-prob', type: 'problem', body: 'What is 6 times 7?', points: 3,
      data: {}, key: { answer: '42', tolerance: 0.5 }, sourceText: '', status: 'draft'
    },
    {
      id: 't-match', type: 'matching', body: 'Match them.', points: 3,
      data: {
        left: [{ id: 'l1', text: 'L1' }, { id: 'l2', text: 'L2' }],
        right: [{ id: 'r1', text: 'R1' }, { id: 'r2', text: 'R2' }, { id: 'r3', text: 'spare' }]
      },
      key: { l1: 'r1', l2: 'r2' }, sourceText: '', status: 'draft'
    },
    {
      id: 't-conn', type: 'connect', body: 'Connect them.', points: 3,
      data: {
        prompts: [{ id: 'p1', text: 'P1' }, { id: 'p2', text: 'P2' }],
        answers: [{ id: 'a1', text: 'A1' }, { id: 'a2', text: 'A2' }, { id: 'a3', text: 'decoy' }]
      },
      key: { p1: 'a1', p2: 'a2' }, sourceText: '', status: 'draft'
    }
  ]
}

/**
 * Step-4 library checks against a temp database: seed, CRUD, validation for
 * all eight types, export/import round trip, malformed import rejection, and
 * start refusal. Returns the seeded sample quiz as a runtime Quiz so the
 * existing quiz-run checks exercise a saved quiz rather than a constant.
 */function checkLibrary(): Quiz {
  const dir = mkdtempSync(join(tmpdir(), 'quiz-check-'))
  try {
    const lib = openQuizLibrary(join(dir, 'test.db'))

    // --- first run seeds the step-2 sample quiz ---
    const first = lib.list()
    log(first.length === 1 && first[0].title === 'Sample quiz', 'a fresh database seeds the sample quiz')
    log(
      first[0].questionCount === 8 && first[0].timeLimitSec === 300,
      'the seeded quiz lists 8 questions and a 5-minute limit'
    )
    const seeded = lib.get(first[0].id)!
    log(seeded.questions.length === 8, 'the seeded quiz loads all 8 questions')
    log(
      deepEqual(
        seeded.questions.map((q) => q.id),
        SAMPLE_QUIZ.questions.map((q) => q.qid)
      ),
      'seeded questions keep their order and ids'
    )
    log(seeded.questions.every((q) => q.status === 'ready'), 'every seeded question is ready')
    const seededRuntime = toRuntimeQuiz(seeded)
    log(deepEqual(seededRuntime, SAMPLE_QUIZ), 'the seeded quiz converts back to the step-2 sample exactly')
    log(quizStartError(seeded) === null, 'the seeded quiz passes the start checks')
    assertNoKeys(toPublicQuestions(seededRuntime), 'the seeded library quiz')

    // --- create/read/update/delete ---
    const created = lib.create('Draft quiz')
    log(created.questions.length === 0, 'create makes an empty quiz')
    log(lib.list().length === 2, 'the new quiz appears in the list')
    const saved = lib.save({
      ...created,
      title: 'Renamed quiz',
      timeLimitSec: 120,
      questions: validQuestions()
    })
    log(saved.title === 'Renamed quiz' && saved.timeLimitSec === 120, 'save updates title and time limit')
    log(
      saved.questions.length === 8 && saved.questions.every((q) => q.status === 'ready'),
      'save stores all questions as ready'
    )
    const loaded = lib.get(created.id)!
    log(
      deepEqual(
        loaded.questions.map((q) => q.id),
        validQuestions().map((q) => q.id)
      ),
      'saved questions reload in order'
    )
    const reordered = lib.save({ ...loaded, questions: [loaded.questions[7], loaded.questions[0]] })
    log(
      reordered.questions.length === 2 && reordered.questions[0].id === loaded.questions[7].id,
      'save replaces the question list and order'
    )
    const brokenMcq: StoredQuestion = {
      ...validQuestions().find((q) => q.type === 'mcq')!,
      data: { options: [{ id: 'a', text: 'only one' }] },
      key: 'a'
    }
    const withDraft = lib.save({ ...reordered, questions: [brokenMcq] })
    log(withDraft.questions[0].status === 'draft', 'a question with problems is stored as draft')
    const copy = lib.duplicate(created.id)!
    log(copy.id !== created.id && copy.title === 'Renamed quiz copy', 'duplicate copies under a new id')
    log(
      deepEqual(
        copy.questions.map((q) => [q.type, q.body]),
        withDraft.questions.map((q) => [q.type, q.body])
      ),
      'duplicate copies the questions'
    )
    log(
      !copy.questions.some((q) => q.id === withDraft.questions[0].id),
      'duplicate regenerates question ids'
    )
    log(lib.get(created.id)!.questions.length === 1, 'duplicating leaves the original alone')
    log(lib.duplicate('no-such-quiz') === null, 'duplicating an unknown quiz returns null')
    log(lib.delete(copy.id) === true, 'delete removes the copy')
    log(lib.get(copy.id) === null, 'the deleted quiz no longer loads')
    log(lib.delete(copy.id) === false, 'deleting twice reports false')
    log(lib.list().length === 2, 'the list is back to seeded plus working quiz')

    checkValidationRules()
    checkExportImport(lib, seeded)
    checkStartRefusal(lib, seeded)

    lib.close()
    return seededRuntime
  } finally {
    safeRmSync(dir)
  }
}

/** Validation rules for all eight types: one good and several bad per type. */
function checkValidationRules(): void {
  const good = validQuestions()
  const byType = (t: QuestionType): StoredQuestion => good.find((q) => q.type === t)!
  const tweak = (t: QuestionType, patch: Partial<StoredQuestion>): StoredQuestion => ({
    ...byType(t),
    ...patch
  })
  const cases: { q: StoredQuestion; ready: boolean; label: string }[] = [
    { q: tweak('mcq', { body: '' }), ready: false, label: 'empty body is not ready' },
    { q: tweak('mcq', { points: 0 }), ready: false, label: 'zero points is not ready' },
    { q: byType('mcq'), ready: true, label: 'a valid mcq is ready' },
    {
      q: tweak('mcq', { data: { options: [{ id: 'a', text: 'only one' }] }, key: 'a' }),
      ready: false,
      label: 'an mcq with one option is not ready'
    },
    {
      q: tweak('mcq', { key: 'zzz' }),
      ready: false,
      label: 'an mcq whose key is not an option is not ready'
    },
    { q: tweak('mcq', { key: null }), ready: false, label: 'an mcq with no correct option is not ready' },
    { q: byType('tf'), ready: true, label: 'a valid tf is ready' },
    { q: tweak('tf', { key: null }), ready: false, label: 'a tf with no choice is not ready' },
    { q: byType('identification'), ready: true, label: 'a valid identification is ready' },
    {
      q: tweak('identification', { key: [] }),
      ready: false,
      label: 'an identification with no accepted answers is not ready'
    },
    {
      q: tweak('identification', { key: ['  '] }),
      ready: false,
      label: 'an identification with a blank accepted answer is not ready'
    },
    { q: byType('fillin'), ready: true, label: 'a valid fillin is ready' },
    {
      q: tweak('fillin', { body: 'No blanks here.' }),
      ready: false,
      label: 'a fillin with no ___ is not ready'
    },
    {
      q: tweak('fillin', { key: [['x']] }),
      ready: false,
      label: 'a fillin with fewer answer lists than blanks is not ready'
    },
    {
      q: tweak('fillin', { key: [['x'], []] }),
      ready: false,
      label: 'a fillin with an empty blank is not ready'
    },
    { q: byType('enumeration'), ready: true, label: 'a valid enumeration is ready' },
    {
      q: tweak('enumeration', { data: { count: 0 } }),
      ready: false,
      label: 'an enumeration with count 0 is not ready'
    },
    {
      q: tweak('enumeration', { key: ['red'] }),
      ready: false,
      label: 'an enumeration with fewer items than count is not ready'
    },
    { q: byType('problem'), ready: true, label: 'a valid problem is ready' },
    {
      q: tweak('problem', { key: { answer: '' } }),
      ready: false,
      label: 'a problem with an empty answer is not ready'
    },
    {
      q: tweak('problem', { key: { answer: '42', tolerance: -1 } }),
      ready: false,
      label: 'a problem with a negative tolerance is not ready'
    },
    {
      q: tweak('problem', { key: { answer: '42' } }),
      ready: true,
      label: 'a problem without tolerance is ready'
    },
    { q: byType('matching'), ready: true, label: 'a valid matching is ready' },
    {
      q: tweak('matching', { key: { l1: 'r1' } }),
      ready: false,
      label: 'a matching with an unpaired left item is not ready'
    },
    {
      q: tweak('matching', { key: { l1: 'nope', l2: 'r2' } }),
      ready: false,
      label: 'a matching pointing at an unknown right item is not ready'
    },
    {
      q: tweak('matching', { key: { l1: 'r1', l2: 'r1' } }),
      ready: false,
      label: 'a matching that reuses a right item is not ready'
    },
    { q: byType('connect'), ready: true, label: 'a valid connect is ready' },
    {
      q: tweak('connect', { key: { p1: 'a1' } }),
      ready: false,
      label: 'a connect with an unpaired prompt is not ready'
    },
    {
      q: tweak('connect', {
        data: { prompts: [{ id: 'p1', text: '' }], answers: byType('connect').data.answers }
      }),
      ready: false,
      label: 'a connect with an empty prompt is not ready'
    }
  ]
  for (const { q, ready, label } of cases) {
    const problems = validateQuestion(q)
    log(ready ? problems.length === 0 : problems.length > 0, `${label} (${q.type})`)
  }
}

/** Export/import round trip on a real library quiz, plus malformed rejection. */
function checkExportImport(lib: QuizLibrary, seeded: StoredQuiz): void {
  const json = serializeQuiz(seeded)
  const parsed = parseQuizJson(json)
  log(parsed.ok, 'the seeded quiz exports to JSON that parses back')
  if (!parsed.ok) return

  const imported = lib.importQuiz(parsed.quiz)
  log(imported.title === seeded.title, 'import restores the title')
  log(
    imported.timeLimitSec === seeded.timeLimitSec,
    `import restores the time limit (${imported.timeLimitSec}s)`
  )
  log(imported.id !== seeded.id, 'import creates a new quiz id')
  log(
    deepEqual(
      imported.questions.map((q) => q.type),
      seeded.questions.map((q) => q.type)
    ),
    'import keeps question order'
  )
  log(
    deepEqual(serializeQuiz(imported), json),
    'export/import round-trips byte-identically'
  )
  log(imported.questions.every((q) => q.status === 'ready'), 'imported questions are ready')
  assertNoKeys(toPublicQuestions(toRuntimeQuiz(imported)), 'the imported library quiz')

  // A fix-and-reimport loop: edit the working copy, export, and reimport.
  const edited: StoredQuiz = {
    ...imported,
    questions: imported.questions.map((q, i) =>
      i === 0 ? { ...q, body: 'Edited body', points: q.points + 1 } : q
    )
  }
  const again = parseQuizJson(serializeQuiz(edited))
  log(
    again.ok && again.quiz.questions[0].body === 'Edited body' && again.quiz.questions[0].points === 2,
    'an exported edit survives a reimport'
  )

  const bad: [string, string][] = [
    ['garbage', '{not json'],
    ['an array', '[]'],
    ['a wrong format', JSON.stringify({ format: 'quiz', version: 1, title: 'x', timeLimitSec: 60, questions: [] })],
    ['a wrong version', JSON.stringify({ format: 'quiz-export', version: 99, title: 'x', timeLimitSec: 60, questions: [] })],
    ['a missing title', JSON.stringify({ format: 'quiz-export', version: 1, title: ' ', timeLimitSec: 60, questions: [] })],
    ['a zero time limit', JSON.stringify({ format: 'quiz-export', version: 1, title: 'x', timeLimitSec: 0, questions: [] })],
    [
      'an unknown type',
      JSON.stringify({
        format: 'quiz-export', version: 1, title: 'x', timeLimitSec: 60,
        questions: [{ type: 'essay', body: 'Write.', points: 1, data: {}, key: null, sourceText: '' }]
      })
    ],
    [
      'a question with no body',
      JSON.stringify({
        format: 'quiz-export', version: 1, title: 'x', timeLimitSec: 60,
        questions: [{ type: 'tf', body: '', points: 1, data: {}, key: true, sourceText: '' }]
      })
    ],
    [
      'an mcq with one option',
      JSON.stringify({
        format: 'quiz-export', version: 1, title: 'x', timeLimitSec: 60,
        questions: [
          { type: 'mcq', body: 'Pick.', points: 1, data: { options: [{ id: 'a', text: 'A' }] }, key: 'a', sourceText: '' }
        ]
      })
    ],
    [
      'a matching with a bad pairing',
      JSON.stringify({
        format: 'quiz-export', version: 1, title: 'x', timeLimitSec: 60,
        questions: [
          {
            type: 'matching', body: 'Match.', points: 1,
            data: { left: [{ id: 'l1', text: 'L' }], right: [{ id: 'r1', text: 'R' }] },
            key: 5, sourceText: ''
          }
        ]
      })
    ],
    [
      'a fillin with a malformed key',
      JSON.stringify({
        format: 'quiz-export', version: 1, title: 'x', timeLimitSec: 60,
        questions: [
          {
            type: 'fillin', body: 'A ___ here.', points: 1,
            data: {}, key: 'Au', sourceText: ''
          }
        ]
      })
    ]
  ]
  for (const [label, text] of bad) {
    const result = parseQuizJson(text)
    log(!result.ok && result.error.length > 0, `malformed import rejected with a message: ${label}`)
  }
}

/** Start is refused for empty or draft quizzes, naming the blocking questions. */
function checkStartRefusal(lib: QuizLibrary, seeded: StoredQuiz): void {
  const empty = lib.create('Empty for a test')
  const emptyQuiz = lib.get(empty.id)!
  log(
    emptyQuiz.questions.length === 0 &&
      quizStartError(emptyQuiz) === 'This quiz has no questions.',
    'an empty quiz names its problem'
  )
  const emptyAttempt = runtimeQuizForStart(lib, empty.id)
  log(
    !emptyAttempt.ok && emptyAttempt.message === 'This quiz has no questions.',
    'runtimeQuizForStart refuses an empty quiz'
  )

  const brokenFillin: StoredQuestion = {
    ...validQuestions().find((q) => q.type === 'fillin')!,
    body: 'A single ___ here.'
  }
  const brokenEnum: StoredQuestion = {
    ...validQuestions().find((q) => q.type === 'enumeration')!,
    data: { count: 5 }
  }
  const drafty = lib.save({ ...emptyQuiz, questions: [brokenFillin, brokenEnum] })
  log(
    drafty.questions.every((q) => q.status === 'draft') &&
      quizStartError(drafty) === 'Questions 1, 2 are still drafts — fix them before starting.',
    'draft quizzes name every blocking question'
  )
  const draftAttempt = runtimeQuizForStart(lib, drafty.id)
  log(
    !draftAttempt.ok && draftAttempt.message.includes('Questions 1, 2'),
    'runtimeQuizForStart refuses a draft quiz and names the questions'
  )
  const missing = runtimeQuizForStart(lib, 'no-such-quiz')
  log(!missing.ok, 'runtimeQuizForStart refuses an unknown quiz id')
  const seededAttempt = runtimeQuizForStart(lib, seeded.id)
  log(
    seededAttempt.ok && deepEqual(seededAttempt.quiz.quizId, seeded.id),
    'runtimeQuizForStart converts the seeded quiz for the server'
  )
}
/** Step-2 quiz run against the live server. */
async function checkQuizRun(
  server: any,
  port: number,
  quiz: Quiz = SAMPLE_QUIZ,
  results: ResultsStore = liveResults
): Promise<void> {
  // A fresh lobby with no students: the server must refuse to start.
  server.newSession()
  const freshPin = server.session.pin
  log(server.session.status() === 'lobby', 'a new session is back in the lobby')
  log(server.startQuiz(quiz) === false, 'startQuiz refuses with no students')

  const alice = client(port)
  await alice.open()
  alice.send('join', { pin: freshPin, name: 'RunAlice', deviceToken: 'run-alice' })
  const aliceId = (await alice.wait('joined')).d.studentId

  // --- start ---
  const t0 = Date.now()
  log(server.startQuiz(quiz), 'startQuiz succeeds with a student in the lobby')
  log(server.session.status() === 'running', 'the session status becomes running')
  const start = await alice.wait('quiz_start')
  log(start.d.questions.length === quiz.questions.length, 'quiz_start carries every question')
  log(
    start.d.endsAt >= t0 + quiz.limitMs - 1000 &&
      start.d.endsAt <= Date.now() + quiz.limitMs,
    'quiz_start sets endsAt limitMs from the server clock'
  )
  log(start.d.serverTime > 0, 'quiz_start carries serverTime for the phone clock offset')
  log(server.startQuiz(quiz) === false, 'startQuiz is refused while already running')

  // No key material of any kind may appear in the phone-facing payload.
  assertNoKeys(start.d, 'the quiz_start from a library quiz')

  // --- answers: one per question type, all acked ---
  let seq = 0
  for (const q of quiz.questions) {
    alice.send('answer', { qid: q.qid, value: TYPE_ANSWERS[q.qid], seq: ++seq })
  }
  const acks = await alice.wait('ack')
  log(acks.d.qid === 'q1' && acks.d.seq === 1, 'the first answer is acked with its qid and seq')
  await sleep(300)
  const ackedCount = alice.msgs.filter((m) => m.t === 'ack').length
  log(
    ackedCount === quiz.questions.length,
    `every answer type is acked (${ackedCount}/${quiz.questions.length})`
  )
  const state = server.session.quizState()
  log(state.questions.every((q: any) => q.answered === 1), 'the per-question counts show one answered')
  log(
    state.answeredByStudent[aliceId] === quiz.questions.length,
    'the student shows all questions answered'
  )

  // --- type validation ---
  const badAnswers: [string, unknown, string][] = [
    ['q1', 'zzz', 'mcq with an unknown option'],
    ['q1', true, 'mcq with a boolean'],
    ['q2', 'yes', 'tf with a string'],
    ['q3', ['Tokyo'], 'identification with an array'],
    ['q4', ['Au'], 'fillin with the wrong number of blanks'],
    ['q5', ['a', 'b', 'c', 'd'], 'enumeration with more items than count'],
    ['q6', 15, 'problem with a number'],
    ['q7', { l1: 'nope', l2: 'r2' }, 'matching with an unknown right id'],
    ['q7', { l1: 'r1', l2: 'r1' }, 'matching that uses one right id twice'],
    ['q7', ['r1'], 'matching sent as an array'],
    ['q8', { pX: 'a1' }, 'connect with an unknown prompt id'],
    ['q8', { p1: 'aX' }, 'connect with an unknown answer id'],
    ['q8', { p1: 'a1', p2: 'a1' }, 'connect that uses one answer id twice']
  ]
  for (const [qid, value, why] of badAnswers) {
    const before = JSON.stringify(server.session.quizState().answeredByStudent)
    const seen = alice.msgs.filter((m) => m.t === 'error').length
    alice.send('answer', { qid, value, seq: ++seq })
    await sleep(120)
    const fresh = alice.msgs.filter((m) => m.t === 'error').slice(seen)
    const after = JSON.stringify(server.session.quizState().answeredByStudent)
    log(
      fresh.length === 1 && fresh[0].d.code === 'BAD_ANSWER' && before === after,
      `${why} returns BAD_ANSWER and stores nothing`
    )
  }
  const q8 = quiz.questions.find((q) => q.type === 'connect')!
  log(isValidAnswer(q8, { p1: 'a2', p2: 'a3' }), 'a partial connect map with known ids is valid')
  log(!isValidAnswer(q8, 'not an object'), 'a connect answer that is not a map is invalid')
  log(!isValidAnswer(q8, { p1: 'a1', p2: 'a2', p3: 'a1' }), 'connect with a repeated answer id is invalid')

  const errorsBefore = alice.msgs.filter((m) => m.t === 'error').length
  alice.send('answer', { qid: 'nope', value: 'x', seq: ++seq })
  await sleep(200)
  const newErrors = alice.msgs.filter((m) => m.t === 'error').slice(errorsBefore)
  log(
    newErrors.length === 1 && newErrors[0].d.code === 'UNKNOWN_QUESTION',
    'an unknown qid returns UNKNOWN_QUESTION'
  )

  // --- stale seq: ignored but still acked ---
  const highSeq = seq + 100
  alice.send('answer', { qid: 'q1', value: 'a', seq: highSeq })
  await sleep(200)
  const stale = client(port)
  await stale.open()
  stale.send('join', { pin: freshPin, name: 'RunAlice', deviceToken: 'run-alice' })
  await stale.wait('joined')
  stale.send('answer', { qid: 'q1', value: 'c', seq: highSeq - 1 })
  const staleAck = await stale.wait('ack')
  log(staleAck.d.seq === highSeq - 1 && staleAck.d.qid === 'q1', 'a stale seq is still acked')
  const afterStale = server.session.quizState()
  log(
    afterStale.questions.find((q: any) => q.qid === 'q1').answered === 1,
    'the stale answer did not change the stored count'
  )
  const restoredStale = await stale.wait('answers_state')
  log(restoredStale.d.answers.q1 === 'a', 'the stored value is still the newer one, not the stale one')

  // --- a stranger during the run gets CLOSED ---
  const stranger = client(port)
  await stranger.open()
  stranger.send('join', { pin: freshPin, name: 'RunStranger', deviceToken: 'run-stranger' })
  log((await stranger.wait('error')).d.code === 'CLOSED', 'a new joiner during the quiz gets CLOSED')
  stranger.close()

  // --- rejoin mid-quiz restores the answers ---
  stale.close()
  await sleep(200)
  const back = client(port)
  await back.open()
  back.send('join', { pin: freshPin, name: 'RunAlice', deviceToken: 'run-alice' })
  const rejoinStart = await back.wait('quiz_start')
  log(rejoinStart.d.questions.length === quiz.questions.length, 'a mid-quiz rejoin gets quiz_start again')
  const restored = await back.wait('answers_state')
  log(
    Object.keys(restored.d.answers).length === quiz.questions.length &&
      restored.d.answers.q1 === 'a' &&
      JSON.stringify(restored.d.answers.q8) === JSON.stringify({ p1: 'a2', p2: 'a3', p3: 'a1' }),
    'answers_state returns the same answers, including the connect value'
  )

  // --- instructor ends it ---
  log(server.endQuiz(), 'endQuiz succeeds while running')
  const endedMsg = await back.wait('quiz_end')
  log(endedMsg.d.reason === 'instructor', 'quiz_end reports reason "instructor"')
  log(
    endedReasons[endedReasons.length - 1] === 'instructor',
    'the session reports that the instructor ended it'
  )
  log(liveResult !== null, 'the finished run is saved as a result session')
  const liveDetail = liveResult ? results.get(liveResult.id) : null
  log(liveDetail !== null && liveDetail.questions.length === quiz.questions.length, 'the saved sheet has every question')
  log(liveDetail !== null && liveDetail.students.length === 1, 'the saved sheet has the student of the run')
  const liveAlice = liveDetail?.students.find((s) => s.studentName === 'RunAlice')
  log(liveAlice !== undefined && liveAlice.totalPointsAwarded > 0, 'the saved sheet scores the answers of the run')
  log(
    liveDetail !== null && liveDetail.meta.endReason === 'instructor',
    'the saved sheet remembers why the run ended'
  )
  log(server.session.status() === 'ended', 'the session status becomes ended')
  back.send('answer', { qid: 'q2', value: false, seq: ++seq })
  log((await back.wait('error')).d.code === 'QUIZ_ENDED', 'a late answer returns QUIZ_ENDED')

  // --- the server timer ends the quiz on its own ---
  server.newSession()
  const timerPin = server.session.pin
  const bob = client(port)
  await bob.open()
  bob.send('join', { pin: timerPin, name: 'RunBob', deviceToken: 'run-bob' })
  await bob.wait('joined')
  log(server.startQuiz({ ...quiz, limitMs: 1500 }), 'a short quiz starts for the timer test')
  await bob.wait('quiz_start')
  const timerEnd = await bob.wait('quiz_end', 6000)
  log(timerEnd.d.reason === 'time', 'the server timer ends the quiz with reason "time"')
  log(endedReasons[endedReasons.length - 1] === 'time', 'the session reports that the timer ended it')
  log(server.session.quizState().status === 'ended', 'the timer moves the status to ended')

  // --- step 3: lock and pause ---
  console.log('\n--- lock and pause ---')
  await checkLockPause(server, port, quiz)
  alice.close()
  back.close()
  bob.close()
  await sleep(150)

  // --- step 5: finish ---
  console.log('\n--- finish ---')
  await checkFinish(server, port, quiz)
  await sleep(150)

  // --- timer control: pause/resume/adjust ---
  console.log('\n--- timer control ---')
  await checkTimerControl(server, port)
  await sleep(150)

  // --- clean disconnects and paused reconnects ---
  console.log('\n--- disconnect and paused reconnect ---')
  await checkReconnectPause(server, port, quiz)
  await sleep(150)
  server.newSession()
}

/**
 * The meme tray and the phone-facing pop, against the live server: the
 * payload shape, the HTTP asset route, the targeting, the dismiss and the
 * promise that a pop never touches the quiz clock.
 */
async function checkMemes(
  server: any,
  port: number,
  store: MemeStore,
  assets: MemeAssets
): Promise<void> {
  server.newSession()
  const pin = server.session.pin

  // --- a meme in the tray ---
  const bytes = Buffer.from('these stand in for the compressed jpeg bytes')
  const id = randomUUID()
  const fileName = assets.write(id, bytes, 'image/jpeg')
  const row = store.insert({
    id,
    name: 'Test meme',
    fileName,
    mime: 'image/jpeg',
    width: 320,
    height: 240,
    byteSize: bytes.length,
    thumb: ''
  })
  const list = store.list()
  log(list.length === 1 && list[0].name === 'Test meme', 'the meme store lists the meme')
  log(!('fileName' in list[0]), 'the public meme shape carries no file name')
  log(MEME_FILE_PATTERN.test(row.fileName), 'the stored file name matches the safe pattern')
  log(!MEME_FILE_PATTERN.test('../../quiz-library.db'), 'a path traversal never matches the pattern')
  log(store.get('no-such-meme') === null, 'an unknown meme id is unknown to the store')

  // --- the bundled sample meme ---
  const sampleDir = mkdtempSync(join(tmpdir(), 'quiz-sample-meme-'))
  const sampleData = openAppData(join(sampleDir, 'sample.db'))
  const sampleAssets = new MemeAssets(sampleData.memes, join(sampleDir, 'files'))
  const sample = seedSampleMeme(sampleAssets, [projectRoot()])
  log(sample !== null, 'the bundled sample meme is seeded on a fresh profile')
  log(
    sample !== null && MEME_FILE_PATTERN.test(sample.fileName),
    'the seeded sample gets a safe file name'
  )
  log(
    sample !== null && sampleAssets.read(sample.fileName) !== null,
    'the seeded sample file is written to the meme folder'
  )
  log(sampleData.fresh, 'a brand-new database reports itself as fresh')
  sampleData.quizzes.close()
  safeRmSync(sampleDir)

  // --- the payload the phone would get ---
  const payload = buildPopPayload(store, id, 3000)
  log(payload !== null, 'a known meme builds a pop payload')
  log(buildPopPayload(store, 'no-such-meme', 3000) === null, 'an unknown meme id is refused')
  log(
    payload !== null && Object.keys(payload).sort().join(',') ===
      'durationMs,height,memeId,mime,path,width',
    'the pop payload carries exactly the documented fields'
  )
  log(
    payload !== null && payload.path.startsWith('/memes/') && !payload.path.includes('://'),
    'the path is relative, never an absolute URL'
  )
  log(
    payload !== null &&
      !payload.path.includes('\\') &&
      !payload.path.includes(':') &&
      !payload.path.includes('..'),
    'the path never leaks a local file path'
  )
  assertNoKeys(payload, 'the meme pop payload')

  // --- two students join ---
  const alice = client(port)
  await alice.open()
  alice.send('join', { pin, name: 'MemeAlice', deviceToken: 'meme-alice' })
  const aliceId = (await alice.wait('joined')).d.studentId
  const aliceHb = setInterval(() => alice.send('hb', {}), 400)
  const bob = client(port)
  await bob.open()
  bob.send('join', { pin, name: 'MemeBob', deviceToken: 'meme-bob' })
  const bobId = (await bob.wait('joined')).d.studentId
  const bobHb = setInterval(() => bob.send('hb', {}), 400)

  // --- a quiz runs, so the clock check has something to compare ---
  const quiz = { ...SAMPLE_QUIZ, limitMs: 600_000 }
  log(server.startQuiz(quiz), 'a quiz runs for the meme checks')
  await alice.wait('quiz_start')
  const endsBefore = server.session.quizState().endsAt

  // --- a pop reaches every connected student ---
  const sent = server.popMeme(payload!)
  log(sent === 2, `a pop reaches every connected student (${sent})`)
  const popAlice = await alice.wait('meme_pop')
  const popBob = await bob.wait('meme_pop')
  log(popAlice.d.memeId === id && popBob.d.memeId === id, 'the pop carries the meme id')
  log(popAlice.d.durationMs === 3000, 'the pop carries the duration')
  log(popAlice.d.mime === 'image/jpeg', 'the pop carries the mime type')
  log(popAlice.d.width === 320 && popAlice.d.height === 240, 'the pop carries the pixel size')
  log(
    server.session.quizState().endsAt === endsBefore,
    'a pop does not change the quiz clock'
  )

  // --- the HTTP asset route ---
  const asset = await fetch(`http://127.0.0.1:${port}${popAlice.d.path}`)
  log(asset.status === 200, 'the meme is served over plain HTTP')
  log(asset.headers.get('content-type') === 'image/jpeg', 'the asset route sends the stored content type')
  const served = Buffer.from(await asset.arrayBuffer())
  log(served.length === bytes.length, 'the asset route sends the stored bytes')
  log(
    (asset.headers.get('cache-control') ?? '').includes('immutable'),
    'the asset route marks the file immutable'
  )
  const missing = await fetch(`http://127.0.0.1:${port}/memes/0123456789abcdef0123.jpg`)
  log(missing.status === 404, 'an unknown meme file gets 404')
  const traversal = await fetch(`http://127.0.0.1:${port}/memes/..%2F..%2Fmemes.db`)
  log(traversal.status === 404, 'a path traversal attempt gets 404')

  // --- a targeted pop reaches only its target ---
  const alicePops = alice.msgs.filter((m) => m.t === 'meme_pop').length
  const bobPops = bob.msgs.filter((m) => m.t === 'meme_pop').length
  const targeted = server.popMeme(payload!, [bobId])
  log(targeted === 1, 'a targeted pop is sent to exactly one socket')
  await waitFresh(bob, 'meme_pop')
  log(
    bob.msgs.filter((m) => m.t === 'meme_pop').length === bobPops + 1,
    'the targeted student receives the pop'
  )
  log(
    alice.msgs.filter((m) => m.t === 'meme_pop').length === alicePops,
    'the other student never sees a targeted pop'
  )

  // --- dismiss ---
  const hidden = server.hideMeme()
  log(hidden === 2, 'meme_hide reaches every connected student')
  const hideAlice = await waitFresh(alice, 'meme_hide')
  log(hideAlice.d !== undefined, 'meme_hide carries an empty payload')
  log(
    server.session.quizState().endsAt === endsBefore,
    'dismissing a meme does not change the quiz clock'
  )

  // --- an unknown meme id never reaches a phone ---
  const beforeUnknown = alice.msgs.length
  log(buildPopPayload(store, 'no-such-meme', 3000) === null, 'an unknown meme id sends nothing')
  await sleep(150)
  log(alice.msgs.length === beforeUnknown, 'a refused pop sends no message at all')

  clearInterval(aliceHb)
  clearInterval(bobHb)
  alice.close()
  bob.close()
  await sleep(150)
  server.newSession()
}

/** The project root, so the bundled resources (the sample meme) can be found. */
function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

/** Timer control against the live server: pause, adjust, resume, clamp, rejoin. */async function checkTimerControl(server: any, port: number): Promise<void> {
  server.newSession()
  const pin = server.session.pin
  const quiz = { ...SAMPLE_QUIZ, limitMs: 600_000 }
  const alice = client(port)
  await alice.open()
  alice.send('join', { pin, name: 'TimerAlice', deviceToken: 'timer-alice' })
  await alice.wait('joined')
  const hb = setInterval(() => alice.send('hb', {}), 400)
  try {
    log(server.startQuiz(quiz), 'the timer quiz starts')
    const start = await alice.wait('quiz_start')
    log(start.d.paused === false, 'quiz_start carries paused false')
    const ends0 = start.d.endsAt as number

    // waitFresh, not wait: the same message type arrives several times here and
    // wait() would hand back the first (stale) one.
    log(server.pauseTimer() === true, 'pauseTimer succeeds while running')
    const upd1 = await waitFresh(alice, 'time_update')
    log(upd1.d.paused === true, 'pause broadcasts time_update with paused true')
    log(server.session.quizState().timerPaused === true, 'dashboard state shows timerPaused')
    const rem1 = server.session.quizState().remainingMs as number
    log(typeof rem1 === 'number' && rem1 > 0, 'dashboard state carries the frozen remainder')
    log(server.pauseTimer() === false, 'a second pause is refused')

    await sleep(500)
    const rem2 = server.session.quizState().remainingMs as number
    log(Math.abs(rem2 - rem1) < 1, 'the countdown stays frozen while paused')

    log(server.adjustTimer(60_000) === true, '+1 min while paused succeeds')
    const upd2 = await waitFresh(alice, 'time_update')
    log(upd2.d.paused === true, 'adjust broadcasts time_update still paused')
    const rem3 = server.session.quizState().remainingMs as number
    log(rem3 - rem2 >= 59_000 && rem3 - rem2 <= 61_000, '+1 min grows the frozen remainder')

    log(server.resumeTimer() === true, 'resumeTimer succeeds')
    const upd3 = await waitFresh(alice, 'time_update')
    log(upd3.d.paused === false, 'resume broadcasts time_update with paused false')
    log(server.session.quizState().timerPaused === false, 'dashboard state clears timerPaused')
    const ends1 = upd3.d.endsAt as number
    log(ends1 > ends0, 'resume shifts endsAt forward by the paused duration')

    log(server.adjustTimer(-60_000) === true, '-1 min while running succeeds')
    const upd4 = await waitFresh(alice, 'time_update')
    const ends2 = upd4.d.endsAt as number
    log(ends2 < ends1, '-1 min moves endsAt earlier')

    log(server.adjustTimer(-10_000_000) === true, 'a huge subtraction still returns true')
    await waitFresh(alice, 'time_update')
    const st = server.session.quizState()
    log(st.endsAt - Date.now() >= 9_000, 'adjust clamps so at least ~10 s remain')

    log(server.pauseTimer() === true, 'pause again for the rejoin test')
    await waitFresh(alice, 'time_update')
    alice.close()
    await sleep(200)
    const back = client(port)
    await back.open()
    back.send('join', { pin, name: 'TimerAlice', deviceToken: 'timer-alice' })
    const rs = await back.wait('quiz_start')
    log(rs.d.paused === true, 'a mid-quiz rejoin quiz_start carries paused true')
    back.close()

    log(server.endQuiz() === true, 'the timer quiz ends')
    log(server.pauseTimer() === false, 'pause is refused when not running')
    log(server.resumeTimer() === false, 'resume is refused when not running')
    log(server.adjustTimer(60_000) === false, 'adjust is refused when not running')
  } finally {
    clearInterval(hb)
    alice.close()
  }
  server.newSession()
}

/** Step-3 lock and pause against the live server. */
async function checkLockPause(server: any, port: number, quiz: Quiz = SAMPLE_QUIZ): Promise<void> {
  server.newSession()
  // A short heartbeat timeout keeps the network-pause test fast.
  server.session.heartbeatTimeoutMs = 1500
  const pin = server.session.pin

  const alice = client(port)
  await alice.open()
  alice.send('join', { pin, name: 'LockAlice', deviceToken: 'lock-alice' })
  const aliceId = (await alice.wait('joined')).d.studentId
  const aliceHb = setInterval(() => alice.send('hb', {}), 400)

  const bob = client(port)
  await bob.open()
  bob.send('join', { pin, name: 'LockBob', deviceToken: 'lock-bob' })
  const bobId = (await bob.wait('joined')).d.studentId
  const bobHb = setInterval(() => bob.send('hb', {}), 400)

  const info = (id: string): any => server.session.list().find((s: any) => s.id === id)

  log(server.session.lockEnabled() === true, 'lockMode is on by default')
  log(server.startQuiz(quiz), 'the quiz starts with lock on')
  const start = await alice.wait('quiz_start')
  log(start.d.lockMode === true, 'quiz_start carries lockMode: true')

  // --- focus_lost pauses while the lock is on ---
  alice.send('focus_lost', { reason: 'background' })
  const pausedFocus = await alice.wait('paused')
  log(pausedFocus.d.reason === 'focus', 'focus_lost with lock on sends paused { reason: "focus" }')
  log(info(aliceId).paused === true, 'the student shows as paused in the student list')
  log(info(aliceId).pauseReason === 'focus', 'the pause reason is focus')

  // --- answers while paused are rejected and never stored ---
  const beforePaused = JSON.stringify(server.session.quizState().answeredByStudent)
  alice.send('answer', { qid: 'q1', value: 'b', seq: 1 })
  const pausedErr = await alice.wait('error')
  log(pausedErr.d.code === 'PAUSED', 'an answer while paused returns PAUSED')
  log(
    JSON.stringify(server.session.quizState().answeredByStudent) === beforePaused,
    'a PAUSED answer stores nothing'
  )
  log(!alice.msgs.some((m) => m.t === 'ack'), 'a PAUSED answer is not acked either')

  // --- only the instructor resumes ---
  alice.send('focus_gained', {})
  alice.send('resume_request', {})
  await sleep(300)
  log(!alice.msgs.some((m) => m.t === 'resumed'), 'focus_gained and resume_request never resume')
  log(info(aliceId).paused === true, 'the student is still paused after a resume_request')
  log(info(aliceId).resumeRequested === true, 'the resume_request is marked for the instructor')
  log(server.approveResume('no-such-student') === false, 'approving an unknown student does nothing')
  log(server.approveResume(aliceId), 'approveResume succeeds for a paused student')
  log(!!(await alice.wait('resumed')), 'approveResume sends resumed to the phone')
  log(info(aliceId).paused === false, 'the student is no longer paused after approval')
  log(info(aliceId).resumeRequested === false, 'the resume-request marker is cleared')
  log(
    server.approveResume(aliceId) === false,
    'approving a student who is not paused does nothing'
  )

  // --- focus_lost is ignored while the lock is off ---
  const mark = alice.msgs.length
  server.setLock(false)
  const lockMsg = await alice.wait('lock')
  log(lockMsg.d.on === false, 'setLock(false) broadcasts lock { on: false }')
  log(server.session.lockEnabled() === false, 'the session lock flag follows the toggle')
  alice.send('focus_lost', { reason: 'window' })
  await sleep(300)
  log(!alice.msgs.slice(mark).some((m) => m.t === 'paused'), 'focus_lost with lock off sends no paused')
  log(info(aliceId).paused === false, 'focus_lost with lock off does not pause the student')
  log(
    info(aliceId).focusLosses === 2 && info(aliceId).events.some((e: any) => e.type === 'focus_lost'),
    'focus_lost with lock off is still counted and logged'
  )

  // --- turning the lock off resumes focus pauses ---
  const markPause = alice.msgs.length
  server.setLock(true)
  await sleep(150)
  alice.send('focus_lost', { reason: 'unpinned' })
  await waitFresh(alice, 'paused', 3000, markPause)
  log(info(aliceId).paused === true, 'turning the lock back on pauses on focus_lost again')
  const resumedBefore = alice.msgs.filter((m) => m.t === 'resumed').length
  server.setLock(false)
  await sleep(300)
  log(
    alice.msgs.filter((m) => m.t === 'resumed').length === resumedBefore + 1,
    'setLock(false) resumes a focus pause'
  )
  log(info(aliceId).paused === false, 'the focus pause is cleared when the lock goes off')

  // --- heartbeat timeout while running pauses for network ---
  clearInterval(bobHb)
  const t0 = Date.now()
  while (!info(bobId).paused && Date.now() - t0 < 6000) await sleep(100)
  log(info(bobId).paused === true, 'no heartbeat while running pauses the student')
  log(info(bobId).pauseReason === 'network', 'the heartbeat pause reason is network')
  log(
    server.session.quizState().status === 'running' && server.session.quizState().endsAt !== null,
    'the quiz clock keeps running for a paused student'
  )
  bob.send('answer', { qid: 'q1', value: 'b', seq: 1 })
  log((await bob.wait('error')).d.code === 'PAUSED', 'a network-paused student also gets PAUSED')

  // --- a network-paused student rejoining stays paused ---
  bob.close()
  await sleep(200)
  const bob2 = client(port)
  await bob2.open()
  bob2.send('join', { pin, name: 'LockBob', deviceToken: 'lock-bob' })
  await bob2.wait('quiz_start')
  await bob2.wait('answers_state')
  const rejoinPaused = await bob2.wait('paused')
  log(
    rejoinPaused.d.reason === 'network',
    'a network-paused rejoin gets quiz_start, answers_state, then paused { reason: "network" }'
  )
  log(info(bobId).paused === true, 'the rejoin did not clear the pause')
  const bob2Hb = setInterval(() => bob2.send('hb', {}), 400)
  bob2.send('resume_request', {})
  await sleep(250)
  log(!bob2.msgs.some((m) => m.t === 'resumed'), 'a rejoined student is still not auto-resumed')

  // --- lock off does not touch network pauses ---
  server.setLock(false)
  await sleep(300)
  log(!bob2.msgs.some((m) => m.t === 'resumed'), 'setLock(false) does not resume network pauses')
  log(info(bobId).paused === true, 'the network pause survives the lock going off')

  // --- approve all ---
  server.setLock(true)
  await sleep(150)
  const markPause2 = alice.msgs.length
  alice.send('focus_lost', { reason: 'background' })
  await waitFresh(alice, 'paused', 3000, markPause2)
  const approved = server.approveAllResume()
  log(approved === 2, `approveAllResume resumed both paused students (${approved})`)
  await sleep(250)
  log(info(aliceId).paused === false && info(bobId).paused === false, 'nobody is paused any more')

  // --- the in-memory event log ---
  const aliceEvents = info(aliceId).events.map((e: any) => e.type)
  const bobEvents = info(bobId).events.map((e: any) => e.type)
  for (const type of ['focus_lost', 'focus_gained', 'paused', 'resumed', 'resume_request']) {
    log(aliceEvents.includes(type), `Alice's event log holds a "${type}" event`)
  }
  for (const type of ['paused', 'disconnect', 'resume_request']) {
    log(bobEvents.includes(type), `Bob's event log holds a "${type}" event`)
  }
  log(
    info(aliceId).events.every((e: any) => typeof e.at === 'number' && Number.isFinite(e.at)),
    'every event carries a timestamp'
  )
  log(
    info(aliceId).events.filter((e: any) => e.type === 'focus_lost').length ===
      info(aliceId).focusLosses,
    'the focus-loss counter matches the number of focus_lost events'
  )

  clearInterval(aliceHb)
  clearInterval(bob2Hb)
  bob2.close()
  server.endQuiz()
  await sleep(150)
  server.session.heartbeatTimeoutMs = 10_000
  server.newSession()
}

/** Step-5 finish against the live server. */
async function checkFinish(server: any, port: number, quiz: Quiz = SAMPLE_QUIZ): Promise<void> {
  server.newSession()
  // A short heartbeat timeout keeps the exemption test fast.
  server.session.heartbeatTimeoutMs = 1500
  const pin = server.session.pin

  const alice = client(port)
  await alice.open()
  alice.send('join', { pin, name: 'FinAlice', deviceToken: 'fin-alice' })
  const aliceId = (await alice.wait('joined')).d.studentId
  const aliceHb = setInterval(() => alice.send('hb', {}), 400)

  const bob = client(port)
  await bob.open()
  bob.send('join', { pin, name: 'FinBob', deviceToken: 'fin-bob' })
  const bobId = (await bob.wait('joined')).d.studentId
  const bobHb = setInterval(() => bob.send('hb', {}), 400)

  const info = (id: string): any => server.session.list().find((s: any) => s.id === id)

  log(server.startQuiz(quiz), 'the quiz starts for the finish test')
  await alice.wait('quiz_start')
  await bob.wait('quiz_start')

  // --- finish gives finished ---
  let seq = 0
  alice.send('answer', { qid: 'q1', value: TYPE_ANSWERS.q1, seq: ++seq })
  await alice.wait('ack')
  alice.send('finish', {})
  await waitFresh(alice, 'finished')
  log(true, 'finish gives finished')
  log(info(aliceId).finished === true, 'the student shows as finished in the student list')
  log(
    typeof info(aliceId).finishedAt === 'number' && Number.isFinite(info(aliceId).finishedAt),
    'a finished timestamp is recorded'
  )
  log(
    info(aliceId).events.some((e: any) => e.type === 'finished'),
    'a "finished" event is logged for the student'
  )

  // --- later answers get FINISHED and are not stored ---
  const before = JSON.stringify(server.session.quizState().answeredByStudent)
  const acksBefore = alice.msgs.filter((m) => m.t === 'ack').length
  alice.send('answer', { qid: 'q2', value: TYPE_ANSWERS.q2, seq: ++seq })
  log((await waitFresh(alice, 'error')).d.code === 'FINISHED', 'a later answer gets FINISHED')
  log(
    JSON.stringify(server.session.quizState().answeredByStudent) === before,
    'a FINISHED answer stores nothing'
  )
  log(
    alice.msgs.filter((m) => m.t === 'ack').length === acksBefore,
    'a FINISHED answer is not acked either'
  )

  // --- repeated finish is idempotent ---
  const finishedBefore = alice.msgs.filter((m) => m.t === 'finished').length
  alice.send('finish', {})
  await waitFresh(alice, 'finished', 3000, alice.msgs.length)
  log(
    alice.msgs.filter((m) => m.t === 'finished').length === finishedBefore + 1,
    'a repeated finish gets another finished'
  )
  log(
    info(aliceId).events.filter((e: any) => e.type === 'finished').length === 1,
    'the repeated finish does not log a second finished event'
  )

  // --- finish while paused gets PAUSED ---
  bob.send('focus_lost', { reason: 'background' })
  await waitFresh(bob, 'paused')
  const pausedErrs = bob.msgs.filter((m) => m.t === 'error').length
  bob.send('finish', {})
  log((await waitFresh(bob, 'error', 3000, pausedErrs)).d.code === 'PAUSED', 'finish while paused gets PAUSED')
  log(info(bobId).finished === false, 'a PAUSED finish does not finish the student')
  log(server.approveResume(bobId), 'the paused student is approved for the exemption test')

  // --- a finished student is not paused by focus_lost or a heartbeat timeout ---
  alice.send('focus_lost', { reason: 'background' })
  await sleep(300)
  log(info(aliceId).paused === false, 'focus_lost does not pause a finished student')
  log(
    info(aliceId).focusLosses === 1 && info(aliceId).events.some((e: any) => e.type === 'focus_lost'),
    'the focus_lost on a finished student is still counted and logged'
  )
  clearInterval(aliceHb)
  const sweep0 = Date.now()
  while (info(aliceId).paused && Date.now() - sweep0 < 6000) await sleep(100)
  await sleep(2200)
  log(info(aliceId).paused === false, 'a heartbeat timeout does not pause a finished student')
  log(info(aliceId).status === 'disconnected', 'the finished student still shows as disconnected')

  // --- rejoin sends quiz_start + answers_state + finished ---
  alice.close()
  await sleep(200)
  const rejoin = client(port)
  await rejoin.open()
  const from = rejoin.msgs.length
  rejoin.send('join', { pin, name: 'FinAlice', deviceToken: 'fin-alice' })
  await rejoin.wait('joined')
  await waitFresh(rejoin, 'quiz_start', 3000, from)
  log(true, 'a finished rejoin gets quiz_start again')
  const state = await waitFresh(rejoin, 'answers_state', 3000, from)
  log(state.d.answers.q1 === TYPE_ANSWERS.q1, 'a finished rejoin still gets its answers_state')
  const fin = await waitFresh(rejoin, 'finished', 3000, from)
  log(!!fin, 'a finished rejoin gets quiz_start + answers_state + finished')

  // --- quiz_end still works afterwards ---
  log(server.session.quizState().status === 'running', 'the quiz is still running with everyone finished')
  log(server.endQuiz(), 'endQuiz still works after finishes')
  await rejoin.wait('quiz_end')

  clearInterval(bobHb)
  bob.close()
  rejoin.close()
  await sleep(150)
  server.session.heartbeatTimeoutMs = 10_000
  server.newSession()
}

/**
 * Clean disconnects and paused reconnects against the live server.
 *
 * A clean socket close must still reach the (shortened) heartbeat timeout and
 * become a network pause, and a rejoin must replay the student's real pause
 * reason without ever auto-resuming them. Only instructor approval resumes.
 */
async function checkReconnectPause(server: any, port: number, quiz: Quiz = SAMPLE_QUIZ): Promise<void> {
  server.newSession()
  // A short heartbeat timeout keeps the disconnect tests fast.
  server.session.heartbeatTimeoutMs = 1500
  const pin = server.session.pin
  const info = (id: string): any => server.session.list().find((s: any) => s.id === id)

  const dina = client(port)
  await dina.open()
  dina.send('join', { pin, name: 'RcDina', deviceToken: 'rc-dina' })
  const dinaId = (await dina.wait('joined')).d.studentId
  const dinaHb = setInterval(() => dina.send('hb', {}), 400)

  const eli = client(port)
  await eli.open()
  eli.send('join', { pin, name: 'RcEli', deviceToken: 'rc-eli' })
  const eliId = (await eli.wait('joined')).d.studentId
  const eliHb = setInterval(() => eli.send('hb', {}), 400)

  const fay = client(port)
  await fay.open()
  fay.send('join', { pin, name: 'RcFay', deviceToken: 'rc-fay' })
  const fayId = (await fay.wait('joined')).d.studentId
  const fayHb = setInterval(() => fay.send('hb', {}), 400)

  const gus = client(port)
  await gus.open()
  gus.send('join', { pin, name: 'RcGus', deviceToken: 'rc-gus' })
  const gusId = (await gus.wait('joined')).d.studentId
  const gusHb = setInterval(() => gus.send('hb', {}), 400)

  log(server.startQuiz(quiz), 'the quiz starts for the reconnect tests')
  for (const c of [dina, eli, fay, gus]) await c.wait('quiz_start')
  // --- Test B: a rejoin before the heartbeat timeout must not pause ---
  eli.send('answer', { qid: 'q1', value: TYPE_ANSWERS.q1, seq: 1 })
  await eli.wait('ack')
  clearInterval(eliHb)
  eli.close()
  await sleep(200)
  log(info(eliId).status === 'disconnected', 'B: a clean close marks the student disconnected at once')
  const eliBack = client(port)
  await eliBack.open()
  eliBack.send('join', { pin, name: 'RcEli', deviceToken: 'rc-eli' })
  await eliBack.wait('joined')
  await eliBack.wait('quiz_start')
  const eliState = await eliBack.wait('answers_state')
  log(eliState.d.answers.q1 === TYPE_ANSWERS.q1, 'B: the rejoin restores the stored answer')
  log(!eliBack.msgs.some((m) => m.t === 'paused'), 'B: a rejoin before the timeout is not paused')
  log(info(eliId).paused === false, 'B: the student is not paused after the early rejoin')
  log(info(eliId).status === 'connected', 'B: the rejoined student is connected again')
  const eliHb2 = setInterval(() => eliBack.send('hb', {}), 400)

  // --- Test A: a clean close must still reach the network pause ---
  const answeredBefore = JSON.stringify(server.session.quizState().answeredByStudent)
  const endsAtBefore = server.session.quizState().endsAt
  clearInterval(dinaHb)
  dina.close()
  await sleep(300)
  log(info(dinaId).status === 'disconnected', 'A: a clean close marks the student disconnected at once')
  log(info(dinaId).paused === false, 'A: the close does not pause before the heartbeat timeout')
  const tA = Date.now()
  while (!info(dinaId).paused && Date.now() - tA < 6000) await sleep(100)
  log(info(dinaId).paused === true, 'A: a clean disconnect pauses after the heartbeat timeout')
  log(info(dinaId).pauseReason === 'network', 'A: the pause reason is network')
  log(
    server.session.quizState().status === 'running' && server.session.quizState().endsAt === endsAtBefore,
    'A: the quiz timer keeps running and is unchanged'
  )
  log(
    JSON.stringify(server.session.quizState().answeredByStudent) === answeredBefore,
    'A: the pause does not alter answer data'
  )
  log(info(eliId).paused === false && info(eliId).status === 'connected', 'A: a heartbeating student is unaffected')
  // --- Test C: a network-paused rejoin replays the reason and stays paused ---
  const dinaBack = client(port)
  await dinaBack.open()
  dinaBack.send('join', { pin, name: 'RcDina', deviceToken: 'rc-dina' })
  await dinaBack.wait('joined')
  await dinaBack.wait('quiz_start')
  await dinaBack.wait('answers_state')
  const dinaPaused = await dinaBack.wait('paused')
  log(
    dinaPaused.d.reason === 'network',
    'C: a network-paused rejoin gets quiz_start, answers_state, then paused { reason: "network" }'
  )
  const order = ['joined', 'quiz_start', 'answers_state', 'paused'].map((t) =>
    dinaBack.msgs.findIndex((m) => m.t === t)
  )
  log(order.every((i, n) => i >= 0 && (n === 0 || order[n - 1] < i)), 'C: the rejoin messages arrive in order')
  log(info(dinaId).paused === true, 'C: the rejoin does not clear the pause')
  log(!dinaBack.msgs.some((m) => m.t === 'resumed'), 'C: the rejoin does not auto-resume')
  const cErrs = dinaBack.msgs.length
  dinaBack.send('answer', { qid: 'q2', value: TYPE_ANSWERS.q2, seq: 1 })
  log(
    (await waitFresh(dinaBack, 'error', 3000, cErrs)).d.code === 'PAUSED',
    'C: an answer while still paused gets PAUSED'
  )
  log(info(dinaId).paused === true, 'C: the rejected answer leaves the pause in place')
  const dinaHb2 = setInterval(() => dinaBack.send('hb', {}), 400)

  // --- Test D: a focus-paused rejoin replays the focus reason ---
  fay.send('focus_lost', { reason: 'background' })
  await fay.wait('paused')
  log(info(fayId).pauseReason === 'focus', 'D: focus_lost with the lock on pauses for focus')
  clearInterval(fayHb)
  fay.close()
  await sleep(200)
  log(info(fayId).paused === true, 'D: the clean close does not clear the focus pause')
  const fayBack = client(port)
  await fayBack.open()
  fayBack.send('join', { pin, name: 'RcFay', deviceToken: 'rc-fay' })
  await fayBack.wait('joined')
  await fayBack.wait('quiz_start')
  await fayBack.wait('answers_state')
  const fayPaused = await fayBack.wait('paused')
  log(fayPaused.d.reason === 'focus', 'D: a focus-paused rejoin replays paused { reason: "focus" }')
  log(info(fayId).paused === true && info(fayId).pauseReason === 'focus', 'D: the student remains focus-paused')
  log(!fayBack.msgs.some((m) => m.t === 'resumed'), 'D: the rejoin does not auto-resume')
  const dErrs = fayBack.msgs.length
  fayBack.send('answer', { qid: 'q1', value: TYPE_ANSWERS.q1, seq: 1 })
  log(
    (await waitFresh(fayBack, 'error', 3000, dErrs)).d.code === 'PAUSED',
    'D: an answer while focus-paused gets PAUSED'
  )
  const fayHb2 = setInterval(() => fayBack.send('hb', {}), 400)
  // --- Test E: only instructor approval resumes, for both pause reasons ---
  log(server.approveResume('no-such-student') === false, 'E: approving an unknown student does nothing')
  log(!dinaBack.msgs.some((m) => m.t === 'resumed'), 'E: the network pause was not resumed without approval')
  log(!fayBack.msgs.some((m) => m.t === 'resumed'), 'E: the focus pause was not resumed without approval')
  log(server.approveResume(dinaId), 'E: instructor approval resumes the network pause')
  await dinaBack.wait('resumed')
  log(info(dinaId).paused === false, 'E: approval clears the network pause')
  log(server.approveResume(fayId), 'E: instructor approval resumes the focus pause')
  await fayBack.wait('resumed')
  log(info(fayId).paused === false, 'E: approval clears the focus pause')

  // --- Test F: a finished student is never paused by a clean disconnect ---
  gus.send('answer', { qid: 'q3', value: TYPE_ANSWERS.q3, seq: 1 })
  await gus.wait('ack')
  gus.send('finish', {})
  await gus.wait('finished')
  log(info(gusId).finished === true, 'F: the student finishes before disconnecting')
  clearInterval(gusHb)
  gus.close()
  await sleep(300)
  log(info(gusId).status === 'disconnected', 'F: the finished student is marked disconnected')
  await sleep(2600) // well past the 1500 ms heartbeat timeout, so the sweep has run
  log(info(gusId).paused === false, 'F: a finished student is never paused after a clean disconnect')
  log(info(gusId).finished === true, 'F: the finished flag is unchanged')
  const gusBack = client(port)
  await gusBack.open()
  gusBack.send('join', { pin, name: 'RcGus', deviceToken: 'rc-gus' })
  await gusBack.wait('joined')
  await gusBack.wait('quiz_start')
  await gusBack.wait('answers_state')
  await gusBack.wait('finished')
  log(!gusBack.msgs.some((m) => m.t === 'paused'), 'F: a finished rejoin is not replayed as paused')
  log(info(gusId).paused === false, 'F: the finished student stays unpaused after rejoining')

  clearInterval(eliHb2)
  clearInterval(dinaHb2)
  clearInterval(fayHb2)
  eliBack.close()
  dinaBack.close()
  fayBack.close()
  gusBack.close()
  await sleep(150)
  server.session.heartbeatTimeoutMs = 10_000
  server.newSession()
}

/** A student of the results snapshot, shaped like the roster entry. */
function resultStudent(id: string, name: string, finished: boolean): StudentInfo {
  return {
    id,
    name,
    status: 'connected',
    paused: false,
    pauseReason: null,
    focusLosses: 0,
    resumeRequested: false,
    finished,
    finishedAt: finished ? 2000 : null,
    events: []
  }
}

/** The quiz the results checks run against: one question of every type. */
function resultQuiz(): StoredQuiz {
  return {
    id: 'quiz-1',
    title: 'Results quiz',
    timeLimitSec: 300,
    createdAt: 0,
    updatedAt: 0,
    questions: validQuestions()
  }
}

/** The questions of that quiz, in the shape the results store wants. */
function resultQuestions(quiz: StoredQuiz): ResultQuestionInput[] {
  return snapshotQuestions(quiz, null)
}

/**
 * The results checks: the grading of every question type, the score sheet
 * that comes out of it, the instructor's edits and the CRUD around it. All of
 * it against a temp database, like the library checks.
 */
function checkResults(): void {
  const dir = mkdtempSync(join(tmpdir(), 'quiz-results-'))
  try {
    const dbPath = join(dir, 'results.db')
    const data = openAppData(dbPath)
    try {
      checkResultsStore(data.results, dbPath)
    } finally {
      data.quizzes.close()
    }
    checkResultsMigration(dir)
  } finally {
     safeRmSync(dir)
  }
}

/** The results checks against one open store. */
function checkResultsStore(store: ResultsStore, dbPath: string): void {
  {
    const quiz = resultQuiz()
    const questions = resultQuestions(quiz)

    log(questions.length === 8, 'the snapshot keeps a question of every type')

    // --- the grader on its own, for every type ---
    const byId = (id: string): ResultQuestionInput => questions.find((q) => q.id === id)!
    const graded = (id: string, value: any) => gradeAnswer(byId(id), value)
    log(graded('t-mcq', 'b').correct === true && graded('t-mcq', 'b').pointsAwarded === 1, 'an mcq answer is graded on the option id')
    log(graded('t-mcq', 'a').correct === false, 'the wrong mcq option is wrong')
    log(graded('t-tf', true).correct === true && graded('t-tf', false).correct === false, 'a true/false answer is graded on the boolean')
    log(graded('t-id', ' paris ').correct === true, 'an identification answer ignores case and spaces')
    log(graded('t-id', 'Kyoto').correct === false, 'the wrong identification answer is wrong')
    log(
      graded('t-fillin', ['x', 'y']).pointsAwarded === 2 && graded('t-fillin', ['x', 'y']).correct === true,
      'a fill-in with every blank right gets every point'
    )
    log(
      graded('t-fillin', ['x', 'nope']).pointsAwarded === 1 &&
        graded('t-fillin', ['x', 'nope']).correct === false,
      'a fill-in with one blank right gets half the points'
    )
    log(
      graded('t-fillin', ['x', 'why']).correct === true,
      'a fill-in accepts an alternative answer for a blank'
    )
    log(
      graded('t-enum', ['red', 'blue']).pointsAwarded === 2,
      'an enumeration with every item right gets every point'
    )
    log(graded('t-enum', ['red']).pointsAwarded === 1, 'an enumeration with one item right gets partial points')
    log(
      graded('t-enum', ['red', 'red', 'red']).pointsAwarded === 1,
      'an enumeration counts the same answer only once'
    )
    log(
      graded('t-enum', ['red', 'green', 'blue']).pointsAwarded === 2,
      'an enumeration with every colour right gets every point'
    )
    log(graded('t-prob', '42.3').correct === true, 'a problem answer inside the tolerance is right')
    log(graded('t-prob', '41').correct === false, 'a problem answer outside the tolerance is wrong')
    log(graded('t-prob', '42.6').correct === false, 'the tolerance is not a free pass')
    log(graded('t-match', { l1: 'r1', l2: 'r2' }).pointsAwarded === 3, 'a complete matching gets every point')
    log(graded('t-match', { l1: 'r1' }).pointsAwarded === 1.5, 'a half-right matching gets half the points')
    log(graded('t-conn', { p1: 'a1', p2: 'a2' }).pointsAwarded === 3, 'a complete connect gets every point')
    log(graded('t-conn', { p1: 'a1' }).pointsAwarded === 1.5, 'a half-right connect gets half the points')
    log(graded('t-mcq', null).correct === null, 'an answer that was never given is not graded')

    // --- the case, the spaces and the dashes do not count ---
    log(graded('t-id', 'PARIS').correct === true, 'an identification answer ignores the case')
    log(graded('t-id', '  pArIs  ').correct === true, 'an identification answer ignores the spaces around it')
    log(graded('t-id', 'P a r i s').correct === true, 'an identification answer ignores spaces inside it')
    log(graded('t-id', 'Par').correct === false, 'a shorter answer is still wrong')
    log(graded('t-id', 'paris-city').correct === false, 'a longer answer is still wrong')
    log(graded('t-fillin', ['X', 'y']).correct === true, 'a fill-in blank ignores the case')
    log(graded('t-fillin', ['x', 'Y']).pointsAwarded === 2, 'every blank right gives every point')
    log(graded('t-enum', ['RED', 'Blue']).pointsAwarded === 2, 'an enumeration ignores the case')
    log(graded('t-enum', ['red', 'green']).pointsAwarded === 1, 'an enumeration with one item right keeps its point')

    // --- the helpers behind it ---
    log(normalizeAnswer('Paris') === 'paris', 'the folding lower-cases the answer')
    log(normalizeAnswer('E-Mail') === 'e mail', 'a hyphen folds into a space')
    log(normalizeAnswer('e–mail') === 'e mail', 'an en dash folds into a space')
    log(normalizeAnswer('e−mail') === 'e mail', 'a minus sign folds into a space')
    log(normalizeAnswer('the  beatles') === 'the beatles', 'a run of spaces folds into one space')
    log(normalizeAnswerTight('e-mail') === 'email', 'the tight folding drops the separator')
    log(normalizeAnswerTight('E Mail') === 'email', 'the tight folding drops the case too')
    log(
      compareAnswers('Paris', 'Paris') === 'exact',
      'the same text is an exact match'
    )
    log(
      compareAnswers('PARIS', 'Paris') === 'loose',
      'a different case is a loose match'
    )
    log(
      compareAnswers('e mail', 'e-mail') === 'loose',
      'a dash for a space is a loose match'
    )
    log(
      compareAnswers('email', 'e-mail') === 'loose',
      'a missing separator is a loose match'
    )
    log(
      compareAnswers('London', 'Paris') === 'none',
      'a different word is not a match'
    )
    log(answersMatch(['Paris'], 'pArIs'), 'the match helper finds the answer')
    log(!answersMatch(['Paris'], 'Rome'), 'the match helper rejects the wrong answer')
    log(editDistance('abc', 'abc') === 0, 'the edit distance of the same text is zero')
    log(editDistance('abc', 'abd') === 1, 'the edit distance counts one change')
    log(editDistance('', 'abc') === 3, 'the edit distance counts every letter of an empty text')
    log(suggestAnswer(['Paris'], 'Pariss') === 'Paris', 'a close answer suggests the key')
    log(suggestAnswer(['Paris'], 'London') === null, 'a far answer suggests nothing')
    log(suggestAnswer(['Paris'], '') === null, 'an empty answer suggests nothing')

    // --- what the instructor is told about an answer ---
    const idQuestion = byId('t-id')
    log(
      adviseAnswer(idQuestion, 'Paris').match === 'exact',
      'the advice calls a letter-perfect answer exact'
    )
    log(
      adviseAnswer(idQuestion, 'PARIS').match === 'loose',
      'the advice calls a carelessly written answer loose'
    )
    log(
      adviseAnswer(idQuestion, 'Pariss').suggestion === 'Paris',
      'the advice suggests the key for a near miss'
    )
    log(
      adviseAnswer(idQuestion, 'London').suggestion === null,
      'the advice says nothing for a far miss'
    )
    log(
      adviseAnswer(byId('t-mcq'), 'b').match === 'exact' &&
        adviseAnswer(byId('t-mcq'), 'a').match === 'none',
      'the advice reads an option id as it is'
    )

    // --- the snapshot of a finished session ---
    const snapshot = buildSessionSnapshot({
      quiz,
      runtime: null,
      quizTitle: 'Results quiz',
      startedAt: 1000,
      endedAt: 2000,
      endReason: 'instructor',
      students: [
        resultStudent('s1', 'Alice', true),
        resultStudent('s2', 'Bob', false),
        resultStudent('s3', 'Carol', false)
      ],
      answers: {
        s1: {
          't-mcq': 'b',
          't-tf': true,
          't-id': 'PARIS',
          't-fillin': ['x', 'y'],
          't-enum': ['red', 'blue'],
          't-prob': '42.3',
          't-match': { l1: 'r1', l2: 'r2' },
          't-conn': { p1: 'a1', p2: 'a2' }
        },
        s2: {
          't-mcq': 'a',
          't-tf': false,
          't-id': 'Kyoto',
          't-fillin': ['x', 'nope'],
          't-enum': ['red'],
          't-prob': '41',
          't-match': { l1: 'r1' },
          't-conn': { p1: 'a1' }
        }
      }
    })
    log(snapshot.quizId === 'quiz-1' && snapshot.students.length === 3, 'the snapshot keeps the quiz and the students')

    const meta = store.createFromSession(snapshot)
    log(meta.quizTitle === 'Results quiz' && meta.totalPoints === 16, 'the session keeps its title and the quiz total')
    log(meta.endReason === 'instructor' && meta.startedAt === 1000 && meta.endedAt === 2000, 'the session keeps when it ran')
    log(store.list().length === 1 && store.list()[0].studentCount === 3, 'the results list shows the session with its three students')

    const detail = store.get(meta.id)!
    log(detail.questions.length === 8, 'the score sheet keeps every question')
    log(detail.students.length === 3, 'the score sheet keeps every student')
    log(detail.questions[0].key === 'b', 'the score sheet keeps the answer keys')

    const alice = detail.students.find((s) => s.studentName === 'Alice')!
    const bob = detail.students.find((s) => s.studentName === 'Bob')!
    const carol = detail.students.find((s) => s.studentName === 'Carol')!
    // The answers point at the snapshot rows, so the library id is looked up
    // through the question list.
    const rowIdOf = (libraryId: string): string =>
      detail.questions.find((q) => q.questionId === libraryId)!.id
    const answerOf = (student: typeof alice, libraryId: string) =>
      student.answers.find((a) => a.questionId === rowIdOf(libraryId))!
    log(alice.totalPointsAwarded === 16 && alice.totalPointsPossible === 16, 'a perfect student scores every point')
    log(bob.totalPointsAwarded === 5, 'a partly wrong student gets the partial points')
    log(
      carol.totalPointsAwarded === 0 &&
        carol.answers.length === 8 &&
        carol.answers.every((a) => a.value === null && a.correct === null),
      'a student who never answered has a row for every question but no mark'
    )
    log(answerOf(bob, 't-fillin').pointsAwarded === 1, 'the score sheet shows the partial points of a fill-in')
    log(answerOf(bob, 't-match').pointsAwarded === 1.5, 'the score sheet shows the partial points of a matching')
    log(answerOf(alice, 't-prob').correct === true, 'the score sheet marks a tolerated answer as right')
    log(
      answerOf(alice, 't-id').correct === true && answerOf(alice, 't-id').pointsAwarded === 1,
      'a student who typed the answer in capitals keeps the point'
    )
    log(answerOf(bob, 't-prob').correct === false, 'the score sheet marks a wrong answer as wrong')

    // --- the instructor changes a mark ---
    const edited = answerOf(bob, 't-fillin')
    const update = store.updateAnswer({
      answerId: edited.id,
      pointsAwarded: 2,
      correct: true,
      notes: 'good idea, wrong word'
    })
    log(update.ok, 'an instructor can change a mark')
    const after = store.get(meta.id)!
    const bobAfter = after.students.find((s) => s.studentName === 'Bob')!
    log(bobAfter.totalPointsAwarded === 6, 'the student total follows the changed mark')
    const changed = bobAfter.answers.find((a) => a.id === edited.id)!
    log(changed.autoGraded === false, 'a changed mark is no longer auto-graded')
    log(changed.notes === 'good idea, wrong word', 'the note of a changed mark is kept')
    log(changed.correct === true && changed.pointsAwarded === 2, 'the mark and the points of the change are stored')

    log(store.updateAnswer({ answerId: edited.id, pointsAwarded: 99 }).ok, 'a mark beyond the question is accepted')
    const clamped = store.get(meta.id)!.students
      .find((s) => s.studentName === 'Bob')!
      .answers.find((a) => a.id === edited.id)!
    log(clamped.pointsAwarded === 2, 'a mark beyond the question is clamped to the question')
    log(
      store.updateAnswer({ answerId: 'no-such-answer', pointsAwarded: 1 }).ok === false,
      'changing an answer that is not there is refused'
    )
    log(
      store.updateAnswer({ answerId: edited.id, pointsAwarded: Number.NaN }).ok === false,
      'a mark that is not a number is refused'
    )

    // --- delete ---
    log(store.delete(meta.id), 'a session can be deleted')
    log(store.get(meta.id) === null, 'the deleted session is gone')
    log(store.list().length === 0, 'the results list is empty again')
    log(store.delete(meta.id) === false, 'deleting twice reports false')

    // The cascade really happened: the rows are gone from the file.
    const raw = new Database(dbPath)
    const left = raw
      .prepare(
        `SELECT (SELECT COUNT(*) FROM result_students) +
                (SELECT COUNT(*) FROM result_questions) +
                (SELECT COUNT(*) FROM result_answers) AS n`
      )
      .get() as { n: number }
    log(left.n === 0, 'deleting a session takes its students, questions and answers with it')
    raw.close()
  }
}

/**
 * An existing database (schema v2) upgrades to v3 without losing anything:
 * the library is still there and the results tables are created.
 */
function checkResultsMigration(dir: string): void {
  const path = join(dir, 'legacy.db')
  const first = openAppData(path)
  first.quizzes.create('Legacy quiz')
  first.quizzes.close()

  // Turn it back into a v2 database: no results tables, user_version 2.
  const raw = new Database(path)
  raw.pragma('foreign_keys = OFF')
  raw.exec('DROP TABLE IF EXISTS result_answers; DROP TABLE IF EXISTS result_students; DROP TABLE IF EXISTS result_questions; DROP TABLE IF EXISTS result_sessions; DROP TABLE IF EXISTS ai_chunks; DROP TABLE IF EXISTS ai_fts; DROP TABLE IF EXISTS ai_vectors; DROP INDEX IF EXISTS idx_ai_chunks_source;')
  raw.pragma('user_version = 2')
  raw.close()

  const upgraded = openAppData(path)
  const quizzes = upgraded.quizzes.list()
  log(quizzes.some((q) => q.title === 'Legacy quiz'), 'an existing database keeps its quizzes after the upgrade')
  log(upgraded.results.list().length === 0, 'the upgraded database starts with no results')
  log(upgraded.results.get('no-such-session') === null, 'an unknown session is unknown to the results store')
  upgraded.quizzes.close()
}

/**
 * The AI layer: stub provider generation, validation of all eight types,
 * auto-key completion, and round-trip through the library.
 */
async function checkAi(): Promise<void> {
  const manager = createAiManager()

  // --- status ---
  const status = manager.status()
  log(status.ready === true, 'the AI stub provider reports ready')
  log(typeof status.provider === 'string' && status.provider.length > 0, 'the stub provider has a name')

  // --- chunking ---
  const text = 'Alpha. Beta. Gamma. Delta. Epsilon. Zeta. Eta. Theta. Iota. Kappa. '
  const chunks = await manager.chunkText(text)
  log(chunks.length > 0, 'the chunker splits text into at least one chunk')
  log(chunks.every((c) => c.text.length > 0), 'every chunk has non-empty text')

  // --- generation: all 8 types, valid ---
  const result = await manager.generate({
    sourceText: 'The Earth orbits the Sun. Gold is Au. Water boils at 100°C.',
    questionTypes: QUESTION_TYPES,
    count: 8,
    points: 1
  })

  log(result.questions.length === 8, 'AI generates 8 questions, one per type')
  for (let i = 0; i < result.questions.length; i++) {
    const q = result.questions[i]!
    const stub = { ...q, id: `ai-test-${i}`, status: 'ready' as const }
    const problems = validateQuestion(stub)
    log(problems.length === 0, `generated ${q.type} question passes validation`)
  }

  // --- round-trip through the library ---
  const dir = mkdtempSync(join(tmpdir(), 'quiz-ai-'))
  try {
    const data = openAppData(join(dir, 'ai.db'))
    const quiz = data.quizzes.create('AI test')
    quiz.questions = result.questions.map((q) => ({ ...q, id: randomUUID(), status: 'draft' as const }))
    const saved = data.quizzes.save(quiz)
    const loaded = data.quizzes.get(saved.id)
    log(loaded !== null, 'the generated quiz round-trips through the library')
    log(
      loaded !== null && loaded.questions.length === 8,
      'the saved quiz has all 8 questions'
    )
    log(
      !!loaded && loaded.questions.every((q) => validateQuestion(q).length === 0),
      'every saved question is still valid after round-trip'
    )
    data.quizzes.close()
  } finally {
     safeRmSync(dir)
  }

  // --- auto-key ---
  const draftQuestions: StoredQuestion[] = [
    { id: 'd1', type: 'mcq', body: 'Test?', points: 1, data: { options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] }, key: null, sourceText: '', status: 'draft' },
    { id: 'd2', type: 'tf', body: 'True or false.', points: 1, data: {}, key: null, sourceText: '', status: 'draft' }
  ]
  const autoKeyed = await manager.autoKey({ questions: draftQuestions })
  log(autoKeyed.questions.length === 2, 'autoKey returns one key per question')
  log(autoKeyed.questions.every((q) => q.key !== null), 'every autoKeyed question has a key')
}

/**
 * The retrieval: cutting a document into pieces, searching it by words,
 * putting two rankings together and picking passages that are not all the
 * same.
 */
async function checkRag(): Promise<void> {
  // --- cutting a document ---
  const run = (text: string, bold = false) => ({
    text,
    bold,
    underline: false,
    highlight: false
  })
  const paragraph = (text: string) => ({ kind: 'paragraph' as const, runs: [run(text)] })
  const blocks = blocksToDocBlocks([
    { kind: 'paragraph', heading: 1, runs: [run('1. Introduction', true)] },
    paragraph(
      'Photosynthesis turns water and carbon dioxide into sugar and oxygen. Chlorophyll absorbs the light of the sun. The energy of the light is stored in the sugar. The oxygen is given back to the air through the stomata of the leaf.'
    ),
    paragraph(
      'The sugar is carried through the plant to the parts that need it. The phloem does this work. The leaves are the kitchens of the plant. The roots bring the water up from the soil. Every part of the plant eats what the leaves make.'
    ),
    { kind: 'paragraph', heading: 1, runs: [run('2. Meiosis', true)] },
    paragraph(
      'Meiosis halves the number of chromosomes in a cell. It happens in two divisions. The first division separates the homologous chromosomes. The second division separates the sister chromatids. The result is four cells with half the chromosomes.'
    ),
    paragraph(
      'Meiosis makes the gametes. A gamete has one set of chromosomes. When two gametes meet, they fuse. The new cell has two sets of chromosomes again. That is fertilization.'
    )
  ])

  const chunks = chunkDocument(blocks)
  const parents = chunks.filter((chunk) => chunk.kind === 'parent')
  const children = chunks.filter((chunk) => chunk.kind === 'child')

  log(parents.length >= 2, `a document becomes parent chunks (${parents.length})`)
  log(children.length >= 4, `a document becomes child chunks (${children.length})`)
  log(
    children.every((child) => child.parentId !== ''),
    'every child knows the parent it belongs to'
  )
  log(
    parents.some((parent) => parent.heading === '1. Introduction'),
    'a chunk keeps the heading it sits under'
  )
  log(
    parents.some((parent) => parent.heading === '2. Meiosis'),
    'the second section has its own heading'
  )
  log(
    children.every((child) => child.text.length < 400),
    'a child chunk is a part of the document, not the whole document'
  )
  log(
    children.every((child) => child.tokens <= MAX_CHILD_TOKENS + 40),
    'a child chunk stays small enough to search in'
  )
  log(estimateTokens('four words go here') > 0, 'the size of a text is estimated')

  const sentences = splitSentences('One sentence. Two sentences. Three sentences.')
  log(sentences.length === 3, `a text is cut into sentences (${sentences.length})`)
  log(
    contentWords('The chloroplasts in the leaves').includes('chloroplasts'),
    'the words that matter are found'
  )
  log(
    !contentWords('The chloroplasts in the leaves').includes('the'),
    'the words that say nothing are left out'
  )

  // --- the index and the search by words ---
  const dir = mkdtempSync(join(tmpdir(), 'quiz-rag-'))
  try {
    const data = openAppData(join(dir, 'rag.db'))
    const index = data.ai
    const sourceRef = 'file:chapter1.docx'
    index.replace(sourceRef, chunks)

    log(index.has(sourceRef), 'a source is in the index')
    const hits = index.searchWords(sourceRef, 'meiosis chromosomes')
    log(hits.length > 0, 'the search finds a chunk by its words')
    log(
      hits.length > 0 && hits[0].chunk.text.toLowerCase().includes('meiosis'),
      'the best hit is the chunk with the words'
    )
    log(
      index.searchWords(sourceRef, 'nothing here at all').length === 0,
      'a search without a hit finds nothing'
    )
    log(index.list(sourceRef).length === chunks.length, 'every chunk comes back from the index')

    // The vectors of a chunk.
    index.replaceVectors(sourceRef, new Map([[children[0].id, [0.1, 0.2, 0.3]]]))
    log(index.hasVectors(sourceRef), 'the vectors of a source are stored')
    const vectors = index.vectors(sourceRef)
    log(
      vectors.length === 1 && Math.abs(vectors[0].vector[2] - 0.3) < 0.0001,
      'a vector comes back the way it went in'
    )
    log(
      Math.abs(cosineSimilarity([1, 0, 0], [1, 0, 0]) - 1) < 0.0001,
      'the same vectors are one'
    )
    log(
      Math.abs(cosineSimilarity([1, 0, 0], [0, 1, 0])) < 0.0001,
      'two different vectors are not alike'
    )
    log(
      fromBlob(toBlob([0.5, -0.25])).length === 2,
      'a vector survives the trip through bytes'
    )

    data.quizzes.close()
  } finally {
    safeRmSync(dir)
  }

  // --- putting two rankings together ---
  const first = [
    { chunk: { id: 'a', text: 'alpha' } as never, score: 1, rank: 1, source: 'bm25' as const },
    { chunk: { id: 'b', text: 'beta' } as never, score: 0.5, rank: 2, source: 'bm25' as const }
  ]
  const second = [
    { chunk: { id: 'b', text: 'beta' } as never, score: 1, rank: 1, source: 'dense' as const },
    { chunk: { id: 'c', text: 'gamma' } as never, score: 0.5, rank: 2, source: 'dense' as const }
  ]
  const fused = reciprocalRankFusion([first, second])
  log(fused.length === 3, 'the two rankings are put together')
  log(fused[0]?.chunk.id === 'b', 'the chunk both searches found comes first')

  // --- picking passages that are not all the same ---
  const candidates = [
    {
      chunk: { id: '1', text: 'photosynthesis in the leaves' } as never,
      score: 1,
      rank: 1,
      source: 'bm25' as const
    },
    {
      chunk: { id: '2', text: 'photosynthesis in the leaves' } as never,
      score: 0.9,
      rank: 2,
      source: 'bm25' as const
    },
    {
      chunk: { id: '3', text: 'meiosis halves the chromosomes' } as never,
      score: 0.8,
      rank: 3,
      source: 'bm25' as const
    }
  ]
  const picked = maximalMarginalRelevance(candidates, 2)
  log(picked.length === 2, 'as many passages are picked as wanted')
  log(
    picked[0]?.chunk.id === '1' && picked[1]?.chunk.id === '3',
    'the second pick is not a copy of the first'
  )

  // --- the passage the model reads ---
  const passage = {
    text: 'The leaf makes sugar out of light, water and carbon dioxide.',
    heading: '2. Photosynthesis',
    chunkId: 'c1',
    focus: 'The leaf makes sugar out of light, water and carbon dioxide.',
    score: 1
  }
  const context = assembleContext(passage)
  log(context.includes('2. Photosynthesis'), 'the passage keeps its heading')
  log(context.includes('carbon dioxide'), 'the passage holds the text that is read')

  // --- the passages are spread over the document ---
  const many = Array.from({ length: 12 }, (_, i) => ({
    ...children[i % children.length],
    id: `chunk-${i}`,
    text: `${children[i % children.length].text} (part ${i})`
  }))
  const parentMap = new Map(parents.map((parent) => [parent.id, parent]))
  const spreadOut = spread(many, 3, parentMap)
  log(spreadOut.length === 3, 'as many passages are spread out as wanted')
  log(
    new Set(spreadOut.map((entry) => entry.focus)).size === 3,
    'the spread passages are about different sentences'
  )
}

/**
 * The model registry: listing, the active model, the engine path, and the
 * fallback to the built-in generator when llama.cpp is missing.
 */
async function checkAiModels(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'quiz-models-'))
  try {
    const store = new ModelStore(dir)

    const models = store.listModels()
    log(models.length === AVAILABLE_MODELS.length, 'the model list holds every catalog model')
    log(models.every((m) => m.downloaded === false), 'no model is downloaded in a fresh folder')
    log(models.every((m) => m.active === false), 'no model is active in a fresh folder')

    const first = models[0]!
    log(!store.setActiveModel(first.id), 'a model that is not downloaded cannot be activated')
    log(store.getActiveModel() === null, 'the active model stays empty')

    // Pretend the download happened.
    writeFileSync(store.modelPath(first.id)!, 'fake model bytes')
    log(store.isDownloaded(first.id), 'a model file on disk counts as downloaded')

    log(store.setActiveModel(first.id), 'a downloaded model can be activated')
    log(store.getActiveModel() === first.id, 'the active model is remembered')
    log(store.activeConfig().provider === 'gguf', 'the active model becomes the provider')
    log(store.listModels().find((m) => m.id === first.id)?.active === true, 'the list marks the active model')

    // The engine path round-trips.
    log(store.getEnginePath() === null, 'no engine is set at first')
    log(store.setEnginePath('C:\\llama\\llama-cli.exe'), 'the engine path is stored')
    log(store.getEnginePath() === 'C:\\llama\\llama-cli.exe', 'the engine path is read back')
    store.setEnginePath(null)
    log(store.getEnginePath() === null, 'the engine path can be cleared')

    // Deleting the active model falls back to the built-in generator.
    log(store.deleteModel(first.id), 'the model file is deleted')
    log(!store.isDownloaded(first.id), 'the deleted model is gone')
    log(store.getActiveModel() === null, 'deleting the active model clears the choice')

    // A provider without a model file is not ready, and the manager falls back.
    const provider = new GgufProvider({ modelPath: join(dir, 'missing.gguf'), modelName: 'Test model' })
    const providerStatus = provider.status()
    log(providerStatus.ready === false, 'a model without its file is not ready')
    log(
      typeof providerStatus.note === 'string' && providerStatus.note.length > 0,
      'the status says why the model cannot answer'
    )

    const manager = new AiManager(provider)
    const managerStatus = manager.status()
    log(managerStatus.ready === true, 'the manager keeps working with the built-in generator')
    log(managerStatus.provider === 'stub', 'the manager reports the built-in generator')

    const generated = await manager.generate({
      sourceText: 'Gold is Au.',
      questionTypes: ['mcq'],
      count: 1,
      points: 1
    })
    log(generated.questions.length === 1, 'the fallback generator still answers')

    // The JSON the model writes is picked out of whatever it says.
    const parsed = extractJsonArray('noise [ {"a": 1} ] trailing')
    log(Array.isArray(parsed) && parsed.length === 1, 'a JSON list is found in the model output')
    log(extractJsonArray('no json here') === null, 'text without a JSON list gives nothing')
    log(extractJsonArray('[{"broken": ]') === null, 'broken JSON gives nothing')

    // The binary echoes the prompt, so the answer has to be picked out of the
    // noise: the last list that stands on its own, not an inner list of it.
    const echoed = extractJsonArray(
      'prompt: use ["chlorophyll"] as the key\n```json\n[\n  "a",\n  ["carbon dioxide"],\n  true\n]\n```\n[ Prompt: 221 t/s ]'
    )
    log(
      Array.isArray(echoed) && echoed.length === 3 && echoed[1] !== undefined,
      'the outer list of the answer is taken, not the inner one'
    )
    const lastList = extractJsonArray('first [1] then [2, 3] then [ Prompt: 1 t/s ]')
    log(
      Array.isArray(lastList) && lastList.length === 2 && lastList[1] === 3,
      'the last list that parses is the answer'
    )

    // --- the guards that keep a wrong question out of the quiz ---
    const source =
      'my name is alchie im 23 years old. im 6ft tall and 95 kilos. i live in arizona and my favorate color is blue'

    log(isQuestion('What is the favorite color?'), 'a question is recognised as a question')
    log(!isQuestion('The person lives in arizona.'), 'a statement is not a question')
    log(isQuestion('Which planet is known as the Red Planet?'), 'a which-question is recognised')

    log(
      isCopy('my name is alchie im 23 years old. im 6ft tall and 95 kilos.', source),
      'a body that repeats the source is a copy'
    )
    log(!isCopy('What is the favorite color of the person?', source), 'a real question is not a copy')

    log(
      sharesWithSource('The person lives in arizona.', source),
      'a statement that the source also says is accepted'
    )
    log(
      !sharesWithSource('Water boils at 100 degrees Celsius at sea level.', source),
      'a statement about something else is refused'
    )

    const mcqData = {
      options: [
        { id: 'a', text: 'blue' },
        { id: 'b', text: 'red' }
      ]
    }
    log(
      groundedAnswer('mcq', 'a', mcqData, source),
      'a multiple choice answer the text says is accepted'
    )
    log(
      !groundedAnswer('mcq', 'b', mcqData, source),
      'a multiple choice answer the text never says is refused'
    )
    log(
      groundedAnswer('identification', ['blue'], {}, source),
      'an identification answer the text says is accepted'
    )
    log(
      !groundedAnswer('identification', ['chlorophyll'], {}, source),
      'an identification answer the text never says is refused'
    )
    log(
      !groundedAnswer('identification', ['blue', 'chlorophyll'], {}, source),
      'an identification answer with one made-up word is refused'
    )
    log(
      groundedAnswer('fillin', [['23']], { blanks: 1 }, source),
      'a fill-in answer the text says is accepted'
    )
    log(
      !groundedAnswer('fillin', [['Au']], { blanks: 1 }, source),
      'a fill-in answer the text never says is refused'
    )

    // --- the text of notes is often one long sentence ---
    const runOn =
      'My name is Luel i live in dipolog Im filipino i dont like chocolate im 4.9 ft tall i weigh 50 kilos and i like roblox i dont like valorant im at college i go to school only every weekdays and i like tomatoes'
    const facts = splitFacts(runOn)
    log(facts.length >= 8, `a text without full stops is split into facts (${facts.length})`)
    log(
      facts.some((f) => f.toLowerCase().includes('dipolog')),
      'the facts keep the words of the text'
    )
    log(
      splitFacts('First fact here. Second fact here.').length === 2,
      'a text with full stops is split at the full stops'
    )

    log(numberInBody('Which two things does the author like?') === 2, 'a question names a number')
    log(numberInBody('Which three things does the author like?') === 3, 'a number word is read')
    log(numberInBody('What is the name?') === null, 'a question without a number says so')

    log(
      repeatsTheQuestion('i like roblox', 'I like ___'),
      'an answer that repeats the question is noticed'
    )
    log(!repeatsTheQuestion('roblox', 'I like ___'), 'an answer that fills the blank is kept')

    log(containsPhrase(['my', 'name', 'is', 'alchie'], ['name', 'is']), 'a phrase is found')
    log(!containsPhrase(['my', 'name', 'is', 'alchie'], ['alch']), 'a part of a word is not a word')
    log(mentionsText(source, 'blue'), 'a word of the text is mentioned')
    log(!mentionsText(source, 'blueish'), 'a longer word is not mentioned')

    log(
      sameFact('What is the favorite color of the person?', 'my favorite color is blue'),
      'two questions about the same fact are recognised'
    )
    log(
      !sameFact('Where does Luel live?', 'Luel weighs 50 kilos'),
      'two questions about different facts are not the same'
    )

    // --- a Word document has to give its text to the AI ---
    const docxDir = mkdtempSync(join(tmpdir(), 'quiz-docx-'))
    try {
      const zip = new JSZip()
      zip.file(
        'word/document.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>Photosynthesis is the process where plants use sunlight.</w:t></w:r></w:p>
<w:p><w:r><w:t>Chlorophyll absorbs the light in the leaf.</w:t></w:r></w:p>
</w:body></w:document>`
      )
      const buffer = await zip.generateAsync({ type: 'nodebuffer' })
      const docxPath = join(docxDir, 'chapter1.docx')
      writeFileSync(docxPath, buffer)

      const docxText = await extractTextFromPath(docxPath)
      log(
        docxText.includes('Photosynthesis is the process where plants use sunlight.'),
        'a Word document gives its text to the AI'
      )
      log(
        docxText.includes('Chlorophyll absorbs the light in the leaf.'),
        'every paragraph of a Word document is read'
      )

      const txtPath = join(docxDir, 'notes.txt')
      writeFileSync(txtPath, 'Gold is Au. Water boils at 100 degrees.', 'utf8')
      const txtText = await extractTextFromPath(txtPath)
      log(txtText.includes('Gold is Au.'), 'a text file gives its text to the AI')
    } finally {
      safeRmSync(docxDir)
    }
  } finally {
    safeRmSync(dir)
  }
}