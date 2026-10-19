import { useEffect, useState } from 'react'
import type { StateSnapshot, StudentInfo } from '../../shared/types'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { ConfirmButton } from '../components/ConfirmButton'
import { EmptyState } from '../components/EmptyState'
import { Icon } from '../components/Icon'
import { LockToggle } from '../components/LockToggle'
import { Panel } from '../components/Panel'

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
    <span className="live__controls">
      {timerPaused ? (
        <Button
          variant="secondary"
          size="sm"
          icon={<Icon name="play" />}
          disabled={busy}
          testId="resume-timer"
          onClick={() => run(() => window.quiz.resumeTimer())}
        >
          Resume timer
        </Button>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          icon={<Icon name="pause" />}
          disabled={busy}
          testId="pause-timer"
          onClick={() => run(() => window.quiz.pauseTimer())}
        >
          Pause timer
        </Button>
      )}
      <Button
        variant="secondary"
        size="sm"
        disabled={busy}
        testId="timer-plus"
        onClick={() => run(() => window.quiz.adjustTimer(60_000))}
      >
        +1 min
      </Button>
      <Button
        variant="secondary"
        size="sm"
        disabled={busy}
        testId="timer-minus"
        onClick={() => run(() => window.quiz.adjustTimer(-60_000))}
      >
        −1 min
      </Button>
    </span>
  )
}

function EndQuizButton(): React.JSX.Element {
  return (
    <ConfirmButton
      label="End quiz now"
      confirmLabel="Yes, end it"
      icon={<Icon name="stop" />}
      testId="end-quiz"
      confirmTestId="end-quiz-confirm"
      onConfirm={() => void window.quiz.endQuiz()}
    />
  )
}

/** A compact, grouped one-student card with a progress bar and status. */
function StudentCard({
  student,
  total,
  answered
}: {
  student: StudentInfo
  total: number
  answered: number
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
    <li
      className={`live__card${paused ? ' live__card--paused' : ''}${finished ? ' live__card--finished' : ''}`}
    >
      <div className="live__card-head">
        <span className="roster__avatar" aria-hidden="true">
          {initials}
        </span>
        <span className="live__card-name">{student.name}</span>
        {paused && <Badge tone="warn">Paused</Badge>}
        {finished && <Badge tone="ok">Finished</Badge>}
        <Badge tone={student.status === 'connected' ? 'ok' : 'danger'}>{student.status}</Badge>
      </div>
      <div className="live__card-meta">
        answered {answered} of {total} ({pct}%)
      </div>
      <div className="live__bar live__bar--sm">
        <div
          className={`live__bar-fill${paused ? ' live__bar-fill--ok' : ''}${finished ? ' live__bar-fill--ok' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {paused && (
        <Button
          variant="secondary"
          size="sm"
          testId={`approve-${student.name}`}
          onClick={() => void window.quiz.approveResume(student.id)}
        >
          Approve resume
        </Button>
      )}
    </li>
  )
}

/** Human wording for a student event. */
const describe = (type: StudentInfo['events'][number]['type']): string => {
  switch (type) {
    case 'paused':
      return 'paused'
    case 'resumed':
      return 'resumed'
    case 'focus_lost':
      return 'lost focus'
    case 'focus_gained':
      return 'regained focus'
    case 'finished':
      return 'finished'
    case 'resume_request':
      return 'asked to resume'
    case 'disconnect':
      return 'disconnected'
    case 'reconnect':
      return 'reconnected'
  }
}

/** Collapsible event log for a student. */
function EventLog({ events, open, onToggle }: { events: StudentInfo['events']; open: boolean; onToggle: () => void }): React.JSX.Element {
  if (events.length === 0) return <></>
  const eventTime = (at: number): string =>
    new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return (
    <div className="live__events">
      <Button variant="ghost" size="sm" onClick={onToggle}>
        Events ({events.length})
      </Button>
      {open && (
        <ul>
          {events.map((e, i) => (
            <li key={`${e.at}-${i}`} className="live__event">
              <span className="live__event-time">{eventTime(e.at)}</span>
              <Badge>{e.type}</Badge>
              <span>{describe(e.type)}</span>
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
    <div className="live">
      <div className="live__hero">
        <div>
          <div className="live__clock-label">Session over</div>
          <div className="live__clock" data-testid="countdown">
            {clock(0)}
          </div>
        </div>
        <div className="live__progress">
          <div className="live__bar">
            <div className="live__bar-fill live__bar-fill--ok" style={{ width: `${overall}%` }} />
          </div>
          <span className="live__bar-label">{overall}% answered</span>
        </div>
        <Button
          variant="primary"
          testId="new-session"
          onClick={() => void window.quiz.newSession()}
        >
          New session
        </Button>
      </div>

      <Panel title="Summary" actions={<Badge tone="neutral">{reason}</Badge>}>
        <p className="ui-muted">
          {total} question{total === 1 ? '' : 's'} · {students.length} student
          {students.length === 1 ? '' : 's'}
        </p>
      </Panel>

      <Panel title="Students" actions={<Badge tone="neutral">{students.length}</Badge>}>
        {students.length === 0 ? (
          <EmptyState title="Nobody joined this session" icon={<Icon name="users" />} />
        ) : (
          <ul className="live__cards">
            {students.map((s) => {
              const answered = state.quiz.answeredByStudent[s.id] ?? 0
              const pct = total > 0 ? Math.round((answered / total) * 100) : 0
              return (
                <li key={s.id} className="live__card">
                  <div className="live__card-head">
                    <span className="roster__avatar" aria-hidden="true">
                      {s.name.trim().split(' ').map((w) => w[0]).join('') || '?'}
                    </span>
                    <span className="live__card-name">{s.name}</span>
                    {s.finished && <Badge tone="ok">Finished</Badge>}
                    <Badge tone={s.status === 'connected' ? 'ok' : 'danger'}>{s.status}</Badge>
                  </div>
                  <div className="live__card-meta">
                    answered {answered} of {total} ({pct}%)
                  </div>
                  <div className="live__bar live__bar--sm">
                    <div className="live__bar-fill" style={{ width: `${pct}%` }} />
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Panel>
    </div>
  )
}

/** Running and ended views. Counts only; step 2 has no scores. */
export function LiveSession({ state }: { state: StateSnapshot }): React.JSX.Element {
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
  const overall = Math.min(
    100,
    Math.round(
      (students.reduce((acc, s) => acc + (quiz.answeredByStudent[s.id] ?? 0), 0) /
        (total * students.length)) *
        100
    )
  )

  const groups: { title: string; list: StudentInfo[]; tone: 'accent' | 'warn' | 'ok' | 'neutral' }[] = [
    { title: 'Connected', list: connected, tone: 'accent' },
    { title: 'Paused', list: paused, tone: 'warn' },
    { title: 'Finished', list: finished, tone: 'ok' },
    { title: 'Disconnected', list: disconnected, tone: 'neutral' }
  ]

  return (
    <div className="live">
      <div className="live__hero">
        <div>
          <div className="live__clock-label">Time left</div>
          <div
            className={`live__clock${remaining < 30_000 ? ' live__clock--urgent' : ''}${
              timerPaused ? ' live__clock--paused' : ''
            }`}
            data-testid="countdown"
          >
            {clock(remaining)}
          </div>
        </div>
        <div className="live__progress">
          <div className="live__bar">
            <div className="live__bar-fill" style={{ width: `${overall}%` }} />
          </div>
          <span className="live__bar-label">{overall}% answered</span>
        </div>
        <div className="live__controls">
          <TimerControls timerPaused={timerPaused} />
          <LockToggle lockMode={state.lockMode} />
          {paused.length > 0 && (
            <Button
              variant="secondary"
              size="sm"
              testId="approve-all"
              onClick={() => void window.quiz.approveAllResume()}
            >
              Approve all ({paused.length})
            </Button>
          )}
          <EndQuizButton />
        </div>
      </div>

      {allFinished && (
        <div className="shell__banner shell__banner--accent" data-testid="all-finished">
          All connected students have finished
        </div>
      )}

      <div className="live__columns">
        <Panel
          title="Students"
          actions={
            <Badge tone="neutral">
              {students.length} in session · {paused.length} paused · {finished.length} finished
            </Badge>
          }
        >
          {students.length === 0 ? (
            <EmptyState title="No students in this session" icon={<Icon name="users" />} />
          ) : (
            <>
              {groups
                .filter((g) => g.list.length > 0)
                .map((g) => (
                  <div key={g.title} className="live__group">
                    <div className="live__group-title">
                      <span>{g.title}</span>
                      <Badge tone={g.tone}>{g.list.length}</Badge>
                    </div>
                    <ul className="live__cards">
                      {g.list.map((s) => (
                        <StudentCard
                          key={s.id}
                          student={s}
                          total={total}
                          answered={quiz.answeredByStudent[s.id] ?? 0}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
              <EventLog
                events={students.flatMap((s) => s.events)}
                open={eventsOpen}
                onToggle={() => setEventsOpen((v) => !v)}
              />
            </>
          )}
        </Panel>

        <Panel
          title="Per question"
          actions={
            <Badge tone="neutral">
              {total} question{total === 1 ? '' : 's'} ·{' '}
              {quiz.questions.reduce((acc, q) => acc + q.answered, 0)} answered
            </Badge>
          }
        >
          {quiz.questions.length === 0 ? (
            <EmptyState title="No questions in this quiz" icon={<Icon name="quizzes" />} />
          ) : (
            <div className="qgrid">
              {quiz.questions.map((q, qi) => (
                <div className="qgrid__cell" key={q.qid}>
                  <span className="qgrid__num">Q{qi + 1}</span>
                  <div className="qgrid__body">
                    <div className="qgrid__text" title={q.body}>
                      {q.body.slice(0, 60)}
                      {q.body.length > 60 ? '…' : ''}
                    </div>
                    <div className="live__bar live__bar--sm">
                      <div
                        className="live__bar-fill"
                        style={{
                          width: `${total > 0 ? Math.round((q.answered / students.length) * 100) : 0}%`
                        }}
                      />
                    </div>
                  </div>
                  <span className="qgrid__count">
                    {q.answered}/{students.length}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  )
}

