// Width-audit harness — proves WHERE xterm's cell-width model disagrees with
// Claude Code's string-width. A 1-cell disagreement on any glyph in Claude's TUI
// desyncs its cursor-up / line-wrap math, so its in-place status redraws land on
// the wrong row and OVERPRINT the scrollback (the permanent garble). This mounts
// the PRODUCTION xterm (same addons/version as TerminalPane) and, for a battery of
// real Claude glyphs, reads xterm's actual per-string width from the buffer and
// diffs it against string-width (Claude's algorithm). Every mismatch is a drift
// source. Read by scripts/width-audit/audit.mjs.
import { Terminal } from '@xterm/xterm'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import stringWidth from 'string-width'
// Import the REAL production stripOrnaments so this audit can't drift from it.
import { stripOrnaments } from '../../src/renderer/lib/terminal'

// Production terminal — MUST match TerminalPane's unicode setup exactly. Narrow
// cols so realistic lines actually reach the wrap boundary (where row-count drift
// would show). Tall enough that a wrapped line has somewhere to go.
const COLS = 80
const term = new Terminal({ cols: COLS, rows: 40, allowProposedApi: true })
term.loadAddon(new UnicodeGraphemesAddon())
term.unicode.activeVersion = '15-graphemes'
term.open(document.getElementById('term')!)

// xterm's width for a string = how far the cursor advances when written at col 0
// on an empty line. For strings wider than COLS this saturates; short glyphs only.
function xtermWidth(s: string): Promise<number> {
  return new Promise((res) => {
    term.write('\r\x1b[2K\x1b[H\x1b[2J', () => {
      term.write(s, () => res(term.buffer.active.cursorX))
    })
  })
}

// How many terminal ROWS xterm uses to lay out `s` (from home). This is the number
// Claude's Ink renderer must predict as ceil(stringWidth/cols) to move its cursor
// up correctly; a disagreement is the direct cause of a shifted status redraw.
function xtermRows(s: string): Promise<number> {
  return new Promise((res) => {
    term.write('\x1b[H\x1b[2J', () => {
      term.write(s, () => res(term.buffer.active.cursorY + 1))
    })
  })
}

// The battery: every glyph class Claude Code's TUI actually emits. Grouped so the
// report says which class drifts. `label` is human context; `s` is the raw glyph.
const BATTERY: { group: string; items: { s: string; label: string }[] }[] = [
  { group: 'status-markers', items: [
    { s: '⏺', label: 'U+23FA record' }, { s: '⎿', label: 'U+23BF tree' },
    { s: '●', label: 'U+25CF' }, { s: '◆', label: 'U+25C6' }, { s: '▸', label: 'U+25B8' },
    { s: '✔', label: 'U+2714' }, { s: '✗', label: 'U+2717' }, { s: '✦', label: 'U+2726' },
    { s: '✱', label: 'U+2731 spinner' }, { s: '✳', label: 'U+2733' }, { s: '✻', label: 'U+273B' },
    { s: '·', label: 'U+00B7 middot' }, { s: '…', label: 'U+2026 ellipsis' },
  ]},
  { group: 'arrows-ambiguous', items: [
    { s: '↓', label: 'U+2193 down (EAW-Ambiguous)' }, { s: '↑', label: 'U+2191 up' },
    { s: '→', label: 'U+2192 right' }, { s: '←', label: 'U+2190 left' },
    { s: '↳', label: 'U+21B3 dispatch arrow' }, { s: '⤷', label: 'U+2937' },
  ]},
  { group: 'box-drawing', items: [
    { s: '─', label: 'U+2500' }, { s: '│', label: 'U+2502' }, { s: '╭', label: 'U+256D' },
    { s: '╮', label: 'U+256E' }, { s: '╰', label: 'U+2570' }, { s: '╯', label: 'U+256F' },
  ]},
  { group: 'emoji-presentation', items: [
    { s: '👀', label: 'U+1F440 eyes' }, { s: '👣', label: 'U+1F463 footprints' },
    { s: '🚀', label: 'U+1F680' }, { s: '🧠', label: 'U+1F9E0' }, { s: '🎯', label: 'U+1F3AF' },
  ]},
  { group: 'emoji-VS16 (base+FE0F)', items: [
    { s: '▶️', label: 'U+25B6+FE0F play' }, { s: '⭐️', label: 'U+2B50+FE0F star' },
    { s: '✅', label: 'U+2705 check' }, { s: '❤️', label: 'U+2764+FE0F heart' },
    { s: '#️⃣', label: 'keycap #' }, { s: '⚡', label: 'U+26A1 bolt' },
    { s: '✨', label: 'U+2728 sparkles' }, { s: '⚠️', label: 'U+26A0+FE0F warn' },
    { s: '✔️', label: 'U+2714+FE0F check-emoji' }, { s: '✖️', label: 'U+2716+FE0F' },
  ]},
  { group: 'ornament-blocks (stripped range)', items: [
    { s: '🀄', label: 'U+1F004 mahjong red' }, { s: '🎴', label: 'U+1F3B4 flower card' },
    { s: '🃏', label: 'U+1F0CF joker' }, { s: '🁣', label: 'U+1F063 domino' },
    { s: '\u{1F02B}', label: 'U+1F02B mahjong back' }, { s: '\u{1F031}', label: 'U+1F031 domino h' },
    { s: '\u{1F0A1}', label: 'U+1F0A1 ace spades' },
  ]},
  { group: 'misc-punct', items: [
    { s: '‼', label: 'U+203C' }, { s: '⁇', label: 'U+2047 dbl-question' },
    { s: '™', label: 'U+2122' }, { s: '©', label: 'U+00A9' }, { s: '®', label: 'U+00AE' },
  ]},
]

// Realistic Claude TUI lines — including the two that garbled in the wild. Tested
// BOTH raw and post-stripOrnaments (what actually reaches xterm), for per-glyph
// width AND xterm's wrap-row count vs Claude's ceil(stringWidth/cols).
const LINES: { label: string; s: string }[] = [
  { label: 'status short', s: '✱ Slithering… (2s · ↓ 25 tokens · thinking with high effort)' },
  { label: 'status long', s: '✱ Slithering… (39s · ↓ 1.9k tokens · thinking with high effort)' },
  { label: 'tool line', s: '⏺ Bash(git log --oneline -10 && echo "---README---")' },
  { label: 'tree result', s: '  ⎿ Running…' },
  { label: 'dispatch', s: '↳ component @ src/App.tsx:42 — “Submit”' },
  { label: 'divider+ornament', s: '────────── 👀 ──────────' },
  { label: 'divider+ornament2', s: '────────── 🀄 ──────────' },
  { label: 'wrap boundary 79', s: 'x'.repeat(79) + '↓' },
  { label: 'wrap boundary 80', s: 'x'.repeat(80) + '↓' },
  { label: 'emoji at margin', s: 'x'.repeat(78) + '🚀y' },
]

async function run() {
  const rows: { group: string; label: string; s: string; cp: string; xterm: number; claude: number }[] = []
  for (const { group, items } of BATTERY) {
    for (const { s, label } of items) {
      const xw = await xtermWidth(s)
      const cw = stringWidth(s)
      rows.push({ group, label, s, cp: [...s].map((c) => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase()).join(' '), xterm: xw, claude: cw })
    }
  }
  const glyphMismatches = rows.filter((r) => r.xterm !== r.claude)

  // Ornament substitution: does replacing each stripped glyph with 2 spaces keep
  // the SAME string-width? If not, stripOrnaments itself injects the drift.
  const ornamentChecks: { s: string; cp: string; before: number; after: number }[] = []
  for (const g of ['👀', '👣', '🚀', '🀄', '🎴', '🃏', '🁣', '🧠', '🎯']) {
    ornamentChecks.push({ s: g, cp: 'U+' + g.codePointAt(0)!.toString(16).toUpperCase(), before: stringWidth(g), after: stringWidth(stripOrnaments(g)) })
  }
  const ornamentMismatches = ornamentChecks.filter((o) => o.before !== o.after)

  // Line-level: wrap-row parity (the real cursor-up input), raw AND stripped.
  const lineChecks: { label: string; variant: string; claudeW: number; xtermRows: number; claudeRows: number }[] = []
  for (const { label, s } of LINES) {
    for (const [variant, str] of [['raw', s], ['stripped', stripOrnaments(s)]] as const) {
      const cw = stringWidth(str)
      const xr = await xtermRows(str)
      lineChecks.push({ label, variant, claudeW: cw, xtermRows: xr, claudeRows: Math.max(1, Math.ceil(cw / COLS)) })
    }
  }
  const lineMismatches = lineChecks.filter((l) => l.xtermRows !== l.claudeRows)

  ;(window as unknown as { __widthAudit: unknown }).__widthAudit = {
    cols: COLS, rows, glyphMismatches, ornamentChecks, ornamentMismatches, lineChecks, lineMismatches,
  }
  ;(window as unknown as { __auditReady: boolean }).__auditReady = true
}
void run()
