import { useEffect } from 'react'
import { createRefocusController } from './refocus-controller'
import { getTerminal } from './terminal-registry'

// App activation → keyboard focus, for the whole window, in ONE place. The rules are in lib/refocus,
// the event handling in lib/refocus-controller; this only wires them to the real DOM.
//
// It replaced a `window` 'focus' listener in every mounted TerminalPane, which relied on an event main
// never guaranteed and let the selected lane's HIDDEN pane take focus while the board or settings was
// showing.

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
    const c = createRefocusController<HTMLElement>({
      activeElement: () => document.activeElement as HTMLElement | null,
      hasFocus: () => document.hasFocus(),
      now: () => performance.now(),
      defer: (fn) => { setTimeout(fn, 0) },
      nextFrame: (fn) => { requestAnimationFrame(fn) },
      isUsable: visible,
      laneOnScreen: () => view().laneOnScreen,
      primaryInput,
      focusElement: (el) => el.focus(),
      focusTerminal: (id) => getTerminal(id)?.focus(),
    })
    const onBlur = () => c.onWindowBlur()
    const onInput = () => c.onUserInput()
    // Hidden → visible is an activation; visible → hidden is not.
    const onVisibility = () => { if (document.visibilityState === 'visible') c.onActivated() }
    window.addEventListener('blur', onBlur)
    window.addEventListener('pointerdown', onInput, { capture: true })
    window.addEventListener('keydown', onInput, { capture: true })
    document.addEventListener('visibilitychange', onVisibility)
    // main's activation signal. Where there is none (a bridge without it), there is no activation to
    // act on: the page's own 'focus' also fires for iframe focus changes and must not be used.
    const offMain = window.operator.onWindowActivated?.(() => c.onActivated())
    return () => {
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('pointerdown', onInput, { capture: true } as EventListenerOptions)
      window.removeEventListener('keydown', onInput, { capture: true } as EventListenerOptions)
      document.removeEventListener('visibilitychange', onVisibility)
      offMain?.()
    }
    // `view` is read at activation time; it is a ref-backed getter, stable for the component's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
