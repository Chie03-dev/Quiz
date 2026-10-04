import { useEffect, useState } from 'react'
import type { StateSnapshot } from '../shared/types'
import { Lobby } from './Lobby'

export function App(): React.JSX.Element {
  const [state, setState] = useState<StateSnapshot | null>(null)
  const [failed, setFailed] = useState(false)

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

  if (failed) {
    return <div className="empty">Could not start the quiz server.</div>
  }
  if (!state) {
    return <div className="empty">Starting server…</div>
  }
  return <Lobby state={state} />
}