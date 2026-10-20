import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { IconButton } from './Button'
import { Icon } from './Icon'

/**
 * A panel that stays at the bottom of the screen while the page scrolls.
 *
 * The score sheet is tall, so an editor that sits in the flow at the bottom of
 * the page is a panel you have to scroll down and go and find - right after
 * you clicked a cell. This one stays where you are: it slides in over the
 * bottom of the window, and the page keeps enough room under it that the last
 * row of the sheet can still be reached.
 */
export function Drawer({
  title,
  onClose,
  children
}: {
  title: string
  onClose: () => void
  children: ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLElement>(null)

  useEffect(() => {
    // Escape closes it, so a stray click never traps the instructor here.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <section className="drawer" role="dialog" aria-label={title} ref={ref}>
      <header className="drawer__head">
        <strong className="drawer__title">{title}</strong>
        <IconButton label="Close" icon={<Icon name="close" />} onClick={onClose} testId="drawer-close" />
      </header>
      <div className="drawer__body">{children}</div>
    </section>
  )
}
