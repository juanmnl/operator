import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import {
  HOVER_REST_MS, emptyHoverCard, hoverCardReducer, isOpen,
  type HoverCardEvent, type HoverCardState,
} from './hover-card-machine'

// ONE CONTROLLER for the sidebar's fixed-position hover cards, shared by SessionItem, the rail's
// project headers and the rail's lane orbs. They are the same widget.
//
// THE REWRITE, and why the previous shape could not be patched. This file used to give every row
// its own `useState` pair plus a module-level "owner" slot that a new card evicted by calling a
// closure back into whoever held it. A screenshot with SEVEN cards open at once
// (`rail-hover-cards-stuck-2026-08-24.png`) is what that guarantee was actually worth: the slot
// only ever reached the holder through that one closure, so any path that left a row's state
// `true` without going through it — a remount under the cursor, a re-render that recreated the
// row, a module re-evaluation — stranded a card nothing afterwards could close.
//
// Now the state lives OUTSIDE the rows, in one store, with a single `openFor` field. At most one
// card is not a lock that can be defeated; it is the shape of the data. A row renders a card iff
// it is that id, so a stranded card has nowhere to exist.
//
// The card's own styling is untouched — this file owns WHEN, never HOW.

// --- the store ------------------------------------------------------------------------------

let state: HoverCardState = emptyHoverCard()
const listeners = new Set<() => void>()

function dispatch(event: HoverCardEvent): void {
  const next = hoverCardReducer(state, event)
  if (next === state) return
  state = next
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/** Close everything. Exported so a surface that knows it is about to move the world — a menu
 *  opening, a drag starting — can say so without reaching for a row. */
export function closeHoverCards(): void {
  dispatch({ type: 'close' })
}

// --- the global close listeners, installed once ----------------------------------------------
//
// EVERY WAY A POINTER STOPS BEING OVER A ROW. The old hook covered three of these; the rest are
// why cards survived ⌘Tab, a scroll that slid the row out from under a stationary cursor, and the
// rail re-rendering mid-hover. They are installed once at module scope rather than per hovered
// row, because "close everything" is not a per-row concern and per-row listeners were themselves
// a way for a stranded card to end up with none.
if (typeof window !== 'undefined') {
  const close = () => closeHoverCards()
  window.addEventListener('blur', close)
  window.addEventListener('resize', close)
  document.addEventListener('visibilitychange', close)
  // `mouseout` with a null relatedTarget is the reliable "pointer left the document" signal;
  // `mouseleave` on documentElement covers the browsers that prefer it.
  document.addEventListener('mouseout', (e) => { if (!(e as MouseEvent).relatedTarget) close() })
  document.documentElement.addEventListener('mouseleave', close)
  // Capture: the sidebar scroller's own scroll does not bubble, and a scroll is precisely the
  // event that moves a row out from under a cursor that never moved.
  document.addEventListener('scroll', close, true)
  // Any keydown. Someone who has started typing is not reading a hover card, and this also
  // catches ⌘Tab-adjacent chords that never produce a blur.
  document.addEventListener('keydown', close, true)
}

export interface HoverCard {
  /** Viewport coordinates for the fixed-position card, or null when this row's card is closed. */
  card: { top: number; left: number } | null
  hovered: boolean
  onMouseEnter: (e: ReactMouseEvent) => void
  onMouseLeave: () => void
  /** Attach to the row so the card can follow it while open. */
  ref: React.RefObject<HTMLElement | null>
  /** Dismiss from outside (a context menu opening over the row, a drag starting). */
  dismiss: () => void
}

export function useHoverCard(id: string, offset = 8): HoverCard {
  const open = useSyncExternalStore(subscribe, () => isOpen(state, id), () => false)
  const ref = useRef<HTMLElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const timerRef = useRef<number | null>(null)

  const dismiss = useCallback(() => { dispatch({ type: 'leave', id }) }, [id])

  const onMouseEnter = useCallback((_e: ReactMouseEvent) => {
    dispatch({ type: 'enter', id, now: Date.now() })
    if (timerRef.current) window.clearTimeout(timerRef.current)
    // The rest delay: flicking down a column of orbs to find one should show no cards at all.
    // The timer is not cancelled on leave — a stale `rest` for a target that is no longer
    // pending is a no-op in the reducer, which is cheaper than tracking cancellations.
    timerRef.current = window.setTimeout(() => dispatch({ type: 'rest', id }), HOVER_REST_MS)
  }, [id])

  // Position is measured when the card OPENS and re-measured while it stays open, so a row that
  // moves under a resting cursor takes its card with it rather than leaving it behind.
  useEffect(() => {
    if (!open) { setPos(null); return }
    const measure = () => {
      const el = ref.current
      if (!el) { dispatch({ type: 'close' }); return }
      const r = el.getBoundingClientRect()
      setPos((prev) => (prev && prev.top === r.top && prev.left === r.right + offset
        ? prev
        : { top: r.top, left: r.right + offset }))
    }
    measure()
    // Re-measure on the animation frame rather than on every render: the rail re-renders on
    // every transcript tick, and this must not turn that into a layout read per row.
    const raf = window.setInterval(measure, 200)
    return () => window.clearInterval(raf)
  }, [open, offset])

  // A row that unmounts while holding the card must not leave it open — the exact stranding this
  // rewrite exists for, and the one the old owner-slot could not reach.
  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current)
    if (isOpen(state, id)) dispatch({ type: 'close' })
  }, [id])

  return { card: open ? pos : null, hovered: open, onMouseEnter, onMouseLeave: dismiss, ref, dismiss }
}
