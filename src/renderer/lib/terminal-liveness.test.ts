import { describe, it, expect } from 'vitest'
import { endedByBackend } from './terminal-liveness'

describe('endedByBackend', () => {
  it('marks a tab ended when the backend says its child exited', () => {
    const tabs = [{ id: 't4' }]
    expect(endedByBackend(tabs, [{ id: 't4', alive: false }])).toEqual(['t4'])
  })

  it('marks a tab ended when the pty is gone from the list entirely', () => {
    // The renderer was dead when `terminal:exit` fired, so it never heard about t4.
    const tabs = [{ id: 't4' }, { id: 't7' }]
    expect(endedByBackend(tabs, [{ id: 't7', alive: true }])).toEqual(['t4'])
  })

  it('leaves live tabs alone', () => {
    const tabs = [{ id: 't1' }, { id: 't2' }]
    const live = [{ id: 't1', alive: true }, { id: 't2', alive: true }]
    expect(endedByBackend(tabs, live)).toEqual([])
  })

  it('returns nothing when a tab is ALREADY ended — the caller can skip the update', () => {
    const tabs = [{ id: 't4', ended: true }]
    expect(endedByBackend(tabs, [{ id: 't4', alive: false }])).toEqual([])
    expect(endedByBackend(tabs, [])).toEqual([])
  })

  it('never un-ends a tab, even if a reused id reports alive', () => {
    const tabs = [{ id: 't4', ended: true }]
    expect(endedByBackend(tabs, [{ id: 't4', alive: true }])).toEqual([])
  })

  it('ends every tab when the backend has no ptys at all', () => {
    // The whole backend run died. All of them are gone, and saying so is what routes the next
    // dispatch to a fresh launch instead of into a corpse.
    const tabs = [{ id: 't1' }, { id: 't2' }]
    expect(endedByBackend(tabs, [])).toEqual(['t1', 't2'])
  })

  it('reproduces the 2026-08-04 failure: a dispatch target dead for hours still reads live', () => {
    // t4 = the Code lane. Its claude process had been gone five hours; the renderer still had
    // the tab un-ended, so routeDispatch took the `send` path and two tasks were filed as
    // running against it. With the backend consulted, t4 is ended and the route becomes a launch.
    const tabs = [{ id: 't0' }, { id: 't4' }, { id: 't5' }]
    const live = [{ id: 't0', alive: true }, { id: 't4', alive: false }, { id: 't5', alive: true }]
    expect(endedByBackend(tabs, live)).toEqual(['t4'])
  })
})
