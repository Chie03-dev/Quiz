import { useEffect } from 'react'

interface MemeOverlayProps {
  /** The image as a data URL. */
  url: string
  /** How long the overlay stays up. */
  durationMs: number
  /** Called when the overlay hides itself. */
  onDone: () => void
}

/**
 * The instructor's own preview of a pop. It never takes pointer events, so
 * the instructor can keep clicking while it is on screen, and it hides
 * itself after the meme's own duration.
 */
export function MemeOverlay({ url, durationMs, onDone }: MemeOverlayProps): React.JSX.Element {
  useEffect(() => {
    const timer = setTimeout(onDone, durationMs)
    return () => clearTimeout(timer)
  }, [url, durationMs, onDone])

  return (
    <div className="memes__overlay" data-testid="meme-overlay" aria-hidden="true">
      <img className="memes__overlay-img" src={url} alt="" />
    </div>
  )
}
