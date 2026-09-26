import { describe, expect, it } from 'vitest'
import { placeMenu } from './menu-placement'

// Window coordinates. The Team tab's scroller runs from under the project header (y 90) to the
// card's foot; "+ Add agent" is a 30px row.
const bounds = { top: 90, bottom: 690 }

describe('placeMenu — open where there is room, else scroll inside', () => {
  it('keeps the preferred side when the whole menu fits there', () => {
    expect(placeMenu({ anchor: { top: 600, bottom: 630 }, bounds, height: 290, prefer: 'above' }))
      .toEqual({ side: 'above', maxHeight: 290 })
  })

  it('THE REPORTED CASE: a short roster puts the trigger near the header, so it flips below instead of running under the header', () => {
    // 3 lanes: the trigger sits ~120px under the header. Above has ~110px, below has ~430px.
    expect(placeMenu({ anchor: { top: 210, bottom: 240 }, bounds, height: 290, prefer: 'above' }))
      .toEqual({ side: 'below', maxHeight: 290 })
  })

  it('neither side fits: takes the roomier side and caps the height to it', () => {
    // A 700px window: the scroller is only ~350px tall.
    const short = { top: 90, bottom: 440 }
    const p = placeMenu({ anchor: { top: 250, bottom: 280 }, bounds: short, height: 290, prefer: 'above' })
    expect(p.side).toBe('above') // 150 above vs 150 below: ties keep the preferred side
    expect(p.maxHeight).toBeLessThan(290)
    expect(p.maxHeight).toBe(250 - 4 - (90 + 6))
  })

  it('never lets the menu start past the bounds (the header edge), whatever the side', () => {
    const anchor = { top: 150, bottom: 180 }
    const p = placeMenu({ anchor, bounds, height: 900, prefer: 'above' })
    const top = p.side === 'above' ? anchor.top - 4 - p.maxHeight : anchor.bottom + 4
    const bottom = p.side === 'above' ? anchor.top - 4 : anchor.bottom + 4 + p.maxHeight
    expect(top).toBeGreaterThanOrEqual(bounds.top)
    expect(bottom).toBeLessThanOrEqual(bounds.bottom)
  })

  it('a downward menu (toolbar) flips up only when below cannot hold it and above can', () => {
    expect(placeMenu({ anchor: { top: 640, bottom: 660 }, bounds, height: 200, prefer: 'below' }).side).toBe('above')
    expect(placeMenu({ anchor: { top: 100, bottom: 120 }, bounds, height: 200, prefer: 'below' }).side).toBe('below')
  })
})
