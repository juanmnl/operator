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

/** Strip OSC and CSI/SGR escape sequences so colorized banners match plainly.
 *  Also used by the CHAT surface (CanvasConversation): terminal output quoted in an answer
 *  arrives with raw SGR codes, and a canvas renderer has no notion of escape sequences —
 *  they paint as replacement glyphs plus a literal "[1m". Not terminal-only; don't inline it. */
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

const DEV_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/i

/** Scan a rolling output tail for a localhost dev-server URL. Pure: takes the
 *  previous tail + the new chunk + the last reported port, returns the newly
 *  detected port (null if none or a duplicate) and the next 512-char tail. The
 *  tail keeps escapes intact so a sequence split across chunks still strips. */
export function detectDevServerPort(
  tail: string,
  chunk: string,
  lastPort: number | null,
): { port: number | null; tail: string } {
  const hay = tail + chunk
  let port: number | null = null
  const m = DEV_RE.exec(stripAnsi(hay))
  if (m) {
    const p = parseInt(m[1], 10)
    if (p && p !== lastPort) port = p
  }
  return { port, tail: hay.length > 512 ? hay.slice(-512) : hay }
}

const URL_RE = /(https?:\/\/[^\s'"`<>()\[\]]+)/g

/** The http(s) URL whose run covers `col` in a line of text, or null. */
export function findUrlAtColumn(text: string, col: number): string | null {
  URL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = URL_RE.exec(text))) {
    if (col >= m.index && col < m.index + m[0].length) return m[0]
  }
  return null
}
