// THE COMPOSER GHOST, headlessly.
//
// Every other fixture in this directory is classic tui (`{"tui":"default"}`). This one replays a
// real FULLSCREEN (alt-screen) capture, because that is where the ghost lives: an alt-screen TUI
// rewrites a fixed viewport in place, so the composer and the rule/status lines around it are the
// LAST rows — and the last rows are what go stale.
//
// Each scenario replays the SAME bytes at the SAME cadence; only the mid-stream interference
// differs. The buffer (`translateToString`) is ground truth; the DOM (`.xterm-rows > *`) is what
// the user sees. A buffer-clean/DOM-stale row is a renderer bug reproducible right here.
//
// ONE SCENARIO PER PAGE LOAD, selected by `?scenario=`. Stacking them in one page was the first
// version and it was unusable: xterm pauses its RenderService for a terminal that is not
// intersecting the viewport, so every pane below the fold rendered differently from one at the
// top, and the results moved depending on how many scenarios ran before them. One terminal, alone,
// at the top of the viewport is also what production actually looks like.
//
// Read by fullscreen-ghost.mjs.
import { Terminal } from '@xterm/xterm'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import { stripOrnaments } from '../../src/renderer/lib/terminal'

/** Is the terminal inside a DEC 2026 synchronized-output frame? Reported per scenario, because it
 *  decides whether a `refresh()` paints at all: `RenderService.refreshRows` BUFFERS the request and
 *  returns while the mode is set. Claude Code's fullscreen TUI wraps every redraw in one — the
 *  short fixture has 24 balanced `?2026h`/`?2026l` pairs in 4KB. */
function inSynchronizedOutput(term: Terminal): boolean {
  type Internals = { _core?: { coreService?: { decPrivateModes?: { synchronizedOutput?: boolean } } } }
  return (term as unknown as Internals)._core?.coreService?.decPrivateModes?.synchronizedOutput === true
}

/** THE CANDIDATE MITIGATION, off by default (`?fix=1` to arm it), and NOT in the app.
 *
 *  The research recommendation was: drop the DOM renderer's row cache before the active effect's
 *  `refresh()`, the way `clearTextureAtlas()` is dropped on resize. This is that. Two measurements,
 *  2026-08-10, and neither of them justifies shipping it:
 *
 *   - ISOLATED (one terminal per page, as the gate runs): exactly neutral. 0 mismatches with it and
 *     0 without, on every hide/show variant including `display:none`. It cannot be shown to fix
 *     anything, because there is nothing left to fix.
 *   - STACKED (several panes in one page, the layout the original spike used): it BLANKED 15 rows
 *     that were correct without it. When the render service is paused — a terminal with no box, or
 *     one scrolled out of the viewport — `clear()` empties every row and the `refresh()` that
 *     should refill them is dropped on the floor. That is the ghost, caused rather than cured.
 *
 *  `DomRenderer.renderRows` rebuilds every row it is asked for unconditionally, so there is no row
 *  cache to drop in the first place; the only thing `clear()` adds is a window in which the rows
 *  are empty. Left runnable so the next person can re-measure in one command rather than rebuild
 *  it, not because it is a candidate. */
function dropRowCacheAndRefresh(term: Terminal): void {
  type Internals = { _core?: { _renderService?: { clear?: () => void } } }
  try {
    ;(term as unknown as Internals)._core?._renderService?.clear?.()
    term.refresh(0, term.rows - 1)
  } catch { /* disposed */ }
}

const COLS = 120, ROWS = 30
// The panel-open narrowing a real lane goes through, used by the resize scenarios.
const NARROW_COLS = 84, NARROW_ROWS = 24

// TerminalPane's real repaint cadence. Not approximations — the same numbers, so a scenario that
// passes here is not passing because it was given a gentler schedule than production.
const REFRESH_THROTTLE_MS = 180
const SETTLE_MS = 90
const FIT_QUIET_MS = 150
const CHUNK = 256

const params = new URLSearchParams(location.search)
const FIX = params.get('fix') === '1'
const WANTED = params.get('scenario') || 'baseline'
const FIXTURE = params.get('fixture') || 'claude-fullscreen'

type Row = { row: number; buffer: string; dom: string; match: boolean }

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms))
const frame = () => new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())))
// The same rule-flanking heuristic replay.ts uses: a letter or digit abutting a box rule is the
// signature of a width-drift overprint.
const GARBLE = /[A-Za-z0-9]─|─[A-Za-z0-9]/

/** Context handed to a scenario's hooks. */
type Ctx = { term: Terminal; write: (s: string) => Promise<void>; repaint: () => void }
type Scenario = {
  /** Runs before each chunk is written. Return '' to withhold it, a string to substitute. */
  onChunk?: (ctx: Ctx & { i: number; total: number; chunk: string }) => Promise<string | void> | string | void
  /** Runs once after the last chunk, before the settle wait. */
  onEnd?: (ctx: Ctx) => Promise<void> | void
}

/** Mimics TerminalPane's `active=false → true` cycle. Chunks arriving while hidden are WITHHELD
 *  rather than written (that is `bgBufferRef`), then flushed on show followed by a repaint (that
 *  is the `active` effect's `flushBg()` + `fit()` + `refresh()`).
 *
 *  THE HIDE WINDOW RUNS TO THE END OF THE STREAM, and that is not arbitrary — it is the difference
 *  between reproducing this and not. A window that closes mid-stream gets repainted by the chunks
 *  that follow and everything comes back clean. In production the pane is hidden while the lane
 *  works, you switch back, the flush is the last thing that happens, and then it sits there. What
 *  that flush failed to paint is what you are looking at.
 *
 *  `flushMode` isolates whether coalescing into one write is what confuses the renderer;
 *  `lateRefresh` tests whether this is a race a later repaint would clear. */
function hideShow(opts: {
  flushMode: 'coalesced' | 'chunked'
  lateRefresh?: boolean
  /** How the pane's DOM is hidden, which decides whether xterm's own renderer keeps running.
   *  - `writes-only`: the element stays laid out; only writes are withheld. This is what the app
   *    does today — DashboardView hides inactive panes with `visibility: hidden`, and an element
   *    with that still has a box, so IntersectionObserver keeps reporting it visible.
   *  - `visibility`: the same thing, asserted rather than assumed.
   *  - `display`: the element loses its box entirely. xterm's RenderService observes intersection
   *    and PAUSES when the terminal is not visible — a `refresh()` issued while paused is dropped
   *    and only remembered as `_needsFullRefresh`, released whenever the observer next fires. That
   *    is the one path where a refresh can genuinely vanish, so it is worth testing even though
   *    the app does not currently take it. */
  hideStyle?: 'writes-only' | 'visibility' | 'display'
}): Scenario {
  const withheld: string[] = []
  const host = () => document.getElementById('term')!
  return {
    onChunk: ({ i, total, chunk }) => {
      if (i >= Math.floor(total * 0.55)) {
        if (withheld.length === 0) {
          if (opts.hideStyle === 'visibility') host().style.visibility = 'hidden'
          if (opts.hideStyle === 'display') host().style.display = 'none'
        }
        withheld.push(chunk)
        return ''
      }
      return undefined
    },
    onEnd: async ({ term, write }) => {
      // Shown again FIRST, then flushed — the order the `active` effect runs in.
      host().style.visibility = ''
      host().style.display = ''
      if (opts.flushMode === 'coalesced') await write(withheld.join(''))
      else for (const w of withheld) await write(w)
      withheld.length = 0
      // What the app does on becoming visible again. `?fix=1` swaps in the candidate mitigation
      // instead — see `dropRowCacheAndRefresh` for why it is not the default.
      if (FIX) dropRowCacheAndRefresh(term)
      else { try { term.refresh(0, term.rows - 1) } catch { /* disposed */ } }

      if (!opts.lateRefresh) return
      await sleep(340) // well clear of any write — a race would have settled by now
      try { term.refresh(0, term.rows - 1) } catch { /* disposed */ }
    },
  }
}

const SCENARIOS: Record<string, () => Scenario> = {
  // The control. Proves the fixture renders clean with no interference, so any failure below is
  // the interference and not the bytes.
  baseline: () => ({}),

  // TerminalPane.handleResize's real quiet-gate: defer until output has been quiet FIT_QUIET_MS.
  'resize-guarded': () => {
    let lastWriteAt = 0, done = false
    return {
      onChunk: async ({ term, i, total }) => {
        lastWriteAt = Date.now()
        if (!done && i > total * 0.5) {
          await sleep(FIT_QUIET_MS + 10)
          if (Date.now() - lastWriteAt >= FIT_QUIET_MS) { term.resize(NARROW_COLS, NARROW_ROWS); done = true }
        }
      },
    }
  },
  // The same narrowing with NO gate, synchronously mid-burst.
  'resize-forced': () => {
    let done = false
    return {
      onChunk: ({ term, i, total }) => {
        if (!done && i > total * 0.5) { term.resize(NARROW_COLS, NARROW_ROWS); done = true }
      },
    }
  },
  // Toggled on EVERY chunk boundary, so a resize lands inside each of the capture's redraws.
  'resize-thrash': () => ({
    onChunk: ({ term, i }) => {
      if (i % 2 === 0) term.resize(NARROW_COLS, NARROW_ROWS)
      else term.resize(COLS, ROWS)
    },
  }),

  'hide-show': () => hideShow({ flushMode: 'coalesced' }),
  'hide-show-chunked-flush': () => hideShow({ flushMode: 'chunked' }),
  'hide-show-late-refresh': () => hideShow({ flushMode: 'coalesced', lateRefresh: true }),
  'hide-show-visibility': () => hideShow({ flushMode: 'coalesced', hideStyle: 'visibility' }),
  'hide-show-display-none': () => hideShow({ flushMode: 'coalesced', hideStyle: 'display' }),

  // NOT a scenario — the harness checking itself. It stales the tail rows on purpose, in exactly
  // the shape the ghost takes, AFTER the last repaint. The runner requires this one to FAIL.
  //
  // Every other scenario currently comes back clean, and a comparator that had quietly stopped
  // comparing would look identical. This is what tells the two apart: if the diff, the row
  // scoping, or the &nbsp; normalisation breaks, `selftest` goes green and the run fails.
  selftest: () => ({
    onEnd: async () => {
      await sleep(SETTLE_MS + 300) // let every scheduled repaint land first
      const rowEls = Array.from(document.querySelectorAll('#term .xterm-rows > *')) as HTMLElement[]
      for (const el of rowEls.slice(-3)) el.replaceChildren()
    },
  }),
}

export const SCENARIO_NAMES = Object.keys(SCENARIOS)

async function run() {
  const scenario = SCENARIOS[WANTED]?.()
  if (!scenario) throw new Error(`unknown scenario ${WANTED}`)

  const host = document.getElementById('term')!
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 10000, allowProposedApi: true })
  term.loadAddon(new UnicodeGraphemesAddon())
  term.unicode.activeVersion = '15-graphemes'
  term.open(host)

  let lastRefreshAt = 0
  let settleTimer = 0
  const repaint = () => {
    const now = Date.now()
    if (now - lastRefreshAt > REFRESH_THROTTLE_MS) {
      lastRefreshAt = now
      try { term.refresh(0, term.rows - 1) } catch { /* disposed */ }
    }
    clearTimeout(settleTimer)
    settleTimer = window.setTimeout(() => {
      lastRefreshAt = Date.now()
      try { term.refresh(0, term.rows - 1) } catch { /* disposed */ }
    }, SETTLE_MS)
  }
  const write = (s: string) => new Promise<void>((res) => term.write(s, () => res()))
  const ctx: Ctx = { term, write, repaint }

  const buf = new Uint8Array(await (await fetch(`./.bin`)).arrayBuffer())
  const text = stripOrnaments(new TextDecoder().decode(buf))

  const total = Math.ceil(text.length / CHUNK)
  for (let i = 0; i < total; i++) {
    const chunk = text.slice(i * CHUNK, (i + 1) * CHUNK)
    const replacement = await scenario.onChunk?.({ ...ctx, i, total, chunk })
    const toWrite = typeof replacement === 'string' ? replacement : chunk
    if (toWrite) { await write(toWrite); repaint() }
    await sleep(4) // let rAF/render run between chunks, as a real pty does
  }
  await scenario.onEnd?.(ctx)
  await sleep(SETTLE_MS + 250)
  await frame()

  const rowEls = Array.from(host.querySelectorAll('.xterm-rows > *')) as HTMLElement[]
  const b = term.buffer.active
  const rows: Row[] = []
  for (let i = 0; i < term.rows; i++) {
    const line = b.getLine(b.viewportY + i)
    if (!line) continue
    // trimRight both sides: the DOM pads trailing cells, and &nbsp; is not a plain space.
    const buffer = line.translateToString(true).replace(/\s+$/, '')
    const dom = (rowEls[i]?.textContent ?? '').replace(/ /g, ' ').replace(/\s+$/, '')
    rows.push({ row: i, buffer, dom, match: buffer === dom })
  }

  ;(window as unknown as { __ghost: unknown }).__ghost = {
    name: WANTED,
    fixture: FIXTURE,
    fix: FIX,
    cols: term.cols,
    rows: term.rows,
    bufferGarbled: rows.filter((r) => GARBLE.test(r.buffer)).length,
    // DOM garbled where the buffer is not — the renderer inventing corruption, as opposed to
    // faithfully rendering a buffer that was already wrong.
    domOnlyGarbled: rows.filter((r) => GARBLE.test(r.dom) && !GARBLE.test(r.buffer)).length,
    mismatches: rows.filter((r) => !r.match),
    // Diagnostics, so a failure says something about WHY rather than only that it happened.
    syncOutputAtEnd: inSynchronizedOutput(term),
  }
  ;(window as unknown as { __ghostReady: boolean }).__ghostReady = true
}
void run()
