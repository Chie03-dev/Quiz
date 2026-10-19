import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

/** The screens the sidebar can show. */
export type ShellSection = 'dashboard' | 'quizzes' | 'live'

interface NavEntry {
  id: ShellSection
  label: string
  icon: IconName
}

const NAV: NavEntry[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'quizzes', label: 'Quizzes', icon: 'quizzes' },
  { id: 'live', label: 'Live session', icon: 'live' }
]

interface AppShellProps {
  section: ShellSection
  onNavigate: (section: ShellSection) => void
  /** Count shown next to the live session entry. */
  liveBadge?: string
  /** The title and subtitle of the current screen. */
  title: string
  subtitle?: string
  /** Buttons shown at the right of the top bar. */
  actions?: ReactNode
  /** A notice bar under the top bar. */
  banner?: ReactNode
  children: ReactNode
}

/**
 * The persistent app shell: a sidebar that never goes away and a content
 * area that the screens render into. A screen never replaces the shell.
 */
export function AppShell({
  section,
  onNavigate,
  liveBadge,
  title,
  subtitle,
  actions,
  banner,
  children
}: AppShellProps): React.JSX.Element {
  return (
    <div className="shell">
      <nav className="shell__nav" aria-label="Main">
        <div className="shell__brand">
          <span className="shell__brand-mark" aria-hidden="true">
            Q
          </span>
          <span className="shell__brand-name">
            Quiz
            <span className="shell__brand-sub">Instructor console</span>
          </span>
        </div>

        <div className="shell__nav-group">
          <span className="shell__nav-label">Workspace</span>
          {NAV.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`shell__nav-item${section === entry.id ? ' is-active' : ''}`}
              data-testid={`nav-${entry.id}`}
              aria-current={section === entry.id ? 'page' : undefined}
              onClick={() => onNavigate(entry.id)}
            >
              <span className="shell__nav-icon">
                <Icon name={entry.icon} />
              </span>
              <span className="shell__nav-text">{entry.label}</span>
              {entry.id === 'live' && liveBadge && (
                <span className="shell__nav-badge">
                  <span className="ui-badge ui-badge--accent">{liveBadge}</span>
                </span>
              )}
            </button>
          ))}
        </div>
      </nav>

      <div className="shell__main">
        <header className="shell__topbar">
          <div className="shell__heading">
            <h1 className="shell__title">{title}</h1>
            {subtitle && <p className="shell__subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="shell__actions">{actions}</div>}
        </header>
        {banner && <div className="shell__banner">{banner}</div>}
        <main className="shell__content">{children}</main>
      </div>
    </div>
  )
}
