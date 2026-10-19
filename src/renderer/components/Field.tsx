import type { ReactNode } from 'react'

interface FieldProps {
  label: string
  /** Hides the visible label but keeps it for screen readers. */
  hideLabel?: boolean
  className?: string
  children: ReactNode
}

/** A labelled form control. */
export function Field({ label, hideLabel = false, className, children }: FieldProps): React.JSX.Element {
  return (
    <label className={className ? `ui-field ${className}` : 'ui-field'}>
      <span className={hideLabel ? 'ui-sr-only' : 'ui-field__label'}>{label}</span>
      {children}
    </label>
  )
}
