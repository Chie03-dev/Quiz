import type { ReactNode } from 'react'

/** The visual variants shared by every button in the app. */
export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'

interface ButtonProps {
  variant?: ButtonVariant
  size?: 'md' | 'sm'
  icon?: ReactNode
  testId?: string
  title?: string
  disabled?: boolean
  type?: 'button' | 'submit'
  onClick?: () => void
  children?: ReactNode
}

/**
 * The one button in the app. Screens must not define their own button
 * markup; pass a variant instead.
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  testId,
  title,
  disabled = false,
  type = 'button',
  onClick,
  children
}: ButtonProps): React.JSX.Element {
  const classes = ['ui-btn', `ui-btn--${variant}`]
  if (size === 'sm') classes.push('ui-btn--sm')
  return (
    <button
      type={type}
      className={classes.join(' ')}
      data-testid={testId}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {icon && <span className="ui-btn__icon">{icon}</span>}
      {children}
    </button>
  )
}

interface IconButtonProps {
  /** Required: an icon-only button still needs an accessible name. */
  label: string
  icon: ReactNode
  variant?: ButtonVariant
  size?: 'md' | 'sm'
  testId?: string
  disabled?: boolean
  onClick?: () => void
}

/** A square button holding a single icon. */
export function IconButton({
  label,
  icon,
  variant = 'ghost',
  size = 'md',
  testId,
  disabled = false,
  onClick
}: IconButtonProps): React.JSX.Element {
  const classes = ['ui-btn', 'ui-btn--icon', `ui-btn--${variant}`]
  if (size === 'sm') classes.push('ui-btn--sm')
  return (
    <button
      type="button"
      className={classes.join(' ')}
      data-testid={testId}
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="ui-btn__icon">{icon}</span>
    </button>
  )
}
