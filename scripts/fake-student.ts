/**
 * Fake phone, for testing the lobby without a real device.
 *
 *   npm run fake-student -- --pin 1234 --name Alice
 *   npm run fake-student -- --pin 1234 --name Alice --token fixed-token
 *
 * Options: --pin, --name, --ip (default 127.0.0.1), --port (default 8080),
 *          --token (default: a stable token cached in .fake-student-token.json),
 *          --no-hb (stop sending heartbeats, to test the 10 s timeout).
 */
import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ServerMessage } from '../src/shared/types'

interface Args {
  pin: string
  name: string
  ip: string
  port: number
  token: string
  hb: boolean
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
    console.error('Usage: npm run fake-student -- --pin <pin> --name <name> [--ip <ip>] [--port <port>] [--token <token>] [--no-hb]')
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
    hb: !argv.includes('--no-hb')
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const url = `ws://${args.ip}:${args.port}/ws`
  console.log(`[${args.name}] connecting to ${url}`)

  const ws = new WebSocket(url)
  let joined = false

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
    } else if (msg.t === 'error') {
      console.log(`[${args.name}] error: ${msg.d.code}`)
      if (msg.d.code === 'RATE_LIMITED') {
        console.log('[rate limited] stopping, the IP is blocked for 60 s')
        process.exit(0)
      }
    } else if (msg.t === 'kick') {
      console.log(`[${args.name}] kicked`)
      process.exit(0)
    }
  })

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