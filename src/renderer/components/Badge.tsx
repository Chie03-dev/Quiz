import type { ReactNode } from 'react'

/** The semantic tones a badge can carry. */
export type BadgeTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent' | 'teal'

interface BadgeProps {
  tone?: BadgeTone
  icon?: ReactNode
  children: ReactNode
}

/** A small status pill. One component for every badge in the app. */
export function Badge({ tone = 'neutral', icon, children }: BadgeProps): React.JSX.Element {
  return (
    <span className={`ui-badge ui-badge--${tone}`}>
      {icon && <span className="ui-btn__icon">{icon}</span>}
      {children}
    </span>
  )
}
