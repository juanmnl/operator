// Visual-verification harness — mounts a real xterm with Operator's PRODUCTION
// config and writes a "glyph battery" covering every codepoint class in the
// terminal-symbol saga, so a headless WebKit screenshot can confirm what actually
// renders (tofu vs glyph, monochrome vs colour-emoji, box-drawing continuity,
// width/alignment). Loaded by scripts/visual/index.html, captured by capture.mjs.
//
// It imports the REAL src/renderer/styles.css (so the @font-face blocks and the
// `font-variant-emoji: text` rule are the production ones, not a copy that could
// drift) and the REAL @xterm config. Keep the options below in sync with
// src/renderer/components/terminal/TerminalPane.tsx.
import '@xterm/xterm/css/xterm.css'
import '../../src/renderer/styles.css'
import { Terminal } from '@xterm/xterm'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'

// Mirror of TerminalPane.tsx fontFamily (the production fallback stack).
const FONT_FAMILY =
  "'Operator Symbols', 'Operator Dingbats', 'Operator Legacy', 'Operator Emoji', 'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, 'Apple Symbols', 'Apple Color Emoji', monospace"

const term = new Terminal({
  fontFamily: FONT_FAMILY,
  fontSize: 13,
  lineHeight: 1.2,
  fontWeight: 400,
  fontWeightBold: 600,
  drawBoldTextInBrightColors: false,
  allowProposedApi: true,
  cols: 92,
  rows: 26,
  theme: { background: '#0b0d10', foreground: '#d7d7de' },
})
term.loadAddon(new UnicodeGraphemesAddon())
term.unicode.activeVersion = '15-graphemes'
term.open(document.getElementById('term')!)

const DIM = '\x1b[38;5;245m'
const RST = '\x1b[0m'
const BOLD = '\x1b[1m'

// Each row: a dim label + the glyphs that exercise one fallback path. The label
// says which bundled font is SUPPOSED to win, so the screenshot is self-checking.
const rows: string[] = [
  `${DIM}status  (Operator Symbols/Menlo)${RST}  ⏺ ⏸ ⎿  ● ◆ ▸ ✔ ✦ ✻ ✗`,
  `${DIM}emoji   (Operator Emoji — THE FIX)${RST}  👀 👣 🐾 👋 🤔 🧠 🚀 🎯 💡 🔍 🦶 🎉`,
  `${DIM}divider (composer ornament in situ)${RST}  ──────────  👀  ──────────`,
  `${DIM}dingbat (Operator Dingbats)${RST}  ✳ ✔ ✖ ✨ ❯  ✦ ✧ ❍ ➤`,
  `${DIM}legacy  (Operator Legacy mosaics)${RST}  🮂 🮐 🯠 🯰 𜵉 𜵭  ▁▂▃▄▅▆▇█`,
  `${DIM}braille (Apple Symbols)${RST}  ⠁ ⠉ ⠿ ⡀ ⣀ ⣿ ⢿ ⠟ ⠷`,
  `${DIM}box     (SF Mono — must be continuous)${RST}`,
  `        ╭──────────────╮`,
  `        │  ${BOLD}tidy box${RST}  ✔ │`,
  `        ╰──────────────╯`,
  `${DIM}blocks  (SF Mono)${RST}  █ ▀ ▄ ▌ ▐ ░ ▒ ▓  ▰▰▱▱`,
  `${DIM}text    (SF Mono)${RST}  The quick brown fox  ${BOLD}bold emphasis${RST}  0O1lI|`,
  `${DIM}claude  (real-ish line)${RST}  ⏺ Running…  ⎿ npm test  ✔ 56 passed (5s)`,
]

term.write(rows.join('\r\n'), () => {
  // xterm has flushed its writes; now wait for the bundled @font-face files to
  // finish loading before signalling the capturer, else it screenshots tofu.
  document.fonts.ready.then(() => {
    // Give the DOM renderer one frame to repaint with the loaded fonts.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      ;(window as unknown as { __visualReady?: boolean }).__visualReady = true
    }))
  })
})
