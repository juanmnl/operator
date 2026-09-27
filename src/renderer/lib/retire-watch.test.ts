import { describe, it, expect } from 'vitest'
import {
  noteFinishing, clearWatch, dueSignals, signalLine, finishingReason, finishingDelivery, watchFor,
  FINISHING_WATCH_MAX_MS, type WatchBook,
} from './retire-watch'

const base = { projectId: 'p1', roleId: 'code', roleName: 'Code', laneTerminalId: 't1' }

describe('noteFinishing', () => {
  it('opens one watch per role lane; a repeat extends it and dedupes who to tell', () => {
    const book: WatchBook = new Map()
    expect(noteFinishing(book, { ...base, notify: 'op', now: 0 }).repeat).toBe(false)
    const again = noteFinishing(book, { ...base, notify: 'op', now: 5 })
    expect(again.repeat).toBe(true)
    expect(again.watch.refusals).toBe(2)
    expect(again.watch.notify).toEqual(['op'])
    noteFinishing(book, { ...base, notify: 'op2', now: 6 })
    expect(watchFor(book, 'p1', 'code', 't1')?.notify).toEqual(['op', 'op2'])
  })

  it('a different lane on the role starts a new watch', () => {
    const book: WatchBook = new Map()
    noteFinishing(book, { ...base, now: 0 })
    expect(noteFinishing(book, { ...base, laneTerminalId: 't9', now: 1 }).repeat).toBe(false)
  })

  it('clearWatch drops it (the lane was retired)', () => {
    const book: WatchBook = new Map()
    noteFinishing(book, { ...base, now: 0 })
    clearWatch(book, 'p1', 'code')
    expect(book.size).toBe(0)
  })
})

describe('dueSignals — the one message, and it always comes', () => {
  const book = (): WatchBook => { const b: WatchBook = new Map(); noteFinishing(b, { ...base, notify: 'op', now: 0 }); return b }
  const at = (lane: Parameters<typeof dueSignals>[1][number], now = 1) => dueSignals(book(), [lane], now).map((d) => d.signal)

  it('idle: released, between turns and settled', () => {
    expect(at({ id: 't1', released: true, phase: 'waiting' })).toEqual(['idle'])
  })
  it('nothing while mid-turn, asking, or settling', () => {
    expect(at({ id: 't1', released: true, phase: 'running' })).toEqual([])
    expect(at({ id: 't1', released: true, phase: 'asking' })).toEqual([])
    expect(at({ id: 't1', released: true, phase: 'waiting', settling: true })).toEqual([])
  })
  it('took-work: its release was cancelled', () => {
    expect(at({ id: 't1', released: false, phase: 'running' })).toEqual(['took-work'])
  })
  it('ended: gone or ended', () => {
    expect(dueSignals(book(), [], 1).map((d) => d.signal)).toEqual(['ended'])
    expect(at({ id: 't1', ended: true, released: true })).toEqual(['ended'])
  })
  // "Unknown phase must terminate": an unseen lane never reads idle, and the ceiling ends the watch.
  it('timeout: still busy or still unseen at the ceiling', () => {
    expect(at({ id: 't1', released: true, phase: 'asking' }, FINISHING_WATCH_MAX_MS)).toEqual(['timeout'])
    expect(at({ id: 't1', released: true }, FINISHING_WATCH_MAX_MS - 1)).toEqual([])
    expect(at({ id: 't1', released: true }, FINISHING_WATCH_MAX_MS)).toEqual(['timeout'])
  })
})

describe('the lines a dispatcher reads', () => {
  const w = { ...base, notify: [], since: 0, refusals: 1 }
  it('carry no directive token, so they are never parsed as a dispatch', () => {
    for (const s of ['idle', 'took-work', 'ended', 'timeout'] as const) {
      expect(signalLine(w, s)).not.toMatch(/OPERATOR-(DISPATCH|REPLY)/)
      expect(signalLine(w, s).startsWith('[Operator] Code')).toBe(true)
    }
  })
  it('an unseen lane that timed out is handed to the user, not retried', () => {
    expect(signalLine({ ...w, unseen: true }, 'timeout')).toMatch(/Do not dispatch to it again; tell the user/)
  })
  it('first, repeat and unseen refusals say different things', () => {
    expect(finishingReason('Code', { unseen: false, repeat: false })).toMatch(/message you once when it is idle.*do not ask the user to close it/)
    expect(finishingReason('Code', { unseen: false, repeat: true, refusals: 3 })).toMatch(/already refused \(3 times\)/)
    expect(finishingReason('Code', { unseen: true, repeat: false })).toMatch(/cannot read its state, so it will not end it/)
  })
})

describe('finishingDelivery — the sentinel and approval path', () => {
  const r = { ...base, unseen: false, approving: false, dispatcher: 'op', now: 0 }

  it('a first refusal records `finishing` and types the reason into the dispatcher', () => {
    const out = finishingDelivery(new Map(), r)
    expect(out.record?.outcome).toBe('finishing')
    expect(out.feedback).toBe(out.reason)
  })

  // M1: the typed note starts the dispatcher's next turn; typing it again on every repeat was
  // the loop with no human in it.
  it('a repeat records it and types NOTHING', () => {
    const book: WatchBook = new Map()
    finishingDelivery(book, r)
    const out = finishingDelivery(book, { ...r, now: 500 })
    expect(out.record?.outcome).toBe('finishing')
    expect(out.feedback).toBeUndefined()
  })

  // M3: an approval keeps its record so the card stays in Waiting with its buttons, and the
  // watch tells the user (nobody to type into).
  it('an approval records nothing and opens a watch with no dispatcher to tell', () => {
    const book: WatchBook = new Map()
    const out = finishingDelivery(book, { ...r, approving: true })
    expect(out.record).toBeUndefined()
    expect(out.feedback).toBeUndefined()
    expect(watchFor(book, 'p1', 'code', 't1')?.notify).toEqual([])
  })
})
