/**
 * Generates the Windows app icon (build/icon.ico) from scratch: an indigo
 * rounded square with a white "Q" ring and tail. No image libraries needed -
 * the PNG is encoded by hand and embedded in the ICO container.
 */
const zlib = require('node:zlib')
const fs = require('node:fs')
const path = require('node:path')

function crc32(buf) {
  let c
  let crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const INDIGO = [99, 102, 241, 255]
const INDIGO_DEEP = [79, 70, 229, 255]
const WHITE = [255, 255, 255, 255]

class Canvas {
  constructor(w, h) {
    this.w = w
    this.h = h
    this.data = Buffer.alloc(w * h * 4)
  }
  set(x, y, c) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const i = (y * this.w + x) * 4
    this.data[i] = c[0]
    this.data[i + 1] = c[1]
    this.data[i + 2] = c[2]
    this.data[i + 3] = c[3]
  }
  /** A rounded square covering the whole canvas. */
  roundedSquare(radius, color) {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const dx = Math.max(radius - x, x - (this.w - 1 - radius), 0)
        const dy = Math.max(radius - y, y - (this.h - 1 - radius), 0)
        if (dx * dx + dy * dy <= radius * radius) this.set(x, y, color)
      }
    }
  }
  ellipse(cx, cy, rx, ry, color) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x - cx) / rx
        const dy = (y - cy) / ry
        if (dx * dx + dy * dy <= 1) this.set(x, y, color)
      }
    }
  }
  /** A thick diagonal stroke, used for the tail of the Q. */
  stroke(x0, y0, x1, y1, width, color) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
    for (let s = 0; s <= steps; s++) {
      const t = steps === 0 ? 0 : s / steps
      const cx = x0 + (x1 - x0) * t
      const cy = y0 + (y1 - y0) * t
      this.ellipse(cx, cy, width / 2, width / 2, color)
    }
  }
  toPng() {
    return encodePng(this.w, this.h, this.data)
  }
}

function makeIcon(size) {
  const c = new Canvas(size, size)
  c.roundedSquare(size * 0.22, INDIGO)
  // A slightly deeper bottom edge, for a hint of depth.
  for (let y = Math.floor(size * 0.72); y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (c.data[(y * size + x) * 4 + 3] === 255) c.set(x, y, INDIGO_DEEP)
    }
  }
  // The Q: a white ring with a tail.
  const cx = size * 0.48
  const cy = size * 0.46
  const r = size * 0.26
  const ring = size * 0.085
  c.ellipse(cx, cy, r, r, WHITE)
  c.ellipse(cx, cy, r - ring, r - ring, INDIGO)
  c.stroke(cx + r * 0.55, cy + r * 0.55, cx + r * 1.12, cy + r * 1.12, ring, WHITE)
  return c.toPng()
}

function buildIco(sizes) {
  const images = sizes.map((size) => ({ size, png: makeIcon(size) }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)
  const entries = []
  let offset = 6 + images.length * 16
  for (const img of images) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(img.size >= 256 ? 0 : img.size, 0) // width (0 means 256)
    entry.writeUInt8(img.size >= 256 ? 0 : img.size, 1) // height
    entry.writeUInt8(0, 2) // palette size
    entry.writeUInt8(0, 3) // reserved
    entry.writeUInt16LE(1, 4) // color planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(img.png.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += img.png.length
    entries.push(entry)
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)])
}

const target = process.argv[2] || path.join(process.cwd(), 'build', 'icon.ico')
fs.mkdirSync(path.dirname(target), { recursive: true })
const ico = buildIco([16, 32, 48, 64, 128, 256])
fs.writeFileSync(target, ico)
console.log(`wrote ${target} (${ico.length} bytes)`)
