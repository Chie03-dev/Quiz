/**
 * Pure geometry for the deterministic avatar. Returning SVG path `d` strings
 * (rather than JSX) keeps the drawing logic out of React so it is unit-testable
 * on its own and trivially mirrored by the Android client.
 *
 * The coordinate space is a 64x80 viewBox: the head is centred at (32, 36)
 * with roughly an 32x40 box. Eyes sit around y=30, mouth around y=46.
 */

export type FaceShape = 'round' | 'soft' | 'oval' | 'square' | 'heart' | 'diamond' | 'blob'
export type EyesShape = 'none' | 'closed' | 'open' | 'wink' | 'happy' | 'squint' | 'up' | 'half' | 'wide' | 'sparkle'
export type MouthShape = 'none' | 'smile' | 'grin' | 'laughing' | 'sad' | 'neutral' | 'kiss' | 'surprised'
export type AccessoryShape = 'none' | 'glasses' | 'sunglasses' | 'hat' | 'cap' | 'headband'

/** An `M ... z` ellipse centred at (cx, cy). */
export function ellipse(cx: number, cy: number, rx: number, ry: number): string {
  return `M ${cx - rx} ${cy} a ${rx} ${ry} 0 1 0 ${rx * 2} 0 a ${rx} ${ry} 0 1 0 ${-rx * 2} 0 z`
}

/** A rounded rect: (cx, cy) is centre, w x h, r is corner radius. */
export function roundRect(cx: number, cy: number, w: number, h: number, r: number): string {
  const x = cx - w / 2
  const y = cy - h / 2
  return `
    M ${x + r} ${y}
    h ${w - 2 * r}
    a ${r} ${r} 0 0 1 ${r} ${r}
    v ${h - 2 * r}
    a ${r} ${r} 0 0 1 ${-r} ${r}
    h ${-(w - 2 * r)}
    a ${r} ${r} 0 0 1 ${-r} ${-r}
    v ${-(h - 2 * r)}
    a ${r} ${r} 0 0 1 ${r} ${-r}
    z
  `.replace(/\s+/g, ' ')
}

interface Parts {
  faceShape: FaceShape
  eyeShape: EyesShape
  mouthShape: MouthShape
  accessoryShape: AccessoryShape
  skin: string
  hair: string
  rng: () => number
}

type DrawFn = (parts: Parts) => string

const FACE_CX = 32
const FACE_CY = 36
const FACE_RX = 15.5
const FACE_RY = 20

export function facePath(shape: FaceShape, rng: () => number): string {
  const cx = FACE_CX + (rng() - 0.5) * 1.6
  const cy = FACE_CY + (rng() - 0.5) * 1.6
  const rx = FACE_RX + (rng() - 0.5) * 1.4
  const ry = FACE_RY + (rng() - 0.5) * 2
  switch (shape) {
    case 'soft':
      return roundRect(cx, cy, rx * 2, ry * 2, 22)
    case 'oval':
      return ellipse(cx, cy, rx, ry + 2)
    case 'square':
      return roundRect(cx, cy, rx * 2, ry * 2, 2)
    case 'heart':
      return heart(cx, cy, rx, ry)
    case 'diamond':
      return diamond(cx, cy, rx, ry)
    case 'blob':
      return blob(cx, cy, rx, ry)
    default:
      return ellipse(cx, cy, rx, ry)
  }
}

function heart(cx: number, cy: number, rx: number, ry: number): string {
  const w = rx * 0.6
  return `
    M ${cx} ${cy + ry * 0.6}
    c ${-w} ${-w - ry} ${-w * 2} ${ry * 0.2} ${0} ${-ry * 1.2}
    a ${w} ${w} 0 1 1 ${w * 2} 0
    c ${0} ${ry * 1.1} ${-w} ${ry * 0.9} 0 ${ry * 1.2} z
  `.replace(/\s+/g, ' ')
}

function diamond(cx: number, cy: number, rx: number, ry: number): string {
  return `M ${cx} ${cy - ry} l ${rx} ${ry} 0 ${ry} l ${-rx} ${ry} l ${-rx} ${-ry} 0 ${-ry} z`
}

function blob(cx: number, cy: number, rx: number, ry: number): string {
  return `
    M ${cx - rx} ${cy}
    c ${rx * 0.4} ${-ry * 0.6} ${rx * 0.9} ${-ry * 0.2} ${rx} ${-ry * 0.3}
    c ${rx * 0.1} ${ry * 0.4} ${rx * 0.1} ${ry * 0.8} 0 ${ry * 1.3}
    c ${-rx * 0.4} ${ry * 0.2} ${-rx * 0.9} ${ry * 0.4} ${-rx} ${ry * 0.3}
    c ${-rx * 0.1} ${-ry * 0.4} ${-rx * 0.1} ${-ry * 0.8} 0 ${-ry * 1.3} z
  `.replace(/\s+/g, ' ')
}

/** Both eyes drawn together, or '' when the shape is 'none'. */
export function eyesPath(shape: EyesShape, rng: () => number): string {
  if (shape === 'none') return ''
  const lx = 23 + (rng() - 0.5) * 1.6
  const rx = 41 + (rng() - 0.5) * 1.6
  const cy = 30 + (rng() - 0.5) * 0.8
  const f = 0.8 + rng() * 0.4
  const lOpen = 0.4 + f * 0.6
  const rOpen = 0.4 + f * 0.6
  switch (shape) {
    case 'closed':
      return line(lx, cy, rx, cy, 0.8)
    case 'open':
      return pair(ellipse(lx, cy, 3.2, lOpen), ellipse(rx, cy, 3.2, rOpen))
    case 'wink':
      return pair(ellipse(lx, cy, 3.2, lOpen), line(rx - 3, cy, rx + 3, cy, 1))
    case 'happy':
      return pair(ellipse(lx, cy, 2.8, lOpen * 1.3), ellipse(rx, cy, 2.8, rOpen * 1.3))
    case 'squint':
      return pair(ellipse(lx, cy, 3.4, lOpen * 0.55), ellipse(rx, cy, 3.4, rOpen * 0.55))
    case 'wide':
      return pair(ellipse(lx, cy, 3.6, lOpen * 1.7), ellipse(rx, cy, 3.6, rOpen * 1.7))
    case 'half':
      return pair(upperHalf(lx, cy, 3.4, lOpen), upperHalf(rx, cy, 3.4, rOpen))
    case 'up':
      return pair(ellipse(lx, cy - 1.5, 2.6, lOpen), ellipse(rx, cy - 1.5, 2.6, rOpen))
    case 'sparkle':
      return pair(ellipse(lx, cy, 3, lOpen), ellipse(rx, cy, 3, rOpen)) + sparkle(lx, cy, rx)
    default:
      return ''
  }
}

function upperHalf(cx: number, cy: number, rx: number, ry: number): string {
  const p = ellipse(cx, cy, rx, ry)
  return p.replace(/z$/, ` L ${cx + rx} ${cy} L ${cx - rx} ${cy} z`)
}

function sparkle(lx: number, cy: number, rx: number): string {
  return ` M ${lx - 6} ${cy - 4} l 3 3 m -3 0 l 0 3 m 3 -3 l 3 -3 m 3 3 l 3 3 m 0 3 l 3 3 m -3 3 l 0 3 m -3 0 l -3 3 m -3-3 l -3 3 m -3-3 l -3-3 m 0-3 z`
}

function pair(...paths: string[]): string {
  return paths.join(' ')
}

function line(x1: number, y1: number, x2: number, y2: number, sw: number): string {
  const r = sw / 2
  const a = Math.atan2(y2 - y1, x2 - x1)
  const dx = Math.sin(a) * r
  const dy = Math.cos(a) * r
  return `M ${x1 + dx} ${y1 - dy} L ${x2 + dx} ${y2 - dy} L ${x2 - dx} ${y2 + dy} L ${x1 - dx} ${y1 + dy} z`
}

/** The mouth drawn as a single closed path. */
export function mouthPath(shape: MouthShape, rng: () => number): string {
  if (shape === 'none') return ''
  const cx = 32 + (rng() - 0.5) * 1.4
  const cy = 46 + (rng() - 0.5) * 0.8
  const w = 7 + rng() * 2
  switch (shape) {
    case 'smile':
      return bezierSmile(cx, cy, w, 3.2)
    case 'grin':
      return bezierSmile(cx, cy, w, 5)
    case 'laughing':
      return bezierSmile(cx, cy, w, 6.5)
    case 'sad':
      return bezierSmile(cx, cy, w, -3.2)
    case 'neutral':
      return line(cx - w, cy, cx + w, cy, 1.4)
    case 'kiss':
      return pair(line(cx - w, cy, cx + w, cy, 1.2), kiss(cx, cy))
    case 'surprised':
      return ellipse(cx, cy, w * 0.5, 2.2)
    default:
      return ''
  }
}

function bezierSmile(cx: number, cy: number, w: number, d: number): string {
  const c = Math.abs(d) * 0.55
  if (d >= 0) {
    return `M ${cx - w} ${cy} c ${c} ${d} ${w - c} ${d} ${w} 0`
  }
  return `M ${cx - w} ${cy} c ${c} ${d} ${w - c} ${d} ${w} 0`
}

function kiss(cx: number, cy: number): string {
  const ly = cy - 2.8
  return pair(ellipse(cx - 2.2, ly, 1.2, 1.6), ellipse(cx + 2.2, ly, 1.2, 1.6))
}

/** The accessory drawn as a single closed path. */
export function accessoryPath(shape: AccessoryShape, rng: () => number): string {
  const cx = 32
  switch (shape) {
    case 'glasses':
      return glasses(cx + 3.5, 28, cx - 3.5, 28)
    case 'sunglasses':
      return sunglasses(cx + 5.5, 28.5, cx - 5.5, 28.5)
    case 'hat':
      return hat(cx, 12)
    case 'cap': {
      const size = 16 + rng() * 3
      return cap(cx, 12, size)
    }
    case 'headband':
      return line(cx - 20, 10, cx + 20, 10, 2.6)
    default:
      return ''
  }
}

/** Reading glasses: two circles joined by a bridge. */
function glasses(rx: number, ry: number, lx: number, ly: number): string {
  const r = 5.2
  return pair(circle(rx, ry, r), circle(lx, ly, r), `M ${lx + r} ${ly} H ${rx - r}`)
}

/** Sunglasses: two circles joined by a nose bridge. */
function sunglasses(rx: number, ry: number, lx: number, ly: number): string {
  const r = 5.6
  return pair(circle(rx, ry, r), circle(lx, ly, r), `M ${lx + r} ${ly} H ${rx - r}`)
}

function circle(cx: number, cy: number, r: number): string {
  return `M ${cx} ${cy - r} a ${r} ${r} 0 1 1 ${-0.1} 0 a ${r} ${r} 0 1 1 0.1 0 z`
}

function hat(cx: number, cy: number): string {
  const w = 36
  const h = 6
  return pair(
    roundRect(cx, cy, w, h, 3),
    `M ${cx - w / 2 + 4} ${cy} L ${cx} ${cy + 14} L ${cx + w / 2 - 4} ${cy} z`
  )
}

function cap(cx: number, cy: number, size: number): string {
  return `M ${cx - size} ${cy} C ${cx - size} ${cy - 10} ${cx + size} ${cy - 10} ${cx + size} ${cy} A ${size} ${size * 1.2} 0 0 1 ${cx - size} ${cy} z`
}
