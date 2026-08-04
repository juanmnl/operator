import { describe, it, expect } from 'vitest'
import { planRestore, readWorkspace, describeRestore, WORKSPACE_VERSION, type Workspace } from './workspace'
import type { SavedSession } from '../../shared/types'

const saved = (over: Partial<SavedSession> & { key: string }): SavedSession => ({
  cwd: `/w/${over.key}`,
  projectName: 'operator',
  projectId: 'p1',
  claudeSessionId: `uuid-${over.key}`,
  lastActiveAt: '2026-08-03T10:00:00Z',
  ...over,
})

const ws = (over: Partial<Workspace> = {}): Workspace => ({
  v: WORKSPACE_VERSION,
  projectId: 'p1',
  mode: 'project',
  projectTab: 'board',
  liveKeys: [],
  at: '2026-08-03T12:00:00Z',
  ...over,
})

describe('readWorkspace', () => {
  it('treats absent, malformed and future-schema snapshots as no snapshot', () => {
    // Landing somewhere wrong is worse than landing at the gallery, so anything we do not
    // positively recognise is ignored rather than half-read.
    expect(readWorkspace(null)).toBeNull()
    expect(readWorkspace('{{{')).toBeNull()
    expect(readWorkspace(JSON.stringify({ v: 99, mode: 'project', liveKeys: [] }))).toBeNull()
    expect(readWorkspace(JSON.stringify(ws()))).toEqual(ws())
  })
})

describe('planRestore', () => {
  it('FIRST RUN: nothing persisted → the gallery, and it says so', () => {
    const plan = planRestore({ workspace: null, projectIds: ['p1'], savedSessions: [] })
    expect(plan).toMatchObject({ projectId: null, mode: 'gallery', lanes: [] })
    expect(plan.notes).toEqual([{ kind: 'first-run' }])
  })

  it('restores project scope, mode and tab', () => {
    const plan = planRestore({
      workspace: ws({ mode: 'project', projectTab: 'team' }),
      projectIds: ['p1'],
      savedSessions: [],
    })
    expect(plan).toMatchObject({ projectId: 'p1', mode: 'project', projectTab: 'team' })
  })

  it('PROJECT GONE: falls back to the gallery instead of scoping to nothing', () => {
    const plan = planRestore({ workspace: ws({ projectId: 'deleted' }), projectIds: ['p1'], savedSessions: [] })
    expect(plan).toMatchObject({ projectId: null, mode: 'gallery' })
    expect(plan.notes).toContainEqual({ kind: 'project-gone', projectId: 'deleted' })
    expect(describeRestore(plan)).toBe('That project is no longer on record')
  })

  it('A FOCUSED SESSION becomes Project Home — you cannot focus a dead pty', () => {
    // The app's session objects are derived from live terminals, so at launch there is no
    // session to focus and nothing for the chat view to render. It must not look live.
    const code = saved({ key: 'k-code', roleId: 'code' })
    const plan = planRestore({
      workspace: ws({ mode: 'session', focusedKey: 'k-code', liveKeys: ['k-code'] }),
      projectIds: ['p1'],
      savedSessions: [code],
    })
    expect(plan.mode).toBe('project')
    expect(plan.focused?.saved.key).toBe('k-code')
    expect(plan.notes).toContainEqual({ kind: 'session-not-live', name: 'code' })
    expect(describeRestore(plan)).toBe('You were in code. 1 agent ready to resume.')
  })

  it('offers THE ONES YOU HAD, not every session ever saved', () => {
    // `savedSessions` keeps everything never explicitly closed, including previous runs — which
    // is why the snapshot records the live set rather than trusting that list.
    const a = saved({ key: 'k-a', roleId: 'a', lastActiveAt: '2026-08-03T09:00:00Z' })
    const b = saved({ key: 'k-b', roleId: 'b', lastActiveAt: '2026-08-03T08:00:00Z' })
    const stale = saved({ key: 'k-old', roleId: 'old' })
    const plan = planRestore({
      workspace: ws({ liveKeys: ['k-a', 'k-b'] }),
      projectIds: ['p1'],
      savedSessions: [a, b, stale],
    })
    // Oldest first, matching handleResumeProject, so the sidebar comes back in its usual order.
    expect(plan.lanes.map((l) => l.saved.key)).toEqual(['k-b', 'k-a'])
  })

  it('SESSION GONE: a live key whose SavedSession has been forgotten just drops', () => {
    const plan = planRestore({
      workspace: ws({ liveKeys: ['k-a', 'k-vanished'], focusedKey: 'k-vanished', mode: 'session' }),
      projectIds: ['p1'],
      savedSessions: [saved({ key: 'k-a', roleId: 'a' })],
    })
    expect(plan.lanes.map((l) => l.saved.key)).toEqual(['k-a'])
    expect(plan.focused).toBeUndefined()
    // Still says the lane isn't live, without inventing a name for one it cannot identify.
    expect(plan.notes).toContainEqual({ kind: 'session-not-live', name: undefined })
  })

  it('FOLDER MISSING: the lane is listed but blocked, never silently skipped', () => {
    const dead = saved({ key: 'k-dead', roleId: 'fastrack', cwd: '/gone/FastTrack' })
    const plan = planRestore({
      workspace: ws({ liveKeys: ['k-dead'] }),
      projectIds: ['p1'],
      savedSessions: [dead],
      missingPaths: new Set(['/gone/FastTrack']),
    })
    expect(plan.lanes[0].blocked).toBe('folder-missing')
    expect(describeRestore(plan)).toBe('fastrack — folder gone')
  })

  it('NO claudeSessionId: says it would be FRESH before anything starts one', () => {
    const fresh = saved({ key: 'k-fresh', roleId: 'design', claudeSessionId: undefined })
    const plan = planRestore({ workspace: ws({ liveKeys: ['k-fresh'] }), projectIds: ['p1'], savedSessions: [fresh] })
    expect(plan.lanes[0].blocked).toBe('no-conversation')
    expect(describeRestore(plan)).toBe('design — no saved conversation, would start fresh')
  })

  it('scopes the resume offer to the restored project', () => {
    const mine = saved({ key: 'k-mine', roleId: 'mine' })
    const other = saved({ key: 'k-other', roleId: 'other', projectId: 'p2' })
    const plan = planRestore({
      workspace: ws({ liveKeys: ['k-mine', 'k-other'] }),
      projectIds: ['p1', 'p2'],
      savedSessions: [mine, other],
    })
    expect(plan.lanes.map((l) => l.saved.key)).toEqual(['k-mine'])
  })

  it('keeps a non-project mode that does not depend on a project', () => {
    for (const mode of ['agents', 'prefs', 'globalPrefs'] as const) {
      expect(planRestore({ workspace: ws({ mode }), projectIds: ['p1'], savedSessions: [] }).mode).toBe(mode)
    }
  })

  it('never returns `session` as a mode, whatever it is handed', () => {
    const plan = planRestore({
      workspace: ws({ mode: 'session', projectId: 'deleted' }),
      projectIds: ['p1'],
      savedSessions: [],
    })
    expect(plan.mode).toBe('gallery')
  })

  it('says nothing when there is nothing to say', () => {
    expect(describeRestore(planRestore({ workspace: ws(), projectIds: ['p1'], savedSessions: [] }))).toBeNull()
  })
})
