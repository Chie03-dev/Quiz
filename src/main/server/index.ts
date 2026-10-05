import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import type { PhoneMessage, Quiz, QuizState, ServerInfo, StudentInfo } from '../../shared/types'
import { FIRST_PORT, MAX_PORT } from '../../shared/types'
import { advertiseServer, type BonjourAdvertiser } from './mdns'
import { listLanAddresses } from './network'
import { QuizSession, type SocketLike } from './session'

/** Number of ports tried, from FIRST_PORT up to MAX_PORT inclusive. */
const PORT_ATTEMPTS = MAX_PORT - FIRST_PORT + 1

export interface QuizServerOptions {
  onStudentsChanged: (students: StudentInfo[]) => void
  onServerChanged: (info: ServerInfo) => void
  onQuizChanged: (state: QuizState) => void
  onLockChanged: (lockMode: boolean) => void
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
  /** Last mDNS failure, if any. mDNS is a convenience only, never required. */
  advertisementError(): string | null
  close(): Promise<void>
}

export async function startServer(opts: QuizServerOptions): Promise<QuizServer> {
  const app = Fastify({ logger: false })

  let selectedIp = listLanAddresses()[0]?.ip ?? '127.0.0.1'
  let port = FIRST_PORT
  let advertiser: BonjourAdvertiser | null = null

  const session = new QuizSession(
    (students) => opts.onStudentsChanged(students),
    (state) => opts.onQuizChanged(state),
    (lockMode) => opts.onLockChanged(lockMode)
  )
  const info = (): ServerInfo => ({
    pin: session.pin,
    port,
    addresses: listLanAddresses().map((a) => a.ip),
    selectedIp
  })
  const broadcastInfo = (): void => opts.onServerChanged(info())

  await app.register(websocket)

  app.get('/ws', { websocket: true }, (socket, req) => {
    // ws sockets are already bound to the raw ws client; wrap for the session module.
    const sock = socket as unknown as SocketLike & {
      on(event: 'message', l: (raw: unknown) => void): void
    }
    const ip = req.socket.remoteAddress ?? 'unknown'
    let joined = false

    sock.on('message', (raw: unknown) => {
      const data = Buffer.isBuffer(raw) ? raw.toString() : String(raw)
      let msg: PhoneMessage
      try {
        msg = JSON.parse(data)
      } catch {
        return // ignore garbage
      }
      if (!msg || typeof msg.t !== 'string') return

      if (msg.t === 'join') {
        joined = true
        session.handleJoin(sock, ip, msg.d ?? {})
      } else if (msg.t === 'hb') {
        if (joined) session.handleHeartbeat(sock)
      } else if (msg.t === 'answer') {
        if (joined) session.handleAnswer(sock, msg.d ?? {})
      } else if (msg.t === 'focus_lost') {
        if (joined) session.handleFocusLost(sock)
      } else if (msg.t === 'focus_gained') {
        if (joined) session.handleFocusGained(sock)
      } else if (msg.t === 'resume_request') {
        if (joined) session.handleResumeRequest(sock)
      }
      // No other message types are accepted from phones; instructor commands come via IPC only.
    })

    sock.on('close', () => session.handleClose(sock))
    sock.on('error', () => session.handleClose(sock))
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

  advertiser = advertiseServer(session.pin, port)
  broadcastInfo()

  return {
    session,
    info,
    selectIp(ip: string) {
      if (!listLanAddresses().some((a) => a.ip === ip)) return false
      selectedIp = ip
      broadcastInfo()
      return true
    },
    newSession() {
      session.reset()
      advertiser?.stop()
      advertiser = advertiseServer(session.pin, port)
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
    async close() {
      session.stop()
      advertiser?.stop()
      await app.close()
    },
    advertisementError: () => advertiser?.error ?? null
  }
}