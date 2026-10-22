import type { AvatarSpec } from '../../shared/types'
import { AVATAR_PRESETS, skinTone, seedRng } from '../../shared/avatar'
import type { AccessoryShape, EyesShape, FaceShape, MouthShape } from './avatarShapes'
import { facePath, eyesPath, mouthPath, accessoryPath } from './avatarShapes'

/** 64x80 viewBox the whole sheet renders into. */
const W = 64
const H = 80

/** The color used for eyes, mouth and accessories that are not shaded. */
const LINE = '#3f4b5a'

export interface AvatarProps {
  /** The avatar spec sent on join; absent => initials fallback. */
  avatar?: AvatarSpec
  /** The name used for the initials fallback. */
  name: string
  /** A size token; the slot is square. */
  size?: number
  /** Extra class for the surrounding span. */
  className?: string
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  const letters = parts.slice(0, 2).map((p) => p[0] ?? '')
  const out = letters.join('').toUpperCase()
  return out || '?'
}

/**
 * A deterministic avatar drawn from an AvatarSpec as inline SVG, with the
 * student's initials as a fallback when no avatar was picked. The preset
 * tables in `src/shared/avatar.ts` are the single source of truth shared with
 * the Android client, so a spec rendered here is pixel-for-pixel the same face
 * the phone shows.
 */
export function Avatar({ avatar, name, size = 32, className }: AvatarProps): React.JSX.Element {
  const cls = [className, 'avatar'].filter(Boolean).join(' ')
  if (!avatar) {
    return (
      <span
        className={cls}
        aria-label={name}
        style={{
          width: size,
          height: size,
          fontSize: Math.max(10, Math.round(size * 0.4)),
          borderRadius: '50%',
          background: 'var(--ui-accent-soft)',
          color: 'var(--ui-accent-hover)',
          fontWeight: 'var(--fw-bold)'
        }}
        data-testid="avatar-initials"
      >
        {initials(name)}
      </span>
    )
  }

  const skin = skinTone(avatar.hue)
  const rng = seedRng(avatar.seed)
  const faceI = Math.min(AVATAR_PRESETS.face.length - 1, Math.max(0, avatar.face))
  const eyesI = Math.min(AVATAR_PRESETS.eyes.length - 1, Math.max(0, avatar.eyes))
  const mouthI = Math.min(AVATAR_PRESETS.mouth.length - 1, Math.max(0, avatar.mouth))
  const accI = Math.min(AVATAR_PRESETS.accessory.length - 1, Math.max(0, avatar.accessory))

  const faceShape: FaceShape = AVATAR_PRESETS.face[faceI].shape as FaceShape
  const eyeShape: EyesShape = AVATAR_PRESETS.eyes[eyesI].shape as EyesShape
  const mouthShape: MouthShape = AVATAR_PRESETS.mouth[mouthI].shape as MouthShape
  const accessoryShape: AccessoryShape = AVATAR_PRESETS.accessory[accI].shape as AccessoryShape

  // A hair color for hats/caps derived from the seed so two students with the
  // same accessory still get different colors.
  const hairHue = Math.round(rng() * 360)
  const hair = `hsl(${hairHue}, 60%, 35%)`

  const paths = drawFace({ faceShape, eyeShape, mouthShape, accessoryShape, skin, hair, rng })

  return (
    <svg
      className={cls}
      aria-label={name}
      data-testid="avatar-spec"
      width={size}
      height={size}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      style={{ borderRadius: '50%', overflow: 'visible' }}
    >
      {paths.map((p, i) => (
        <path key={i} d={p.d} fill={p.fill} stroke={p.stroke} strokeWidth={p.strokeWidth} />
      ))}
    </svg>
  )
}

interface DrawnPath {
  d: string
  fill: string
  stroke: string
  strokeWidth: number
}

interface FaceParts {
  faceShape: FaceShape
  eyeShape: EyesShape
  mouthShape: MouthShape
  accessoryShape: AccessoryShape
  skin: string
  hair: string
  rng: () => number
}

function drawFace(parts: FaceParts): DrawnPath[] {
  const { faceShape, eyeShape, mouthShape, accessoryShape, skin, hair, rng } = parts
  const out: DrawnPath[] = []

  // Accessory first when it sits behind the head (none/sunglasses/headband),
  // then the face, then eyes + mouth + front accessories. The order keeps the
  // deterministic spec readable while still layering sensibly.
  const face = facePath(faceShape, rng)
  out.push({ d: face, fill: skin, stroke: LINE, strokeWidth: 0.8 })

  if (accessoryShape === 'glasses' || accessoryShape === 'sunglasses') {
    const ap = accessoryPath(accessoryShape, rng)
    out.push({ d: ap, fill: 'none', stroke: '#1a2332', strokeWidth: 1.4 })
  }

  const eyes = eyesPath(eyeShape, rng)
  if (eyes) out.push({ d: eyes, fill: '#1a2332', stroke: '#1a2332', strokeWidth: 0.6 })

  const mouth = mouthPath(mouthShape, rng)
  if (mouth) out.push({ d: mouth, fill: 'none', stroke: '#d95f6a', strokeWidth: 1.2 })

  if (accessoryShape === 'hat' || accessoryShape === 'cap') {
    const ap = accessoryPath(accessoryShape, rng)
    out.push({ d: ap, fill: hair, stroke: 'none', strokeWidth: 0 })
  }

  if (accessoryShape === 'headband') {
    const ap = accessoryPath('headband', rng)
    out.push({ d: ap, fill: hair, stroke: 'none', strokeWidth: 0 })
  }

  return out
}
