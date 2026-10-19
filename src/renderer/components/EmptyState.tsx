import type { ReactNode } from 'react'

interface EmptyStateProps {
  title: string
  body?: string
  icon?: ReactNode
  /** An optional call to action, e.g. a "New quiz" button. */
  action?: ReactNode
}

/** The placeholder shown when a list has nothing in it. */
export function EmptyState({ title, body, icon, action }: EmptyStateProps): React.JSX.Element {
  return (
    <div className="ui-empty">
      {icon && <span className="ui-empty__icon">{icon}</span>}
      <span className="ui-empty__title">{title}</span>
      {body && <span className="ui-empty__body">{body}</span>}
      {action}
    </div>
  )
}
