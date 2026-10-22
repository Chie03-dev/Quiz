import type { PhotoMime, ProfilePhoto } from './types'

/** Largest base64 payload the server will accept on a join (~7.5 KB of image). */
export const MAX_PHOTO_BASE64_LEN = 10_000

const PHOTO_MIMES: readonly PhotoMime[] = ['image/jpeg', 'image/png']

/**
 * Rejects anything that isn't a small, plain base64 image. The server drops a
 * malformed photo instead of rejecting the join — a bad upload is not a
 * connection error. The byte cap is the compression contract: phones resize to
 * a roster thumb before base64-encoding.
 */
export function isValidProfilePhoto(photo: unknown): photo is ProfilePhoto {
  if (typeof photo !== 'object' || photo === null || Array.isArray(photo)) return false
  const p = photo as Record<string, unknown>
  const mime = p.mime
  if (!PHOTO_MIMES.includes(mime as PhotoMime)) return false
  const data = p.data
  if (typeof data !== 'string' || data.length === 0) return false
  if (data.length > MAX_PHOTO_BASE64_LEN) return false
  return /^[A-Za-z0-9+/]*={0,2}$/.test(data)
}
