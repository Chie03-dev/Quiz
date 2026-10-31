import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type {
  MemePopPayload,
  PhoneMessage,
  Quiz,
  QuizState,
  ServerInfo,
  StudentInfo
} from '../../shared/types'
import { FIRST_PORT, MAX_PORT } from '../../shared/types'
import { advertiseServer, type BonjourAdvertiser } from './mdns'
import { listLanAddresses } from './network'
import { QuizSession, type SocketLike } from './session'

/** Number of ports tried, from FIRST_PORT up to MAX_PORT inclusive. */
const PORT_ATTEMPTS = MAX_PORT - FIRST_PORT + 1

/**
 * The meme files the HTTP asset route serves. The server only ever reads
 * them; the store that owns them lives in the main process.
 */
export interface MemeAssetSource {
  /** The meme behind a file name, or null when there is none. */
  byFileName(fileName: string): { filePath: string; mime: string } | null
}

export interface QuizServerOptions {
  onStudentsChanged: (students: StudentInfo[]) => void
  onServerChanged: (info: ServerInfo) => void
  onQuizChanged: (state: QuizState) => void
  onLockChanged: (lockMode: boolean) => void
  /** The meme tray, when the app has one open. */
  memes?: MemeAssetSource
  /** Called once when a run ends, whatever ended it (timer or instructor). */
  onQuizEnded?: (reason: 'time' | 'instructor') => void
}

export interface QuizServer {
  session: QuizSession
  info: () => ServerInfo
  /** Chooses which LAN address the UI advertises. */
  selectIp(ip: string): boolean
  /** New PIN, empty lobby, mDNS re-published under the new name. */
  newSession(): ServerInfo
  startQuiz(quiz: Quiz): boolean
  endQuiz(): boolean
  /** Step 3: the lock toggle. Turning it off resumes focus pauses. */
  setLock(on: boolean): void
  approveResume(studentId: string): boolean
  approveAllResume(): number
  /** Timer control (IPC-only): pause, resume, or shift the countdown. */
  pauseTimer(): boolean
  resumeTimer(): boolean
  adjustTimer(deltaMs: number): boolean
  /** Pops a meme to the targeted students (everyone when unlisted). */
  popMeme(payload: MemePopPayload, studentIds?: string[]): number
  /** Clears the meme overlay on the targeted students. */
  hideMeme(studentIds?: string[]): number
  /** Last mDNS failure, if any. mDNS is a convenience only, never required. */
  advertisementError(): string | null
  close(): Promise<void>
}

export async function startServer(opts: QuizServerOptions): Promise<QuizServer> {
  const app = Fastify({ logger: false, bodyLimit: 1 * 1024 * 1024 })
  app.setErrorHandler((err, _req, reply) => {
    const code = (err as { statusCode?: number }).statusCode ?? 500
    reply.code(code).send({ error: 'request_failed', code })
  })

  let selectedIp = listLanAddresses()[0]?.ip ?? '127.0.0.1'
  let port = FIRST_PORT
  const connectionsByIp = new Map<string, number>()
  const MAX_CONNECTIONS_PER_IP = 50
  let advertiser: BonjourAdvertiser | null = null

  const session = new QuizSession(
    (students) => opts.onStudentsChanged(students),
    (state) => opts.onQuizChanged(state),
    (lockMode) => opts.onLockChanged(lockMode),
    (reason) => opts.onQuizEnded?.(reason)
  )
  const info = (): ServerInfo => ({
    pin: session.pin,
    port,
    addresses: listLanAddresses().map((a) => a.ip),
    selectedIp
  })
  const broadcastInfo = (): void => opts.onServerChanged(info())
  const publish = (): void => {
    advertiser?.stop()
    advertiser = advertiseServer(session.pin, port, selectedIp)
  }

  await app.register(websocket)

  app.get('/ws', { websocket: true }, (socket, req) => {
    // ws sockets are already bound to the raw ws client; wrap for the session module.
    const sock = socket as unknown as SocketLike & {
      on(event: 'message', l: (raw: unknown) => void): void
    }
    const ip = req.socket.remoteAddress ?? 'unknown'
    const count = connectionsByIp.get(ip) ?? 0
    if (count >= MAX_CONNECTIONS_PER_IP) { socket.close(1008, 'too many connections'); return }
    connectionsByIp.set(ip, count + 1)
    let joined = false

    sock.on('message', (raw: unknown) => {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw))
      if (buf.byteLength > 64 * 1024) return
      let parsed: unknown
      try {
        parsed = JSON.parse(buf.toString())
      } catch {
        return // ignore garbage
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      const obj = parsed as { t?: unknown; d?: unknown }
      if (typeof obj.t !== 'string') return
      const allowed = new Set(['join', 'hb', 'answer', 'focus_lost', 'focus_gained', 'resume_request', 'finish'])
      if (!allowed.has(obj.t)) return

      if (obj.t === 'join') {
        const joinSchema = z.object({ pin: z.string().optional(), name: z.string().optional(), deviceToken: z.string().optional(), photo: z.unknown().optional() })
        const parsedJoin = joinSchema.safeParse(obj.d ?? {})
        if (!parsedJoin.success) return
        joined = true
        session.handleJoin(sock, ip, parsedJoin.data as any)
      } else if (obj.t === 'hb') {
        if (joined) session.handleHeartbeat(sock)
      } else if (obj.t === 'answer') {
        if (joined) session.handleAnswer(sock, (obj.d ?? {}) as any)
      } else if (obj.t === 'focus_lost') {
        if (joined) session.handleFocusLost(sock)
      } else if (obj.t === 'focus_gained') {
        if (joined) session.handleFocusGained(sock)
      } else if (obj.t === 'resume_request') {
        if (joined) session.handleResumeRequest(sock)
      } else if (obj.t === 'finish') {
        if (joined) session.handleFinish(sock)
      }

    })

    sock.on('close', () => {
      const c = connectionsByIp.get(ip) ?? 1
      if (c <= 1) connectionsByIp.delete(ip)
      else connectionsByIp.set(ip, c - 1)
      session.handleClose(sock)
    })
    sock.on('error', () => session.handleClose(sock))
  })

  // The meme images the phones download. The file name is validated by the
  // store before anything touches the filesystem, so this route cannot be
  // walked out of the meme folder.
  app.get('/memes/:file', async (req, reply) => {
    const file = String((req.params as { file?: string }).file ?? '')
    if (!file || file.includes('/') || file.includes('\\\\') || file.includes('\\u0000')) {
      return reply.code(404).send('Not found')
    }
    const asset = opts.memes?.byFileName(file)
    if (!asset) return reply.code(404).send('Not found')
    let bytes: Buffer
    try {
      bytes = await readFile(asset.filePath)
    } catch {
      return reply.code(404).send('Not found')
    }
    return reply
      .header('Content-Type', asset.mime)
      .header('Content-Length', bytes.length)
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .send(bytes)
  })

  session.start()

  // Listen on all interfaces; fall back to the next free port when taken.
  let lastError: unknown = null
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
    try {
      await app.listen({ host: '0.0.0.0', port })
      lastError = null
      break
    } catch (err) {
      lastError = err
      port++
    }
  }
  if (lastError) {
    session.stop()
    throw lastError
  }

  publish()
  broadcastInfo()

  return {
    session,
    info,
    selectIp(ip: string) {
      if (!listLanAddresses().some((a) => a.ip === ip)) return false
      selectedIp = ip
      publish()
      broadcastInfo()
      return true
    },
    newSession() {
      session.reset()
      publish()
      broadcastInfo()
      return info()
    },
    startQuiz(quiz: Quiz) {
      const ok = session.startQuiz(quiz)
      if (ok) broadcastInfo()
      return ok
    },
    endQuiz() {
      return session.endQuiz()
    },
    setLock(on: boolean) {
      session.setLock(on)
    },
    approveResume(studentId: string) {
      return session.approveResume(studentId)
    },
    approveAllResume() {
      return session.approveAllResume()
    },
    pauseTimer() {
      return session.pauseTimer()
    },
    resumeTimer() {
      return session.resumeTimer()
    },
    adjustTimer(deltaMs: number) {
      return session.adjustTimer(deltaMs)
    },
    popMeme(payload: MemePopPayload, studentIds?: string[]) {
      return session.broadcastMeme(payload, studentIds)
    },
    hideMeme(studentIds?: string[]) {
      return session.broadcastMemeHide(studentIds)
    },
    async close() {
      session.stop()
      advertiser?.stop()
      await app.close()
    },
    advertisementError: () => advertiser?.error ?? null
  }
}