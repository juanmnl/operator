// Does xterm's rendered DOM match its (known-correct) BUFFER after incremental writes?
//
// The replay harness proved the buffer is clean, which was read as "therefore the garble is
// WKWebView compositing." But that conflates two different failures:
//   (a) DOM is correct, PIXELS are stale  → compositor bug, only reproducible in the app.
//   (b) DOM ITSELF is stale               → xterm DOM-renderer dirty-tracking, reproducible
//                                            and fixable RIGHT HERE.
// Nobody tested (b). The buffer check reads `translateToString`, which reads the buffer —
// never the DOM. So this harness writes the real captured stream in CHUNKS (as pty data
// actually arrives) using TerminalPane's repaint cadence, then diffs, per row, the buffer
// text against the text xterm actually put in the DOM.
//
// Read by dom-vs-buffer.mjs.
import { Terminal } from '@xterm/xterm'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import { stripOrnaments } from '../../src/renderer/lib/terminal'

const COLS = 100, ROWS = 30
const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 10000, allowProposedApi: true })
term.loadAddon(new UnicodeGraphemesAddon())
term.unicode.activeVersion = '15-graphemes'
term.open(document.getElementById('term')!)

// Mirror of TerminalPane's throttle/settle cadence (the production repaint path).
const REFRESH_THROTTLE_MS = 180
const SETTLE_MS = 90
let lastRefreshAt = 0
let settleTimer = 0
function scheduleRepaint() {
  const now = Date.now()
  if (now - lastRefreshAt > REFRESH_THROTTLE_MS) {
    lastRefreshAt = now
    term.refresh(0, term.rows - 1)
  }
  clearTimeout(settleTimer)
  settleTimer = window.setTimeout(() => {
    lastRefreshAt = Date.now()
    term.refresh(0, term.rows - 1)
  }, SETTLE_MS)
}

const write = (s: string) => new Promise<void>((res) => term.write(s, () => res()))
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms))

async function run() {
  const buf = new Uint8Array(await (await fetch('./claude-turn.bin')).arrayBuffer())
  const text = stripOrnaments(new TextDecoder().decode(buf))

  // Chunk it the way a pty delivers it — many small writes, not one big one. A single
  // write lets xterm render once from a settled buffer, which is exactly the case that
  // already tests clean; the incremental path is what the live terminal does.
  const CHUNK = 256
  for (let i = 0; i < text.length; i += CHUNK) {
    await write(text.slice(i, i + CHUNK))
    scheduleRepaint()
    await sleep(4) // let rAF/render run between chunks
  }
  // Let the settle repaint fire, then give the renderer a couple of frames.
  await sleep(SETTLE_MS + 250)
  await new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())))

  // Compare, per VIEWPORT row: what the buffer says vs what xterm actually rendered.
  // The DOM renderer emits one element per viewport row under .xterm-rows.
  const rowEls = Array.from(document.querySelectorAll('.xterm-rows > *')) as HTMLElement[]
  const b = term.buffer.active
  const rows: { row: number; buffer: string; dom: string; match: boolean }[] = []
  for (let i = 0; i < term.rows; i++) {
    const line = b.getLine(b.viewportY + i)
    if (!line) continue
    // trimRight on both sides: the DOM pads trailing cells with spaces/&nbsp;.
    const bufferText = line.translateToString(true).replace(/\s+$/, '')
    const domText = (rowEls[i]?.textContent ?? '').replace(/ /g, ' ').replace(/\s+$/, '')
    rows.push({ row: i, buffer: bufferText, dom: domText, match: bufferText === domText })
  }

  ;(window as unknown as { __domCheck: unknown }).__domCheck = {
    cols: COLS,
    rowsChecked: rows.length,
    rowElsFound: rowEls.length,
    mismatches: rows.filter((r) => !r.match),
    rows,
  }
  ;(window as unknown as { __domCheckReady: boolean }).__domCheckReady = true
}
void run()
