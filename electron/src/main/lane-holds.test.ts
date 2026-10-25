import { describe, it, expect } from 'vitest'
import { LaneHolds, OWED_LIMIT } from './lane-holds'

const entry = (key: string, at: number, terminalId = 't1') => ({ key, terminalId, text: `msg ${key}`, at })

describe('lane holds (review F1: a held message survives a renderer reload)', () => {
  it('hands the owed messages to the next renderer, oldest first, once', () => {
    const h = new LaneHolds()
    h.apply({ kind: 'owe', entry: entry('b', 20) })
    h.apply({ kind: 'owe', entry: entry('a', 10) })
    h.apply({ kind: 'owe', entry: entry('c', 30) })
    h.apply({ kind: 'settle', key: 'c' })
    expect(h.take().owed.map((e) => e.key)).toEqual(['a', 'b'])
    expect(h.take().owed).toEqual([])
  })

  it('keeps the draft flags across takes, and drops one when it is cleared', () => {
    const h = new LaneHolds()
    h.apply({ kind: 'draft', terminalId: 't1', on: true })
    h.apply({ kind: 'draft', terminalId: 't2', on: true })
    h.apply({ kind: 'draft', terminalId: 't2', on: false })
    expect(h.take().drafts).toEqual(['t1'])
    expect(h.take().drafts).toEqual(['t1'])
  })

  it('stays bounded when settles were lost', () => {
    const h = new LaneHolds()
    for (let i = 0; i < OWED_LIMIT + 5; i++) h.apply({ kind: 'owe', entry: entry(`k${i}`, i) })
    const owed = h.take().owed
    expect(owed).toHaveLength(OWED_LIMIT)
    expect(owed[0].key).toBe('k5')
  })

  it('keeps whether the draft held a message, with its images and reports (review S4/S5)', () => {
    const h = new LaneHolds()
    h.apply({ kind: 'owe', entry: { ...entry('a', 10), images: ['/tmp/a.png'], reports: [7] } })
    h.apply({ kind: 'held', key: 'a', on: true })
    h.apply({ kind: 'held', key: 'gone', on: true })
    expect(h.take().owed).toEqual([{ ...entry('a', 10), images: ['/tmp/a.png'], reports: [7], held: true }])
  })
})
