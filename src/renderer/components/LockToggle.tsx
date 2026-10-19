import { Icon } from './Icon'

interface LockToggleProps {
  lockMode: boolean
  label?: string
}

/** The switch that freezes student phones when they lose focus. */
export function LockToggle({ lockMode, label = 'Lock phones' }: LockToggleProps): React.JSX.Element {
  return (
    <label className={`lock${lockMode ? ' is-on' : ''}`} data-testid="lock-toggle">
      <input
        type="checkbox"
        checked={lockMode}
        onChange={(e) => void window.quiz.setLock(e.target.checked)}
      />
      <span className="lock__track" aria-hidden="true">
        <span className="lock__thumb" />
      </span>
      <span className="lock__label">{label}</span>
      <span className="lock__state">{lockMode ? 'ON' : 'OFF'}</span>
      <span className="ui-btn__icon" aria-hidden="true">
        <Icon name={lockMode ? 'lock' : 'unlock'} />
      </span>
    </label>
  )
}
