import { randomInt, randomUUID } from 'node:crypto'
import type { ServerErrorCode, ServerMessage, StudentInfo, StudentStatus } from '../../shared/types'
import { PinRateLimiter } from './rateLimit'

export const HEARTBEAT_TIMEOUT_MS = 10_000
const SWEEP_INTERVAL_MS = 1_000

/** Minimal socket surface so the session logic stays testable without a real server. */
export interface SocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: 'close', listener: () => void): void
  on(event: 'message', listener: (raw: unknown) => void): void
  on(event: 'error', listener: (err: unknown) => void): void
}

export interface Student {
  id: string
  name: string
  deviceToken: string
  status: StudentStatus
  lastSeen: number
  socket: SocketLike | null
}

/** Random 4-digit PIN, zero padded so it is always 4 characters. */
export function generatePin(): string {
  return String(randomInt(0, 10_000)).padStart(4, '0')
}

export class QuizSession {
  pin: string
  private students = new Map<string, Student>()
  private byDeviceToken = new Map<string, Student>()
  private limiter = new PinRateLimiter()
  private sweeper: NodeJS.Timeout | null = null

  constructor(private onChange: (students: StudentInfo[]) => void) {
    this.pin = generatePin()
  }

  start(): void {
    if (this.sweeper) return
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = null
  }

  /** New PIN, empty lobby. */
  reset(): void {
    for (const student of this.students.values()) this.dropSocket(student)
    this.students.clear()
    this.byDeviceToken.clear()
    this.limiter = new PinRateLimiter()
    this.pin = generatePin()
    this.notify()
  }

  list(): StudentInfo[] {
    return [...this.students.values()].map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status
    }))
  }

  private notify(): void {
    this.onChange(this.list())
  }

  private send(socket: SocketLike, msg: ServerMessage): void {
    try {
      socket.send(JSON.stringify(msg))
    } catch {
      /* socket already gone; the close handler cleans up */
    }
  }

  private error(socket: SocketLike, code: ServerErrorCode): void {
    this.send(socket, { t: 'error', d: { code } })
  }

  handleJoin(
    socket: SocketLike,
    ip: string,
    d: { pin?: string; name?: string; deviceToken?: string }
  ): void {
    if (this.limiter.isBlocked(ip)) {
      this.error(socket, 'RATE_LIMITED')
      return
    }

    const name = (d.name ?? '').trim()
    if (typeof d.pin !== 'string' || d.pin.trim() !== this.pin) {
      // The attempt that trips the limit is rejected with RATE_LIMITED itself.
      if (this.limiter.recordFailure(ip)) this.error(socket, 'RATE_LIMITED')
      else this.error(socket, 'BAD_PIN')
      return
    }
    this.limiter.recordSuccess(ip)

    // Identity restore: same deviceToken => same studentId.
    const existing = d.deviceToken ? this.byDeviceToken.get(d.deviceToken) : undefined
    if (existing) {
      this.attach(existing, socket, existing.name)
      return
    }

    // Names are unique per session, case-insensitive, unless the token matches.
    const byName = [...this.students.values()].find(
      (s) => s.name.toLowerCase() === name.toLowerCase()
    )
    if (byName) {
      this.error(socket, 'NAME_TAKEN')
      return
    }

    const student: Student = {
      id: randomUUID(),
      name,
      deviceToken: d.deviceToken ?? randomUUID(),
      status: 'connected',
      lastSeen: Date.now(),
      socket
    }
    this.students.set(student.id, student)
    this.byDeviceToken.set(student.deviceToken, student)
    this.send(socket, { t: 'joined', d: { studentId: student.id, deviceToken: student.deviceToken } })
    this.notify()
  }

  handleHeartbeat(socket: SocketLike): void {
    const student = this.findBySocket(socket)
    if (!student) return
    const wasDisconnected = student.status === 'disconnected'
    student.lastSeen = Date.now()
    student.status = 'connected'
    if (wasDisconnected) this.notify()
  }

  handleClose(socket: SocketLike): void {
    const student = this.findBySocket(socket)
    if (!student) return
    student.socket = null
    if (student.status === 'connected') {
      student.status = 'disconnected'
      this.notify()
    }
  }

  // --- instructor commands (local UI only, via IPC) ---

  kick(studentId: string): boolean {
    const student = this.students.get(studentId)
    if (!student) return false
    if (student.socket) this.send(student.socket, { t: 'kick', d: {} })
    this.remove(student)
    return true
  }

  private remove(student: Student): void {
    this.dropSocket(student)
    this.students.delete(student.id)
    this.byDeviceToken.delete(student.deviceToken)
    this.notify()
  }

  private dropSocket(student: Student): void {
    if (!student.socket) return
    try {
      student.socket.close(1000, 'closed')
    } catch {
      /* already closed */
    }
    student.socket = null
  }

  private attach(student: Student, socket: SocketLike, name: string): void {
    this.dropSocket(student) // replace any stale connection for the same device
    student.name = name
    student.status = 'connected'
    student.lastSeen = Date.now()
    student.socket = socket
    this.send(socket, { t: 'joined', d: { studentId: student.id, deviceToken: student.deviceToken } })
    this.notify()
  }

  private findBySocket(socket: SocketLike): Student | undefined {
    for (const student of this.students.values()) {
      if (student.socket === socket) return student
    }
    return undefined
  }

  /** Marks students that stopped sending heartbeats as disconnected. */
  private sweep(): void {
    const now = Date.now()
    let changed = false
    for (const student of this.students.values()) {
      if (student.status === 'connected' && now - student.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        student.status = 'disconnected'
        changed = true
      }
    }
    if (changed) this.notify()
  }
}