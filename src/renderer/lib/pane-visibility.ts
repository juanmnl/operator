// WHICH TERMINAL PANE PAINTS, and why "the active one, always" was wrong under Chromium.
//
// The panes stay mounted and full-size across a Console⇄Chat⇄Preview switch — overlaying them
// rather than unmounting is what keeps the terminal from ever resizing, which is the invariant
// that avoids the ghostty resize/render hang. The overlay was assumed to HIDE what it covers.
//
// It does not, once the overlay contains a cross-origin iframe. Chromium composites such a frame
// out-of-process, in its own layer, and the terminal underneath can end up composited ABOVE that
// layer — so the Preview stage showed the app's page with a line of terminal text, selection
// highlight and all, painted straight through it (2026-08-22, packaged 0.17.0). WKWebView
// composited the opaque overlay over everything and the bug could not exist there.
//
// So the rule becomes: a pane paints only when it is the active one AND nothing is covering it.
// `visibility: hidden` and NOT `display: none`, deliberately — a hidden box still has layout, so
// the pane keeps its size and xterm is never told the viewport changed.

export type MainView = 'terminal' | 'chat' | 'preview'

/** `visibility` for one lane's pane. `mainView` is the overlay state: anything but `terminal`
 *  means Chat or Preview is covering the area. */
export function paneVisibility(paneId: string, activePaneId: string | null, mainView: MainView): 'visible' | 'hidden' {
  if (paneId !== activePaneId) return 'hidden'
  return mainView === 'terminal' ? 'visible' : 'hidden'
}
