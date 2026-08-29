import { describe, it, expect } from 'vitest'
import { isLightBackground, stripAnsi, detectDevServerPort, findUrlAtColumn, stripOrnaments, detectDevServerPorts } from './terminal'

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
  it('strips the known double-width ornaments (👀/👣) to TWO spaces', () => {
    expect(stripOrnaments('───\u{1F463}───')).toBe('───  ───')
    expect(stripOrnaments('──\u{1F440}──')).toBe('──  ──')
  })

  it('strips newer/uncovered double-width pictographs (no tofu)', () => {
    // 1FA77 (newer than some Apple Color Emoji builds) is emoji-presentation → 2 cells.
    expect(stripOrnaments('─\u{1FA77}─')).toBe('─  ─')
  })

  it('replaces each ornament with an EQUAL-WIDTH space run (the anti-drift invariant)', () => {
    // The substitution must occupy the SAME cells as the glyph, or Claude's cursor
    // math shifts and its next in-place redraw overprints the scrollback (garble).
    // These low-block tiles are width-1 in BOTH string-width and xterm (verified by
    // scripts/width-audit) — so they must become ONE space, not two. Emitting two
    // spaces here was the bug that widened the composer divider by a cell each redraw.
    expect(stripOrnaments('─\u{1F02B}─')).toBe('─ ─') // Mahjong back — width 1
    expect(stripOrnaments('─\u{1F031}─')).toBe('─ ─') // Domino tile — width 1
    expect(stripOrnaments('─\u{1F0A1}─')).toBe('─ ─') // Playing card — width 1
    expect(stripOrnaments('─\u{1F004}─')).toBe('─  ─') // Mahjong RED dragon — width 2
    // Ornamental dingbats U+1F670/1F652 are width-1 each → two of them = two spaces.
    expect(stripOrnaments('─\u{1F670}\u{1F652}─')).toBe('─  ─')
  })

  it('leaves Claude\'s structural BMP markers and box-drawing untouched', () => {
    expect(stripOrnaments('⏺ ⎿ ✳ ✔ ● ◆ ▸')).toBe('⏺ ⎿ ✳ ✔ ● ◆ ▸')
    expect(stripOrnaments('──── ← ❯')).toBe('──── ← ❯')
  })

  it('is a no-op for plain text', () => {
    expect(stripOrnaments('auto mode on (shift+tab to cycle)')).toBe('auto mode on (shift+tab to cycle)')
  })
})

const ESCAPE = String.fromCharCode(27)

describe('detectDevServerPorts — every banner, not just the first', () => {
  // Vite prints Local: and Network: on adjacent lines; an app with an API prints both on one.
  // Taking only the first match meant a lane serving two ports announced one, which undercuts
  // the picker's whole "several servers, pick one" story.
  it('finds EVERY port in the tail, in order', () => {
    const { ports } = detectDevServerPorts('', 'Local: http://localhost:5173/  API: http://localhost:4000/')
    expect(ports).toEqual([5173, 4000])
  })

  // Rails, Django, anything in Docker and `vite --host` all print 0.0.0.0. A lane serving there
  // was never attributed, so the panel fell back to the reserved port — the other half of the
  // wrong-server report.
  it('accepts 0.0.0.0 and [::] as localhost banners', () => {
    expect(detectDevServerPorts('', 'http://0.0.0.0:3000').ports).toEqual([3000])
    expect(detectDevServerPorts('', 'http://[::]:8080').ports).toEqual([8080])
  })

  it('still accepts the forms it always did', () => {
    expect(detectDevServerPorts('', 'http://127.0.0.1:1234 http://[::1]:4321').ports).toEqual([1234, 4321])
  })

  it('drops ports already known, and duplicates within one chunk', () => {
    expect(detectDevServerPorts('', 'http://localhost:5173 http://localhost:5173').ports).toEqual([5173])
    expect(detectDevServerPorts('', 'http://localhost:5173', [5173]).ports).toEqual([])
  })

  it('sees through ANSI colour, which is how these banners are actually printed', () => {
    const line = ESCAPE + '[36mhttp://localhost:5173/' + ESCAPE + '[0m'
    expect(detectDevServerPorts('', line).ports).toEqual([5173])
  })

  it('joins a URL split across two chunks via the tail', () => {
    const first = detectDevServerPorts('', 'listening on http://local')
    expect(first.ports).toEqual([])
    expect(detectDevServerPorts(first.tail, 'host:7777/').ports).toEqual([7777])
  })

  it('keeps the tail bounded at 512 chars', () => {
    expect(detectDevServerPorts('', 'x'.repeat(900)).tail).toHaveLength(512)
  })

  it('ignores a non-localhost host', () => {
    expect(detectDevServerPorts('', 'http://example.com:5173').ports).toEqual([])
  })

  // The single-port form the existing caller still uses is the same scan, first result.
  it('the legacy single-port form agrees with it', () => {
    expect(detectDevServerPort('', 'http://localhost:5173 http://localhost:4000', null).port).toBe(5173)
    expect(detectDevServerPort('', 'http://localhost:5173', 5173).port).toBeNull()
  })
})
