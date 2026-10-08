/**
 * End-to-end check of the step-1 protocol against a real Fastify + WebSocket server.
 *
 *   npm run check
 *
 * Not part of the app; it only imports the server module.
 */
import WebSocket from 'ws'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../src/main/server'
import { isValidAnswer, toPublicQuestions } from '../src/main/server/quizRun'
import { SAMPLE_QUIZ } from '../src/main/sampleQuiz'
import { openQuizLibrary, runtimeQuizForStart, type QuizLibrary } from '../src/main/db'
import { parseQuizJson, serializeQuiz, toRuntimeQuiz } from '../src/main/quizFormat'
import { quizStartError, validateQuestion } from '../src/shared/validation'
import { buildCheckArgs, buildInstallCommand, CHECK_OPTIONS, classifyCheckOutput, encodePowerShell, FIREWALL_RULES, FIREWALL_PROFILE } from '../src/main/firewall'
import { FIRST_PORT, MAX_PORT, PORT_RANGE, type QuestionType, type Quiz, type StoredQuestion, type StoredQuiz } from '../src/shared/types'

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

async function main(): Promise<void> {
  // --- quiz library (step 4): exercised offline against a temp database ---
  console.log('--- quiz library ---')
  const seededQuiz = checkLibrary()

  const seen: any[] = []
  let lastInfo: any = null
  const server = await startServer({
    onStudentsChanged: (s) => seen.push(JSON.parse(JSON.stringify(s))),
    onServerChanged: (i) => (lastInfo = i),
    onQuizChanged: () => {},
    onLockChanged: () => {}
  })
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
 */
function checkLibrary(): Quiz {
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
    rmSync(dir, { recursive: true, force: true })
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
async function checkQuizRun(server: any, port: number, quiz: Quiz = SAMPLE_QUIZ): Promise<void> {
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

  // --- clean disconnects and paused reconnects ---
  console.log('\n--- disconnect and paused reconnect ---')
  await checkReconnectPause(server, port, quiz)
  await sleep(150)
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