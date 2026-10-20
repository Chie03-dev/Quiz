import type { MemeMime } from '../../shared/types'

/** The largest source file the app accepts. */
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024
/** The long edge of the stored image. */
export const MAX_LONG_EDGE = 1024
/** The long edge of the tray thumbnail. */
export const THUMB_LONG_EDGE = 320
/** The quality of the stored JPEG. */
export const JPEG_QUALITY = 0.72
/** The quality of the thumbnail. */
export const THUMB_QUALITY = 0.6

export interface CompressedImage {
  mime: MemeMime
  width: number
  height: number
  /** The encoded image bytes. */
  bytes: Uint8Array
  /** The thumbnail as a data URL (the CSP allows data: images, not blob:). */
  thumb: string
}

/**
 * Decodes an image the OS understands. createImageBitmap decodes the first
 * frame only, so an animated GIF is flattened to a still image.
 */
async function decode(file: File): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('This system cannot process images.')
  }
  try {
    return await createImageBitmap(file)
  } catch {
    throw new Error('That file could not be read as an image.')
  }
}

/** The size an image is scaled to, never upscaled. */
function scaled(width: number, height: number, longEdge: number): { width: number; height: number } {
  const scale = Math.min(1, longEdge / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}

function draw(bitmap: ImageBitmap, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This system cannot process images.')
  ctx.drawImage(bitmap, 0, 0, width, height)
  return canvas
}

/** True when any sampled pixel is not fully opaque. */
function hasTransparency(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  const data = ctx.getImageData(0, 0, width, height).data
  // Sampling every fourth pixel is enough to spot a transparent background.
  const step = 4
  for (let i = 3; i < data.length; i += 4 * step) {
    if (data[i] < 255) return true
  }
  return false
}

/** Encodes a canvas; PNG ignores the quality argument. */
async function encode(
  canvas: HTMLCanvasElement,
  mime: MemeMime,
  quality?: number
): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, mime, quality)
  })
  if (!blob) throw new Error('The image could not be encoded.')
  return new Uint8Array(await blob.arrayBuffer())
}

/**
 * Compresses an uploaded image for the tray: at most 1024 px on the long
 * edge, JPEG unless the picture needs its transparency, plus a small
 * data-URL thumbnail for the tray grid.
 */
export async function compressImage(file: File): Promise<CompressedImage> {
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error('That image is larger than 25 MB.')
  }
  const bitmap = await decode(file)
  try {
    const size = scaled(bitmap.width, bitmap.height, MAX_LONG_EDGE)
    const canvas = draw(bitmap, size.width, size.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('This system cannot process images.')

    // Transparency only survives a PNG; everything else becomes a JPEG.
    const mime: MemeMime = hasTransparency(ctx, size.width, size.height) ? 'image/png' : 'image/jpeg'
    const bytes = await encode(canvas, mime, mime === 'image/png' ? undefined : JPEG_QUALITY)

    const thumbSize = scaled(bitmap.width, bitmap.height, THUMB_LONG_EDGE)
    const thumbCanvas = draw(bitmap, thumbSize.width, thumbSize.height)
    const thumb = thumbCanvas.toDataURL('image/jpeg', THUMB_QUALITY)

    return { mime, width: size.width, height: size.height, bytes, thumb }
  } finally {
    bitmap.close()
  }
}
