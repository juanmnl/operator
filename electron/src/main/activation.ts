// App or window activation → the renderer's keyboard focus.
//
// Nothing in main reacted to activation before: `app.on('activate')` only created a window when there
// was none, and nothing focused the web contents or told the renderer. On macOS the NSWindow becoming
// key does not by itself give the page keyboard focus in every path (a Dock click on an app whose
// window is already open is the usual one), so the renderer's `window` 'focus' was the only signal
// and it could be missing. Now main focuses the web contents and sends `onWindowActivated`; which
// ELEMENT gets focus is the renderer's decision (src/renderer/lib/refocus.ts).

/** The part of a BrowserWindow this touches, so it can be tested with a fake. */
export interface ActivatableWindow {
  isDestroyed(): boolean
  isVisible(): boolean
  focus(): void
  webContents: { isDestroyed(): boolean; focus(): void }
}

/** BrowserWindow 'focus': give the page keyboard focus, then let the renderer pick the element. */
export function onWindowFocused(win: ActivatableWindow, notify: () => void): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.focus()
  notify()
}

/** app 'activate' (a Dock click, or relaunching the running app) with a window already open: focus it,
 *  which fires 'focus' and so `onWindowFocused`. A window that is not visible yet is left alone: the
 *  window starts hidden and the renderer shows it when it is ready, and 'activate' also fires at
 *  launch, so showing it here would flash an unfinished window. */
export function onAppActivated(win: ActivatableWindow | null): void {
  if (!win || win.isDestroyed() || !win.isVisible()) return
  win.focus()
}
