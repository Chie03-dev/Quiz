import { useEffect, useState } from 'react'
import type { StateSnapshot, StudentInfo } from '../shared/types'
import { LockToggle } from './Lobby'

/** Ticks once a second so the countdown moves without any server round trip. */
function useRemaining(endsAt: number | null, timerPaused: boolean, remainingMs: number | null): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (timerPaused) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [timerPaused])
  if (endsAt === null) return 0
  if (timerPaused) return Math.max(0, remainingMs ?? Math.max(0, endsAt - now))
  return Math.max(0, endsAt - now)
}

const clock = (ms: number): string => {
  const total = Math.ceil(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Instructor timer controls: pause/resume plus +1/-1 minute steps. */
function TimerControls({ timerPaused }: { timerPaused: boolean }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const run = (fn: () => Promise<boolean>): void => {
    setBusy(true)
    void fn().finally(() => setBusy(false))
  }
  return (
    <span className="timer-controls">
      {timerPaused ? (
        <button className="secondary" disabled={busy} onClick={() => run(() => window.quiz.resumeTimer())}>
          Resume timer
        </button>
      ) : (
        <button className="secondary" disabled={busy} onClick={() => run(() => window.quiz.pauseTimer())}>
          Pause timer
        </button>
      )}
      <button className="secondary" disabled={busy} onClick={() => run(() => window.quiz.adjustTimer(60_000))}>
        +1 min
      </button>
      <button className="secondary" disabled={busy} onClick={() => run(() => window.quiz.adjustTimer(-60_000))}>
        −1 min
      </button>
    </span>
  )
}

function EndQuizButton(): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  // Back to the plain button if the instructor hesitates.
  useEffect(() => {
    if (!confirming) return
    const t = setTimeout(() => setConfirming(false), 5000)
    return () => clearTimeout(t)
  }, [confirming])

  if (!confirming) {
    return (
      <button className="danger" onClick={() => setConfirming(true)}>
        End quiz now
      </button>
    )
  }
  return (
    <span className="confirm">
      <button
        className="danger"
        onClick={() => {
          setConfirming(false)
          void window.quiz.endQuiz()
        }}
      >
        Yes, end it
      </button>
      <button className="secondary" onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </span>
  )
}

/** A compact, grouped one-student card with a progress bar and status. */
function StudentCard({
  student,
  total,
  answered,
  selected,
  onToggle
}: {
  student: StudentInfo
  total: number
  answered: number
  selected: Set<string>
  onToggle: (id: string) => void
}): React.JSX.Element {
  const avatar = student.name.trim()
    .split(' ')
    .map((w) => w[0])
    .join('') ||
    '?'
  const initials = avatar.slice(0, 2).toUpperCase()
  const pct = total > 0 ? Math.round((answered / total) * 100) : 0
  const paused = student.paused
  const finished = student.finished

  return (
    <li className={`student-card${paused ? ' card-paused' : ''}${finished ? ' card-finished' : ''}`}>
      <div className="student-head">
        <span className="student-avatar" aria-hidden="true">
          {initials}
        </span>
        <div className="student-main">
          <span className="student-name">{student.name}</span>
          <span className="student-meta">
            answered {answered} of {total} ({pct}%)
          </span>
        </div>
        <button className="secondary mini" disabled={!selected.has(student.id)} onClick={() => onToggle(student.id)} aria-label={`Select ${student.name}`}>
          {selected.has(student.id) ? '✓' : ''}
        </button>
      </div>
      <div className="student-progress">
        <div className="student-progress-bar">
          <div className={"student-progress-fill" + (paused ? ' paused' : '') + (finished ? ' finished' : '')} style={{ width: `${pct}%` }} />
        </div>
      </div>
      {paused && (
        <button className="approve" onClick={() => void window.quiz.approveResume(student.id)}>
          Approve
        </button>
      )}
      <div className="student-tags">
        {paused && <span className="tag pause">PAUSED {student.pauseReason === 'network' ? '· network' : '· focus'}</span>}
        {finished && <span className="tag done">Finished{student.finishedAt !== null ? ` · ${new Date(student.finishedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</span>}
        <span className={"tag status" + (student.status === 'connected' ? ' ok' : ' bad')}>{student.status}</span>
      </div>
    </li>
  )
}

/** Collapsible event log for a student. */
function EventLog({ events, open, onToggle }: { events: StudentInfo['events']; open: boolean; onToggle: () => void }): React.JSX.Element {
  if (events.length === 0) return <></>
  const eventTime = (at: number): string =>
    new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return (
    <div className="events">
      <button className="events-toggle" onClick={onToggle}>
        Events ({events.length}){events.length > 0 ? (open ? ' ▾' : ' ▴') : ''}
      </button>
      {open && (
        <ul className="events-list">
          {events.map((e, i) => (
            <li key={`${e.at}-${i}`} className={e.type}>
              <span className="events-time">{eventTime(e.at)}</span>
              <span className="events-tag">{e.type}</span>
              <span className="events-detail">
                {e.type === 'paused' && 'paused'}
                {e.type === 'resumed' && 'resumed'}
                {e.type === 'focus_lost' && 'lost focus'}
                {e.type === 'focus_gained' && 'regained focus'}
                {e.type === 'finished' && 'finished'}
                {e.type === 'resume_request' && '· asked to resume'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Ended({ state }: { state: StateSnapshot }): React.JSX.Element {
  const { students, quiz } = state
  const total = quiz.questions.length
  const reason = quiz.endReason === 'time' ? 'Time is up.' : 'Ended by the instructor.'
  const overall = students.length > 0
    ? Math.round((students.reduce((acc, s) => acc + (quiz.answeredByStudent[s.id] ?? 0), 0) / (total * students.length)) * 100)
    : 0
  return (
    <div className="lobby">
      <header className="topbar">
        <h1>Quiz ended</h1>
        <span className="topbar-right">
          <span className="countdown">{clock(0)}</span>
          <button className="secondary" onClick={() => void window.quiz.newSession()}>
            New session
          </button>
        </span>
      </header>
      <div className="summary">
        <p className="muted">{reason}</p>
        <div className="progress">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${overall}%` }} />
          </div>
          <span className="progress-label">{overall}% answered</span>
        </div>
        <p className="count">{total} question{total === 1 ? '' : 's'} · {students.length} student{students.length === 1 ? '' : 's'}</p>
      </div>
      <section className="students">
        <div className="student-grid">
          {students.map((s) => (
            <div key={s.id} className={`student-card${s.status === 'disconnected' ? ' card-disconnected' : ''}`}>
              <div className="student-head">
                <span className="student-avatar" aria-hidden="true">
                  {s.name.trim().split(' ').map((w) => w[0]).join('') || '?'}
                </span>
                <div className="student-main">
                  <span className="student-name">{s.name}</span>
                  <span className="student-meta">
                    answered {state.quiz.answeredByStudent[s.id] ?? 0} of {total}
                  </span>
                </div>
              </div>
              <div className="student-progress">
                <div className="student-progress-bar">
                  <div className={"student-progress-fill" + (s.finished ? ' finished' : '')} style={{ width: Math.round((state.quiz.answeredByStudent[s.id] ?? 0) / total * 100) + '%' }} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

/** Running and ended views. Counts only; step 2 has no scores. */
export function QuizRun({ state }: { state: StateSnapshot }): React.JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [eventsOpen, setEventsOpen] = useState(true)
  const { students, quiz } = state
  const remaining = useRemaining(quiz.endsAt, quiz.timerPaused, quiz.remainingMs)
  const timerPaused = quiz.timerPaused

  if (quiz.status === 'ended') return <Ended state={state} />

  const total = quiz.questions.length
  const paused = students.filter((s) => s.paused)
  const finished = students.filter((s) => s.finished)
  const disconnected = students.filter((s) => s.status === 'disconnected')
  // Nothing ends automatically: the banner is informational only.
  const connected = students.filter((s) => s.status === 'connected' && !s.paused)
  const allFinished = connected.length > 0 && connected.every((s) => s.finished)
  const overall = Math.min(100, Math.round((students.reduce((acc, s) => acc + (quiz.answeredByStudent[s.id] ?? 0), 0) / (total * students.length)) * 100))

  return (
    <div className="lobby">
      <header className="topbar">
        <div className="topbar-top">
          <h1>Running: {quiz.title}</h1>
          <p className="topbar-sub">
            {students.length} student{students.length === 1 ? '' : 's'} in session · {paused.length} paused · {finished.length} finished
          </p>
        </div>
        <div className="topbar-right">
          <span className={`countdown${remaining < 30_000 ? ' urgent' : ''}${timerPaused ? ' paused' : ''}`}>
            {clock(remaining)}{timerPaused ? ' · paused' : ''}
          </span>
          <div className="progress">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${overall}%` }} />
            </div>
            <span className="progress-label">{overall}% answered</span>
          </div>
          <TimerControls timerPaused={timerPaused} />
          <LockToggle lockMode={state.lockMode} />
          {paused.length > 0 && (
            <button className="secondary" onClick={() => void window.quiz.approveAllResume()}>
              Approve all ({paused.length})
            </button>
          )}
          <EndQuizButton />
        </div>
      </header>

      <div className="dashboard">
        <section className="column students-column">
          <div className="panel-head">
            <h2>Students</h2>
            <span className="count">
              {students.length} in session · {paused.length} paused · {finished.length} finished
            </span>
          </div>

          {connected.length > 0 && (
            <div className="group">
              <h3 className="group-title">Connected</h3>
              <div className="student-grid">
                {connected.map((s) => (
                  <StudentCard
                    key={s.id}
                    student={s}
                    total={total}
                    answered={quiz.answeredByStudent[s.id] ?? 0}
                    selected={selected}
                    onToggle={(id) => {
                      const next = new Set(selected)
                      if (next.has(id)) next.delete(id)
                      else next.add(id)
                      setSelected(next)
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {paused.length > 0 && (
            <div className="group group-paused">
              <h3 className="group-title">Paused</h3>
              <div className="student-grid">
                {paused.map((s) => (
                  <StudentCard
                    key={s.id}
                    student={s}
                    total={total}
                    answered={quiz.answeredByStudent[s.id] ?? 0}
                    selected={selected}
                    onToggle={(id) => {
                      const next = new Set(selected)
                      if (next.has(id)) next.delete(id)
                      else next.add(id)
                      setSelected(next)
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {finished.length > 0 && (
            <div className="group">
              <h3 className="group-title">Finished</h3>
              <div className="student-grid">
                {finished.map((s) => (
                  <StudentCard
                    key={s.id}
                    student={s}
                    total={total}
                    answered={quiz.answeredByStudent[s.id] ?? 0}
                    selected={selected}
                    onToggle={(id) => {
                      const next = new Set(selected)
                      if (next.has(id)) next.delete(id)
                      else next.add(id)
                      setSelected(next)
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {disconnected.length > 0 && (
            <div className="group">
              <h3 className="group-title">Disconnected</h3>
              <div className="student-grid">
                {disconnected.map((s) => (
                  <StudentCard
                    key={s.id}
                    student={s}
                    total={total}
                    answered={quiz.answeredByStudent[s.id] ?? 0}
                    selected={selected}
                    onToggle={(id) => {
                      const next = new Set(selected)
                      if (next.has(id)) next.delete(id)
                      else next.add(id)
                      setSelected(next)
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {allFinished && <p className="banner">All connected students have finished</p>}

          <EventLog events={students.flatMap((s) => s.events)} open={eventsOpen} onToggle={() => setEventsOpen((v) => !v)} />
        </section>

        <section className="column questions-column">
          <div className="panel-head">
            <h2>Per question</h2>
            <span className="count">{total} question{total === 1 ? '' : 's'} · {quiz.questions.reduce((acc, q) => acc + q.answered, 0)} answered</span>
          </div>
          {quiz.questions.length === 0 ? (
            <p className="muted">No questions in this quiz.</p>
          ) : (
            <div className="question-grid">
              {quiz.questions.map((q, qi) => (
                <div className="question-cell" key={q.qid}>
                  <div className="question-cell-head">
                    <span className="question-cell-qid">Q{qi + 1}</span>
                    <span className="question-cell-type">{q.type}</span>
                  </div>
                  <div className="question-cell-body" title={q.body}>
                    {q.body.slice(0, 60)}{q.body.length > 60 ? '…' : ''}
                  </div>
                  <div className="question-cell-bar">
                    <div className={"question-cell-fill" + (q.answered > 0 ? ' answered' : '')} style={{ width: `${total > 0 ? Math.round((q.answered / students.length) * 100) : 0}%` }} />
                  </div>
                  <span className="question-cell-count">{q.answered}/{students.length}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}