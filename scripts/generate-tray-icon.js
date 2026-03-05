// Generate a proper PNG tray icon for macOS
const zlib = require('zlib')
const fs = require('fs')
const path = require('path')

function createPNG(width, height, drawFn) {
  // Raw RGBA pixel data with filter byte per row
  const raw = Buffer.alloc((width * 4 + 1) * height, 0)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const rgba = drawFn(x, y, width, height)
      const offset = y * (width * 4 + 1) + 1 + x * 4
      raw[offset] = rgba[0]
      raw[offset + 1] = rgba[1]
      raw[offset + 2] = rgba[2]
      raw[offset + 3] = rgba[3]
    }
  }

  const compressed = zlib.deflateSync(raw)

  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

  // IHDR
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 6  // color type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  const chunks = [
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]

  return Buffer.concat([sig, ...chunks])
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeB = Buffer.from(type, 'ascii')
  const crcData = Buffer.concat([typeB, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(crcData), 0)
  return Buffer.concat([len, typeB, data, crc])
}

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

// Draw the operator logo: three rounded horizontal bars
function drawLogo(x, y, w, h) {
  const bars = [
    { y: 0.15, h: 0.20, x: 0.10, w: 0.80, opacity: 1.0 },
    { y: 0.42, h: 0.20, x: 0.32, w: 0.58, opacity: 0.5 },
    { y: 0.69, h: 0.20, x: 0.32, w: 0.58, opacity: 0.3 },
  ]

  const nx = x / w
  const ny = y / h

  for (const bar of bars) {
    const bx1 = bar.x
    const bx2 = bar.x + bar.w
    const by1 = bar.y
    const by2 = bar.y + bar.h
    const r = bar.h / 2

    if (nx >= bx1 && nx <= bx2 && ny >= by1 && ny <= by2) {
      // Check rounded ends
      const midY = (by1 + by2) / 2
      const dy = ny - midY
      const rNorm = r

      if (nx < bx1 + rNorm) {
        const cx = bx1 + rNorm
        const dx = nx - cx
        if (dx * dx + dy * dy > rNorm * rNorm) continue
      }
      if (nx > bx2 - rNorm) {
        const cx = bx2 - rNorm
        const dx = nx - cx
        if (dx * dx + dy * dy > rNorm * rNorm) continue
      }

      const alpha = Math.round(255 * bar.opacity)
      return [0, 0, 0, alpha]
    }
  }

  return [0, 0, 0, 0]
}

const assetsDir = path.join(__dirname, '..', 'assets')

// 16x16 for 1x
const png16 = createPNG(16, 16, drawLogo)
fs.writeFileSync(path.join(assetsDir, 'trayTemplate.png'), png16)

// 32x32 for 2x
const png32 = createPNG(32, 32, drawLogo)
fs.writeFileSync(path.join(assetsDir, 'trayTemplate@2x.png'), png32)

// Light version of logo for dark backgrounds (widget avatar)
function drawLogoLight(x, y, w, h) {
  const result = drawLogo(x, y, w, h)
  if (result[3] > 0) {
    return [255, 255, 255, result[3]]
  }
  return result
}

const png64 = createPNG(64, 64, drawLogoLight)
fs.writeFileSync(path.join(assetsDir, 'logo-light-64.png'), png64)

console.log('Tray icons and light logo generated.')
