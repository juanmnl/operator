// THROWAWAY spike (2026-08-04 terminal-research-v2). NOT product code — proves/disproves
// whether the WebGL or canvas addon renders Claude's TUI cleanly in Playwright's WebKit today.
// Mounts the SAME production font/unicode config as TerminalPane, picks a renderer addon from
// `?renderer=dom|webgl|canvas`, then replays a pattern that mimics the actual failure trigger
// recorded in git history: repeated in-place status-line rewrites via cursor-up + overwrite
// (Claude's ticking spinner/elapsed-timer), not just one static write.
import '@xterm/xterm/css/xterm.css'
import '../../src/renderer/styles.css'
import { Terminal } from '@xterm/xterm'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'

const FONT_FAMILY =
  "'Operator Symbols', 'Operator Dingbats', 'Operator Legacy', 'Operator Emoji', 'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, 'Apple Symbols', 'Apple Color Emoji', monospace"

const params = new URLSearchParams(location.search)
const renderer = params.get('renderer') || 'dom'

const term = new Terminal({
  fontFamily: FONT_FAMILY,
  fontSize: 13,
  lineHeight: 1.2,
  fontWeight: 400,
  fontWeightBold: 600,
  drawBoldTextInBrightColors: false,
  allowProposedApi: true,
  cols: 92,
  rows: 30,
  theme: { background: '#0b0d10', foreground: '#d7d7de' },
})
term.loadAddon(new UnicodeGraphemesAddon())
term.unicode.activeVersion = '15-graphemes'
term.open(document.getElementById('term')!)

let addonLoaded = renderer
;(async () => {
  try {
    if (renderer === 'webgl') {
      const { WebglAddon } = await import('@xterm/addon-webgl')
      const addon = new WebglAddon()
      addon.onContextLoss(() => { addonLoaded = 'webgl-context-lost'; term.write('\r\n[WEBGL CONTEXT LOST]\r\n') })
      term.loadAddon(addon)
    } else if (renderer === 'canvas') {
      // @xterm/addon-canvas@0.8.0-beta.48's package.json module/exports field is still
      // broken as of 2026-08-04 (confirmed live: Vite's import-analysis 500s trying to
      // resolve its entry) — the same brokenness the 2026-06-16 vendoring commit noted.
      // No fixed/stable release exists to test against without re-doing that vendor
      // workaround, so this path is intentionally left unexercised here.
      addonLoaded = 'canvas-package-broken-untested'
    }
  } catch (e) {
    addonLoaded = 'load-failed'
    term.write(`\r\n[ADDON LOAD FAILED: ${String(e)}]\r\n`)
  }

  // Fill scrollback with box-drawn tool-call blocks (realistic TUI content).
  for (let i = 0; i < 40; i++) {
    term.write(`\x1b[38;5;245m⏺\x1b[0m Bash(npm test -- suite-${i})\r\n`)
    term.write(`  ⎿  Running…\r\n`)
  }

  // Now the actual trigger from git history: an in-place status line that gets
  // rewritten ~30 times via cursor-up + redraw at a shorter/longer length each
  // time (the "ticking elapsed-timer/token-count" pattern), while box-drawn
  // content and emoji sit just above and below it — the same layout git history
  // says corrupted WebGL wholesale in real long sessions.
  const box = ['╭──────────────╮', '│  tidy box  ✔ │', '╰──────────────╯']
  term.write(box.join('\r\n') + '\r\n')
  term.write('──────────  👀  ──────────\r\n')
  term.write('\n') // spacer row the status line will occupy

  for (let n = 0; n < 30; n++) {
    const secs = n + 1
    const tokens = (n * 37) % 999
    const line = `✳ Slithering… (${secs}s · ↓ ${tokens} tokens · thinking with high effort)`
    // cursor up 1, clear line, redraw — exactly Claude's in-place status redraw.
    term.write(`\x1b[1A\x1b[2K${line}\r\n`)
  }
  term.write('\r\n✔ 56 passed (5s)\r\n')

  await new Promise((r) => setTimeout(r, 50))
  ;(window as unknown as { __rendererSpikeMode?: string }).__rendererSpikeMode = addonLoaded
  document.fonts.ready.then(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      ;(window as unknown as { __rendererSpikeReady?: boolean }).__rendererSpikeReady = true
    }))
  })
})()
