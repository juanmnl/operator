import { isAppChord } from './key-routing'

// What the guard dialogs (components/GuardDialog: the quit guard and the project close guard) do
// with a keydown, pure so it can be tested without a DOM.

/** `safe`: answer the safe verb (Esc, ⌘.). `cycle`: move focus between the two buttons (Tab).
 *  `block`: an app chord, kept from the app while the dialog is up (review R4, 2026-10-24): ⌘W
 *  closed the active lane under the dialog, ⌘N started a lane the dialog never named, and ⌘K
 *  opened the palette beneath the scrim with keyboard focus. ⌘E (Preview mode) is the window
 *  handler's too, outside `isAppChord`. `null`: let it through (⌘Q's menu item, ⌘C). */
export function guardKeyAction(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey?: boolean }): 'safe' | 'cycle' | 'block' | null {
  if (e.key === 'Escape' || (e.key === '.' && e.metaKey)) return 'safe'
  if (e.key === 'Tab') return 'cycle'
  if (isAppChord(e) || ((e.metaKey || e.ctrlKey) && (e.key === 'e' || e.key === 'E'))) return 'block'
  return null
}

/** Remember where focus is and return how to put it back (review R5): when a dialog that took focus
 *  unmounts, focus fell to `body`, and keys typed after Esc went nowhere. Nothing is restored to an
 *  element that has left the document.
 *
 *  `fallback` puts focus somewhere stable when there is nothing to go back to (review T2,
 *  2026-10-25). A dialog opened from a menu item or the palette mounts after that menu has closed,
 *  so focus is already on `body` when it is read. */
export function keepFocus(doc: Pick<Document, 'activeElement' | 'body'> = document, fallback?: () => void): () => void {
  const before = doc.activeElement
  return () => {
    const el = before as HTMLElement | null
    if (el && el !== doc.body && el.isConnected && typeof el.focus === 'function') el.focus()
    else fallback?.()
  }
}
