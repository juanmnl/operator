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

const TUI_MODE_KEY = 'operator.terminal.tuiMode'
export type TuiMode = 'default' | 'fullscreen'

/** Claude Code's TUI renderer for sessions Operator spawns. 'default' = classic
 *  streaming renderer (accumulates scrollback; its in-place status redraws can
 *  ghost/garble in the DOM xterm). 'fullscreen' = alt-screen fixed viewport
 *  (absolute positioning, no scrollback → structurally can't ghost), but it
 *  replaces the native scrollback with Claude's own scrolling. Default 'default'
 *  until fullscreen is confirmed clean in the live app; opt-in via Preferences. */
export function getTuiMode(): TuiMode {
  try {
    return localStorage.getItem(TUI_MODE_KEY) === 'fullscreen' ? 'fullscreen' : 'default'
  } catch {
    return 'default'
  }
}

export function setTuiMode(mode: TuiMode): void {
  try {
    localStorage.setItem(TUI_MODE_KEY, mode)
  } catch {
    /* ignore */
  }
}

const RENDERER_MODE_KEY = 'operator.terminal.renderer'
export type RendererMode = 'xterm' | 'grid'

/** WHICH TERMINAL RENDERER a session is spawned with. **Default `xterm`, and that is the whole
 *  point of it.**
 *
 *  `xterm` = the shipped DOM-renderer pane (`TerminalSurface`). `grid` = our own terminal
 *  (`GridTerminalPane`): the pty bytes are parsed by alacritty in Rust and only a themed CELL
 *  SNAPSHOT crosses into the webview, so there is no escape-sequence stream for a webview buffer
 *  to mis-track.
 *
 *  THIS IS AN ESCAPE HATCH FOR A SOAK TEST, NOT A PRODUCT SURFACE. The standing rule is "do not
 *  reintroduce a renderer toggle without a soak test", and the toggle is what makes the soak test
 *  possible at all — the grid path has been unreachable since 2026-06-30, so nobody can judge it.
 *  It is deliberately not exposed in Preferences: turn it on from the console with
 *
 *      localStorage.setItem('operator.terminal.renderer', 'grid')
 *
 *  and start a NEW session. It binds at SPAWN — the grid core is created by `terminal_spawn` — so
 *  a running session cannot switch, and flipping the pref never changes which pane is mounted
 *  over a live pty. What renderer an existing session uses is read back off the pty
 *  (`ManagedTerminal.grid`), never off this pref.
 *
 *  Read the history before promoting it: the commit that created the grid (e9e02e3, 2026-06-30)
 *  is the same commit that shelved it, for "an endless edge-case tail". */
export function getRendererMode(): RendererMode {
  try {
    return localStorage.getItem(RENDERER_MODE_KEY) === 'grid' ? 'grid' : 'xterm'
  } catch {
    return 'xterm'
  }
}

export function setRendererMode(mode: RendererMode): void {
  try {
    localStorage.setItem(RENDERER_MODE_KEY, mode)
  } catch {
    /* ignore */
  }
}

/** THE SPAWN DECISION: which renderer, and which TUI mode goes with it.
 *
 *  Pure and in one place because the interesting half is a COUPLING rather than two independent
 *  prefs — grid mode forces `fullscreen` whatever the tui pref says, and that is the claim worth
 *  being able to test. Inline in the bridge it could only be asserted in a comment, which is what
 *  it was: `operator-bridge.ts` has described this behaviour since 2026-06-30 while sending
 *  neither flag.
 *
 *  WHY THE COUPLING. The grid parses alt-screen correctly and that is the whole reason to run it;
 *  classic is the mode whose absolute-column redraws over relatively-positioned rows produce the
 *  overprint the grid exists to escape. Running the grid in classic mode would be testing it in
 *  the one configuration it was not built for. Outside grid mode the user's pref is honoured
 *  exactly as before — this must not change what a default install does. */
export function spawnTerminalMode(): { grid: boolean; tuiMode: TuiMode } {
  const grid = getRendererMode() === 'grid'
  return { grid, tuiMode: grid ? 'fullscreen' : getTuiMode() }
}

/** Scrollback for the pane you are looking at. Unchanged — the visible terminal keeps the full
 *  history it has always had. */
export const ACTIVE_SCROLLBACK = 10_000

/** Scrollback for a pane that is mounted but NOT on screen.
 *
 *  EVERY session's terminal stays mounted, always — the chosen surface (Chat/Preview) overlays a
 *  still-mounted, still-sized pty because unmounting blanks the final output and resizing hangs
 *  the terminal. That rule is right and is not what changes here.
 *
 *  What it costs: `DashboardView` renders every tab, so a project with eight lanes holds eight
 *  live xterm instances, and at 10k lines each that is 80,000 lines of buffered cells in one
 *  renderer. Measured on the real app: WebContent resting at 737MB with 23.6% CPU, and opening
 *  the heaviest project pushed it past what WebKit would give it — the renderer was killed and
 *  respawned mid-navigation, which reads to the user as "the app restarts, blinks, and goes back
 *  to another project" (the respawn re-hydrates scope from localStorage, so you land somewhere
 *  else). Eight mounted terminals is not exotic here; it is a normal working day.
 *
 *  2,000 lines is ~20 screens of history on a background lane — generous enough that switching
 *  back rarely finds the top, small enough that eight of them cost a fifth of what they did.
 *
 *  THE COST, STATED PLAINLY: lowering `scrollback` DISCARDS lines beyond the new limit, and
 *  raising it again does not bring them back. Switching away from a lane trims its history to
 *  2,000 lines. That is a real loss and it is the price of the pane still being there at all —
 *  the alternative on the table was unmounting inactive panes entirely, which loses the whole
 *  buffer and risks the resize-hang the never-unmount rule exists to prevent.
 *
 *  If that trade needs undoing later, the honest fix is replay-on-activate: the backend already
 *  retains each pty's output (`terminalHistory`, the same source the post-reload re-attach
 *  replays from), so a reactivated pane could restore what it dropped. Not built here because it
 *  changes what a pane shows on every switch, and this bug needed a fix that does not. */
export const INACTIVE_SCROLLBACK = 2_000

/** How much scrollback a pane should hold right now. Pure so the policy is one testable thing
 *  rather than a number written at two call sites that can drift apart. */
export function scrollbackFor(active: boolean): number {
  return active ? ACTIVE_SCROLLBACK : INACTIVE_SCROLLBACK
}

/** Should a pane's resize callback fit — and therefore resize its pty?
 *
 *  ONLY THE PANE YOU ARE LOOKING AT. Every session's terminal stays mounted as an absolutely
 *  positioned sibling in one shared container, hidden with `visibility` (which keeps a real,
 *  measurable box), so a layout change fires EVERY pane's ResizeObserver — and the per-session
 *  Plan/Diff panel is a flex sibling of that container, so switching to a lane whose panel state
 *  differs genuinely changes its width. Measured before this guard (scripts/resize-guard):
 *  ONE lane switch resized 5 of 5 mounted terminals, each one a real TIOCSWINSZ → SIGWINCH →
 *  a background Claude Code redrawing → bytes back through the pty → `note_activity` →
 *  `phase = "running"` for 1.5s. That is the reported "switching agents wakes every lane": every
 *  orb in every project animating because the user changed tabs.
 *
 *  A background pane holding a stale size is the accepted cost, and it is already how the app's
 *  other terminal behaves (`GridTerminalPane`'s `if (activeRef.current)` reflow guard). It catches
 *  up on activation, where the pane refits before you can look at it — and that is the ONE resize
 *  a switch should cause.
 *
 *  `suspendFit` is the pre-existing half of the same policy: held during a panel drag so the
 *  terminal reflows once on release instead of every frame. */
export function shouldFitOnResize(active: boolean, suspendFit: boolean): boolean {
  return active && !suspendFit
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
    scrollback: ACTIVE_SCROLLBACK,
    // Lift dim secondary text to AA on light backgrounds only; on dark the DOM
    // renderer shows true alpha and any lift just whitens it.
    minimumContrastRatio: isLightBackground(theme.background) ? 4.5 : 1,
  }
}
