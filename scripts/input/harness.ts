// Input-verification harness. Mounts a real xterm with the PRODUCTION terminal
// options and the SAME key-routing + IME-composition wiring as TerminalPane, then
// records every onData chunk (what would be sent to the pty) into
// window.__inputRecorded. capture.mjs drives real keyboard/IME/chord/paste events
// through a headless WebKit and asserts the recorded byte stream.
import '@xterm/xterm/css/xterm.css'
import '../../src/renderer/styles.css'
import { Terminal } from '@xterm/xterm'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import { buildTerminalOptions } from '../../src/renderer/lib/terminal-options'
import { isAppChord } from '../../src/renderer/lib/key-routing'

const recorded: string[] = []
const w = window as unknown as {
  __inputRecorded: string[]
  __inputReset: () => void
  __inputReady?: boolean
}
w.__inputRecorded = recorded
w.__inputReset = () => {
  recorded.length = 0
}

// macOptionIsMeta defaults to false here (fresh localStorage), matching the new
// production default — so ⌥ composes rather than sending Meta.
const term = new Terminal(buildTerminalOptions({ background: '#0b0d10', foreground: '#d7d7de' }))
term.loadAddon(new UnicodeGraphemesAddon())
term.unicode.activeVersion = '15-graphemes'
term.open(document.getElementById('term')!)

// Mirror TerminalPane's IME guard + key routing exactly.
let composing = false
const ta = term.textarea
ta?.addEventListener('compositionstart', () => { composing = true })
ta?.addEventListener('compositionend', () => { composing = false })
term.attachCustomKeyEventHandler((e) => {
  if (composing) return true
  if (e.type === 'keydown' && e.metaKey && isAppChord(e)) return false
  return true
})

term.onData((d) => recorded.push(d))

term.focus()
document.fonts.ready.then(() => {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    term.focus()
    w.__inputReady = true
  }))
})
