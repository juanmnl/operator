import { useLayoutEffect, useState, type RefObject } from 'react'

// WHERE A DROPDOWN OPENS: above or below its trigger, and how tall it may be.
//
// Written for the Team tab's "+ Add agent" menu, which always opened upward. It lives in a scroll
// container under the project header, and once the preset list grew (the Infra preset) its top
// ran past the container's top edge, under the header, where nothing could reach it: an absolutely
// positioned child that overflows a scroller's TOP cannot be scrolled to. Clamping the window was
// not enough, because the thing doing the clipping is the scroller, not the window.
//
// The rule: open on the preferred side if the whole menu fits there; else on the other side if it
// fits there; else on whichever side has more room, capped to that room, and the menu scrolls
// inside itself. "Room" is measured inside every ancestor that clips (overflow other than
// visible), intersected with the window.

export interface Box { top: number; bottom: number }
export type MenuSide = 'above' | 'below'
export interface MenuPlacement { side: MenuSide; maxHeight: number }

/** Pure: the side and the height cap for a menu `height` tall, opening from `anchor`, inside
 *  `bounds` (both in window coordinates). `gap` is the space between trigger and menu; `margin`
 *  keeps the menu off the bounds' edge. */
export function placeMenu(o: {
  anchor: Box; bounds: Box; height: number; prefer: MenuSide; gap?: number; margin?: number
}): MenuPlacement {
  const gap = o.gap ?? 4, margin = o.margin ?? 6
  const room: Record<MenuSide, number> = {
    above: Math.max(0, Math.floor(o.anchor.top - gap - (o.bounds.top + margin))),
    below: Math.max(0, Math.floor(o.bounds.bottom - margin - (o.anchor.bottom + gap))),
  }
  const other: MenuSide = o.prefer === 'above' ? 'below' : 'above'
  if (room[o.prefer] >= o.height) return { side: o.prefer, maxHeight: o.height }
  if (room[other] >= o.height) return { side: other, maxHeight: o.height }
  const side = room[o.prefer] >= room[other] ? o.prefer : other
  return { side, maxHeight: room[side] }
}

/** The part of the window `el` can actually be seen in: the window, cut down by every ancestor
 *  whose overflow clips. */
export function visibleBounds(el: Element): Box {
  let top = 0, bottom = window.innerHeight
  for (let p = el.parentElement; p; p = p.parentElement) {
    const cs = getComputedStyle(p)
    if (cs.overflowY === 'visible' && cs.overflowX === 'visible') continue
    const r = p.getBoundingClientRect()
    top = Math.max(top, r.top)
    bottom = Math.min(bottom, r.bottom)
  }
  return { top, bottom }
}

/** Places an open menu: measured before paint, again on window resize. The menu renders on
 *  `prefer`'s side with no cap until measured (both happen before the first paint). `anchorRef`
 *  is the trigger; `menuRef` the menu. */
export function useMenuPlacement(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
  prefer: MenuSide,
  opts: { gap?: number; margin?: number } = {},
): MenuPlacement | null {
  const [place, setPlace] = useState<MenuPlacement | null>(null)
  const { gap, margin } = opts
  useLayoutEffect(() => {
    if (!open) { setPlace(null); return }
    const measure = () => {
      const a = anchorRef.current, m = menuRef.current
      if (!a || !m) return
      const r = a.getBoundingClientRect()
      // Natural height INCLUDING borders: `scrollHeight` leaves them out, so a cap of exactly
      // `scrollHeight` on a border-box menu came out 2px short and drew a scrollbar on a menu
      // that fitted. +1 because `scrollHeight` is rounded and fractional rows (12px text at 1.2
      // line-height) left the capped box a fraction short, which still drew the scrollbar.
      const height = m.scrollHeight + (m.offsetHeight - m.clientHeight) + 1
      const next = placeMenu({ anchor: { top: r.top, bottom: r.bottom }, bounds: visibleBounds(a), height, prefer, gap, margin })
      setPlace((cur) => (cur && cur.side === next.side && cur.maxHeight === next.maxHeight ? cur : next))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open, anchorRef, menuRef, prefer, gap, margin])
  return place
}
