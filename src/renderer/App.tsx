import { useEffect, useState } from 'react'
import type { ImportQuizReport, StateSnapshot } from '../shared/types'
import { AppShell, type ShellSection } from './components/AppShell'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Dashboard } from './screens/Dashboard'
import { LiveSession } from './screens/LiveSession'
import { QuizLibrary } from './screens/QuizLibrary'
import { QuizEditor } from './screens/QuizEditor'
import { ResultDetail, Results } from './screens/Results'
import { Settings } from './screens/Settings'

/** Where the instructor is. The editor sits on top of the library. */
type View =
  | { name: 'dashboard' }
  | { name: 'library' }
  | { name: 'editor'; quizId: string; importReport?: ImportQuizReport | null }
  | { name: 'results' }
  | { name: 'result'; sessionId: string }
  | { name: 'settings' }

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
  if (state.quiz.status === 'running') {
    return (
      <AppShell
        section="live"
        onNavigate={() => undefined}
        liveBadge="live"
        title={state.quiz.title ?? 'Live session'}
        subtitle="The session is live. Counts and progress only."
      >
        <ErrorBoundary>
          <LiveSession state={state} />
        </ErrorBoundary>
      </AppShell>
    )
  }

  // The results stay reachable after the quiz ended: the finished session
  // keeps its own screen until the instructor walks away from it.
  const inResults = view.name === 'results' || view.name === 'result'
  if (state.quiz.status === 'ended' && !inResults) {
    return (
      <AppShell
        section="live"
        onNavigate={() => undefined}
        liveBadge="ended"
        title="Quiz ended"
        subtitle="The session has finished."
      >
        <ErrorBoundary>
          <LiveSession state={state} onOpenResults={() => setView({ name: 'results' })} />
        </ErrorBoundary>
      </AppShell>
    )
  }

  const section: ShellSection =
    view.name === 'library' || view.name === 'editor'
      ? 'quizzes'
      : view.name === 'results' || view.name === 'result'
        ? 'results'
        : view.name === 'settings'
          ? 'settings'
          : 'dashboard'

  const navigate = (next: ShellSection): void => {
    if (next === 'quizzes') setView({ name: 'library' })
    else if (next === 'results') setView({ name: 'results' })
    else if (next === 'settings') setView({ name: 'settings' })
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
        onOpen={(quizId, report) => setView({ name: 'editor', quizId, importReport: report ?? null })}
      />
    )
  } else if (view.name === 'results') {
    title = 'Results'
    subtitle = 'Every finished session, with its score sheet.'
    content = (
      <Results onOpen={(sessionId) => setView({ name: 'result', sessionId })} onBack={() => setView({ name: 'dashboard' })} />
    )
  } else if (view.name === 'result') {
    title = 'Score sheet'
    subtitle = 'Where every student answered what.'
    content = (
      <ResultDetail sessionId={view.sessionId} onBack={() => setView({ name: 'results' })} />
    )
  } else if (view.name === 'settings') {
    title = 'Settings'
    subtitle = 'Configure your quiz library and AI provider.'
    content = <Settings />
  } else {
    content = (
      <Dashboard
        state={state}
        onOpenLibrary={() => setView({ name: 'library' })}
        onOpenResults={() => setView({ name: 'results' })}
      />
    )
  }

  return (
    <AppShell
      section={section}
      onNavigate={navigate}
      liveBadge={state.students.filter((s) => s.status === 'connected').length.toString()}
      title={title}
      subtitle={subtitle}
    >
      {/* A screen that fails to render shows a message, not a white window,
          and the shell around it keeps working. The key is the screen, so
          moving to another one gives the broken screen a fresh start. */}
      <ErrorBoundary key={view.name === 'result' ? view.sessionId : view.name}>{content}</ErrorBoundary>
    </AppShell>
  )
}
