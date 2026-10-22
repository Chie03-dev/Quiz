export type { AvatarSpec } from './types'
import type { AvatarSpec } from './types'

/**
 * Deterministic avatar maker: a small JSON spec is sent inline on join — no
 * image bytes ever travel over the WebSocket. Both the instructor (React) and
 * the Android phone render the same face from the same spec + preset table,
 * so this file is the single source of truth for the presets. Index 0 on any
 * attribute means "none" (blank eyes/mouth/accessory, or the default face).
 */

export interface AvatarPreset {
  /** Display name used in logs / the Android picker. */
  name: string
  /** The drawing primitive the renderer draws. */
  shape: string
}

/** The bounds every index in an AvatarSpec must satisfy. */
export const AVATAR_BOUNDS = {
  hue: { min: 0, max: 360 },
  face: { min: 0, max: 6 },
  eyes: { min: 0, max: 8 },
  mouth: { min: 0, max: 6 },
  accessory: { min: 0, max: 4 }
} as const

/** Face outlines: the silhouette of the head. 0 = the default rounded shape. */
export const FACE_PRESETS: AvatarPreset[] = [
  { name: 'default', shape: 'round' },
  { name: 'soft', shape: 'soft' },
  { name: 'oval', shape: 'oval' },
  { name: 'square', shape: 'square' },
  { name: 'heart', shape: 'heart' },
  { name: 'diamond', shape: 'diamond' },
  { name: 'blob', shape: 'blob' }
]

/** Eye presets: 0 = none (blank). */
export const EYE_PRESETS: AvatarPreset[] = [
  { name: 'none', shape: 'none' },
  { name: 'closed', shape: 'closed' },
  { name: 'open', shape: 'open' },
  { name: 'wink', shape: 'wink' },
  { name: 'happy', shape: 'happy' },
  { name: 'squint', shape: 'squint' },
  { name: 'up', shape: 'up' },
  { name: 'half', shape: 'half' },
  { name: 'wide', shape: 'wide' },
  { name: 'sparkle', shape: 'sparkle' }
]

/** Mouth presets: 0 = none. */
export const MOUTH_PRESETS: AvatarPreset[] = [
  { name: 'none', shape: 'none' },
  { name: 'smile', shape: 'smile' },
  { name: 'grin', shape: 'grin' },
  { name: 'laughing', shape: 'laughing' },
  { name: 'sad', shape: 'sad' },
  { name: 'neutral', shape: 'neutral' },
  { name: 'kiss', shape: 'kiss' },
  { name: 'surprised', shape: 'surprised' }
]

/** Accessories: 0 = none. */
export const ACCESSORY_PRESETS: AvatarPreset[] = [
  { name: 'none', shape: 'none' },
  { name: 'glasses', shape: 'glasses' },
  { name: 'sun-glasses', shape: 'sunglasses' },
  { name: 'hat', shape: 'hat' },
  { name: 'cap', shape: 'cap' },
  { name: 'headband', shape: 'headband' }
]

/** Preset tables keyed by the spec field that indexes them. */
export const AVATAR_PRESETS = {
  face: FACE_PRESETS,
  eyes: EYE_PRESETS,
  mouth: MOUTH_PRESETS,
  accessory: ACCESSORY_PRESETS
} as const

/**
 * A tiny deterministic PRNG (mulberry32) so two identical specs always render
 * the same, with no randomness leaking between clients. Seeded from `seed`.
 */
export function seedRng(seed: string): () => number {
  let h = 0
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0
  }
  let a = (h ^ 0x9e3779b9) >>> 0
  for (let i = 0; i < 4; i++) a = (a + 0x6d2b79f5) | 0
  return function next(): number {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let r = 0x3efb29b ^ ((a ^ (a >>> 15)) >>> 0)
    r ^= r >>> 13
    return ((r ^ (r >>> 16)) >>> 0) / 4294967296
  }
}

/** Clamps a value to an inclusive integer range, returning 0 for NaN. */
function clampInt(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const n = Math.trunc(value)
  return Math.max(min, Math.min(max, n))
}

/**
 * Returns the spec only when every field is in range; otherwise null. The
 * server uses this to drop a malformed avatar without rejecting the join.
 */
export function isValidAvatarSpec(spec: unknown): spec is AvatarSpec {
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) return false
  const s = spec as Record<string, unknown>
  if (typeof s.seed !== 'string' || s.seed.length === 0) return false
  return (
    clampInt(s.hue, AVATAR_BOUNDS.hue.min, AVATAR_BOUNDS.hue.max) === s.hue &&
    clampInt(s.face, AVATAR_BOUNDS.face.min, AVATAR_BOUNDS.face.max) === s.face &&
    clampInt(s.eyes, AVATAR_BOUNDS.eyes.min, AVATAR_BOUNDS.eyes.max) === s.eyes &&
    clampInt(s.mouth, AVATAR_BOUNDS.mouth.min, AVATAR_BOUNDS.mouth.max) === s.mouth &&
    clampInt(s.accessory, AVATAR_BOUNDS.accessory.min, AVATAR_BOUNDS.accessory.max) === s.accessory
  )
}

/**
 * Returns a copy of `spec` with every index clamped into its preset range.
 * Never returns null: callers that have already validated can skip re-checking.
 */
export function clampAvatarSpec(spec: AvatarSpec): AvatarSpec {
  return {
    ...spec,
    hue: clampInt(spec.hue, AVATAR_BOUNDS.hue.min, AVATAR_BOUNDS.hue.max),
    face: clampInt(spec.face, AVATAR_BOUNDS.face.min, AVATAR_BOUNDS.face.max),
    eyes: clampInt(spec.eyes, AVATAR_BOUNDS.eyes.min, AVATAR_BOUNDS.eyes.max),
    mouth: clampInt(spec.mouth, AVATAR_BOUNDS.mouth.min, AVATAR_BOUNDS.mouth.max),
    accessory: clampInt(spec.accessory, AVATAR_BOUNDS.accessory.min, AVATAR_BOUNDS.accessory.max)
  }
}

/**
 * Maps a raw hue (0..360) to a warm skin-tone RGB string, by interpolating
 * between the preset stops. The renderer uses this so a student who picks a
 * different hue actually sees a different shade of skin.
 */
export function skinTone(hue: number): string {
  const h = clampInt(hue, AVATAR_BOUNDS.hue.min, AVATAR_BOUNDS.hue.max)
  const t = h / 360
  const stops: readonly [number, number, number][] = [
    [255, 224, 192],
    [255, 204, 178],
    [239, 186, 163],
    [222, 184, 135],
    [210, 160, 120],
    [196, 140, 100]
  ]
  const i = Math.min(stops.length - 1, Math.max(0, Math.floor(t * (stops.length - 1))))
  const j = Math.min(i + 1, stops.length - 1)
  const f = t * (stops.length - 1) - i
  const pa = stops[i]
  const pb = stops[j]
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * f)
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * f)
  const b = Math.round(pa[2] + (pb[2] - pa[2]) * f)
  return `rgb(${r}, ${g}, ${b})`
}
