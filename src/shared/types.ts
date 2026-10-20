// Types shared by the main process, the preload bridge and the renderer.

// --- server ports (used by both the server fallback and the firewall rules) ---

/** First port the server tries to bind. */
export const FIRST_PORT = 8080
/** Highest port the server will fall back to before giving up. */
export const MAX_PORT = 8089
/**
 * "first-last", for the firewall rule and any human-readable text.
 * The firewall range must cover every port the server can ever pick.
 */
export const PORT_RANGE = `${FIRST_PORT}-${MAX_PORT}`

export type StudentStatus = 'connected' | 'disconnected'

/** Why a student is paused (see docs/protocol.md, step 3). */
export type PauseReason = 'focus' | 'network'

/** Events kept in memory per student for the instructor's event list. */
export type StudentEventType =
  | 'focus_lost'
  | 'focus_gained'
  | 'paused'
  | 'resumed'
  | 'resume_request'
  | 'disconnect'
  | 'reconnect'
  | 'finished'

export interface StudentEvent {
  at: number
  type: StudentEventType
}

/** Question shapes and the session status machine (see docs/protocol.md, step 2). */
export type QuestionType =
  | 'mcq'
  | 'tf'
  | 'identification'
  | 'fillin'
  | 'enumeration'
  | 'problem'
  | 'matching'
  | 'connect'

export interface Choice {
  id: string
  text: string
}

/**
 * A question as a phone sees it. Only the fields listed here are ever sent;
 * the answer key never leaves the main process.
 */
export interface PublicQuestion {
  qid: string
  type: QuestionType
  body: string
  points: number
  options?: Choice[] // mcq
  blanks?: number // fillin
  count?: number // enumeration
  left?: Choice[] // matching
  right?: Choice[] // matching
  prompts?: Choice[] // connect
  answers?: Choice[] // connect
}

/** What a phone may send back: a scalar, a list, or a leftId -> rightId map. */
export type AnswerValue = string | boolean | string[] | Record<string, string>

/** A question plus its key. Main process only. */
export interface QuizQuestion extends PublicQuestion {
  key: AnswerValue
}

export interface Quiz {
  quizId: string
  title: string
  limitMs: number
  questions: QuizQuestion[]
}

// --- step 4: quiz library (SQLite) and editor ---

/** The question types as a list, for editor pickers and import validation. */
export const QUESTION_TYPES: QuestionType[] = [
  'mcq',
  'tf',
  'identification',
  'fillin',
  'enumeration',
  'problem',
  'matching',
  'connect'
]

/** A stored question is 'ready' only when it passes validation for its type. */
export type QuestionStatus = 'draft' | 'ready'

/**
 * The phone-facing parts of a saved question (`data_json`): exactly the
 * optional fields a PublicQuestion may carry. Which fields apply is decided
 * by the question type. Answer keys never appear here.
 */
export interface QuestionData {
  options?: Choice[] // mcq
  blanks?: number // fillin
  count?: number // enumeration
  left?: Choice[] // matching
  right?: Choice[] // matching
  prompts?: Choice[] // connect
  answers?: Choice[] // connect
}

/** The answer key of a problem question; main process only. */
export interface ProblemKey {
  answer: string
  /** Optional accepted numeric tolerance around the answer; grading is a later step. */
  tolerance?: number
}

/**
 * Answer key per type as stored in `key_json` (main process only):
 * mcq: correct option id · tf: true/false · identification: accepted answers ·
 * fillin: accepted answers per blank · enumeration: accepted items ·
 * problem: { answer, tolerance? } · matching/connect: fromId -> toId map.
 * null means "not decided yet" while editing.
 */
export type StoredKey =
  | string
  | boolean
  | null
  | string[]
  | string[][]
  | ProblemKey
  | Record<string, string>

/** One question as the library stores it: parsed data/key instead of JSON columns. */
export interface StoredQuestion {
  id: string
  type: QuestionType
  body: string
  points: number
  data: QuestionData
  key: StoredKey
  /** Optional passage the question came from; empty until imports exist. */
  sourceText: string
  status: QuestionStatus
}

/** One quiz as the library stores it: quiz row plus questions in position order. */
export interface StoredQuiz {
  id: string
  title: string
  timeLimitSec: number
  createdAt: number
  updatedAt: number
  questions: StoredQuestion[]
}

/** What the library list shows per quiz. */
export interface QuizMeta {
  id: string
  title: string
  timeLimitSec: number
  questionCount: number
  createdAt: number
  updatedAt: number
}

/** Result of a start request; a refusal says which questions block it. */
export type StartQuizResult = { ok: true } | { ok: false; message: string }

export type SaveQuizResult = { ok: true; quiz: StoredQuiz } | { ok: false; error: string }

/**
 * Export/import outcomes. `cancelled` means the instructor closed the file
 * dialog; `error` is a human-readable reason (import rejects malformed files).
 */
export type ExportQuizResult =
  | { ok: true; path: string }
  | { ok: false; error: string; cancelled?: boolean }

export interface ImportQuizReport {
  /** The new quiz the imported file was stored as. */
  id: string
  title: string
  questionCount: number
  /** Compiler-placement warnings from the importer, in file order. */
  warnings: { questionIndex: number | null; message: string }[]
  /** Every imported question with its stored sourceText, for the import report. */
  questions: { id: string; type: QuestionType; body: string; sourceText: string }[]
}

export type ImportQuizResult =
  | { ok: true; quiz: StoredQuiz }
  | { ok: true; report: ImportQuizReport }
  | { ok: false; error: string; cancelled?: boolean }

export type SessionStatus = 'lobby' | 'running' | 'ended'

export interface QuestionProgress {
  qid: string
  type: QuestionType
  body: string
  /** How many students have sent an answer for this question. */
  answered: number
}

export interface QuizState {
  status: SessionStatus
  title: string | null
  endsAt: number | null
  /** Timer control: true while the instructor froze the countdown. */
  timerPaused: boolean
  /** Frozen remainder while timerPaused; null otherwise. */
  remainingMs: number | null
  questions: QuestionProgress[]
  /** Answers per student id. Counters only: no values, no scores. */
  answeredByStudent: Record<string, number>
  endReason: 'time' | 'instructor' | null
}

export interface StudentInfo {
  id: string
  name: string
  status: StudentStatus
  /** Lock/pause state, step 3. */
  paused: boolean
  pauseReason: PauseReason | null
  /** How many times this student reported losing focus. */
  focusLosses: number
  /** The phone asked to be resumed. A marker only; it never resumes anything. */
  resumeRequested: boolean
  /** Step 5: the student submitted; no further answers accepted. */
  finished: boolean
  /** Step 5: server timestamp of finish, null until finished. */
  finishedAt: number | null
  /** Recent events, oldest first. */
  events: StudentEvent[]
}

export interface ServerInfo {
  pin: string
  port: number
  /** LAN addresses the phone can use, best match first. */
  addresses: string[]
  /** Address the UI currently shows. */
  selectedIp: string
}

export interface StateSnapshot {
  server: ServerInfo
  students: StudentInfo[]
  quiz: QuizState
  /** Step 3: when on, focus_lost pauses the student. Always true in a fresh session. */
  lockMode: boolean
  /**
   * The last meme pop, or null when none was ever sent. Small on purpose:
   * the snapshot is pushed on every answer, so the meme *list* never rides
   * along with it - the tray loads it through memes:list() instead.
   */
  meme: MemeState | null
}

/** Error codes defined in docs/protocol.md. */
export type ServerErrorCode =
  | 'BAD_PIN'
  | 'NAME_TAKEN'
  | 'RATE_LIMITED'
  | 'CLOSED'
  | 'QUIZ_ENDED'
  | 'BAD_ANSWER'
  | 'UNKNOWN_QUESTION'
  | 'PAUSED'
  | 'FINISHED'

// --- results: the persisted score sheet of a finished session ---

/** Why a session ended; the same reasons the phones are told about. */
export type ResultEndReason = 'time' | 'instructor'

/** One saved session in the results list. */
export interface ResultSessionMeta {
  id: string
  /** The library quiz it came from; null when that quiz is gone. */
  quizId: string | null
  quizTitle: string
  startedAt: number | null
  endedAt: number
  endReason: ResultEndReason | null
  /** The points the quiz was worth in total. */
  totalPoints: number
  studentCount: number
  createdAt: number
}

/**
 * A question as it was asked, snapshotted with its answer key. The snapshot
 * keeps the score sheet readable even after the library question is edited.
 */
export interface ResultQuestionDetail {
  id: string
  sessionId: string
  /** The library question id; null when the question was created ad hoc. */
  questionId: string | null
  position: number
  type: QuestionType
  body: string
  points: number
  data: QuestionData
  key: StoredKey
}

/** One student's answer to one question. */
export interface ResultAnswerDetail {
  id: string
  sessionId: string
  studentId: string
  questionId: string
  /** The answer as the student sent it; null when they never answered. */
  value: AnswerValue | null
  /** null when the answer was never graded (no answer, or no key). */
  correct: boolean | null
  pointsAwarded: number
  pointsPossible: number
  /** False once the instructor has adjusted the answer by hand. */
  autoGraded: boolean
  notes: string | null
}

/** One student in a session, with all of their answers. */
export interface ResultStudentDetail {
  id: string
  sessionId: string
  studentName: string
  /** The session student id this row came from. */
  studentKey: string | null
  finished: boolean
  totalPointsAwarded: number
  totalPointsPossible: number
  answers: ResultAnswerDetail[]
}

/** A whole session: the questions, the students and every answer. */
export interface ResultSessionDetail {
  meta: ResultSessionMeta
  questions: ResultQuestionDetail[]
  students: ResultStudentDetail[]
}

/** What the instructor changes about one answer. */
export interface SaveResultAnswerInput {
  answerId: string
  pointsAwarded: number
  /** null marks the answer as ungraded; omitted leaves it as it is. */
  correct?: boolean | null
  notes?: string | null
}

/** The outcome of a write to the results store. */
export type ResultOperationResult = { ok: true } | { ok: false; error: string }

// --- memes: the instructor's jumpscare tray (see docs/protocol.md, "Meme pop") ---

/** How long a popped meme stays on a student's screen. */
export const MEME_DURATION_MS = 3000
/** The shortest and longest pop the server accepts. */
export const MEME_MIN_DURATION_MS = 500
export const MEME_MAX_DURATION_MS = 15_000
/** The two image types the app stores and serves. */
export type MemeMime = 'image/jpeg' | 'image/png'

/** One meme in the instructor's tray. */
export interface MemeInfo {
  id: string
  name: string
  mime: MemeMime
  width: number
  height: number
  byteSize: number
  /** data: URL thumbnail for the tray grid (the CSP allows data: images). */
  thumb: string
  createdAt: number
}

/** What the renderer hands to the main process for one upload. */
export interface MemeSavePayload {
  name: string
  mime: MemeMime
  width: number
  height: number
  /** The compressed image bytes. */
  bytes: Uint8Array
  /** data: URL thumbnail, produced by the renderer. */
  thumb: string
}

export type MemeSaveResult = { ok: true; meme: MemeInfo } | { ok: false; error: string }

/**
 * The phone-facing payload of a meme pop. Exactly these six fields: the
 * check script asserts that nothing else (no file name, no local path)
 * ever reaches a phone.
 */
export interface MemePopPayload {
  memeId: string
  /** Relative path on the quiz server, e.g. "/memes/<file>". */
  path: string
  mime: MemeMime
  width: number
  height: number
  durationMs: number
}

/** What the instructor's own screen shows about the last pop. */
export interface MemeState {
  memeId: string
  /** Server timestamp of the pop. */
  at: number
  /** Student ids it went to; empty means every connected student. */
  targets: string[]
  /** True while the meme is still meant to be showing. */
  active: boolean
}

export type MemePopResult = { ok: true; sent: number } | { ok: false; error: string }

// --- Windows firewall (see src/main/firewall.ts) ---

export interface FirewallStatus {
  /** True when every expected rule is present. */
  ok: boolean
  /** Display names of the rules that are not installed. */
  missing: string[]
  /**
   * Rules whose state netsh reported in a way we do not recognise. These are
   * deliberately not counted as missing: showing the "allow phones" notice for a
   * rule that is really installed would send the instructor chasing a fault that
   * is not there.
   */
  unknown: string[]
  /** False on non-Windows platforms, where the feature is not offered. */
  supported: boolean
}

/** Outcome of the elevated install attempt. */
export type FirewallInstallResult = 'installed' | 'cancelled' | 'failed'

// --- WebSocket protocol (see docs/protocol.md) ---

export interface JoinMessage {
  t: 'join'
  id?: string
  d: { pin: string; name: string; deviceToken?: string }
}
export interface HeartbeatMessage {
  t: 'hb'
  id?: string
  d: Record<string, never>
}
export interface JoinedMessage {
  t: 'joined'
  id?: string
  d: { studentId: string; deviceToken: string }
}
export interface ErrorMessage {
  t: 'error'
  id?: string
  d: { code: ServerErrorCode }
}
export interface KickMessage {
  t: 'kick'
  id?: string
  d: Record<string, never>
}
export interface AnswerMessage {
  t: 'answer'
  id?: string
  d: { qid: string; value: unknown; seq: number }
}
export interface FocusLostMessage {
  t: 'focus_lost'
  id?: string
  d: { reason: 'background' | 'window' | 'unpinned' }
}
export interface FocusGainedMessage {
  t: 'focus_gained'
  id?: string
  d: Record<string, never>
}
export interface ResumeRequestMessage {
  t: 'resume_request'
  id?: string
  d: Record<string, never>
}
export interface FinishMessage {
  t: 'finish'
  id?: string
  d: Record<string, never>
}
export type PhoneMessage =
  | JoinMessage
  | HeartbeatMessage
  | AnswerMessage
  | FocusLostMessage
  | FocusGainedMessage
  | ResumeRequestMessage
  | FinishMessage

export interface QuizStartMessage {
  t: 'quiz_start'
  id?: string
  d: {
    quizId: string
    title: string
    questions: PublicQuestion[]
    endsAt: number
    serverTime: number
    /** Step 3: when true, focus_lost pauses this student. */
    lockMode: boolean
    /** Timer control: true while the instructor froze the countdown. */
    paused: boolean
  }
}
export interface AnswersStateMessage {
  t: 'answers_state'
  id?: string
  d: { answers: Record<string, unknown> }
}
export interface AckMessage {
  t: 'ack'
  id?: string
  d: { qid: string; seq: number }
}
export interface QuizEndMessage {
  t: 'quiz_end'
  id?: string
  d: { reason: 'time' | 'instructor' }
}
export interface PausedMessage {
  t: 'paused'
  id?: string
  d: { reason: PauseReason }
}
export interface ResumedMessage {
  t: 'resumed'
  id?: string
  d: Record<string, never>
}
export interface LockMessage {
  t: 'lock'
  id?: string
  d: { on: boolean }
}
export interface FinishedMessage {
  t: 'finished'
  id?: string
  d: Record<string, never>
}
export interface TimeUpdateMessage {
  t: 'time_update'
  id?: string
  d: { endsAt: number; serverTime: number; paused: boolean }
}
export interface MemePopMessage {
  t: 'meme_pop'
  id?: string
  d: MemePopPayload
}
export interface MemeHideMessage {
  t: 'meme_hide'
  id?: string
  d: Record<string, never>
}
export type ServerMessage =
  | JoinedMessage
  | ErrorMessage
  | KickMessage
  | QuizStartMessage
  | AnswersStateMessage
  | AckMessage
  | QuizEndMessage
  | PausedMessage
  | ResumedMessage
  | LockMessage
  | FinishedMessage
  | TimeUpdateMessage
  | MemePopMessage
  | MemeHideMessage
