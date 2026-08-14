// A file dropped anywhere the app does not itself handle makes the webview navigate to
// `file:///…/that-file` — the dropped file fills the window and the entire React app is gone,
// with no way back. That is plain WKWebView default behaviour for an unhandled file drop, and
// `dragDropEnabled` is false in tauri.conf ON PURPOSE (the composer's image attach, the
// terminal's screenshot drop and the lane reorder all need HTML5 DnD), so the backstop has to
// live in the page.
//
// BOTH events matter. The browser decides at `dragover` whether a drop is allowed at all, so
// cancelling only `drop` still navigates — the `drop` event never even fires. `dragover` is
// what turns the default navigation into a `drop` we can then cancel.
//
// The listeners sit on `window` in the BUBBLE phase, i.e. after React's root-container
// handlers, so every existing drop target (ChatComposer, MoodboardPanel, TerminalPane,
// ProjectRail, RosterPanel) still sees the event first and is untouched: it has already called
// preventDefault, and a second call is a no-op. This is a backstop, not an interceptor — it
// never reads the payload and never opens anything. A stray drop ends in nothing happening.

/** The two payloads whose unhandled default is NAVIGATION: a file dragged in from Finder, and a
 *  URL/link dragged out of another app or page. */
const NAVIGATING_TYPES = ['Files', 'text/uri-list']

/** WHY THE GUARD IS SCOPED TO THOSE TWO, and not "cancel every drag the app ignored".
 *
 *  The rail refuses a cross-kind or cross-project lane drag by deliberately NOT cancelling
 *  `dragover` (ProjectRail.tsx: "a row that does not recognise the type … draws no line"). A
 *  blanket cancel would make every one of those refusals read as accepted — drop line logic,
 *  cursor, and the `drop` event firing where today it cannot. So drags with no navigating
 *  default — the app's own reorder types, plain text — are left exactly as they were; they
 *  could not have destroyed the app in the first place. */
function shouldGuard(e: DragEvent): boolean {
  const dt = e.dataTransfer
  // Unreadable payload: assume the dangerous one. A real in-app drag always has a DataTransfer.
  if (!dt) return true
  const types = Array.from(dt.types)
  if (!NAVIGATING_TYPES.some((t) => types.includes(t))) return false
  // One exception: a URL dragged into a text field is inserted as text by the browser, not
  // navigated to, and cancelling that would silently break drag-to-edit in every input in the
  // app. A drag carrying FILES gets no such pass — that one navigates wherever it lands.
  if (!types.includes('Files') && isEditable(e.target)) return false
  return true
}

function isEditable(node: EventTarget | null): boolean {
  const el = node instanceof Element ? node : null
  return !!el?.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')
}

/** Install the global drag backstop. Returns a disposer. */
export function installDropGuard(target: EventTarget = window): () => void {
  const onDragOver = (ev: Event) => {
    const e = ev as DragEvent
    if (!shouldGuard(e)) return
    // An app drop target already claimed this one — leave it, and in particular leave its
    // `dropEffect` alone so the cursor keeps showing what that target will do.
    if (e.defaultPrevented) return
    e.preventDefault()
    // Nothing here accepts the drag: say so, so the cursor reads "no drop" rather than
    // inviting a drop that will be swallowed. Per spec a "none" effect also means `drop`
    // is not fired at all — the handler below covers us either way.
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
  }
  const onDrop = (ev: Event) => {
    const e = ev as DragEvent
    if (!shouldGuard(e)) return
    e.preventDefault()
  }
  target.addEventListener('dragover', onDragOver)
  target.addEventListener('drop', onDrop)
  return () => {
    target.removeEventListener('dragover', onDragOver)
    target.removeEventListener('drop', onDrop)
  }
}
