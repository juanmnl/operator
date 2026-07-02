// Pure terminal-output helpers extracted from TerminalPane so the regex/parse
// logic (dev-server sniffing, URL-under-pointer) is unit-testable without xterm.

/** Rough perceived lightness of a #rrggbb background (WCAG luma > 140). */
export function isLightBackground(bg?: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(bg || '')
  if (!m) return false
  const n = parseInt(m[1], 16)
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
  return lum > 140
}

/** Strip OSC and CSI/SGR escape sequences so colorized banners match plainly. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[[(][0-9;?]*[ -/]*[@-~]/g, '')
}

// Claude Code centers a decorative, cycling ornament on the composer divider
// (historically 👀 U+1F440 / 👣 U+1F463; newer builds cycle other pictographs). It's
// chrome, not content — and ghostty's Canvas-2D renderer falls any pictograph that
// neither the bundled subsets NOR the system Apple Color Emoji cover to a LastResort
// "tofu" box (the two ⍰ seen on the divider). Strip the whole emoji-pictograph plane
// on every terminal write so ANY cycled ornament is removed rather than tofu-ing.
// These codepoints are double-width, so replace each with TWO spaces to keep Claude's
// cursor math aligned. Structural TUI markers (⏺ ⎿ ✳ ✔ …, all BMP U+2300–2BFF) sit
// OUTSIDE this range and are untouched; content emoji still render in the reading panel.
const ORNAMENT_RE = /[\u{1F300}-\u{1FAFF}]/gu

/** Remove Claude Code's decorative composer-divider ornaments (emoji-pictograph
 *  plane), replacing each double-width glyph with two spaces to preserve alignment. */
export function stripOrnaments(s: string): string {
  return s.replace(ORNAMENT_RE, '  ')
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
