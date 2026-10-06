import { useEffect, useState } from 'react'
import type { StateSnapshot, StudentInfo } from '../shared/types'
import { LockToggle } from './Lobby'

/** Ticks once a second so the countdown moves without any server round trip. */
function useRemaining(endsAt: number | null): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [])
  return endsAt === null ? 0 : Math.max(0, endsAt - now)
}

const clock = (ms: number): string => {
  const total = Math.ceil(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
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

/** One row per student, with the step-3 pause state and event log. */
function StudentRow({
  student,
  total,
  answered
}: {
  student: StudentInfo
  total: number
  answered: number
}): React.JSX.Element {
  const [showEvents, setShowEvents] = useState(false)
  const eventTime = (at: number): string =>
    new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const finishTime = (at: number | null): string =>
    at === null ? '' : new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

  return (
    <>
      <li className={`${student.status}${student.paused ? ' paused' : ''}`}>
        <span className="name">{student.name}</span>
        <span className="status">{student.status}</span>
        {student.finished && (
          <span className="badge done">Finished{student.finishedAt !== null ? ` · ${finishTime(student.finishedAt)}` : ''}</span>
        )}
        {student.paused && (
          <span className="badge pause">
            PAUSED · {student.pauseReason === 'network' ? 'network' : 'focus'}
          </span>
        )}
        {student.resumeRequested && student.paused && <span className="badge wants">asked to resume</span>}
        <span className="badge focus">focus lost ×{student.focusLosses}</span>
        <span className="answered">
          answered {answered} of {total}
        </span>
        {student.paused && (
          <button className="approve" onClick={() => void window.quiz.approveResume(student.id)}>
            Approve
          </button>
        )}
        <button className="link" onClick={() => setShowEvents((v) => !v)}>
          {showEvents ? 'Hide events' : `Events (${student.events.length})`}
        </button>
      </li>
      {showEvents && (
        <li className="events">
          {student.events.length === 0 ? (
            <span className="muted">No events yet.</span>
          ) : (
            <ul>
              {student.events.map((e, i) => (
                <li key={`${e.at}-${i}`} className={e.type}>
                  <span className="name">{eventTime(e.at)}</span>
                  <span className="tag">{e.type}</span>
                </li>
              ))}
            </ul>
          )}
        </li>
      )}
    </>
  )
}

function Ended({ state }: { state: StateSnapshot }): React.JSX.Element {
  const { students, quiz } = state
  const total = quiz.questions.length
  const reason = quiz.endReason === 'time' ? 'Time is up.' : 'Ended by the instructor.'
  return (
    <div className="lobby">
      <header className="topbar">
        <h1>Quiz ended</h1>
        <button className="secondary" onClick={() => void window.quiz.newSession()}>
          New session
        </button>
      </header>
      <p className="muted">{reason}</p>
      <section className="students">
        <div className="students-head">
          <h2>{quiz.title ?? 'Quiz'}</h2>
          <span className="count">
            {total} question{total === 1 ? '' : 's'}
          </span>
        </div>
        <ul>
          {students.map((s) => (
            <li key={s.id} className={s.status}>
              <span className="name">{s.name}</span>
              <span className="status">
                answered {quiz.answeredByStudent[s.id] ?? 0} of {total}
              </span>
            </li>
          ))}
        </ul>
        <h2>Per question</h2>
        <ul>
          {quiz.questions.map((q) => (
            <li key={q.qid}>
              <span className="name">{q.body}</span>
              <span className="status">
                {q.answered} / {students.length}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

/** Running and ended views. Counts only; step 2 has no scores. */
export function QuizRun({ state }: { state: StateSnapshot }): React.JSX.Element {
  const { students, quiz } = state
  const remaining = useRemaining(quiz.endsAt)

  if (quiz.status === 'ended') return <Ended state={state} />

  const total = quiz.questions.length
  const paused = students.filter((s) => s.paused)
  const finishedCount = students.filter((s) => s.finished).length
  // Nothing ends automatically: the banner is informational only.
  const connected = students.filter((s) => s.status === 'connected')
  const allFinished = connected.length > 0 && connected.every((s) => s.finished)

  return (
    <div className="lobby">
      <header className="topbar">
        <h1>Running: {quiz.title}</h1>
        <span className="topbar-actions">
          <span className={`countdown${remaining < 30_000 ? ' urgent' : ''}`}>{clock(remaining)}</span>
          <LockToggle lockMode={state.lockMode} />
          {paused.length > 0 && (
            <button className="secondary" onClick={() => void window.quiz.approveAllResume()}>
              Approve all ({paused.length})
            </button>
          )}
          <EndQuizButton />
        </span>
      </header>

      <section className="students">
        <div className="students-head">
          <h2>Students</h2>
          <span className="count">
            {students.length} in the session · {paused.length} paused · {finishedCount} finished
          </span>
        </div>
        {allFinished && <p className="banner">All connected students have finished</p>}
        <ul>
          {students.map((s) => (
            <StudentRow
              key={s.id}
              student={s}
              total={total}
              answered={quiz.answeredByStudent[s.id] ?? 0}
            />
          ))}
        </ul>

        <h2>Per question</h2>
        <ul>
          {quiz.questions.map((q) => (
            <li key={q.qid}>
              <span className="name">{q.body}</span>
              <span className="tag">{q.type}</span>
              <span className="status">
                {q.answered} / {students.length}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}