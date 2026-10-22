import { useCallback, useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import type { FirewallInstallResult, QuizMeta, StateSnapshot } from '../../shared/types'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { ConfirmButton } from '../components/ConfirmButton'
import { StudentPhoto } from '../components/StudentPhoto'
import { EmptyState } from '../components/EmptyState'
import { Icon } from '../components/Icon'
import { Panel } from '../components/Panel'
import { MemeTray } from '../memes/MemeTray'

/** Payload a phone scans to find this server. */
export function joinPayload(ip: string, port: number, pin: string): string {
  return JSON.stringify({ ip, port, pin })
}

/** Where the last used quiz is remembered across restarts. */
const LAST_QUIZ_KEY = 'quiz.lastUsedQuizId'

/** How long the green confirmation stays up before hiding itself. */
const OK_HIDE_MS = 4000

/**
 * The firewall state of this PC, and the way out of it.
 *
 * The state is always on screen, not only when something is wrong: a feature
 * that only appears when it fails is a feature nobody knows exists. When the
 * rules are missing the app asks for permission, and the manual commands are
 * one click away for the machines where that prompt never comes.
 */
function FirewallStatus(): React.JSX.Element | null {
  const [supported, setSupported] = useState<boolean | null>(null)
  const [missing, setMissing] = useState<string[]>([])
  const [unknown, setUnknown] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<FirewallInstallResult | null>(null)
  const [manual, setManual] = useState<string[] | null>(null)

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

  // Checked when the dashboard opens, and again whenever the window comes
  // back: the startup prompt steals the focus while it installs the rules.
  useEffect(refresh, [refresh])
  useEffect(() => {
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])

  // Clear the green message after a few seconds.
  useEffect(() => {
    if (result !== 'installed') return
    const t = setTimeout(() => setResult(null), OK_HIDE_MS)
    return () => clearTimeout(t)
  }, [result])

  if (supported !== true) return null

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

  const showManual = (): void => {
    void window.quiz.firewallManual().then(setManual)
  }

  // The state could not be read. It may well be fine, but the instructor has
  // to be able to act anyway: without a button here there is nowhere to go.
  if (unknown.length > 0) {
    return (
      <div className="fw fw--unknown" role="status">
        <div className="fw__title">Could not read the Windows firewall rules, so their state is unknown.</div>
        <div className="fw__detail">
          Phones may not be able to connect. You can set the rules up anyway - it only adds them
          when they are missing.
        </div>
        <div className="fw__actions">
          <Button variant="secondary" onClick={install} disabled={busy}>
            {busy ? 'Waiting for Windows permission…' : 'Set up the firewall'}
          </Button>
          <Button variant="ghost" size="sm" onClick={showManual}>
            Do it manually
          </Button>
        </div>
        {manual && <ManualFirewall commands={manual} />}
      </div>
    )
  }

  if (result === 'installed') {
    return (
      <div className="fw fw--ok" role="status">
        <div className="fw__title">Phones can connect.</div>
      </div>
    )
  }

  if (missing.length === 0) {
    return (
      <div className="fw fw--ready" role="status">
        <span className="fw__dot" aria-hidden="true" />
        <span className="fw__detail">Firewall: ready, phones can connect.</span>
        <Button variant="ghost" size="sm" onClick={refresh}>
          Check again
        </Button>
      </div>
    )
  }

  return (
    <div className="fw" role="alert">
      <div className="fw__title">
        Phones may not be able to connect until you allow this app through the Windows firewall.
      </div>
      {result === 'cancelled' && (
        <div className="fw__detail">Permission was not granted. Phones may not be able to connect.</div>
      )}
      {result === 'failed' && (
        <div className="fw__detail">
          That did not work. Run <code>setup-firewall.bat</code> as administrator instead - it is
          next to the app.
        </div>
      )}
      <div className="fw__actions">
        <Button variant="secondary" onClick={install} disabled={busy}>
          {busy ? 'Waiting for Windows permission…' : 'Allow phones to connect'}
        </Button>
        <Button variant="ghost" size="sm" onClick={showManual}>
          Do it manually
        </Button>
      </div>
      {manual && <ManualFirewall commands={manual} />}
    </div>
  )
}

/**
 * The manual way out: the exact commands, and the file that runs them.
 *
 * Shown when the app could not raise its own prompt, which happens when the
 * machine is managed by policy and no one may elevate.
 */
function ManualFirewall({ commands }: { commands: string[] }): React.JSX.Element {
  const [setupPath, setSetupPath] = useState<boolean | null>(null)

  const openSetup = (): void => {
    void window.quiz.firewallOpenSetup().then(setSetupPath)
  }

  return (
    <div className="fw__manual">
      <div className="fw__detail">
        Open PowerShell as administrator and run these two lines:
      </div>
      <pre className="fw__code" data-testid="firewall-commands">
        {commands.join('\n')}
      </pre>
      <div className="fw__actions">
        <Button variant="ghost" size="sm" onClick={openSetup}>
          Show setup-firewall.bat
        </Button>
        {setupPath === false && (
          <span className="fw__detail">setup-firewall.bat is not next to this app.</span>
        )}
      </div>
    </div>
  )
}

/** The library picker; the selection is remembered across restarts. */
function QuizPicker({
  quizzes,
  selectedId,
  onChange
}: {
  quizzes: QuizMeta[]
  selectedId: string
  onChange: (id: string) => void
}): React.JSX.Element {
  return (
    <label className="ui-field">
      <span className="ui-field__label">Quiz to run</span>
      <select
        className="ui-select"
        data-testid="quiz-picker"
        value={selectedId}
        onChange={(e) => onChange(e.target.value)}
      >
        {quizzes.map((q) => (
          <option key={q.id} value={q.id}>
            {q.title} · {q.questionCount} question{q.questionCount === 1 ? '' : 's'}
          </option>
        ))}
      </select>
    </label>
  )
}

/**
 * Starting is a one-way action on the phones' side, so it asks once. Disabled
 * with nobody in the lobby or no quiz selected: the server would refuse it
 * anyway. A refusal (empty or draft quiz) is shown via onError.
 */
function StartQuizButton({
  connectedCount,
  quizId,
  onError
}: {
  connectedCount: number
  quizId: string
  onError: (message: string) => void
}): React.JSX.Element {
  const none = connectedCount === 0 || !quizId
  return (
    <ConfirmButton
      label="Start quiz"
      confirmLabel={`Start for ${connectedCount} student${connectedCount === 1 ? '' : 's'}?`}
      confirmVariant="primary"
      variant="primary"
      icon={<Icon name="play" />}
      testId="start-quiz"
      confirmTestId="start-quiz-confirm"
      disabled={none}
      onConfirm={() => {
        void window.quiz.startQuiz(quizId).then((result) => {
          if (!result.ok) onError(result.message)
        })
      }}
    />
  )
}

/** One connected student in the roster. */
function RosterRow({
  student
}: {
  student: StateSnapshot['students'][number]
}): React.JSX.Element {
  const connected = student.status === 'connected'
  return (
    <li className="roster__row">
      <StudentPhoto photo={student.photo} name={student.name} size={32} className="roster__photo" />
      <span className="roster__name">{student.name}</span>
      <Badge tone={connected ? 'ok' : 'danger'}>{student.status}</Badge>
      <Button
        variant="ghost"
        size="sm"
        testId={`kick-${student.name}`}
        onClick={() => void window.quiz.kick(student.id)}
      >
        Kick
      </Button>
    </li>
  )
}

/**
 * The dashboard: the landing screen. It shows the join code, the student
 * roster and the controls for starting a session.
 */
export function Dashboard({
  state,
  onOpenLibrary,
  onOpenResults
}: {
  state: StateSnapshot
  onOpenLibrary: () => void
  onOpenResults: () => void
}): React.JSX.Element {
  const { server, students } = state
  const { pin, port, selectedIp, addresses } = server
  const payload = useMemo(() => joinPayload(selectedIp, port, pin), [selectedIp, port, pin])
  const [qr, setQr] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [quizzes, setQuizzes] = useState<QuizMeta[]>([])
  const [selectedQuiz, setSelectedQuiz] = useState('')
  const [startError, setStartError] = useState('')
  /** The meme the instructor picks before the quiz starts. */
  const [selectedMeme, setSelectedMeme] = useState<string | null>(null)

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

  // Load the library and restore the last used quiz selection.
  const refreshQuizzes = useCallback(() => {
    void window.quiz.listQuizzes().then((list) => {
      setQuizzes(list)
      const remembered = localStorage.getItem(LAST_QUIZ_KEY) ?? ''
      const pick = list.find((q) => q.id === remembered) ?? list[0]
      setSelectedQuiz(pick ? pick.id : '')
    })
  }, [])
  useEffect(refreshQuizzes, [refreshQuizzes])

  const selectQuiz = (id: string): void => {
    setSelectedQuiz(id)
    setStartError('')
    localStorage.setItem(LAST_QUIZ_KEY, id)
  }

  const connected = students.filter((s) => s.status === 'connected').length
  const others = addresses.filter((ip) => ip !== selectedIp)

  return (
    <div className="dash">
      <div className="dash__stats">
        <div className="stat">
          <span className="stat__label">Connected</span>
          <span className="stat__value" data-testid="stat-connected">
            {connected}
          </span>
          <span className="stat__hint">of {students.length} joined</span>
        </div>
        <div className="stat">
          <span className="stat__label">Session PIN</span>
          <span className="stat__value" style={{ fontFamily: 'var(--font-mono)' }}>
            {pin}
          </span>
          <span className="stat__hint">phones type this to join</span>
        </div>
        <div className="stat">
          <span className="stat__label">Quiz</span>
          <span className="stat__value" style={{ fontSize: 'var(--fs-lg)' }}>
            {quizzes.length}
          </span>
          <span className="stat__hint">in the library</span>
        </div>
      </div>

      <div className="dash__columns">
        <Panel title="Join this session" actions={<Badge tone="accent">PIN {pin}</Badge>}>
          <div className="ed" style={{ gap: 'var(--sp-4)' }}>
            <FirewallStatus />

            <div className="join__pin">
              <span className="join__pin-value" data-testid="session-pin">
                {pin}
              </span>
            </div>

            {error ? (
              <p className="ui-error">QR failed: {error}</p>
            ) : (
              <div className="join__qr" data-testid="qr-code" dangerouslySetInnerHTML={{ __html: qr }} />
            )}

            <div className="join__endpoint" data-testid="endpoint">
              {selectedIp}:{port}
            </div>

            {others.length > 0 && (
              <div className="join__addresses">
                <span className="ui-field__label">Other addresses</span>
                {others.map((ip) => (
                  <button
                    key={ip}
                    type="button"
                    className="join__address"
                    data-testid={`address-${ip}`}
                    onClick={() => void window.quiz.selectIp(ip)}
                  >
                    <span>{ip}:{port}</span>
                    <span>Use</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </Panel>

        <div className="ed">
          <Panel
            title="Ready to start"
            actions={<Badge tone={connected > 0 ? 'ok' : 'neutral'}>{connected} connected</Badge>}
          >
            <div className="ed">
              {quizzes.length > 0 ? (
                <QuizPicker quizzes={quizzes} selectedId={selectedQuiz} onChange={selectQuiz} />
              ) : (
                <EmptyState
                  title="No quizzes yet"
                  body="Create a quiz in the library, then come back to run it."
                  icon={<Icon name="quizzes" />}
                  action={
                    <Button variant="secondary" onClick={onOpenLibrary}>
                      Open library
                    </Button>
                  }
                />
              )}

              <div className="live__controls">
                <StartQuizButton connectedCount={connected} quizId={selectedQuiz} onError={setStartError} />
                <Button variant="secondary" icon={<Icon name="quizzes" />} onClick={onOpenLibrary}>
                  Quiz library
                </Button>
                <Button
                  variant="secondary"
                  icon={<Icon name="results" />}
                  testId="open-results"
                  onClick={onOpenResults}
                >
                  Results
                </Button>
                <Button
                  variant="secondary"
                  testId="new-session"
                  onClick={() => void window.quiz.newSession()}
                >
                  New session
                </Button>
              </div>

              {startError && <p className="ui-error">{startError}</p>}
            </div>
          </Panel>

          <Panel
            title="Students"
            actions={
              <Badge tone={connected > 0 ? 'ok' : 'neutral'}>
                {connected} / {students.length} connected
              </Badge>
            }
          >
            {students.length === 0 ? (
              <EmptyState
                title="No students yet"
                body="Scan the QR code or type the PIN on a phone to join."
                icon={<Icon name="users" />}
              />
            ) : (
              <ul className="roster">
                {students.map((s) => (
                  <RosterRow key={s.id} student={s} />
                ))}
              </ul>
            )}
          </Panel>

          <MemeTray
            selectedId={selectedMeme}
            onSelect={(id) => setSelectedMeme(id || null)}
          />
        </div>
      </div>
    </div>
  )
}