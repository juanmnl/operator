// Shared xterm construction options, so the live TerminalPane and the headless
// verification harnesses (scripts/visual, scripts/input) build the SAME terminal
// and can't drift. App-specific bits that need window.operator (linkHandler) stay
// in TerminalPane; everything font/behavior lives here.
import type { ITerminalOptions, ITheme } from '@xterm/xterm'
import { isLightBackground } from './terminal'

// Four bundled subsets go FIRST (see styles.css @font-face), supplying monochrome
// glyphs no usable macOS font reaches, so they don't fall to a colour double-width
// emoji or the LastResort "tofu" box: 'Operator Symbols' (Misc-Technical/geometric
// markers ⏺⏸⎿), 'Operator Dingbats' (welcome-box studs ✳✔✖✨), 'Operator Legacy'
// (Symbols-for-Legacy-Computing mosaics), 'Operator Emoji' (the whole pictograph
// plane U+1F300–1FAFF — composer-divider ornaments like 👣/👀). These carry no
// letters, so SF Mono still wins for text; 'Apple Symbols' covers Braille (U+28xx).
export const TERMINAL_FONT_FAMILY =
  "'Operator Symbols', 'Operator Dingbats', 'Operator Legacy', 'Operator Emoji', 'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, 'Apple Symbols', 'Apple Color Emoji', monospace"

const OPTION_IS_META_KEY = 'operator.terminal.macOptionIsMeta'

/** Whether ⌥ acts as Meta/Alt (sends ESC sequences) instead of composing
 *  characters (⌥e→é). Default false so international/accented input works like a
 *  normal Mac terminal; opt-in for readline/emacs users who want Alt-as-Meta. */
export function getMacOptionIsMeta(): boolean {
  try {
    return localStorage.getItem(OPTION_IS_META_KEY) === 'true'
  } catch {
    return false
  }
}

export function setMacOptionIsMeta(on: boolean): void {
  try {
    localStorage.setItem(OPTION_IS_META_KEY, on ? 'true' : 'false')
  } catch {
    /* ignore */
  }
}

export function buildTerminalOptions(
  theme: ITheme,
  opts: { macOptionIsMeta?: boolean } = {},
): ITerminalOptions {
  return {
    theme,
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: 13,
    // 1.2 gives breathing room; xterm rounds the cell to an integer device pixel.
    lineHeight: 1.2,
    // Real SF Mono weights under the DOM renderer; 600 keeps bold distinct as
    // weight only (no bright-colour shift).
    fontWeight: 400,
    fontWeightBold: 600,
    drawBoldTextInBrightColors: false,
    cursorBlink: true,
    cursorStyle: 'bar',
    allowProposedApi: true,
    macOptionIsMeta: opts.macOptionIsMeta ?? getMacOptionIsMeta(),
    scrollback: 10000,
    // Lift dim secondary text to AA on light backgrounds only; on dark the DOM
    // renderer shows true alpha and any lift just whitens it.
    minimumContrastRatio: isLightBackground(theme.background) ? 4.5 : 1,
  }
}
