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

export interface StudentInfo {
  id: string
  name: string
  status: StudentStatus
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
}

/** Error codes defined in docs/protocol.md. */
export type ServerErrorCode = 'BAD_PIN' | 'NAME_TAKEN' | 'RATE_LIMITED' | 'CLOSED'

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
export type PhoneMessage = JoinMessage | HeartbeatMessage

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
export type ServerMessage = JoinedMessage | ErrorMessage | KickMessage
