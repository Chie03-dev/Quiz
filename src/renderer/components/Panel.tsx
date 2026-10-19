import type { ReactNode } from 'react'

interface PanelProps {
  title?: ReactNode
  /** Right-hand side of the panel header, e.g. a count or a button. */
  actions?: ReactNode
  className?: string
  children: ReactNode
}

/** A titled surface. The one panel style used across the app. */
export function Panel({ title, actions, className, children }: PanelProps): React.JSX.Element {
  const classes = ['ui-panel']
  if (className) classes.push(className)
  return (
    <section className={classes.join(' ')}>
      {(title !== undefined || actions !== undefined) && (
        <header className="ui-panel__head">
          <div className="ui-panel__title">{title}</div>
          {actions !== undefined && <div className="ui-panel__actions">{actions}</div>}
        </header>
      )}
      <div className="ui-panel__body">{children}</div>
    </section>
  )
}
