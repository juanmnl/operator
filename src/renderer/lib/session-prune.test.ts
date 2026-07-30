import { describe, it, expect } from 'vitest'
import type { SavedSession } from '../../shared/types'
import { pruneSavedSessions } from './session-prune'

const s = (o: Partial<SavedSession> = {}): SavedSession => ({
  key: o.key ?? crypto.randomUUID(),
  cwd: '/p',
  projectName: 'p',
  lastActiveAt: '2026-07-01T00:00:00.000Z',
  ...o,
})

describe('pruneSavedSessions', () => {
  it('keeps the most recently active of a duplicate lane group', () => {
    const saved = [
      s({ key: 'old', projectId: 'p1', roleId: 'code', lastActiveAt: '2026-07-21T00:00:00.000Z' }),
      s({ key: 'new', projectId: 'p1', roleId: 'code', lastActiveAt: '2026-07-30T00:00:00.000Z' }),
      s({ key: 'mid', projectId: 'p1', roleId: 'code', lastActiveAt: '2026-07-23T00:00:00.000Z' }),
    ]
    const { kept, dropped } = pruneSavedSessions(saved, new Set())
    expect(kept.map((x) => x.key)).toEqual(['new'])
    expect(dropped.map((x) => x.key).sort()).toEqual(['mid', 'old'])
  })

  it('NEVER prunes a record whose session is live, even as a duplicate', () => {
    // The guard the brief demands: only reap what is confirmed gone.
    const saved = [
      s({ key: 'live-but-older', projectId: 'p1', roleId: 'code', lastActiveAt: '2026-07-21T00:00:00.000Z', claudeSessionId: 'uuid-live' }),
      s({ key: 'newer', projectId: 'p1', roleId: 'code', lastActiveAt: '2026-07-30T00:00:00.000Z' }),
    ]
    const { kept, dropped } = pruneSavedSessions(saved, new Set(['uuid-live']))
    expect(kept.map((x) => x.key).sort()).toEqual(['live-but-older', 'newer'])
    expect(dropped).toEqual([])
  })

  it('leaves singletons alone however old — that is somebody restorable session', () => {
    const saved = [
      s({ key: 'a', projectId: 'p1', roleId: 'code', lastActiveAt: '2026-01-01T00:00:00.000Z' }),
      s({ key: 'b', projectId: 'p2', roleId: 'code' }),
      s({ key: 'c', projectId: 'p1', roleId: 'qa' }),
    ]
    const { kept, dropped } = pruneSavedSessions(saved, new Set())
    expect(kept).toHaveLength(3)
    expect(dropped).toEqual([])
  })

  it('never groups an ad-hoc session (no roleId) — it is not a lane', () => {
    const saved = [
      s({ key: 'a', projectId: 'p1' }),
      s({ key: 'b', projectId: 'p1' }),
    ]
    expect(pruneSavedSessions(saved, new Set()).dropped).toEqual([])
  })

  it('is IDEMPOTENT — a second pass drops nothing', () => {
    const saved = [
      s({ key: 'old', projectId: 'p1', roleId: 'code', lastActiveAt: '2026-07-21T00:00:00.000Z' }),
      s({ key: 'new', projectId: 'p1', roleId: 'code', lastActiveAt: '2026-07-30T00:00:00.000Z' }),
    ]
    const once = pruneSavedSessions(saved, new Set())
    const twice = pruneSavedSessions(once.kept, new Set())
    expect(twice.dropped).toEqual([])
    expect(twice.kept.map((x) => x.key)).toEqual(['new'])
  })

  it('preserves the store order, so the restore list is not reshuffled', () => {
    const saved = [
      s({ key: 'z', projectId: 'p2', roleId: 'qa' }),
      s({ key: 'dup-old', projectId: 'p1', roleId: 'code', lastActiveAt: '2026-07-01T00:00:00.000Z' }),
      s({ key: 'a', projectId: 'p3', roleId: 'design' }),
      s({ key: 'dup-new', projectId: 'p1', roleId: 'code', lastActiveAt: '2026-07-30T00:00:00.000Z' }),
    ]
    expect(pruneSavedSessions(saved, new Set()).kept.map((x) => x.key)).toEqual(['z', 'a', 'dup-new'])
  })

  it('matches the real store: 48 records → 20 duplicates dropped, 28 kept', () => {
    // The measured shape of ~/.operator/sessions.json before the fix.
    const groups: [string, string, number][] = [
      ['operator-3cfdffb0', 'research', 5], ['operator-3cfdffb0', 'operator', 4],
      ['operator-3cfdffb0', 'qa', 4], ['operator-3cfdffb0', 'review', 4],
      ['operator-3cfdffb0', 'design', 4], ['operator-3cfdffb0', 'code', 4],
      ['uwazi-app-d9bb8dcc', 'operator', 2],
    ]
    const saved: SavedSession[] = []
    for (const [projectId, roleId, n] of groups) {
      for (let i = 0; i < n; i++) {
        saved.push(s({ key: `${roleId}-${i}`, projectId, roleId, lastActiveAt: `2026-07-${10 + i}T00:00:00.000Z` }))
      }
    }
    // 21 more singletons across the other projects, to reach 48.
    for (let i = 0; i < 21; i++) saved.push(s({ key: `solo-${i}`, projectId: `proj-${i}`, roleId: 'code' }))
    expect(saved).toHaveLength(48)
    const { kept, dropped } = pruneSavedSessions(saved, new Set())
    expect(dropped).toHaveLength(20)
    expect(kept).toHaveLength(28)
  })
})
