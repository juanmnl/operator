import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'

// ONE implementation of the sidebar's fixed-position lane hover card, shared by SessionItem
// and SidebarRail. They are the same widget; keeping two copies is how only one of them ended
// up hardened, and the unhardened one kept drifting behind.
//
// Two ways a card gets stranded, and this handles both:
//
//  1. THE ROW MOVES under a stationary cursor. The list is live (agents come and go, rows
//     reorder), so a row can slide away with no mousemove and therefore no mouseleave. Fixed
//     by re-verifying after every render and on scroll: hit-test the last known pointer with
//     elementFromPoint — still inside the row → follow it, otherwise treat it as a leave.
//     (elementFromPoint, not rect maths, so a row clipped by the scroller or covered by an
//     overlay also counts as "not under the cursor".)
//
//  2. THE CURSOR LEAVES THE WINDOW while the row stays put — ⌘Tab, focus lost, cursor flicked
//     off-window. No further mousemove arrives, WKWebView doesn't reliably deliver mouseleave,
//     and (1)'s hit-test happily re-confirms a stale in-window coordinate that is still over
//     the row. That is the "two cards frozen over the transcript" report: hover A → leave the
//     window → hover B → leave again.
//
// And one structural guarantee: AT MOST ONE CARD EXISTS APP-WIDE. Two at once is a state no
// correct implementation should permit, so a new card evicts the previous holder rather than
// every dismissal path having to fire. Any future leak self-heals on the next hover.
//
// Deliberately NOT a dismissal timeout: a card that vanishes while genuinely hovered is a new
// bug, and a timer hides the state error instead of removing it.

/** The single live card, app-wide. A claim evicts whoever held it. */
let owner: { id: string; release: () => void } | null = null

function claim(id: string, release: () => void) {
  if (owner && owner.id !== id) owner.release()
  owner = { id, release }
}
function releaseIfOwner(id: string) {
  if (owner?.id === id) owner = null
}

export interface HoverCard {
  /** Viewport coordinates for the fixed-position card, or null when nothing is hovered. */
  card: { top: number; left: number } | null
  hovered: boolean
  /** Spread onto the row element (it also needs `ref`). */
  onMouseEnter: (e: ReactMouseEvent) => void
  onMouseLeave: () => void
  /** Attach to the row so its position can be re-verified. */
  ref: React.RefObject<HTMLElement | null>
  /** Dismiss from outside (e.g. a context menu opening over the row). */
  dismiss: () => void
}

export function useHoverCard(id: string, offset = 8): HoverCard {
  const [hovered, setHovered] = useState(false)
  const [card, setCard] = useState<{ top: number; left: number } | null>(null)
  const ref = useRef<HTMLElement | null>(null)
  const pointerRef = useRef<{ x: number; y: number } | null>(null)

  const dismiss = useCallback(() => {
    setHovered(false)
    setCard(null)
    pointerRef.current = null
    releaseIfOwner(id)
  }, [id])

  const onMouseEnter = useCallback((e: ReactMouseEvent) => {
    pointerRef.current = { x: e.clientX, y: e.clientY }
    claim(id, () => { setHovered(false); setCard(null) })
    setHovered(true)
    const r = e.currentTarget.getBoundingClientRect()
    setCard({ top: r.top, left: r.right + offset })
  }, [id, offset])

  const syncHover = useCallback(() => {
    if (!hovered) return
    const el = ref.current
    if (!el) return
    // An unfocused document means the cursor is not meaningfully over anything, whatever the
    // last coordinate said. This is the complement of the hit-test below.
    if (!document.hasFocus()) { dismiss(); return }
    const p = pointerRef.current
    if (p) {
      const hit = document.elementFromPoint(p.x, p.y)
      if (!hit || !el.contains(hit)) { dismiss(); return }
    }
    const r = el.getBoundingClientRect()
    setCard((prev) => (prev && prev.top === r.top && prev.left === r.right + offset
      ? prev
      : { top: r.top, left: r.right + offset }))
  }, [hovered, dismiss, offset])

  // No dep array on purpose — this must run after EVERY render, because the trigger is the
  // list re-rendering around us, not any state of our own.
  useEffect(syncHover)

  useEffect(() => {
    if (!hovered) return
    const onMove = (e: MouseEvent) => { pointerRef.current = { x: e.clientX, y: e.clientY } }
    // `mouseout` with a null relatedTarget is the reliable "pointer left the document" signal;
    // blur and visibilitychange cover app switches where no mouse event arrives at all.
    const onOut = (e: MouseEvent) => { if (!e.relatedTarget) dismiss() }
    window.addEventListener('mousemove', onMove)
    document.addEventListener('mouseout', onOut)
    window.addEventListener('blur', dismiss)
    document.addEventListener('visibilitychange', dismiss)
    // Capture: the sidebar scroller's own scroll doesn't bubble.
    document.addEventListener('scroll', syncHover, true)
    return () => {
      window.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseout', onOut)
      window.removeEventListener('blur', dismiss)
      document.removeEventListener('visibilitychange', dismiss)
      document.removeEventListener('scroll', syncHover, true)
    }
  }, [hovered, dismiss, syncHover])

  // Unmounting while holding the card must not leave the slot claimed.
  useEffect(() => () => releaseIfOwner(id), [id])

  return { card, hovered, onMouseEnter, onMouseLeave: dismiss, ref, dismiss }
}
