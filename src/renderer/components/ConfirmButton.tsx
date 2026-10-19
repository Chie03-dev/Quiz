import { useEffect, useState, type ReactNode } from 'react'
import { Button, type ButtonVariant } from './Button'

/** How long the confirm state stays up before it falls back to the plain button. */
const CONFIRM_TIMEOUT_MS = 5000

interface ConfirmButtonProps {
  /** The label of the button before confirming. */
  label: string
  /** The label of the button that actually performs the action. */
  confirmLabel: string
  /** Optional context shown next to the confirm button, e.g. "2 students". */
  description?: string
  variant?: ButtonVariant
  confirmVariant?: ButtonVariant
  size?: 'md' | 'sm'
  icon?: ReactNode
  testId?: string
  confirmTestId?: string
  disabled?: boolean
  onConfirm: () => void
}

/**
 * A button that asks before it acts. Used for every one-way or destructive
 * action in the app, so the confirmation pattern is identical everywhere.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  description,
  variant = 'danger',
  confirmVariant = 'danger',
  size = 'md',
  icon,
  testId,
  confirmTestId,
  disabled = false,
  onConfirm
}: ConfirmButtonProps): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)

  // Back to the plain button if the instructor hesitates.
  useEffect(() => {
    if (!confirming) return
    const t = setTimeout(() => setConfirming(false), CONFIRM_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [confirming])

  if (!confirming) {
    return (
      <Button
        variant={variant}
        size={size}
        icon={icon}
        testId={testId}
        disabled={disabled}
        onClick={() => setConfirming(true)}
      >
        {label}
      </Button>
    )
  }

  return (
    <span className="ui-confirm" role="group" aria-label={`Confirm: ${label}`}>
      <Button
        variant={confirmVariant}
        size={size}
        testId={confirmTestId}
        onClick={() => {
          setConfirming(false)
          onConfirm()
        }}
      >
        {confirmLabel}
      </Button>
      {description && <span className="ui-confirm__hint">{description}</span>}
      <Button variant="ghost" size={size} onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </span>
  )
}
