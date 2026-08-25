import { describe, it, expect } from 'vitest'
import {
  emptyHoverCard, hoverCardReducer, isOpen, HOVER_REST_MS,
  type HoverCardState, type HoverCardEvent,
} from './hover-card-machine'

const run = (events: HoverCardEvent[], from: HoverCardState = emptyHoverCard()): HoverCardState =>
  events.reduce(hoverCardReducer, from)

const enter = (id: string, now = 0): HoverCardEvent => ({ type: 'enter', id, now })
const rest = (id: string): HoverCardEvent => ({ type: 'rest', id })
const leave = (id: string): HoverCardEvent => ({ type: 'leave', id })
const close: HoverCardEvent = { type: 'close' }

describe('the rest delay — no card while flicking through orbs', () => {
  it('an enter opens NOTHING until the pointer has rested', () => {
    const s = run([enter('a')])
    expect(s.openFor).toBeNull()
    expect(s.pendingFor).toBe('a')
  })

  it('resting opens it', () => {
    expect(run([enter('a'), rest('a')]).openFor).toBe('a')
  })

  // Flicking down a column: five orbs entered in turn, none rested on. The old behaviour opened
  // one card per orb passed over, which is both the noise and the condition under which several
  // ended up stranded at once.
  it('flicking through five targets opens none of them', () => {
    const s = run([enter('a'), enter('b'), enter('c'), enter('d'), enter('e')])
    expect(s.openFor).toBeNull()
    expect(s.pendingFor).toBe('e')
  })

  it('a stale rest for an abandoned target is a no-op — which is why the timer need not be cancelled', () => {
    const s = run([enter('a'), enter('b'), rest('a')])
    expect(s.openFor).toBeNull()
    expect(s.pendingFor).toBe('b')
  })

  it('records when the rest began, so the caller can schedule the reveal', () => {
    expect(run([enter('a', 1000)]).pendingSince).toBe(1000)
    expect(HOVER_REST_MS).toBe(150)
  })
})

// THE BUG, as an invariant. The screenshot had seven cards open at once; with a single `openFor`
// field there is nowhere for a second one to live, and these are the sequences that used to
// produce them.
describe('at most one card, by construction', () => {
  it('entering a new target closes the open one IMMEDIATELY, not after the new rest', () => {
    const s = run([enter('a'), rest('a'), enter('b')])
    expect(s.openFor).toBeNull()          // 'a' is already gone
    expect(s.pendingFor).toBe('b')        // …and 'b' has not earned one yet
  })

  it('no sequence of enters and rests can open two', () => {
    let s = emptyHoverCard()
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      s = run([enter(id), rest(id)], s)
      const openCount = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].filter((x) => isOpen(s, x)).length
      expect(openCount).toBe(1)
    }
    expect(s.openFor).toBe('g')
  })

  it('re-entering the target that is already open changes nothing', () => {
    const open = run([enter('a'), rest('a')])
    expect(hoverCardReducer(open, enter('a'))).toBe(open) // same object — no re-render
  })
})

describe('leave is scoped to its target', () => {
  it('closes the card it names', () => {
    expect(run([enter('a'), rest('a'), leave('a')]).openFor).toBeNull()
  })

  it('cancels a pending rest', () => {
    expect(run([enter('a'), leave('a')]).pendingFor).toBeNull()
  })

  // A row the pointer has already moved off can deliver its `mouseleave` late — after the next
  // row has opened. Closing on it would make the card flicker out from under the cursor.
  it('a LATE leave from an abandoned row does not close the card that replaced it', () => {
    const s = run([enter('a'), rest('a'), enter('b'), rest('b'), leave('a')])
    expect(s.openFor).toBe('b')
  })

  it('is a no-op for a target that was never tracked', () => {
    const open = run([enter('a'), rest('a')])
    expect(hoverCardReducer(open, leave('zzz'))).toBe(open)
  })
})

// Every close path is ONE transition. A card that closes on six events and not the seventh is
// how this survived its first fix — so the reducer has exactly one way to close, and the hook
// wires every event to it.
describe('close — the single transition every global event maps to', () => {
  it('closes an open card', () => {
    expect(run([enter('a'), rest('a'), close]).openFor).toBeNull()
  })

  it('cancels a pending one', () => {
    expect(run([enter('a'), close]).pendingFor).toBeNull()
  })

  it('is identity when nothing is open — no needless re-render on every keystroke', () => {
    const empty = emptyHoverCard()
    expect(hoverCardReducer(empty, close)).toBe(empty)
  })

  it('leaves nothing behind that a later enter could resurrect', () => {
    const s = run([enter('a'), rest('a'), close])
    expect(s).toEqual(emptyHoverCard())
  })
})

describe('isOpen', () => {
  it('is true for exactly one id and false for every other', () => {
    const s = run([enter('a'), rest('a')])
    expect(isOpen(s, 'a')).toBe(true)
    expect(isOpen(s, 'b')).toBe(false)
  })
  it('is false while a rest is still pending', () => {
    expect(isOpen(run([enter('a')]), 'a')).toBe(false)
  })
})
