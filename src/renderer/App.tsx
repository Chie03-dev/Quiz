import { useEffect, useState } from 'react'
import type { ImportQuizReport, StateSnapshot } from '../shared/types'
import { Lobby } from './Lobby'
import { QuizRun } from './QuizRun'
import { QuizLibrary } from './QuizLibrary'
import { QuizEditor } from './QuizEditor'

/** Where the instructor is while the session is in the lobby. */
type View = { name: 'lobby' } | { name: 'library' } | { name: 'editor'; quizId: string; importReport?: ImportQuizReport | null }

export function App(): React.JSX.Element {
  const [state, setState] = useState<StateSnapshot | null>(null)
  const [failed, setFailed] = useState(false)
  const [view, setView] = useState<View>({ name: 'lobby' })

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

  // A quiz (or the ended view) always wins over the library screens.
  useEffect(() => {
    if (state && state.quiz.status !== 'lobby') setView({ name: 'lobby' })
  }, [state?.quiz.status])

  if (failed) {
    return <div className="empty">Could not start the quiz server.</div>
  }
  if (!state) {
    return <div className="empty">Starting server…</div>
  }
  if (state.quiz.status !== 'lobby') return <QuizRun state={state} />
  if (view.name === 'library') {
    return (
      <QuizLibrary
        onBack={() => setView({ name: 'lobby' })}
        onOpen={(quizId) => setView({ name: 'editor', quizId })}
      />
    )
  }
  if (view.name === 'editor') {
    return <QuizEditor quizId={view.quizId} onBack={() => setView({ name: 'library' })} importReport={view.importReport} />
  }
  return <Lobby state={state} onOpenLibrary={() => setView({ name: 'library' })} />
}