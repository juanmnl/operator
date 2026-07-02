import { describe, it, expect } from 'vitest'
import { isLightBackground, stripAnsi, detectDevServerPort, findUrlAtColumn, stripOrnaments } from './terminal'

describe('isLightBackground', () => {
  it('classifies by perceived luma', () => {
    expect(isLightBackground('#ffffff')).toBe(true)
    expect(isLightBackground('#000000')).toBe(false)
    expect(isLightBackground('ffffff')).toBe(true) // hash optional
    expect(isLightBackground('#cccccc')).toBe(true)
    expect(isLightBackground('#404040')).toBe(false)
  })

  it('returns false for invalid or missing input', () => {
    expect(isLightBackground(undefined)).toBe(false)
    expect(isLightBackground('not-a-color')).toBe(false)
    expect(isLightBackground('#fff')).toBe(false) // only 6-digit accepted
  })
})

describe('stripAnsi', () => {
  it('removes CSI/SGR colour codes', () => {
    expect(stripAnsi('\x1b[36mhttp://x\x1b[0m')).toBe('http://x')
  })
  it('removes OSC sequences (BEL- and ST-terminated)', () => {
    expect(stripAnsi('\x1b]0;title\x07rest')).toBe('rest')
    expect(stripAnsi('\x1b]8;;http://x\x1b\\link')).toBe('link')
  })
  it('leaves plain text untouched', () => {
    expect(stripAnsi('plain text 123')).toBe('plain text 123')
  })
})

describe('detectDevServerPort', () => {
  it('detects a localhost port from a colorized banner', () => {
    const r = detectDevServerPort('', '  Local:  \x1b[36mhttp://localhost:5173/\x1b[0m', null)
    expect(r.port).toBe(5173)
  })

  it('matches 127.0.0.1 and IPv6 loopback forms', () => {
    expect(detectDevServerPort('', 'http://127.0.0.1:3000', null).port).toBe(3000)
    expect(detectDevServerPort('', 'http://[::1]:8080', null).port).toBe(8080)
  })

  it('stitches a URL split across two chunks via the tail', () => {
    const first = detectDevServerPort('', 'serving at http://localhost:', null)
    expect(first.port).toBeNull()
    const second = detectDevServerPort(first.tail, '4321/', null)
    expect(second.port).toBe(4321)
  })

  it('dedups against the last reported port', () => {
    expect(detectDevServerPort('', 'http://localhost:5173', 5173).port).toBeNull()
  })

  it('bounds the retained tail to 512 chars', () => {
    const big = 'x'.repeat(1000)
    expect(detectDevServerPort('', big, null).tail.length).toBe(512)
  })

  it('reports null when there is no URL', () => {
    expect(detectDevServerPort('', 'just some log output', null).port).toBeNull()
  })
})

describe('findUrlAtColumn', () => {
  const line = 'see http://example.com/a and https://b.test/x here'
  it('returns the URL whose run covers the column', () => {
    expect(findUrlAtColumn(line, 10)).toBe('http://example.com/a')
    expect(findUrlAtColumn(line, 32)).toBe('https://b.test/x')
  })
  it('returns null when the column is not on a URL', () => {
    expect(findUrlAtColumn(line, 0)).toBeNull()
    expect(findUrlAtColumn(line, 1)).toBeNull()
    expect(findUrlAtColumn('no urls here', 3)).toBeNull()
  })
})

describe('stripOrnaments', () => {
  it('strips the known composer-divider ornaments (👀/👣) to two spaces', () => {
    expect(stripOrnaments('───\u{1F463}───')).toBe('───  ───')
    expect(stripOrnaments('──\u{1F440}──')).toBe('──  ──')
  })

  it('strips newer/uncovered pictographs anywhere in the plane (no tofu)', () => {
    // 1FA77 (newer than some Apple Color Emoji builds) and 1F650–1F67F ornamental
    // dingbats (absent from Apple Color Emoji) are exactly the tofu-prone cases.
    expect(stripOrnaments('─\u{1FA77}─')).toBe('─  ─')
    expect(stripOrnaments('─\u{1F670}\u{1F652}─')).toBe('─    ─')
  })

  it('strips low-block double-width pictographs (Mahjong/Dominoes/Cards → notdef pills)', () => {
    // U+1F000–1F2FF: double-width, absent from Apple Color Emoji, below the old
    // 1F300 floor — these rendered as the two "?" pills on the composer divider.
    expect(stripOrnaments('─\u{1F02B}─')).toBe('─  ─') // Mahjong tile
    expect(stripOrnaments('─\u{1F031}─')).toBe('─  ─') // Domino tile
    expect(stripOrnaments('─\u{1F0A1}─')).toBe('─  ─') // Playing card
  })

  it('leaves Claude\'s structural BMP markers and box-drawing untouched', () => {
    expect(stripOrnaments('⏺ ⎿ ✳ ✔ ● ◆ ▸')).toBe('⏺ ⎿ ✳ ✔ ● ◆ ▸')
    expect(stripOrnaments('──── ← ❯')).toBe('──── ← ❯')
  })

  it('is a no-op for plain text', () => {
    expect(stripOrnaments('auto mode on (shift+tab to cycle)')).toBe('auto mode on (shift+tab to cycle)')
  })
})
