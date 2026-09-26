import { useEffect } from 'react'
import { classifyFocus, refocusTarget } from './refocus'
import { getTerminal } from './terminal-registry'

// App activation → focus, for the whole window, in ONE place (lib/refocus has the rules).
//
// It used to be a `window` 'focus' listener in every mounted TerminalPane, which had two faults:
//   - it relied on the renderer's own 'focus' event, and main never focused the web contents or
//     told the renderer the app had been activated (see `onWindowActivated` in electron/src/main);
//   - every pane decided for itself from its `active` flag, which is true for the selected lane even
//     when the board or settings is on screen, so coming back could move focus from the board's
//     composer (or a dialog) into a hidden terminal.
//
// Three triggers, coalesced into one decision per frame: the renderer's window 'focus', the
// document becoming visible, and main's `onWindowActivated` (sent on BrowserWindow 'focus' and app
// 'activate'). The decision runs a frame later, after the platform has restored whatever it restores.

/** What the view on screen is, read at the moment of activation. */
export interface ActivationView {
  /** The lane whose terminal is on screen, if one is (not the board, not settings). */
  laneOnScreen?: string
}

const visible = (el: Element): boolean =>
  el.isConnected && (el as HTMLElement).getClientRects().length > 0

/** The visible primary input of the view on screen, marked `data-primary-input`. */
function primaryInput(): HTMLElement | null {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-primary-input]'))) {
    if (visible(el) && !(el as HTMLInputElement).disabled) return el
  }
  return null
}

export function useRefocusOnActivate(view: () => ActivationView): void {
  useEffect(() => {
    // What had focus when the window lost it. A WeakRef-free plain ref: the element is checked for
    // `isConnected` before any use, so a removed one is never focused.
    let remembered: Element | null = null
    let queued = false

    const onBlur = () => { remembered = document.activeElement }

    const apply = () => {
      queued = false
      const current = document.activeElement
      const { laneOnScreen } = view()
      const input = primaryInput()
      const plan = refocusTarget({
        current: classifyFocus(current as HTMLElement | null),
        remembered: remembered ? { kind: classifyFocus(remembered as HTMLElement), usable: visible(remembered) } : undefined,
        laneOnScreen,
        hasPrimaryInput: !!input,
      })
      try {
        if (plan.kind === 'restore') (remembered as HTMLElement).focus()
        else if (plan.kind === 'terminal') getTerminal(plan.terminalId)?.focus()
        else if (plan.kind === 'primary-input') input?.focus()
      } catch { /* an element torn down between the check and the focus */ }
    }

    const onActivate = () => {
      if (queued) return
      queued = true
      requestAnimationFrame(apply)
    }
    const onVisibility = () => { if (document.visibilityState === 'visible') onActivate() }

    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onActivate)
    document.addEventListener('visibilitychange', onVisibility)
    const offMain = window.operator.onWindowActivated?.(onActivate)
    return () => {
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onActivate)
      document.removeEventListener('visibilitychange', onVisibility)
      offMain?.()
    }
    // `view` is read at activation time; it is a ref-backed getter, stable for the component's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
