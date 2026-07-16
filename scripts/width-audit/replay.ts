// Replay harness — writes a REAL captured Claude classic-tui byte stream through the
// PRODUCTION xterm (same addons/config/stripOrnaments as TerminalPane) and dumps the
// resulting BUFFER. If the buffer shows the garble (text overprinting a ─ rule on one
// row, merged lines), the corruption is baked in at PARSE time → a stream/width bug we
// can fix. If the buffer is clean, the garble is WKWebView DOM-compositing, not the
// buffer → a different fix. Read by scripts/width-audit/replay.mjs.
import { Terminal } from '@xterm/xterm'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import { stripOrnaments } from '../../src/renderer/lib/terminal'

const COLS = 120, ROWS = 30
const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 10000, allowProposedApi: true })
term.loadAddon(new UnicodeGraphemesAddon())
term.unicode.activeVersion = '15-graphemes'
term.open(document.getElementById('term')!)

async function run() {
  const buf = new Uint8Array(await (await fetch('./claude-stream.bin')).arrayBuffer())
  // Production path: streaming UTF-8 decode → stripOrnaments → write (see TerminalPane).
  const text = stripOrnaments(new TextDecoder().decode(buf))
  await new Promise<void>((res) => term.write(text, () => res()))

  // Dump every row of the full buffer (scrollback + viewport) as xterm sees it.
  const b = term.buffer.active
  const total = b.length
  const rows: { i: number; text: string; garbled: boolean }[] = []
  for (let i = 0; i < total; i++) {
    const line = b.getLine(i)
    if (!line) continue
    const s = line.translateToString(true)
    if (!s.trim()) continue
    // Signature of row drift: a box-rule char (─) sitting INSIDE a run of letters —
    // i.e. text was drawn on top of a rule and the gaps kept the rule. A clean row is
    // either a rule OR prose, not a letter immediately flanking a ─.
    const garbled = /[A-Za-z0-9]─|─[A-Za-z0-9]/.test(s)
    rows.push({ i, text: s, garbled })
  }
  ;(window as unknown as { __replay: unknown }).__replay = {
    cols: COLS, totalRows: total, rows, garbledCount: rows.filter((r) => r.garbled).length,
  }
  ;(window as unknown as { __replayReady: boolean }).__replayReady = true
}
void run()
