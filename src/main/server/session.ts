import { randomInt, randomUUID } from 'node:crypto'
import type {
  PauseReason,
  Quiz,
  QuizState,
  ServerErrorCode,
  ServerMessage,
  StudentEvent,
  StudentEventType,
  StudentInfo,
  StudentStatus
} from '../../shared/types'
import { PinRateLimiter } from './rateLimit'
import { QuizRun } from './quizRun'

export const HEARTBEAT_TIMEOUT_MS = 10_000
const SWEEP_INTERVAL_MS = 1_000
/** Keep the per-student event list bounded; the newest entries are what matter. */
const MAX_EVENTS = 100

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
  // --- step 3: lock and pause ---
  paused: boolean
  pauseReason: PauseReason | null
  focusLosses: number
  resumeRequested: boolean
  // --- step 5: finish ---
  finished: boolean
  finishedAt: number | null
  events: StudentEvent[]
}

/** Random 4-digit PIN, zero padded so it is always 4 characters. */
export function generatePin(): string {
  return String(randomInt(0, 10_000)).padStart(4, '0')
}

export class QuizSession {
  pin: string
  /** Step 3: on by default. Lock is a deterrent plus visibility, not enforcement. */
  private lockMode = true
  private students = new Map<string, Student>()
  private byDeviceToken = new Map<string, Student>()
  private limiter = new PinRateLimiter()
  private sweeper: NodeJS.Timeout | null = null
  private run: QuizRun
  /** Configurable so the check script does not have to wait 10 real seconds. */
  heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS

  constructor(
    private onChange: (students: StudentInfo[]) => void,
    onQuizChange: (state: QuizState) => void,
    private onLockChange: (lockMode: boolean) => void = () => {}
  ) {
    this.pin = generatePin()
    this.run = new QuizRun(
      () => this.broadcast({ t: 'quiz_end', d: { reason: this.run.state().endReason ?? 'instructor' } }),
      onQuizChange
    )
  }

  status(): QuizState['status'] {
    return this.run.currentStatus
  }

  /** Step 3: whether focus_lost pauses a student. */
  lockEnabled(): boolean {
    return this.lockMode
  }

  quizState(): QuizState {
    return this.run.state()
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
    this.lockMode = true
    this.run.reset()
    this.onLockChange(this.lockMode)
    this.notify()
  }

  list(): StudentInfo[] {
    return [...this.students.values()].map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      paused: s.paused,
      pauseReason: s.pauseReason,
      focusLosses: s.focusLosses,
      resumeRequested: s.resumeRequested,
      finished: s.finished,
      finishedAt: s.finishedAt,
      events: [...s.events]
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

  private broadcast(msg: ServerMessage): void {
    for (const student of this.students.values()) {
      if (student.socket) this.send(student.socket, msg)
    }
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

    // Outside the lobby only a known device may (re)join; anyone else is too late.
    if (this.run.currentStatus !== 'lobby' && !existing) {
      this.error(socket, 'CLOSED')
      return
    }

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
      socket,
      paused: false,
      pauseReason: null,
      focusLosses: 0,
      resumeRequested: false,
      finished: false,
      finishedAt: null,
      events: []
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
    if (wasDisconnected) {
      // A network pause is NOT cleared here: only the instructor resumes.
      this.log(student, 'reconnect')
      this.notify()
    }
  }

  // --- step 3: focus and resume requests ---

  /** focus_lost only pauses while the lock is on. It is always logged. */
  handleFocusLost(socket: SocketLike): void {
    const student = this.findBySocket(socket)
    if (!student) return
    student.focusLosses++
    this.log(student, 'focus_lost')
    // A finished student is never paused; the event is still logged.
    if (student.finished) {
      this.notify()
      return
    }
    if (!this.lockMode) {
      this.notify()
      return
    }
    // Already paused: logged, but nothing changes.
    if (student.paused) {
      this.notify()
      return
    }
    this.pause(student, 'focus')
  }

  /** focus_gained is informational only: it never resumes anyone. */
  handleFocusGained(socket: SocketLike): void {
    const student = this.findBySocket(socket)
    if (!student) return
    this.log(student, 'focus_gained')
    this.notify()
  }

  /** A request is a marker for the instructor, never a resume by itself. */
  handleResumeRequest(socket: SocketLike): void {
    const student = this.findBySocket(socket)
    if (!student) return
    student.resumeRequested = true
    this.log(student, 'resume_request')
    this.notify()
  }

  handleAnswer(socket: SocketLike, d: { qid?: unknown; value?: unknown; seq?: unknown }): void {
    const student = this.findBySocket(socket)
    if (!student) return
    // After finish, answers get FINISHED and are not stored or acked.
    if (student.finished) {
      this.error(socket, 'FINISHED')
      return
    }
    // A paused student's answer is rejected and never stored; the phone keeps it
    // queued and resends it after resumed.
    if (student.paused) {
      this.error(socket, 'PAUSED')
      return
    }
    const outcome = this.run.handleAnswer(student.id, d.qid, d.value, d.seq)
    if (outcome.kind === 'error') {
      this.error(socket, outcome.code)
      return
    }
    this.send(socket, { t: 'ack', d: { qid: String(d.qid), seq: outcome.seq } })
  }

  /** Step 5: finish. Valid only while running and not paused; idempotent. */
  handleFinish(socket: SocketLike): void {
    const student = this.findBySocket(socket)
    if (!student) return
    if (this.run.currentStatus !== 'running') {
      this.error(socket, 'QUIZ_ENDED')
      return
    }
    if (student.paused) {
      this.error(socket, 'PAUSED')
      return
    }
    if (!student.finished) {
      student.finished = true
      student.finishedAt = Date.now()
      this.log(student, 'finished')
    }
    this.send(student.socket ?? socket, { t: 'finished', d: {} })
    this.notify()
  }

  handleClose(socket: SocketLike): void {
    const student = this.findBySocket(socket)
    if (!student) return
    student.socket = null
    if (student.status === 'connected') {
      student.status = 'disconnected'
      this.log(student, 'disconnect')
      this.notify()
    }
  }

  // --- instructor commands (local UI only, via IPC) ---

  /**
   * Instructor toggles lock. Turning it off resumes students paused for "focus";
   * network pauses are never auto-resumed.
   */
  setLock(on: boolean): void {
    this.lockMode = on
    this.broadcast({ t: 'lock', d: { on } })
    if (!on) {
      for (const student of this.students.values()) {
        if (student.paused && student.pauseReason === 'focus') this.resume(student)
      }
    }
    this.onLockChange(this.lockMode)
    this.notify()
  }

  /** Approves one student. Unknown or not-connected students do nothing. */
  approveResume(studentId: string): boolean {
    const student = this.students.get(studentId)
    if (!student) return false
    if (!student.socket) return false
    if (!student.paused) return false
    this.resume(student)
    return true
  }

  /** Approves every paused student that is currently connected. */
  approveAllResume(): number {
    let n = 0
    for (const student of this.students.values()) {
      if (student.paused && student.socket) {
        this.resume(student)
        n++
      }
    }
    return n
  }

  /** Starts the run. Only from the lobby, and only with students in it. */
  startQuiz(quiz: Quiz): boolean {
    if (this.run.currentStatus !== 'lobby') return false
    if (this.students.size === 0) return false
    this.run.start(quiz, Date.now())
    this.broadcast({ t: 'quiz_start', d: this.startPayload(Date.now()) })
    return true
  }

  /** Instructor ends the quiz early; the run then sends quiz_end itself. */
  endQuiz(): boolean {
    return this.run.end('instructor')
  }

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

    // A known device rejoining mid-quiz gets the quiz again plus its own answers.
    if (this.run.currentStatus === 'running') {
      this.send(socket, { t: 'quiz_start', d: this.startPayload(Date.now()) })
      this.send(socket, { t: 'answers_state', d: { answers: this.run.answersFor(student.id) } })
      // A finished student gets finished after answers_state.
      if (student.finished) {
        this.send(socket, { t: 'finished', d: {} })
      } else if (student.paused && student.pauseReason) {
        // A paused student stays paused after rejoining. Replay the real reason
        // (focus or network) so the phone does not look unpaused while the
        // server still rejects its answers with PAUSED.
        this.send(socket, { t: 'paused', d: { reason: student.pauseReason } })
      }
    }
    this.notify()
  }

  /** quiz_start plus the step-3 lockMode flag. */
  private startPayload(now: number): ReturnType<QuizRun['startPayload']> & { lockMode: boolean } {
    return { ...this.run.startPayload(now), lockMode: this.lockMode }
  }

  /** Records an event and keeps the list bounded. */
  private log(student: Student, type: StudentEventType): void {
    student.events.push({ at: Date.now(), type })
    if (student.events.length > MAX_EVENTS) student.events.shift()
  }

  private pause(student: Student, reason: PauseReason): void {
    student.paused = true
    student.pauseReason = reason
    this.log(student, 'paused')
    if (student.socket) this.send(student.socket, { t: 'paused', d: { reason } })
    this.notify()
  }

  private resume(student: Student): void {
    student.paused = false
    student.pauseReason = null
    student.resumeRequested = false
    this.log(student, 'resumed')
    if (student.socket) this.send(student.socket, { t: 'resumed', d: {} })
    this.notify()
  }

  private findBySocket(socket: SocketLike): Student | undefined {
    for (const student of this.students.values()) {
      if (student.socket === socket) return student
    }
    return undefined
  }

  /**
   * Marks students that stopped sending heartbeats as disconnected, and pauses
   * them for "network" while the quiz is running. The clock never stops. The
   * timeout is judged from lastSeen alone, so a clean socket close reaches this
   * rule too instead of bypassing it.
   */
  private sweep(): void {
    const now = Date.now()
    let changed = false
    for (const student of this.students.values()) {
      if (now - student.lastSeen <= this.heartbeatTimeoutMs) continue
      // Only flip (and log) a still-connected student. A clean close already set
      // status to "disconnected", but the network-pause rule below must still run.
      if (student.status === 'connected') {
        student.status = 'disconnected'
        this.log(student, 'disconnect')
        changed = true
      }
      // A finished student is never paused by a heartbeat timeout.
      if (this.run.currentStatus === 'running' && !student.paused && !student.finished) {
        this.pause(student, 'network') // pause() notifies on its own
      }
    }
    if (changed) this.notify()
  }
}