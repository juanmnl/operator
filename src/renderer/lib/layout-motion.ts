import { useEffect, useState } from 'react'

// THE LAYOUT MOVE — one toggle of the left rail (⌘B) or the right side panel.
//
// Both change the content card's width, and the card holds the terminal panes and the main-view
// Preview. Measured before this module existed (dev/results/sidepanel-collapse-redesign-2026-09-25.md):
// the rail animated `width` and the card re-laid out its whole subtree, terminal included, on every
// one of ~15 frames, while its own rows re-truncated and re-centred; the panel had no animation at
// all — the card jumped by the panel's width in one frame, and in Electron the terminal refit ~170ms
// later as a second jump. The rule now: the
// card's BOX may move every frame (its toolbar and footer are two short rows that should follow the
// edge), but the heavy content inside it is held at a fixed pixel width for the whole move and
// resizes exactly once, after the edge has stopped.

/** Duration and curve of every layout move. The rail's original values, now shared with the panel
 *  so the two edges move alike. */
export const LAYOUT_MOVE_MS = 260
export const LAYOUT_EASE = 'cubic-bezier(0.4, 0, 0.2, 1)'
/** Past the transition's end before the move is declared settled. A timer rather than
 *  `transitionend`, because a retargeted transition never fires its end event; the side panel
 *  restarts it when its animation actually starts (see `SidePanelSlot`'s `onMoveStart`). */
export const LAYOUT_SETTLE_SLACK_MS = 40

/** The `transition` value for a moving edge, or none when the OS asks for less motion — a reduced-
 *  motion toggle is one frame and one refit, with nothing in between. */
export function layoutTransition(prop: string, reduced: boolean): string {
  return reduced ? 'none' : `${prop} ${LAYOUT_MOVE_MS}ms ${LAYOUT_EASE}`
}

/** The width the heavy content is held at while a move runs: the WIDER of where it starts and
 *  where it ends, so the moving edge only ever covers or uncovers it and never exposes an empty
 *  strip beside it.
 *
 *  `liveW` is the content column's width right now (mid-move if a move is already running) and
 *  `delta` the change this toggle makes to it (negative = the column narrows). `prevPin` carries a
 *  running move's pin, so reversing mid-move keeps a width that covers both endpoints — a reversal
 *  ends where the first move started, and the first pin already covered that.
 *
 *  Resize count this buys: a narrowing move holds its START width and resizes once at the end; a
 *  widening move takes its END width at the start and — terminals being held by `suspendFit` —
 *  still refits once, at the end. */
export function pinWidth(prevPin: number | null, liveW: number, delta: number): number {
  return Math.round(Math.max(prevPin ?? 0, liveW, liveW + delta))
}

/** Whether the user asked the OS for less motion. Follows changes live. */
export function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia(query)
    const on = () => setReduced(mq.matches)
    on()
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  return reduced
}
