import { useCallback, useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import type { FirewallInstallResult, StateSnapshot } from '../shared/types'

/** Payload a phone scans to find this server. */
export function joinPayload(ip: string, port: number, pin: string): string {
  return JSON.stringify({ ip, port, pin })
}

/** How long the green confirmation stays up before hiding itself. */
const OK_HIDE_MS = 4000

/**
 * Firewall notice. Only shown when Windows is missing the rules; on other
 * platforms firewallStatus reports supported:false and this renders nothing.
 */
function FirewallNotice(): React.JSX.Element | null {
  const [supported, setSupported] = useState<boolean | null>(null)
  const [missing, setMissing] = useState<string[]>([])
  const [unknown, setUnknown] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<FirewallInstallResult | null>(null)

  const refresh = useCallback(() => {
    window.quiz
      .firewallStatus()
      .then((s) => {
        setSupported(s.supported)
        setMissing(s.missing)
        setUnknown(s.unknown ?? [])
      })
      .catch(() => setSupported(false))
  }, [])

  // Checked when the Lobby opens.
  useEffect(refresh, [refresh])

  // Clear the green message after a few seconds.
  useEffect(() => {
    if (result !== 'installed') return
    const t = setTimeout(() => setResult(null), OK_HIDE_MS)
    return () => clearTimeout(t)
  }, [result])

  if (supported !== true) return null

  // netsh said something we could not interpret. Say so rather than guessing
  // either way: claiming the rules are missing would send the instructor to
  // install something they already have.
  if (unknown.length > 0) {
    return (
      <div className="fw-notice" role="status">
        <div className="fw-text">
          Could not read the Windows firewall rules, so their state is unknown.
        </div>
        <div className="fw-detail">
          Check them with <code>netsh advfirewall firewall show rule name=&quot;Quiz LAN Server&quot;</code>{' '}
          in a Command Prompt — see the README.
        </div>
      </div>
    )
  }

  if (result === 'installed') {
    return (
      <div className="fw-ok" role="status">
        Phones can connect.
      </div>
    )
  }

  if (supported !== true || missing.length === 0) return null

  const install = (): void => {
    setBusy(true)
    setResult(null)
    window.quiz
      .firewallInstall()
      .then((r) => {
        setResult(r)
        setBusy(false)
        // Re-check afterwards so the notice reflects the real firewall state.
        refresh()
      })
      .catch(() => {
        setResult('failed')
        setBusy(false)
      })
  }

  return (
    <div className="fw-notice" role="alert">
      <div className="fw-text">
        Phones may not be able to connect until you allow this app through the
        Windows firewall.
      </div>
      {result === 'cancelled' && (
        <div className="fw-detail">Permission was not granted. Phones may not be able to connect.</div>
      )}
      {result === 'failed' && (
        <div className="fw-detail">
          That did not work. Run <code>setup-firewall.bat</code> as administrator instead — see the
          README.
        </div>
      )}
      <button className="fw-button" onClick={install} disabled={busy}>
        {busy ? 'Waiting for Windows permission…' : 'Allow phones to connect'}
      </button>
    </div>
  )
}

/**
 * Starting is a one-way action on the phones' side, so it asks once. Disabled
 * with nobody in the lobby: the server would refuse it anyway.
 */
function StartQuizButton({ connectedCount }: { connectedCount: number }): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    if (!confirming) return
    const t = setTimeout(() => setConfirming(false), 5000)
    return () => clearTimeout(t)
  }, [confirming])

  const none = connectedCount === 0
  if (!confirming) {
    return (
      <button className="primary" disabled={none} onClick={() => setConfirming(true)}>
        Start quiz
      </button>
    )
  }
  return (
    <span className="confirm">
      <button
        className="primary"
        onClick={() => {
          setConfirming(false)
          void window.quiz.startQuiz()
        }}
      >
        Start for {connectedCount} student{connectedCount === 1 ? '' : 's'}?
      </button>
      <button className="secondary" onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </span>
  )
}

/** Step 3: the lock toggle, shared by the lobby and the running view. */
export function LockToggle({
  lockMode,
  label = 'Lock student phones'
}: {
  lockMode: boolean
  label?: string
}): React.JSX.Element {
  return (
    <label className={`lock-toggle${lockMode ? ' on' : ''}`}>
      <input
        type="checkbox"
        checked={lockMode}
        onChange={(e) => void window.quiz.setLock(e.target.checked)}
      />
      <span className="lock-label">{label}</span>
      <span className="lock-state">{lockMode ? 'ON' : 'OFF'}</span>
    </label>
  )
}

export function Lobby({ state }: { state: StateSnapshot }): React.JSX.Element {
  const { server, students } = state
  const { pin, port, selectedIp, addresses } = server
  const payload = useMemo(() => joinPayload(selectedIp, port, pin), [selectedIp, port, pin])
  const [qr, setQr] = useState<string>('')
  const [error, setError] = useState<string>('')

  useEffect(() => {
    let active = true
    // SVG keeps it crisp on the projector and needs no canvas.
    QRCode.toString(payload, { type: 'svg', margin: 1, width: 512 })
      .then((svg) => {
        if (active) {
          setQr(svg)
          setError('')
        }
      })
      .catch((err: unknown) => active && setError(String(err)))
    return () => {
      active = false
    }
  }, [payload])

  const connected = students.filter((s) => s.status === 'connected').length

  return (
    <div className="lobby">
      <header className="topbar">
        <h1>Lobby</h1>
        <span className="topbar-actions">
          <LockToggle lockMode={state.lockMode} />
          <StartQuizButton connectedCount={connected} />
          <button className="secondary" onClick={() => void window.quiz.newSession()}>
            New session
          </button>
        </span>
      </header>

      <div className="grid">
        <section className="join">
          <FirewallNotice />
          <div className="pin-label">Session PIN</div>
          <div className="pin" title={pin}>
            {pin}
          </div>
          <div className="qr" dangerouslySetInnerHTML={{ __html: qr }} />
          {error && <p className="error">QR failed: {error}</p>}
          <div className="endpoint">
            {selectedIp}:{port}
          </div>
          {addresses.length > 1 && (
            <div className="alt">
              <span>Other addresses:</span>
              {addresses
                .filter((ip) => ip !== selectedIp)
                .map((ip) => (
                  <button
                    key={ip}
                    className="link"
                    onClick={() => void window.quiz.selectIp(ip)}
                  >
                    {ip}:{port}
                  </button>
                ))}
            </div>
          )}
        </section>

        <section className="students">
          <div className="students-head">
            <h2>Students</h2>
            <span className="count">
              {connected} / {students.length} connected
            </span>
          </div>
          {students.length === 0 ? (
            <p className="empty">No students yet. Scan the QR code to join.</p>
          ) : (
            <ul>
              {students.map((s) => (
                <li key={s.id} className={s.status}>
                  <span className="name">{s.name}</span>
                  <span className="status">{s.status}</span>
                  <button className="kick" onClick={() => void window.quiz.kick(s.id)}>
                    Kick
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}