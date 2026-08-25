// THE HOVER-CARD STATE MACHINE — pure, so the thing that kept going wrong is the thing that is
// tested.
//
// The bug: a screenshot with SEVEN cards open at once down the left rail
// (`/tmp/operator-shots/rail-hover-cards-stuck-2026-08-24.png` — two project headers and five
// lane orbs). `useHoverCard` already claimed to guarantee "at most one card exists app-wide" via
// a module-level owner that each new card evicts. It plainly did not hold, and the reason it
// could not is structural: **every row owned its own card state**, and the owner slot only ever
// evicted by calling back into whichever component happened to hold it. Any path that left a
// component's state `true` without going through that callback — an unmount/remount under the
// cursor, a module re-evaluation, a render that recreated the row — stranded a card that nothing
// afterwards could reach, because the only handle on it was a closure the slot no longer held.
//
// So the state moves OUT of the rows. There is one controller, it holds at most one open card by
// construction (a single `openFor` field, not a lock), and a row is a pure function of it. A
// stranded card is then not a bug that can happen: there is nowhere for a second one to live.
//
// The event list is the other half. A card must close on every way a pointer can stop being over
// a row, and the old hook covered three of them; the rest are why cards survived ⌘Tab, a scroll
// that moved the row out from under a stationary cursor, and the rail re-rendering mid-hover.

/** `null` = nothing open and nothing pending. */
export interface HoverCardState {
  /** The target whose card is OPEN. At most one, by construction. */
  openFor: string | null
  /** The target the pointer is resting on but which has not yet earned a card. */
  pendingFor: string | null
  /** When the pending rest started, so the caller can schedule the reveal. */
  pendingSince: number | null
}

export const emptyHoverCard = (): HoverCardState => ({ openFor: null, pendingFor: null, pendingSince: null })

/** How long the pointer must REST before a card appears.
 *
 *  Flicking down a column of orbs to find one should show no cards at all — the old behaviour
 *  opened one per orb passed over, which is both noisy and the condition under which several
 *  ended up stranded at once. 150ms is below the threshold where a deliberate hover feels
 *  delayed and well above an incidental pass-through. */
export const HOVER_REST_MS = 150

export type HoverCardEvent =
  /** Pointer entered a target. */
  | { type: 'enter'; id: string; now: number }
  /** Pointer left a specific target. Ignored if that target is not the one we are tracking —
   *  a late `mouseleave` from a row the pointer has moved off must not close the card that
   *  replaced it. */
  | { type: 'leave'; id: string }
  /** The rest timer for `id` elapsed. */
  | { type: 'rest'; id: string }
  /** Everything that means "the pointer is not over anything any more", collapsed into one
   *  event because they all have the same answer: rail pointerleave, window blur, document
   *  mouseleave, visibilitychange, scroll, any keydown, target unmount. */
  | { type: 'close' }

/** Pure transition. Every close path is the same transition, which is the point — a card that
 *  closes on six events and not the seventh is how this bug survived its first fix. */
export function hoverCardReducer(state: HoverCardState, event: HoverCardEvent): HoverCardState {
  switch (event.type) {
    case 'enter':
      // Entering a NEW target abandons whatever was pending and — deliberately — closes the open
      // card immediately rather than waiting out the new rest. Two cards must never coexist even
      // for 150ms, and a card that lingers over the row you just left reads as the stuck bug.
      if (state.openFor === event.id) return state
      return { openFor: null, pendingFor: event.id, pendingSince: event.now }

    case 'rest':
      // Only the target still being rested on may open. A stale timer from a row the pointer has
      // since left is a no-op, which is what makes the timer safe to leave un-cancelled.
      if (state.pendingFor !== event.id) return state
      return { openFor: event.id, pendingFor: null, pendingSince: null }

    case 'leave':
      // Scoped to the target: a late leave from an abandoned row must not close the card that
      // has already replaced it.
      if (state.openFor !== event.id && state.pendingFor !== event.id) return state
      return emptyHoverCard()

    case 'close':
      return state.openFor === null && state.pendingFor === null ? state : emptyHoverCard()
  }
}

/** Is this target's card showing? The row is a pure function of the controller. */
export const isOpen = (state: HoverCardState, id: string): boolean => state.openFor === id
