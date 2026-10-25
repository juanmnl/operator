import { describe, it, expect } from 'vitest'
import { closeKeyAction, LaneCloses } from './close-key'

const lane = (phase: string, status = 'active') => ({ terminalId: 't1', status, phase })

describe('closeKeyAction — ⌘W on the active lane', () => {
  it('closes an idle or waiting lane on the first press', () => {
    expect(closeKeyAction(lane('idle'), null, 0)).toBe('close')
    expect(closeKeyAction(lane('waiting'), null, 0)).toBe('close')
  })

  it('arms on a mid-turn lane: running, compacting or asking', () => {
    for (const phase of ['running', 'compacting', 'asking']) expect(closeKeyAction(lane(phase), null, 0)).toBe('arm')
  })

  it('closes on the second press inside the window', () => {
    expect(closeKeyAction(lane('running'), { terminalId: 't1', until: 2500 }, 2499)).toBe('close')
  })

  it('arms again once the window has passed, or for another lane', () => {
    expect(closeKeyAction(lane('running'), { terminalId: 't1', until: 2500 }, 2500)).toBe('arm')
    expect(closeKeyAction(lane('running'), { terminalId: 't2', until: 2500 }, 100)).toBe('arm')
  })

  it('closes an ended or suspended lane at once, whatever its last phase', () => {
    expect(closeKeyAction(lane('running', 'ended'), null, 0)).toBe('close')
  })
})

describe('closeKeyAction — a held ⌘W (review R1)', () => {
  it('ignores an auto-repeat, armed or not, so holding the keys does not arm and close in one gesture', () => {
    expect(closeKeyAction(lane('running'), null, 0, true)).toBe('ignore')
    expect(closeKeyAction(lane('running'), { terminalId: 't1', until: 2500 }, 400, true)).toBe('ignore')
    // Nor close the lane that became active after a close.
    expect(closeKeyAction(lane('idle'), null, 0, true)).toBe('ignore')
  })
})

describe('LaneCloses — one close per lane, whoever asks (review R2/R3)', () => {
  const deferred = <T,>() => {
    let resolve!: (v: T) => void
    const promise = new Promise<T>((r) => { resolve = r })
    return { promise, resolve }
  }

  it('a second ask while the first is running gets the first close', async () => {
    const closes = new LaneCloses<string>()
    const first = deferred<string>()
    let started = 0
    const a = closes.run('t1', () => { started++; return first.promise })
    const b = closes.run('t1', () => { started++; return Promise.resolve('second') })
    expect(b).toBe(a)
    first.resolve('closed')
    expect(await b).toBe('closed')
    expect(started).toBe(1)
  })

  it('starts a new close once the first has settled', async () => {
    const closes = new LaneCloses<string>()
    await closes.run('t1', async () => 'one')
    expect(await closes.run('t1', async () => 'two')).toBe('two')
  })

  it('files a woken lane\'s close under its new id too, and remembers it', async () => {
    const closes = new LaneCloses<string>()
    const wake = deferred<void>()
    const done = deferred<string>()
    const a = closes.run('t-old', async (alias) => { await wake.promise; alias('t-new'); return done.promise })
    wake.resolve()
    await Promise.resolve(); await Promise.resolve()
    // Retry, or a ■ on the resumed lane's row, asks under the new id.
    expect(closes.run('t-new', async () => 'second')).toBe(a)
    expect(closes.closedAs('t-old')).toBe('t-new')
    done.resolve('closed')
    await a
    expect(await closes.run('t-new', async () => 'later')).toBe('later')
    closes.forget('t-old')
    expect(closes.closedAs('t-old')).toBeUndefined()
  })
})
