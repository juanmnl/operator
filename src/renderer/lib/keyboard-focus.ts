// Whether a focus came from the keyboard, as the browser's `:focus-visible` heuristic decides.
//
// The rail row reveals its ■ on focus so the keyboard can reach it (lifecycle audit B1). A mouse
// click focuses the row too (`tabIndex={0}`), and when the click does not move focus on, into the
// terminal, the ■ stayed in place of the phase word after the pointer left (review R7,
// 2026-10-24). `:focus-visible` is what tells the two apart.

/** True when `el` has keyboard-visible focus. An engine that cannot parse `:focus-visible` reads
 *  as true, which keeps the reveal reachable from the keyboard as it was. */
export function isKeyboardFocus(el: EventTarget | null): boolean {
  if (!el || typeof (el as Element).matches !== 'function') return false
  try {
    return (el as Element).matches(':focus-visible')
  } catch {
    return true
  }
}
