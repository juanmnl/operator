import { describe, it, expect } from 'vitest'
import { isLightBackground, stripAnsi, detectDevServerPort, findUrlAtColumn, findUrlInWrappedRows, wrappedLineText, LINK_RE, stripOrnaments, detectDevServerPorts } from './terminal'

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

  // 2026-10-24: "claude.ai/artifact/L6xd2A8XBUUCiXZFGv9qge," opened with the comma and 404'd.
  const at = (text: string, url: string) => findUrlAtColumn(text, text.indexOf(url) + 2)
  it('leaves trailing sentence punctuation out', () => {
    expect(at('open https://claude.ai/artifact/L6xd2A8XBUUCiXZFGv9qge, then', 'https://')).toBe('https://claude.ai/artifact/L6xd2A8XBUUCiXZFGv9qge')
    expect(at('It is at https://x.y/z.', 'https://')).toBe('https://x.y/z')
    expect(at('Is it https://x.y/z?', 'https://')).toBe('https://x.y/z')
    expect(at('see https://x.y/z; and', 'https://')).toBe('https://x.y/z')
    expect(at('done: https://x.y/z!', 'https://')).toBe('https://x.y/z')
    expect(at('"https://x.y/z".', 'https://')).toBe('https://x.y/z')
    expect(at('“https://x.y/z”', 'https://')).toBe('https://x.y/z')
  })
  it('keeps punctuation inside the URL', () => {
    expect(at('go https://x.y/a.b,c?d=1&e=f.g', 'https://')).toBe('https://x.y/a.b,c?d=1&e=f.g')
    expect(at('go https://x.y:8080/p#frag', 'https://')).toBe('https://x.y:8080/p#frag')
  })
  it('leaves the closing paren of prose out', () => {
    expect(at('(see https://x.y/z)', 'https://')).toBe('https://x.y/z')
    expect(at('(see https://x.y/z).', 'https://')).toBe('https://x.y/z')
    expect(at('[docs](https://x.y/z)', 'https://')).toBe('https://x.y/z')
  })
  it('leaves markdown emphasis out', () => {
    expect(at('**https://x.y**', 'https://')).toBe('https://x.y')
    // A trailing _ is kept (review L4), so underscore emphasis keeps its closing mark.
    expect(at('_https://x.y/z_', 'https://')).toBe('https://x.y/z_')
  })
  it('keeps a balanced paren group, also at the end', () => {
    expect(at('https://en.wikipedia.org/wiki/Foo_(bar)', 'https://')).toBe('https://en.wikipedia.org/wiki/Foo_(bar)')
    expect(at('(see https://en.wikipedia.org/wiki/Foo_(bar)).', 'https://')).toBe('https://en.wikipedia.org/wiki/Foo_(bar)')
    expect(at('https://x.y/a_(b)_c', 'https://')).toBe('https://x.y/a_(b)_c')
  })
  it('is one non-global rule, so the link addon can build its own copy from it', () => {
    expect(LINK_RE.flags).not.toContain('g')
    expect(() => new RegExp(LINK_RE.source, LINK_RE.flags + 'g')).not.toThrow()
  })
})

describe('findUrlInWrappedRows', () => {
  // One cell per character, as for ASCII text.
  const cells = (text: string) => [...text].map((chars) => ({ chars: chars === ' ' ? '' : chars, width: 1 }))
  // A 20-column terminal: the URL runs over three rows of one wrapped line.
  const url = 'https://example.com/a/very/long/path/x'
  const text = `see ${url}, ok`
  const rows = [cells(text.slice(0, 20)), cells(text.slice(20, 40)), cells(text.slice(40).padEnd(20))]
  it('resolves the whole URL from any row it covers', () => {
    expect(findUrlInWrappedRows(rows, 0, 6)).toBe(url)
    expect(findUrlInWrappedRows(rows, 1, 3)).toBe(url)
    expect(findUrlInWrappedRows(rows, 2, 0)).toBe(url)
  })
  it('returns null past the end of the URL', () => {
    expect(findUrlInWrappedRows(rows, 2, 3)).toBeNull()
  })
  it('reads a single unwrapped row like findUrlAtColumn', () => {
    expect(findUrlInWrappedRows([cells('go https://x.y/z, now')], 0, 5)).toBe('https://x.y/z')
  })
})

describe('wide characters in the click resolver (review L2/L3, 2026-10-25)', () => {
  // Cells as xterm lays them out: a wide character is a width-2 cell and a width-0 cell after it.
  const row = (text: string, cols: number) => {
    const out: { chars: string; width: number }[] = []
    for (const ch of text) {
      const wide = /[\u3000-\u9fff\uff00-\uffef]/.test(ch)
      out.push({ chars: ch === ' ' ? '' : ch, width: wide ? 2 : 1 })
      if (wide) out.push({ chars: '', width: 0 })
    }
    while (out.length < cols) out.push({ chars: '', width: 1 })
    return out
  }

  it('L3: maps a clicked cell after wide characters to its character', () => {
    // `日本語 ` takes columns 0-6, so the URL takes 7-19.
    const line = [row('日本語 https://x.co/ab', 20)]
    expect(findUrlInWrappedRows(line, 0, 7)).toBe('https://x.co/ab')
    expect(findUrlInWrappedRows(line, 0, 19)).toBe('https://x.co/ab')
    expect(findUrlInWrappedRows(line, 0, 5)).toBeNull() // the second half of 語
    expect(findUrlInWrappedRows(line, 0, 6)).toBeNull() // the space
  })

  it('L2: a wide character that wrapped early leaves no space in the joined text', () => {
    // 20 columns: `https://ja.x.org/w/` is 19 cells, 日 does not fit in the last one and moves down.
    const top = row('https://ja.x.org/w/', 20)
    const next = row('日本語の記事です', 20)
    expect(wrappedLineText([top, next]).text.trimEnd()).toBe('https://ja.x.org/w/日本語の記事です')
    const url = 'https://ja.x.org/w/日本語の記事です'
    expect(findUrlInWrappedRows([top, next], 0, 3)).toBe(url)
    expect(findUrlInWrappedRows([top, next], 1, 0)).toBe(url)
    expect(findUrlInWrappedRows([top, next], 1, 15)).toBe(url)
  })

  it('reads an emoji of several code units in one cell as one character', () => {
    const line = [[{ chars: '👍', width: 1 }, ...row(' https://x.co/a', 19)]]
    expect(wrappedLineText(line).at(0, 2)).toBe('👍 '.length)
    expect(findUrlInWrappedRows(line, 0, 2)).toBe('https://x.co/a')
  })
})

describe('where a URL ends in other languages, and | { } ^ inside one (review L1/L4, 2026-10-25)', () => {
  const at = (text: string) => findUrlAtColumn(text, text.indexOf('https://') + 2)
  it('L1: closing guillemets end a URL', () => {
    expect(at('el informe «https://claude.ai/artifact/abc» está listo')).toBe('https://claude.ai/artifact/abc')
    expect(at('‹https://x.com/a›')).toBe('https://x.com/a')
  })
  it('L1: CJK and fullwidth punctuation end a URL', () => {
    expect(at('詳細は https://x.com/a。次に')).toBe('https://x.com/a')
    expect(at('ver https://x.com/a，y')).toBe('https://x.com/a')
    expect(at('リンク「https://x.com/a」を')).toBe('https://x.com/a')
    expect(at('https://x.com/a、https://x.com/b')).toBe('https://x.com/a')
  })
  it('L1: a trailing ellipsis is left out', () => {
    expect(at('https://x.com/a…')).toBe('https://x.com/a')
  })
  it('L4: | { } ^ are kept inside a URL, not at its end', () => {
    expect(at('https://fonts.googleapis.com/css?family=Roboto|Open+Sans ok')).toBe('https://fonts.googleapis.com/css?family=Roboto|Open+Sans')
    expect(at('https://x.com/a{b}c^d ok')).toBe('https://x.com/a{b}c^d')
    expect(at('https://x.com/a| ok')).toBe('https://x.com/a')
    expect(at('https://x.com/a^ ok')).toBe('https://x.com/a')
  })
  it('L4: a trailing _ or ~ is kept', () => {
    expect(at('https://x.com/snake_case_ ok')).toBe('https://x.com/snake_case_')
    expect(at('https://x.com/~user/~ ok')).toBe('https://x.com/~user/~')
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
