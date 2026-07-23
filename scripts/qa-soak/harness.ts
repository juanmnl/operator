// THROWAWAY diagnostic harness — not committed, not part of the app. Copies
// TerminalPane.tsx's exact repaint/heal closures (forceRepaint / hardRepaint /
// scheduleRepaint / healInterval, verbatim logic as of the uncommitted diff)
// around a real xterm instance, then drives continuous ticking output so the
// 1Hz heal interval's sub-pixel translate3d(0, 0.02px, 0) nudge fires
// repeatedly against a REAL WebKit compositor. soak.mjs screenshot-loops this
// page and diffs frames to check for visible flicker/pulse.
import '@xterm/xterm/css/xterm.css'
import '../../src/renderer/styles.css'
import { Terminal } from '@xterm/xterm'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'

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

// --- Static reference content (never rewritten) so a flicker in these rows can
// ONLY come from the repaint/heal mechanism, never from legitimate new output. ---
const STATIC_ROWS = [
  '╭──────────────────────────────────────────────────────────╮',
  '│  static reference row — must NEVER visibly change  ✔     │',
  '│  The quick brown fox jumps over the lazy dog  0O1lI|      │',
  '│  ──────────  divider ornament  👀  ──────────             │',
  '╰──────────────────────────────────────────────────────────╯',
  '',
]
term.write(STATIC_ROWS.join('\r\n') + '\r\n\r\n')

// --- Copied verbatim (mechanism, not React) from TerminalPane.tsx's uncommitted diff ---
let activeRef = true
let lastDataAtRef = 0
let lastRefreshAtRef = 0
let refreshTimerRef: number | undefined
let termRefCurrent: Terminal | null = term

const forceRepaint = () => {
  if (!activeRef) return
  try { term.refresh(0, term.rows - 1) } catch { /* disposed */ }
}
// A/B switch (throwaway diagnostic only): ?variant=old replays the PREVIOUSLY
// shipped no-op translateZ(0) nudge; default/anything else is the new
// non-identity sub-pixel translate3d, to isolate whether the new value is
// what's causing any observed transient, vs. term.refresh() alone.
const variant = new URLSearchParams(location.search).get('variant') || 'new'
const NUDGE = variant === 'old' ? 'translateZ(0)' : 'translate3d(0, 0.02px, 0)'
const hardRepaint = () => {
  if (!activeRef) return
  try {
    term.refresh(0, term.rows - 1)
    if (variant === 'none') return // isolates term.refresh()'s own AA jitter, no transform at all
    const el = term.element as HTMLElement | null
    if (el) {
      el.style.transform = NUDGE
      requestAnimationFrame(() => { if (termRefCurrent === term) el.style.transform = '' })
    }
  } catch { /* disposed */ }
}
const scheduleRepaint = () => {
  const now = Date.now()
  if (now - lastRefreshAtRef > 180) {
    lastRefreshAtRef = now
    forceRepaint()
  }
  if (refreshTimerRef) clearTimeout(refreshTimerRef)
  refreshTimerRef = window.setTimeout(() => {
    lastRefreshAtRef = Date.now()
    hardRepaint()
  }, 90)
}
const healInterval = window.setInterval(() => {
  if (Date.now() - lastDataAtRef < 6000) hardRepaint()
}, 1000)
;(window as unknown as { __healInterval?: number }).__healInterval = healInterval

// --- Drive continuous ticking output: spinner + elapsed timer in place, on a
// FIXED row below the static block — mirrors garble-triage.md's described
// trigger ("a real multi-second running tool call, ticking its elapsed-timer/
// token count in place"). This keeps lastDataAtRef recent so the heal interval
// keeps firing hardRepaint every second for the whole soak duration. ---
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const tickRow = STATIC_ROWS.length + 1 // 1-based row just under the static block
let tick = 0
const SOAK_MS = Number(new URLSearchParams(location.search).get('soakMs') || '14000')
const startedAt = Date.now()

const tickTimer = window.setInterval(() => {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  const spin = SPINNER[tick % SPINNER.length]
  tick++
  // Move to the fixed row, clear it, write the frame — same shape as Claude's
  // real in-place status-line rewrite (cursor addressing, not a newline).
  const chunk = `\x1b[${tickRow};1H\x1b[2K${spin} Running…  (${elapsed}s elapsed, ${tick * 37} tokens)`
  lastDataAtRef = Date.now()
  term.write(chunk, scheduleRepaint)
  if (Date.now() - startedAt > SOAK_MS) {
    window.clearInterval(tickTimer)
    ;(window as unknown as { __soakDone?: boolean }).__soakDone = true
  }
}, 220)

document.fonts.ready.then(() => {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    ;(window as unknown as { __visualReady?: boolean }).__visualReady = true
  }))
})
