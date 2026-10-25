// Pure terminal-output helpers extracted from TerminalPane so the regex/parse
// logic (dev-server sniffing, URL-under-pointer) is unit-testable without xterm.
import stringWidth from 'string-width'

/** Rough perceived lightness of a #rrggbb background (WCAG luma > 140). */
export function isLightBackground(bg?: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(bg || '')
  if (!m) return false
  const n = parseInt(m[1], 16)
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
  return lum > 140
}

/** Strip OSC and CSI/SGR escape sequences so colorized banners match plainly. Not
 *  terminal-only — anything that quotes pty output into prose needs it, because raw SGR
 *  codes paint as replacement glyphs plus a literal "[1m". Don't inline it. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[[(][0-9;?]*[ -/]*[@-~]/g, '')
}

// Claude Code centers a decorative, cycling ornament on the composer divider
// (historically 👀 U+1F440 / 👣 U+1F463; newer builds cycle other pictographs, incl.
// tiles from the Mahjong/Dominoes/Cards blocks U+1F000–1F2FF). It's chrome, not
// content — and xterm's WebGL atlas (built from the browser's font rendering) falls
// any pictograph that neither the bundled subsets NOR the system Apple Color Emoji
// cover to a plain `.notdef` box — the divider tofu seen in the wild. Strip the whole
// emoji-pictograph space (U+1F000–1FAFF) on every terminal write so ANY cycled ornament
// is removed rather than tofu-ing. CRITICAL: these codepoints are NOT uniformly
// double-width — most pictographs are 2 cells, but the low tile blocks hold width-1
// glyphs (e.g. Dominoes/Cards U+1F031/1F0A1 = 1 cell in both string-width AND xterm).
// So the substitution must be width-EXACT (see ornamentSpaces), not a blanket two
// spaces — widening a width-1 divider ornament by a cell desynced Claude's cursor math
// and garbled the scrollback. Range stops BEFORE U+1FB00 so the Legacy-Computing block
// art (the Claude logo mark) is untouched, and structural TUI markers (⏺ ⎿ ✳ ✔ …, all
// BMP U+2300–2BFF) sit outside it too. Content emoji still render in the reading panel.
const ORNAMENT_RE = /[\u{1F000}-\u{1FAFF}]/gu

// The replacement MUST occupy the same number of terminal cells as the glyph it
// removes, or we shift Claude's cursor math and its next in-place redraw lands on
// the wrong row → overprinted/garbled scrollback. Most pictographs are 2 cells,
// but the range also holds width-1 glyphs (e.g. some Dominoes U+1F063 = 1 cell in
// both string-width AND xterm — see scripts/width-audit). Blindly emitting TWO
// spaces WIDENS those by a cell, which is precisely the drift we were chasing. So
// substitute each glyph's true display width in spaces, using the SAME width oracle
// (string-width) Claude Code lays out its TUI with. Memoized per codepoint — the
// ornament set is tiny and repeats, so this costs ~nothing on the hot write path.
const ornSpaces = new Map<string, string>()
function ornamentSpaces(glyph: string): string {
  let sp = ornSpaces.get(glyph)
  if (sp === undefined) { sp = ' '.repeat(stringWidth(glyph) || 1); ornSpaces.set(glyph, sp) }
  return sp
}

/** Remove Claude Code's decorative composer-divider ornaments (emoji-pictograph
 *  plane), replacing each glyph with an EQUAL-WIDTH run of spaces so Claude's
 *  cursor/wrap math (and thus its in-place status redraws) stay aligned. */
export function stripOrnaments(s: string): string {
  return s.replace(ORNAMENT_RE, ornamentSpaces)
}

/** `0.0.0.0` IS a localhost banner for this purpose, and leaving it out was half a bug.
 *  Rails, Django, anything in Docker and `vite --host` all print it; a lane serving there was
 *  never attributed, so the panel fell back to the reserved port — the other half of the
 *  wrong-server report. `[::]` is the v6 spelling of the same thing. */
const DEV_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):(\d+)/gi

/** Scan a rolling output tail for localhost dev-server URLs. Pure: takes the
 *  previous tail + the new chunk + the ports already reported, returns the newly
 *  detected ones and the next 512-char tail. The tail keeps escapes intact so a
 *  sequence split across chunks still strips.
 *
 *  ALL MATCHES, not the first. Vite prints `Local:` and `Network:` on adjacent lines and an app
 *  with an API prints both on one — taking only the first match meant a lane that serves two
 *  ports only ever announced one, which directly undercuts the picker's "several servers, pick
 *  one" story. */
export function detectDevServerPorts(
  tail: string,
  chunk: string,
  known: readonly number[] = [],
): { ports: number[]; tail: string } {
  const hay = tail + chunk
  const seen = new Set(known)
  const ports: number[] = []
  DEV_RE.lastIndex = 0
  for (const m of stripAnsi(hay).matchAll(DEV_RE)) {
    const p = parseInt(m[1], 10)
    if (p && !seen.has(p)) { seen.add(p); ports.push(p) }
  }
  return { ports, tail: hay.length > 512 ? hay.slice(-512) : hay }
}

/** The single-port form the existing caller uses. Kept so this change is additive. */
export function detectDevServerPort(
  tail: string,
  chunk: string,
  lastPort: number | null,
): { port: number | null; tail: string } {
  const { ports, tail: next } = detectDevServerPorts(tail, chunk, lastPort == null ? [] : [lastPort])
  return { port: ports[0] ?? null, tail: next }
}

// WHERE A URL ENDS, one rule for hover and click. xterm's WebLinksAddon draws the hover from its
// `urlRegex` option and TerminalPane's click resolver (used while Claude Code has mouse tracking
// on) reads `findUrlAtColumn`. Both get this, so the underline and the opened URL are the same text.
//
// Based on the addon's own `strictUrlRegex`: whitespace, straight and curly quotes, backticks, <>,
// [] and \ end a URL, and so does `*`, so markdown bold around a link is not part of it. So do the
// closing marks of prose in other languages (review L1, 2026-10-25): guillemets, as in
// «https://…» in Spanish, and CJK and fullwidth punctuation (。、，「」 and the rest), since no space
// follows a URL in Japanese or Chinese prose.
//
// A URL may not END in sentence punctuation (. , ; : ! ? …): "…/qge," in prose opened with the
// comma and 404'd (2026-10-24). | { } ^ are allowed inside a URL but not as its last character
// (review L4): Google Fonts' `family=Roboto|Open+Sans` resolves whole. A trailing _ or ~ is kept,
// since a URL can end in one; markdown `_https://x.y_` therefore keeps the closing `_`.
//
// One change from the addon: a balanced (…) group is kept, anywhere including at the end, so
// `wiki/Foo_(bar)` resolves whole while the `)` closing "(see https://x.y/z)" does not. An unmatched
// ( or ) ends the URL. One level of nesting, which is what real URLs use. Read as: any URL character
// or (…) group, repeated, then a last character that is not punctuation, or a group.
//
// Not global: the addon builds its own copy with the `g` flag added, and a source that already
// had it would throw there.
const NOT_URL = '\\s"\'`“”‘’<>()\\[\\]\\\\*«»‹›、。，．：；！？（）「」『』【】〈〉《》'
const NOT_LAST = '.,;:!?…|{}^'
export const LINK_RE = new RegExp(`https?://(?:[^${NOT_URL}]|\\([^${NOT_URL}]*\\))*(?:[^${NOT_URL}${NOT_LAST}]|\\([^${NOT_URL}]*\\))`)

/** The http(s) URL whose run covers `col` in a line of text, or null. */
export function findUrlAtColumn(text: string, col: number): string | null {
  const re = new RegExp(LINK_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (col >= m.index && col < m.index + m[0].length) return m[0]
  }
  return null
}

/** One terminal cell, as xterm's buffer gives it: its text ('' when blank) and its width in columns
 *  (2 for a wide character, 0 for the cell a wide character's second half takes). */
export interface RowCell { chars: string; width: number }

/** The text of ONE wrapped line from its rows' cells, top first, and the string index each cell
 *  starts at (review L2/L3, 2026-10-25).
 *
 *  A column is not a string index. A wide character takes two cells and one or two code units, an
 *  emoji grapheme takes one or two cells and several code units, and a blank cell is a space. And
 *  a wide character that does not fit in a row's last column moves to the next row and leaves that
 *  cell blank, which is no character of the text: read as a space, it cut the URL there while the
 *  link addon's underline, which skips it, covered all of it. Same walk as the addon's `_mapStrIdx`. */
export function wrappedLineText(rows: readonly (readonly RowCell[])[]): { text: string; at: (row: number, col: number) => number } {
  let text = ''
  const starts: number[][] = []
  rows.forEach((cells, r) => {
    const row: number[] = []
    const last = cells.length - 1
    cells.forEach((c, x) => {
      row.push(text.length)
      if (c.width === 0) { row[x] = row[x - 1] ?? text.length; return }
      // The cell a wide character left behind when it moved down.
      if (x === last && !c.chars && (rows[r + 1]?.[0]?.width ?? 0) === 2) return
      text += c.chars || ' '
    })
    starts.push(row)
  })
  return { text, at: (row, col) => starts[row]?.[col] ?? -1 }
}

/** The URL under (`row`, `col`), a cell, when a long line wraps across terminal rows: `rows` are the
 *  cells of each row of ONE wrapped line, top first. A URL longer than the terminal is wide is
 *  split over rows, and reading only the clicked row opened the part of it on that row. */
export function findUrlInWrappedRows(rows: readonly (readonly RowCell[])[], row: number, col: number): string | null {
  const { text, at } = wrappedLineText(rows)
  const i = at(row, col)
  return i < 0 ? null : findUrlAtColumn(text, i)
}
