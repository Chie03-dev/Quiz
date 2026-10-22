import type { ProfilePhoto } from '../../shared/types'

export interface StudentPhotoProps {
  /** The photo the student uploaded on join; absent => initials fallback. */
  photo?: ProfilePhoto
  /** The student's name, used for the initials fallback. */
  name: string
  /** A size token; the slot is square. */
  size?: number
  /** Extra class for the wrapping element. */
  className?: string
}

/** A roster slot: a thumbnail `<img>` from the join photo, or the student's initials. */
export function StudentPhoto({ photo, name, size = 32, className }: StudentPhotoProps): React.JSX.Element {
  const cls = [className, 'profile-photo'].filter(Boolean).join(' ')
  const initials = (name?.trim().slice(0, 1) || '?').toUpperCase()
  if (photo) {
    const src = `data:${photo.mime};base64,${photo.data}`
    return (
      <img
        src={src}
        alt={`photo of ${name}`}
        className={cls}
        width={size}
        height={size}
        data-testid="profile-photo"
      />
    )
  }
  return (
    <span className={cls} data-testid="profile-photo-initials" aria-label={`photo of ${name}`}>
      {initials}
    </span>
  )
}
