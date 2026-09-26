// Per-session layout of the session view: what the main area shows, and whether the right side
// panel is open and on which tab. Pure, so the rules below are tested without mounting
// DashboardView, which owns the state and persists it under `operator.sessionLayouts`.

/** The main content area. Console = the raw terminal, always mounted underneath. */
export type MainView = 'terminal' | 'preview'
/** The right side panel's tabs. */
export type PanelTab = 'plan' | 'diff' | 'preview'
/** A panel tab that reads the session rather than showing its app. */
export type ReadingTab = Exclude<PanelTab, 'preview'>

export type SessionLayout = {
  mainView: MainView
  panelOpen: boolean
  panelTab: PanelTab
  /** The last reading tab, so moving the preview out of the panel has somewhere to land. */
  readingTab: ReadingTab
  /** Design overlays over the preview (layout grid, redlines). Persisted per session; nothing
   *  draws them yet. */
  tools: { grid: boolean; redlines: boolean }
}

export const DEFAULT_LAYOUT: SessionLayout = {
  mainView: 'terminal',
  panelOpen: false,
  panelTab: 'plan',
  readingTab: 'plan',
  tools: { grid: false, redlines: false },
}

/** THE PREVIEW IS ONE SURFACE PER SESSION: in the main view or in the side panel, never both.
 *  The native inspect view is a singleton in the main process, two iframes of one dev server are
 *  two running copies of the app, and the pin, path and annotations are one set per session. */
export function previewInBothSlots(l: SessionLayout): boolean {
  return l.mainView === 'preview' && l.panelOpen && l.panelTab === 'preview'
}

/** Apply a layout patch and keep the one-surface rule. Choosing the preview in one slot moves it
 *  out of the other:
 *
 *  - main view → Preview while the panel's tab is Preview: the panel goes back to `readingTab`.
 *    It stays open; open/closed belongs to the panel toggle, and a move must not flip a control
 *    the user did not touch.
 *  - panel tab → Preview while the main view is Preview: the main view goes back to the Console.
 *  - any other patch that would leave both (only reachable from a stored layout): the panel keeps
 *    its placement and the main view shows the Console, because that is the state with both
 *    surfaces visible. `coerceLayouts` resolves it the same way. */
/** A layout change. `tools` merges field by field, so turning the grid on leaves redlines alone. */
export type LayoutPatch = Partial<Omit<SessionLayout, 'tools'>> & { tools?: Partial<SessionLayout['tools']> }

export function applyLayout(prev: SessionLayout, patch: LayoutPatch): SessionLayout {
  const next: SessionLayout = { ...prev, ...patch, tools: { ...prev.tools, ...patch.tools } }
  if (next.panelTab !== 'preview') next.readingTab = next.panelTab
  if (patch.mainView === 'preview' && next.panelTab === 'preview') {
    next.panelTab = next.readingTab
  } else if (next.mainView === 'preview' && next.panelTab === 'preview' && (next.panelOpen || patch.panelTab === 'preview')) {
    next.mainView = 'terminal'
  }
  return next
}

const MAIN_VIEWS: MainView[] = ['terminal', 'preview']
const PANEL_TABS: PanelTab[] = ['plan', 'diff', 'preview']
const READING_TABS: ReadingTab[] = ['plan', 'diff']

/** Persisted layouts, COERCED to values this build still has.
 *
 *  `mainView` used to include `'chat'` and `'files'`, and every install that ever opened one has
 *  that string on disk. After the removal those values match no render branch, so the main pane
 *  was blank — with no way back, because the toolbar segment that used to set `terminal` is only
 *  reachable when a view is showing. A parse that trusts whatever localStorage holds ages badly
 *  by construction; this is the guard, and it is why the unions live here as arrays.
 *
 *  Layouts written before the preview could sit in the panel have no `readingTab` or `tools`;
 *  they get the defaults. A layout that shows the preview in both slots is resolved the way
 *  `applyLayout` resolves it. */
export function coerceLayouts(raw: unknown): Record<string, SessionLayout> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, SessionLayout> = {}
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    const l = v as Record<string, unknown>
    const tools = l.tools && typeof l.tools === 'object' ? l.tools as Record<string, unknown> : {}
    const layout: SessionLayout = {
      mainView: MAIN_VIEWS.includes(l.mainView as MainView) ? l.mainView as MainView : DEFAULT_LAYOUT.mainView,
      panelTab: PANEL_TABS.includes(l.panelTab as PanelTab) ? l.panelTab as PanelTab : DEFAULT_LAYOUT.panelTab,
      panelOpen: typeof l.panelOpen === 'boolean' ? l.panelOpen : DEFAULT_LAYOUT.panelOpen,
      readingTab: READING_TABS.includes(l.readingTab as ReadingTab) ? l.readingTab as ReadingTab : DEFAULT_LAYOUT.readingTab,
      tools: { grid: tools.grid === true, redlines: tools.redlines === true },
    }
    if (layout.panelTab !== 'preview') layout.readingTab = layout.panelTab
    if (previewInBothSlots(layout)) layout.mainView = 'terminal'
    out[id] = layout
  }
  return out
}

// --- Side panel width -------------------------------------------------------------------------
// ONE width for every tab (the user's call, 2026-09-14): switching Plan ⇄ Diff ⇄ Preview never
// resizes the panel, so the Console never refits on a tab switch. The tab only decides what the
// resize handle may reach while the user is dragging it. The one thing that changes the width the
// panel is DRAWN at is the console's minimum (`placePanel` below); the stored width is left alone,
// so a wider window gives it back. The preview scales to whatever width it gets.

/** Narrowest a drag may make the panel on a reading tab (Plan, Diff). */
export const PANEL_MIN_W = 300
/** Widest a drag may make the panel on a reading tab. */
export const PANEL_MAX_W = 1000
/** Narrowest a drag may make the panel on the Preview tab: a 375 layout plus gutter. */
export const PREVIEW_PANEL_MIN_W = 360
/** What a Preview-tab drag must leave the content card beside it. To be checked against Claude
 *  Code's composer in a real window. */
export const MIN_CONSOLE_W = 480

/** Drag bounds for the panel on `tab`, where `rowW` is the width the content card and the panel
 *  share. On Preview the panel may grow until the card is `MIN_CONSOLE_W` wide, but never below
 *  its own minimum, which wins in a window too narrow for both. */
export function panelDragBounds(tab: PanelTab, rowW: number): { min: number; max: number } {
  if (tab !== 'preview') return { min: PANEL_MIN_W, max: PANEL_MAX_W }
  return { min: PREVIEW_PANEL_MIN_W, max: Math.max(PREVIEW_PANEL_MIN_W, Math.round(rowW - MIN_CONSOLE_W)) }
}

export function clampPanelW(w: number, bounds: { min: number; max: number }): number {
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(w)))
}

/** Double-click on the resize handle: split the row in half, within the tab's drag bounds. */
export function halfPanelW(tab: PanelTab, rowW: number): number {
  return clampPanelW(rowW / 2, panelDragBounds(tab, rowW))
}

// --- The console's minimum, and where the panel goes when it cannot be met -------------------

/** Fewest terminal columns the side panel may leave the Console.
 *
 *  Claude Code's own number. Its session header draws the Clawd mascot only at `columns >= 70` and
 *  drops it below; the cwd beside it is truncated to `columns - 11 - <model label>`. Its other
 *  width rules apply only to wider layouts (key hints shorten below 90, a launcher layout changes
 *  at 120), so 70 is where Claude Code stops removing things from its main screen. Read from the
 *  installed 2.1.283 binary on 2026-09-25. Before this rule, a 460px panel beside an expanded rail
 *  left a 1000px window's terminal 29 columns wide. */
export const MIN_CONSOLE_COLS = 70

/** The card's horizontal width that is not terminal cells: the pane's 6px padding on each side
 *  plus xterm's scrollbar gutter, rounded up. Measured in the Electron shell: an 812px card fits a
 *  790px screen (101 columns). */
export const CONSOLE_CHROME_W = 24

/** The narrowest card that still gives the terminal `MIN_CONSOLE_COLS` columns. */
export function consoleMinWidth(cellW: number): number {
  return Math.ceil(MIN_CONSOLE_COLS * cellW) + CONSOLE_CHROME_W
}

export type PanelPlacement = { mode: 'dock' | 'overlay'; width: number }

/** How the side panel sits in a row `rowW` wide (card + gap + panel), for a panel the user sized
 *  to `wantW`:
 *   - DOCKED at `wantW` when the card beside it keeps `minConsoleW`;
 *   - DOCKED NARROWER, down to `minPanelW`, when only that fits;
 *   - OVER THE CONSOLE (a drawer at `wantW`, never wider than the row) when not even the panel's
 *     minimum fits. The terminal keeps its full width, so opening and closing it never refits
 *     the pty, and it narrows no further than the console's minimum by construction. */
export function placePanel(o: { wantW: number; rowW: number; gap: number; minPanelW: number; minConsoleW: number }): PanelPlacement {
  const room = Math.floor(o.rowW - o.gap - o.minConsoleW)
  if (room >= o.wantW) return { mode: 'dock', width: o.wantW }
  if (room >= o.minPanelW) return { mode: 'dock', width: room }
  return { mode: 'overlay', width: Math.max(0, Math.min(o.wantW, Math.floor(o.rowW))) }
}
