import { describe, it, expect } from 'vitest'
import type { AgentSession } from '../../shared/types'
import { sidebarSessions, type SidebarEntry, type SidebarTab } from './sidebar-sessions'

// An unchanged lane keeps ONE entry object across renders (renderer leak,
// dev/results/renderer-leak-live-lanes-2026-10-26.md): the builder used to stamp every synthetic
// entry with the render's clock, so every render made a new object for every lane, and every
// retained render kept its own copy.

const tab = (id: string, extra: Partial<SidebarTab> = {}): SidebarTab => ({ id, key: `k-${id}`, cwd: `/w/${id}`, projectId: 'p', roleId: 'qa', ...extra })
const tracked = (terminalId: string, extra: Partial<AgentSession> = {}): AgentSession => ({
  id: `claude-${terminalId}`, agentId: 'claude-code', workingDirectory: `/w/${terminalId}`, projectName: terminalId,
  status: 'active', phase: 'waiting', activity: [], activeSubagents: 0, lastToolName: null,
  startedAt: '2026-10-26T10:00:00.000Z', lastActivityAt: '2026-10-26T10:05:00.000Z', terminalId, messages: [], ...extra,
} as AgentSession)

/** A clock that moves on every read, as `new Date()` does between renders. */
function ticking() {
  let n = 0
  return () => new Date(Date.UTC(2026, 9, 26, 12, 0, n++)).toISOString()
}

describe('sidebarSessions', () => {
  it('returns the same entry objects when no tab and no tracked session changed', () => {
    const now = ticking()
    const terminals = [tab('t1'), tab('t2')]
    const sessions = [tracked('t1')]
    const first = sidebarSessions(terminals, sessions, new Map(), now)
    const second = sidebarSessions(terminals, sessions, first.cache, now)
    expect(second.sessions[0]).toBe(first.sessions[0])
    expect(second.sessions[1]).toBe(first.sessions[1])
  })

  it('stamps an untracked lane once, with the time it first got an entry', () => {
    const now = ticking()
    const t2 = tab('t2')
    const first = sidebarSessions([t2], [], new Map(), now)
    const later = sidebarSessions([t2], [], first.cache, now)
    expect(first.sessions[0].startedAt).toBe('2026-10-26T12:00:00.000Z')
    expect(later.sessions[0].startedAt).toBe('2026-10-26T12:00:00.000Z')
    expect(later.sessions[0].lastActivityAt).toBe('2026-10-26T12:00:00.000Z')
    // A changed tab rebuilds the entry but keeps the first stamp.
    const suspended = { ...t2, idleSuspendedAt: '2026-10-26T12:30:00.000Z', resumeSessionId: 'claude-old' }
    const rebuilt = sidebarSessions([suspended], [], later.cache, now)
    expect(rebuilt.sessions[0]).not.toBe(later.sessions[0])
    expect(rebuilt.sessions[0]).toMatchObject({ id: 'claude-old', suspended: true, startedAt: '2026-10-26T12:00:00.000Z' })
  })

  it('rebuilds only the lane whose tracked session changed', () => {
    const terminals = [tab('t1'), tab('t2')]
    const s1 = tracked('t1')
    const before = sidebarSessions(terminals, [s1, tracked('t2')], new Map())
    const after = sidebarSessions(terminals, [s1, tracked('t2', { phase: 'running' })], before.cache)
    expect(after.sessions[0]).toBe(before.sessions[0])
    expect(after.sessions[1]).not.toBe(before.sessions[1])
    expect(after.sessions[1].phase).toBe('running')
  })

  it('overlays the tab\'s fields on a tracked session and reads its end from the tab', () => {
    const t1 = tab('t1', { model: 'opus', ended: true })
    const [s] = sidebarSessions([t1], [tracked('t1', { model: 'claude-sonnet-5-5' })], new Map()).sessions
    expect(s).toMatchObject({ id: 'claude-t1', projectId: 'p', roleId: 'qa', savedKey: 'k-t1', model: 'opus', runningModel: 'claude-sonnet-5-5', status: 'ended' })
  })

  it('drops a lane that is gone from the cache', () => {
    const first = sidebarSessions([tab('t1'), tab('t2')], [], new Map())
    const second = sidebarSessions([tab('t2')], [], first.cache)
    expect([...second.cache.keys()]).toEqual(['t2'])
    const entry: SidebarEntry | undefined = second.cache.get('t1')
    expect(entry).toBeUndefined()
  })
})
