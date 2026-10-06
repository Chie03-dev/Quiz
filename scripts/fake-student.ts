/**
 * Fake phone, for testing the lobby without a real device.
 *
 *   npm run fake-student -- --pin 1234 --name Alice
 *   npm run fake-student -- --pin 1234 --name Alice --token fixed-token
 *
 * Options: --pin, --name, --ip (default 127.0.0.1), --port (default 8080),
 *          --token (default: a stable token cached in .fake-student-token.json),
 *          --answer (answer every question once quiz_start arrives),
 *          --no-hb (never send heartbeats; step 3 pauses on the timeout),
 *          --focus-lost <delayMs>, --focus-gained <delayMs>, --resume-request <delayMs>,
 *          --finish <delayMs>
 *          (send that step-3/step-5 message this many ms after joining).
 */
import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { PublicQuestion, ServerMessage } from '../src/shared/types'

interface Args {
  pin: string
  name: string
  ip: string
  port: number
  token: string
  hb: boolean
  answer: boolean
  /** Step-3 triggers: ms after joining, or null for "never". */
  focusLostAt: number | null
  focusGainedAt: number | null
  resumeRequestAt: number | null
  /** Step-5 trigger: ms after joining, or null for "never". */
  finishAt: number | null
}

const TOKEN_FILE = resolve(process.cwd(), '.fake-student-token.json')

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const pin = get('--pin')
  const name = get('--name')
  if (!pin || !name) {
    console.error('Usage: npm run fake-student -- --pin <pin> --name <name> [--ip <ip>] [--port <port>] [--token <token>] [--no-hb] [--answer] [--focus-lost <ms>] [--focus-gained <ms>] [--resume-request <ms>] [--finish <ms>]')
    process.exit(1)
  }

  // A stable default token makes "rejoin with the same deviceToken" easy to test.
  let token = get('--token') ?? ''
  if (!token && existsSync(TOKEN_FILE)) {
    try {
      token = (JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) as Record<string, string>)[name] ?? ''
    } catch {
      token = ''
    }
  }
  if (!token) {
    token = randomUUID()
    try {
      const store = existsSync(TOKEN_FILE)
        ? (JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) as Record<string, string>)
        : {}
      store[name] = token
      writeFileSync(TOKEN_FILE, JSON.stringify(store, null, 2))
    } catch {
      /* caching is a convenience only */
    }
  }

  return {
    pin,
    name,
    ip: get('--ip') ?? '127.0.0.1',
    port: Number(get('--port') ?? 8080),
    token,
    hb: !argv.includes('--no-hb'),
    answer: argv.includes('--answer'),
    focusLostAt: delay(get('--focus-lost')),
    focusGainedAt: delay(get('--focus-gained')),
    resumeRequestAt: delay(get('--resume-request')),
    finishAt: delay(get('--finish'))
  }

  /** A missing or invalid delay means "do not send that message at all". */
  function delay(value: string | undefined): number | null {
    if (value === undefined) return null
    const n = Number(value)
    return Number.isFinite(n) && n >= 0 ? n : null
  }
}

/** A plausible value for any question type, so every type gets exercised. */
function answerFor(q: PublicQuestion): unknown {
  switch (q.type) {
    case 'mcq':
      return q.options?.[0]?.id ?? ''
    case 'tf':
      return true
    case 'fillin':
      return Array.from({ length: q.blanks ?? 0 }, (_, i) => `blank ${i + 1}`)
    case 'enumeration':
      return Array.from({ length: Math.max(1, q.count ?? 1) }, (_, i) => `item ${i + 1}`)
    case 'matching':
      return Object.fromEntries((q.left ?? []).map((l, i) => [l.id, q.right?.[i]?.id ?? '']))
    case 'connect':
      return Object.fromEntries((q.prompts ?? []).map((p, i) => [p.id, q.answers?.[i]?.id ?? '']))
    default:
      return `answer to ${q.qid}`
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const url = `ws://${args.ip}:${args.port}/ws`
  console.log(`[${args.name}] connecting to ${url}`)

  const ws = new WebSocket(url)
  let joined = false
  // The phone owns the seq counter and increases it for every answer it sends.
  let nextSeq = 1

  ws.on('open', () => {
    console.log(`[${args.name}] open, joining with PIN ${args.pin}`)
    ws.send(JSON.stringify({ t: 'join', d: { pin: args.pin, name: args.name, deviceToken: args.token } }))
  })

  ws.on('message', (raw: WebSocket.RawData) => {
    let msg: ServerMessage
    try {
      msg = JSON.parse(raw.toString()) as ServerMessage
    } catch {
      return
    }
    if (msg.t === 'joined') {
      joined = true
      console.log(`[${args.name}] joined, studentId=${msg.d.studentId}`)
      if (msg.d.deviceToken !== args.token) console.log(`[${args.name}] server token: ${msg.d.deviceToken}`)
      schedule(args.focusLostAt, () =>
        ws.send(JSON.stringify({ t: 'focus_lost', d: { reason: 'background' } }))
      )
      schedule(args.focusGainedAt, () => ws.send(JSON.stringify({ t: 'focus_gained', d: {} })))
      schedule(args.resumeRequestAt, () => ws.send(JSON.stringify({ t: 'resume_request', d: {} })))
      schedule(args.finishAt, () => ws.send(JSON.stringify({ t: 'finish', d: {} })))
    } else if (msg.t === 'error') {
      console.log(`[${args.name}] error: ${msg.d.code}`)
      if (msg.d.code === 'RATE_LIMITED') {
        console.log('[rate limited] stopping, the IP is blocked for 60 s')
        process.exit(0)
      }
    } else if (msg.t === 'quiz_start') {
      console.log(`[${args.name}] quiz_start: ${msg.d.questions.length} questions, ends in ${Math.round((msg.d.endsAt - msg.d.serverTime) / 1000)}s`)
      if (args.answer) {
        for (const q of msg.d.questions) {
          const value = answerFor(q)
          const send = (): void =>
            ws.send(JSON.stringify({ t: 'answer', d: { qid: q.qid, value, seq: nextSeq++ } }))
          if (ws.readyState === WebSocket.OPEN) send()
          else ws.once('open', send)
          console.log(`[${args.name}] answering ${q.qid} (${q.type})`)
        }
      }
    } else if (msg.t === 'answers_state') {
      console.log(`[${args.name}] answers_state: ${JSON.stringify(msg.d.answers)}`)
    } else if (msg.t === 'ack') {
      console.log(`[${args.name}] ack ${msg.d.qid} seq=${msg.d.seq}`)
    } else if (msg.t === 'quiz_end') {
      console.log(`[${args.name}] quiz_end (${msg.d.reason})`)
    } else if (msg.t === 'kick') {
      console.log(`[${args.name}] kicked`)
      process.exit(0)
    } else if (msg.t === 'paused') {
      console.log(`[${args.name}] paused (${msg.d.reason})`)
    } else if (msg.t === 'resumed') {
      console.log(`[${args.name}] resumed`)
    } else if (msg.t === 'lock') {
      console.log(`[${args.name}] lock is now ${msg.d.on ? 'ON' : 'OFF'}`)
    } else if (msg.t === 'finished') {
      console.log(`[${args.name}] finished`)
    }
  })

  /** Runs fn after ms, only if the socket is still open. */
  function schedule(ms: number | null, fn: () => void): void {
    if (ms === null) return
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) fn()
    }, ms)
  }

  const hb = setInterval(() => {
    if (args.hb && joined && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'hb', d: {} }))
    }
  }, 3000)

  ws.on('close', (code, reason) => {
    console.log(`[${args.name}] closed (${code} ${reason.toString()})`)
    clearInterval(hb)
    process.exit(0)
  })

  ws.on('error', (err: Error) => {
    console.error(`[${args.name}] error: ${err.message}`)
    clearInterval(hb)
    process.exit(1)
  })
}

main()