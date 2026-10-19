import { useEffect, useState } from 'react'
import type { ImportQuizReport, StateSnapshot } from '../shared/types'
import { AppShell, type ShellSection } from './components/AppShell'
import { Dashboard } from './screens/Dashboard'
import { LiveSession } from './screens/LiveSession'
import { QuizLibrary } from './screens/QuizLibrary'
import { QuizEditor } from './screens/QuizEditor'

/** Where the instructor is. The editor sits on top of the library. */
type View =
  | { name: 'dashboard' }
  | { name: 'library' }
  | { name: 'editor'; quizId: string; importReport?: ImportQuizReport | null }

export function App(): React.JSX.Element {
  const [state, setState] = useState<StateSnapshot | null>(null)
  const [failed, setFailed] = useState(false)
  const [view, setView] = useState<View>({ name: 'dashboard' })

  useEffect(() => {
    let active = true
    window.quiz
      .getState()
      .then((s) => {
        if (!active) return
        if (s) setState(s)
        else setFailed(true)
      })
      .catch(() => active && setFailed(true))

    // Server state arrives over IPC; the UI never polls.
    const off = window.quiz.onStateChanged(setState)
    return () => {
      active = false
      off()
    }
  }, [])

  // A running or ended quiz always wins: the live session takes over.
  useEffect(() => {
    if (state && state.quiz.status !== 'lobby') setView({ name: 'dashboard' })
  }, [state?.quiz.status])

  if (failed) {
    return <div className="ui-empty">Could not start the quiz server.</div>
  }
  if (!state) {
    return <div className="ui-empty">Starting server…</div>
  }

  // While a quiz runs, the live session is the only thing on screen.
  if (state.quiz.status !== 'lobby') {
    return (
      <AppShell
        section="live"
        onNavigate={() => undefined}
        liveBadge={state.quiz.status === 'running' ? 'live' : 'ended'}
        title={state.quiz.status === 'running' ? (state.quiz.title ?? 'Live session') : 'Quiz ended'}
        subtitle={
          state.quiz.status === 'running'
            ? 'The session is live. Counts and progress only.'
            : 'The session has finished.'
        }
      >
        <LiveSession state={state} />
      </AppShell>
    )
  }

  const section: ShellSection =
    view.name === 'library' || view.name === 'editor' ? 'quizzes' : 'dashboard'

  const navigate = (next: ShellSection): void => {
    if (next === 'quizzes') setView({ name: 'library' })
    else setView({ name: 'dashboard' })
  }

  let title = 'Dashboard'
  let subtitle = 'Join phones, pick a quiz, and start the session.'
  let content: React.JSX.Element

  if (view.name === 'editor') {
    title = 'Quiz editor'
    subtitle = 'Add and arrange questions, then save.'
    content = (
      <QuizEditor
        quizId={view.quizId}
        onBack={() => setView({ name: 'library' })}
        importReport={view.importReport}
      />
    )
  } else if (view.name === 'library') {
    title = 'Quizzes'
    subtitle = 'Every quiz in your library.'
    content = (
      <QuizLibrary
        onBack={() => setView({ name: 'dashboard' })}
        onOpen={(quizId) => setView({ name: 'editor', quizId })}
      />
    )
  } else {
    content = <Dashboard state={state} onOpenLibrary={() => setView({ name: 'library' })} />
  }

  return (
    <AppShell
      section={section}
      onNavigate={navigate}
      liveBadge={state.students.filter((s) => s.status === 'connected').length.toString()}
      title={title}
      subtitle={subtitle}
    >
      {content}
    </AppShell>
  )
}
