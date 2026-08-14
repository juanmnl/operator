// A file dropped anywhere the app does not itself handle makes the webview navigate to
// `file:///…/that-file` — the dropped file fills the window and the entire React app is gone,
// with no way back. That is plain WKWebView default behaviour for an unhandled file drop, and
// `dragDropEnabled` is false in tauri.conf ON PURPOSE (the composer's image attach, the
// terminal's screenshot drop and the lane reorder all need HTML5 DnD), so the backstop has to
// live in the page.
//
// ALL THREE EVENTS MATTER, and `dragenter` is the one that is easy to miss. The browser decides
// at drag time whether a drop is allowed at all, so cancelling only `drop` still navigates — the
// `drop` event never even fires. But it is not always `dragover` that asks: WebKit's
// `EventHandler::updateDragAndDrop` is an if/else on whether the drag target CHANGED. Crossing
// into a new element dispatches `dragenter` and takes THAT event's cancellation as the answer;
// `dragover` is only dispatched on later ticks over the same element. A drag that enters an
// element and is released before the pointer moves again — a fast flick in from Finder, which is
// how this defect was hit — is therefore decided entirely by `dragenter`.
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
  // An EMPTY `types` is the opposite call and deliberately so: the rail's project-group drag sets
  // `effectAllowed` and never calls `setData` (ProjectRail.tsx), so `[]` is a shape the app itself
  // produces and no navigating payload does — a null DataTransfer tells us nothing, `[]` tells us
  // it is ours.
  if (!dt) return true
  const types = Array.from(dt.types)
  if (!NAVIGATING_TYPES.some((t) => types.includes(t))) return false
  // One exception: a URL dragged into a text field is inserted as text by the browser, not
  // navigated to, and cancelling that would silently break drag-to-edit in every input in the
  // app. A drag carrying FILES gets no such pass — that one navigates wherever it lands.
  if (!types.includes('Files') && isEditable(e.target)) return false
  return true
}

/** The `<input>` types that hold free text, and so absorb a dropped URL instead of letting the
 *  webview navigate to it. Deliberately NOT the full "text entry" list: `date`, `time`, `month`,
 *  `week` and `datetime-local` render as spinner widgets on WebKit rather than text fields, and a
 *  URL dropped on one is not reliably inserted. This list decides who gets to SKIP the backstop,
 *  so an entry that is wrong in that direction costs the whole app — when unsure, guard. */
const TEXT_ENTRY_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number'])

/** Editable in the only sense that matters here: this element will absorb a dropped URL, so
 *  cancelling would break drag-to-edit for no safety gain.
 *
 *  That is a question about the element's STATE, not its tag, and asking it by tag gets it wrong
 *  in BOTH directions. A `readonly`/`disabled` textarea, a checkbox, a range slider and a button
 *  are all `<input>`/`<textarea>` that cannot take the text — a URL dropped on one falls straight
 *  through to the navigation this file exists to stop. And `contenteditable="plaintext-only"`
 *  (which WebKit supports) takes it fine while matching no `[contenteditable="true"]` selector,
 *  so a tag-shaped test silently kills drag-to-edit there instead. */
function isEditable(node: EventTarget | null): boolean {
  // The drop can land inside an <svg>, whose elements have no `isContentEditable` of their own —
  // walk up to the nearest HTML element before asking.
  let el = node instanceof Element ? node : null
  while (el && !(el instanceof HTMLElement)) el = el.parentElement
  if (!el) return false
  // Covers contenteditable ""/"true"/"plaintext-only", `designMode`, and INHERITED editability —
  // a drop inside an editable region usually lands on a descendant, not the region itself.
  if (el.isContentEditable) return true
  // jsdom does not implement `isContentEditable` (it reads `undefined`), so the line above is
  // dead under test and this attribute walk is what the suite actually exercises. Keep both: the
  // property is the correct question in a real engine, this is the only one jsdom can answer.
  // `closest` stopping at the NEAREST [contenteditable] is right either way — an explicit
  // `contenteditable="false"` island inside an editable region is genuinely not editable.
  const region = el.closest('[contenteditable]')
  const mode = region?.getAttribute('contenteditable')?.toLowerCase()
  if (mode === '' || mode === 'true' || mode === 'plaintext-only') return true
  const field = el.closest('input, textarea')
  if (field instanceof HTMLTextAreaElement) return !field.readOnly && !field.disabled
  if (field instanceof HTMLInputElement) {
    // `.type` reflects the IDL attribute, so a missing or unrecognised `type` reads as `text`.
    return !field.readOnly && !field.disabled && TEXT_ENTRY_INPUT_TYPES.has(field.type)
  }
  return false
}

/** Install the global drag backstop. Returns a disposer. */
export function installDropGuard(target: EventTarget = window): () => void {
  // `dragenter` CLAIMS THE DRAG BUT DOES NOT SET `dropEffect`, which is the whole difference
  // between this and the `dragover` handler below.
  //
  // On the tick a drag enters a new element, no app drop target has been consulted yet — none of
  // them listen for `dragenter`; they all decide on `dragover`. Writing `dropEffect = 'none'` here
  // would therefore refuse, for one tick, a drag the composer or the terminal is about to accept,
  // and a flick that released on exactly that tick would lose the file instead of attaching it.
  // Cancelling alone is enough for safety: it takes the drop away from the webview's navigation
  // default and leaves `dropEffect` at the value the spec initialises from `effectAllowed`
  // ("copy" for a Finder drag), so the drop still fires and still reaches whichever target is
  // under the cursor — or, over a plain area, reaches `onDrop` below and dies there. The very
  // next tick over the same element is a `dragover`, which sets the honest "none".
  const onDragEnter = (ev: Event) => {
    const e = ev as DragEvent
    if (!shouldGuard(e)) return
    if (e.defaultPrevented) return
    e.preventDefault()
  }
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
  target.addEventListener('dragenter', onDragEnter)
  target.addEventListener('dragover', onDragOver)
  target.addEventListener('drop', onDrop)
  return () => {
    target.removeEventListener('dragenter', onDragEnter)
    target.removeEventListener('dragover', onDragOver)
    target.removeEventListener('drop', onDrop)
  }
}
