import { describe, it, expect, afterEach } from 'vitest'
import { launchLanding, continueLabel, planRestore, type RestorePlan, type Workspace } from './workspace'
import { launchKind, resetLaunchKindForTests } from './launch-kind'

const plan = (over: Partial<RestorePlan> = {}): RestorePlan =>
  ({ projectId: 'p1', mode: 'project', projectTab: 'team', lanes: [], notes: [], ...over })
const ids = ['p1', 'p2']

describe('launchLanding — a launch opens on the overview, a reload restores', () => {
  it('a LAUNCH shows the gallery overview and keeps where you were as the Continue target', () => {
    const l = launchLanding('launch', plan(), null, ids)
    expect(l.view).toEqual({ projectId: null, mode: 'gallery', projectTab: 'team' })
    expect(l.galleryTab).toBe('overview')
    expect(l.continueTo).toEqual({ projectId: 'p1', mode: 'project', projectTab: 'team' })
  })

  it('a RELOAD restores exactly where you were, with no overview and no Continue offer', () => {
    const l = launchLanding('reload', plan(), 'p2', ids)
    expect(l.view).toEqual({ projectId: 'p1', mode: 'project', projectTab: 'team' })
    expect(l.galleryTab).toBeUndefined()
    expect(l.continueTo).toBeNull()
  })

  it('UNKNOWN (a shell that cannot tell) behaves like a reload: it never hides your place', () => {
    expect(launchLanding('unknown', plan(), null, ids)).toEqual(launchLanding('reload', plan(), null, ids))
  })

  it('a launch after a launch spent on the overview still offers the last project', () => {
    const l = launchLanding('launch', plan({ projectId: null, mode: 'gallery' }), 'p2', ids)
    expect(l.continueTo).toEqual({ projectId: 'p2', mode: 'project', projectTab: 'team' })
  })

  it('offers nothing when the last project is gone or was never set', () => {
    expect(launchLanding('launch', plan({ projectId: null, mode: 'gallery' }), 'gone', ids).continueTo).toBeNull()
    expect(launchLanding('launch', plan({ projectId: null, mode: 'gallery' }), null, ids).continueTo).toBeNull()
  })

  it('a view with no project (Preferences) is still a place to continue to', () => {
    const l = launchLanding('launch', plan({ projectId: null, mode: 'prefs' }), null, ids)
    expect(l.continueTo).toMatchObject({ projectId: null, mode: 'prefs' })
  })

  it('does not touch the lanes the restore plan offers', () => {
    const ws: Workspace = { v: 1, projectId: 'p1', mode: 'session', projectTab: 'board', liveKeys: ['k'], at: '' }
    const saved = [{ key: 'k', cwd: '/x', projectId: 'p1', claudeSessionId: 'c', lastActiveAt: '2026-01-01' }] as never
    const p = planRestore({ workspace: ws, projectIds: ids, savedSessions: saved })
    launchLanding('launch', p, null, ids)
    expect(p.lanes).toHaveLength(1)
  })
})

describe('continueLabel', () => {
  const projects = [{ id: 'p1', name: 'operator' }]
  it('names the project, or the view', () => {
    expect(continueLabel({ projectId: 'p1', mode: 'project', projectTab: 'board' }, projects)).toBe('operator')
    expect(continueLabel({ projectId: 'p1', mode: 'prefs', projectTab: 'board' }, projects)).toBe('Preferences')
    expect(continueLabel({ projectId: null, mode: 'globalPrefs', projectTab: 'board' }, projects)).toBe('Global settings')
  })
})

describe('launchKind — asked once per document', () => {
  afterEach(() => {
    resetLaunchKindForTests()
    delete (window as { operator?: unknown }).operator
  })

  it('asks main once, so a second call in the same document (StrictMode) cannot turn a launch into a reload', async () => {
    let n = 0
    ;(window as { operator?: unknown }).operator = { launchKind: async () => (n++ === 0 ? 'launch' : 'reload') }
    expect(await launchKind()).toBe('launch')
    expect(await launchKind()).toBe('launch')
    expect(n).toBe(1)
  })

  it('a new document (a reload) asks again and gets main’s answer', async () => {
    let n = 0
    ;(window as { operator?: unknown }).operator = { launchKind: async () => (n++ === 0 ? 'launch' : 'reload') }
    await launchKind()
    resetLaunchKindForTests() // what a reload does to module state
    expect(await launchKind()).toBe('reload')
  })

  it('is unknown without the bridge call, or when it fails or answers nonsense', async () => {
    ;(window as { operator?: unknown }).operator = {}
    expect(await launchKind()).toBe('unknown')
    resetLaunchKindForTests()
    ;(window as { operator?: unknown }).operator = { launchKind: async () => { throw new Error('no') } }
    expect(await launchKind()).toBe('unknown')
    resetLaunchKindForTests()
    ;(window as { operator?: unknown }).operator = { launchKind: async () => 'maybe' }
    expect(await launchKind()).toBe('unknown')
  })
})
