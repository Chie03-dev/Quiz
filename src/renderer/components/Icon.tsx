import type { ReactNode } from 'react'

/**
 * The icon set of the app. Every icon is an inline SVG so the app needs no
 * icon pack and works with no internet.
 *
 * Pen-and-paper theme: these are deliberately *crude*, thick-stroke,
 * hand-drawn sketches instead of precise geometry. They share the same
 * `IconName` set as before so no consumer code changes.
 */
export type IconName =
  | 'dashboard'
  | 'quizzes'
  | 'live'
  | 'results'
  | 'plus'
  | 'trash'
  | 'copy'
  | 'download'
  | 'upload'
  | 'arrow-up'
  | 'arrow-down'
  | 'check'
  | 'close'
  | 'play'
  | 'pause'
  | 'stop'
  | 'clock'
  | 'users'
  | 'edit'
  | 'lock'
  | 'unlock'
  | 'chevron-down'
  | 'chevron-up'
  | 'zap'
  | 'image'
  | 'sparkle'
  | 'settings'

const PATHS: Record<IconName, ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="8" height="7" rx="1.5" />
      <rect x="13" y="3" width="8" height="9" rx="1.5" />
      <rect x="3" y="13" width="8" height="7" rx="1.5" />
      <rect x="13" y="13" width="8" height="7" rx="1.5" />
    </>
  ),
  quizzes: (
    <>
      <path d="M4 4h9l5 5v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
      <path d="M14 4v5h5" />
      <path d="M8 13h7M8 16h5" />
    </>
  ),
  live: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M7 8a7 7 0 0 0 0 8M17 8a7 7 0 0 1 0 8" />
      <path d="M4 5a10 10 0 0 0 0 14M20 5a10 10 0 0 1 0 14" />
    </>
  ),
  results: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="3" />
      <path d="M7 16V12M12 16V9M17 16V13" />
    </>
  ),
  plus: <path d="M11 6h2v11h-2zM6 11h12v2H6z" />,
  trash: (
    <>
      <path d="M4 6h16" />
      <path d="M10 3h4l1 3h-6l1-3z" />
      <path d="M6 6l1 14h10l1-14" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 16H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  download: <path d="M12 3v13m0 0 5-5m-5 5-5-5M5 20h14" />,
  upload: <path d="M12 21V8m0 0 5 5m-5-5-5 5M4 5h16" />,
  'arrow-up': <path d="M12 18V6m0 0-6 6m6-6 6 6" />,
  'arrow-down': <path d="M12 6v12m0 0 6-6m-6 6-6-6" />,
  check: <path d="m5 13 5 5 9-9" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  play: <path d="M8 5v15l12-7z" />,
  pause: <path d="M9 5v14M15 5v14" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20a6 6 0 0 1 10-4" />
      <circle cx="17" cy="8" r="3" />
      <path d="M13 20a6 6 0 0 0 10-4" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20h4l12-12a3 3 0 0 0-4-4L5 15v4z" />
      <path d="m15 9 3 3" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  unlock: (
    <>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0" />
    </>
  ),
  'chevron-down': <path d="m6 10 6 6 6-6" />,
  'chevron-up': <path d="m6 14 6-6 6 6" />,
  zap: <path d="M13 3L5 14h7l-1 7 8-11h-7z" />,
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8" cy="10" r="2" />
      <path d="m4 20 5-5 4 4 3-3 5 4" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 3l2 6h6l-5 4 1.5 6-5-3-5 3 1.5-6-5-4h6z" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12h1a1 1 0 0 1 0 2h-1a5 5 0 0 1-1-2z" />
      <path d="M5 12a5 5 0 0 1 10 0" />
      <path d="M4 12h1a1 1 0 1 1 0 2H4a1 1 0 0 1 0-2z" />
      <path d="M12 4v1a1 1 0 0 1-2 0V4a1 1 0 0 1 2 0z" />
      <path d="M12 19v1a1 1 0 0 1-2 0v-1a1 1 0 0 1 2 0z" />
      <path d="M17.4 6.6a1 1 0 0 1 0 1.4l-.7.7a5 5 0 0 1-1-2.4 1 1 0 0 1 1.7-.7z" />
      <path d="M7.6 17.4a1 1 0 0 1 0 1.4l-.7.7" />
    </>
  ),
}

  /** Renders one of the app's inline SVG icons. */
export function Icon({ name, className }: { name: IconName; className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray="4 2"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {PATHS[name]}
    </svg>
  )
}
