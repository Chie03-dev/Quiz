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
