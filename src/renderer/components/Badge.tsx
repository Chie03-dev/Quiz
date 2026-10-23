import type { ReactNode } from 'react'

/** The semantic tones a badge can carry. */
export type BadgeTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent' | 'teal'

interface BadgeProps {
  tone?: BadgeTone
  icon?: ReactNode
  /** data-testid, for e.g. ui-check.ts assertions. */
  testId?: string
  /** When set the badge is rendered as a tappable button. */
  onClick?: () => void
  children: ReactNode
}

/** A small status pill. One component for every badge in the app. */
export function Badge({ tone = 'neutral', icon, testId, onClick, children }: BadgeProps): React.JSX.Element {
  const inner = (
    <>
      {icon && <span className="ui-btn__icon">{icon}</span>}
      {children}
    </>
  )
  const classes = [`ui-badge`, `ui-badge--${tone}`]
  if (onClick) {
    return (
      <button type="button" className={classes.join(' ')} data-testid={testId} onClick={onClick}>
        {inner}
      </button>
    )
  }
  return (
    <span className={classes.join(' ')} data-testid={testId}>
      {inner}
    </span>
  )
}
