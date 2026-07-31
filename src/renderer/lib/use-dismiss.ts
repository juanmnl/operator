import { useEffect, useRef } from 'react'

// ONE dismissal contract for popovers, and it is the third implementation of this idea rather
// than the first — which is why it is a hook.
//
// `PlanMeter` already had Escape + outside-mousedown inline, and `PopMenu` was about to grow its
// own. (`useHoverCard` is NOT this: it solves cards stranded when a row moves or the cursor leaves
// the window, which is a hover problem, not a dismissal one — nothing there was reusable here.)
//
// THE CONTRACT, all of it, because a popover that closes on one input and not another is the same
// bug reported twice:
//
//   outside pointer-down   closes. POINTER-down, not click: a drag that starts inside the panel
//                          and ends outside must not dismiss, and one that starts outside and ends
//                          inside must — `click` fires on the common ancestor and gets both wrong.
//   Escape                 closes, and returns focus to whatever had it when the panel opened.
//   focus leaving          closes. A menu that survives Tab is the same bug with another input.
//   scroll                 closes. See the note on `onScroll` below.
//   choosing an item       the caller already closes; untouched.
export function useDismiss(open: boolean, opts: {
  /** The panel itself. Pointer-downs inside it are never "outside". */
  panelRef: React.RefObject<HTMLElement | null>
  onDismiss: () => void
  /** Triggers carry `data-popmenu-trigger`; a pointer-down on one is not "outside" either, or the
   *  toggle would close on the way down and reopen on the click. */
  triggerAttr?: string
}) {
  const { panelRef, onDismiss, triggerAttr = 'data-popmenu-trigger' } = opts
  // The element to hand focus back to. Captured at OPEN, not at dismiss — by then the panel has
  // usually taken it.
  const returnTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    returnTo.current = document.activeElement as HTMLElement | null

    const isInside = (t: Node | null) =>
      !!t && (panelRef.current?.contains(t) || !!(t instanceof Element ? t.closest(`[${triggerAttr}]`) : (t.parentElement?.closest(`[${triggerAttr}]`))))

    const onDown = (e: PointerEvent) => { if (!isInside(e.target as Node)) onDismiss() }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onDismiss()
      // Prefer whatever held focus when the panel opened; fall back to the expanded trigger.
      // The capture is not always useful — a pointer-opened menu can leave `activeElement` on
      // `body` in WebKit, which is what "focus after Escape: BODY" measured — so the fallback is
      // the reliable path rather than a belt-and-braces one.
      const back = (returnTo.current && returnTo.current !== document.body)
        ? returnTo.current
        : document.querySelector<HTMLElement>(`[${triggerAttr}][aria-expanded="true"]`)
      back?.focus?.()
    }

    // Focus leaving the panel and its trigger. Deferred a tick: `focusout` fires BEFORE the new
    // element takes focus, so `document.activeElement` is still `body` at that moment and an
    // immediate check would dismiss on every internal focus move.
    const onFocusOut = () => {
      window.setTimeout(() => {
        if (!isInside(document.activeElement)) onDismiss()
      }, 0)
    }

    // CLOSES on scroll rather than repositioning. Both current callers anchor to a non-scrolling
    // ancestor (the composer sits outside the feed's scroller), so nothing detaches today — but a
    // scroll is an unambiguous "I moved on", it is what platform menus do, and it means a future
    // caller anchored INSIDE a scroller cannot silently drift away from its trigger.
    // Capture phase, so a scroll anywhere is seen; a scroll within the panel is ignored so a long
    // menu can still scroll itself.
    const onScroll = (e: Event) => { if (!panelRef.current?.contains(e.target as Node)) onDismiss() }

    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('focusout', onFocusOut, true)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('focusout', onFocusOut, true)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [open, panelRef, onDismiss, triggerAttr])
}
