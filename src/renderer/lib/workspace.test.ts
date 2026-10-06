import { describe, it, expect } from 'vitest'
import { planRestore, readWorkspace, describeRestore, carriedLaneKeys, snapshotLiveKeys, previousRunOffer, WORKSPACE_VERSION, type Workspace } from './workspace'
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

// 2026-10-06: 33 lane keys across 7 projects became 5 four seconds after a relaunch, because the
// carried set was taken from a plan scoped to the focused project.
describe('the previous run\'s lanes are carried whole', () => {
  const a1 = saved({ key: 'a1', roleId: 'code', projectId: 'pA', lastActiveAt: '2026-10-06T10:00:00Z' })
  const a2 = saved({ key: 'a2', roleId: 'qa', projectId: 'pA', lastActiveAt: '2026-10-06T10:05:00Z' })
  const b1 = saved({ key: 'b1', roleId: 'code', projectId: 'pB', lastActiveAt: '2026-10-06T09:00:00Z' })
  const b2 = saved({ key: 'b2', roleId: 'design', projectId: 'pB', lastActiveAt: '2026-10-06T09:30:00Z' })
  const all = [a1, a2, b1, b2]
  const before = ws({ projectId: 'pA', mode: 'session', liveKeys: ['a1', 'a2', 'b1', 'b2', 'k-forgotten'] })

  it('a plan for project A leaves project B\'s carried keys intact', () => {
    const plan = planRestore({ workspace: before, projectIds: ['pA', 'pB'], savedSessions: all })
    // The plan is still scoped: it is "where you were".
    expect(plan.lanes.map((l) => l.saved.key)).toEqual(['a1', 'a2'])
    // The carried set is not, and the first snapshot after the launch keeps B's lanes.
    const carried = carriedLaneKeys(before, all)
    expect(carried).toEqual(['a1', 'a2', 'b1', 'b2'])
    expect(snapshotLiveKeys([], carried)).toEqual(['a1', 'a2', 'b1', 'b2'])
  })

  it('two relaunches in a row keep every project\'s lanes', () => {
    let raw = JSON.stringify(before)
    for (let launch = 0; launch < 2; launch++) {
      const w = readWorkspace(raw)
      // Nothing resumed: no terminals, so the snapshot is the carried set alone.
      raw = JSON.stringify(ws({ projectId: null, mode: 'gallery', liveKeys: snapshotLiveKeys([], carriedLaneKeys(w, all)) }))
    }
    expect(readWorkspace(raw)?.liveKeys).toEqual(['a1', 'a2', 'b1', 'b2'])
  })

  it('drops only keys with no saved row', () => {
    expect(carriedLaneKeys(ws({ liveKeys: ['a1', 'gone', 'a1', 'b1'] }), all)).toEqual(['a1', 'b1'])
    expect(carriedLaneKeys(null, all)).toEqual([])
  })

  it('resuming one lane keeps the others in the snapshot', () => {
    // "terminals, else pending" would write ['a1'] here, and a crash then loses b1 and b2.
    expect(snapshotLiveKeys(['a1', 'new'], ['a1', 'b1', 'b2'])).toEqual(['a1', 'new', 'b1', 'b2'])
  })
})

describe('previousRunOffer', () => {
  const projects = [{ id: 'pA', name: 'Alpha' }, { id: 'pB', name: 'Beta' }]
  const a1 = saved({ key: 'a1', roleId: 'code', projectId: 'pA', lastActiveAt: '2026-10-06T10:00:00Z' })
  const b1 = saved({ key: 'b1', roleId: 'code', projectId: 'pB', lastActiveAt: '2026-10-06T09:00:00Z' })
  const b2 = saved({ key: 'b2', roleId: 'qa', projectId: 'pB', lastActiveAt: '2026-10-06T09:30:00Z' })
  const stale = saved({ key: 'stale', roleId: 'old', projectId: 'pB', lastActiveAt: '2026-08-01T09:30:00Z' })
  const all = [a1, b1, b2, stale]

  it('offers exactly the carried lanes, oldest first across projects, with a per-project count', () => {
    const offer = previousRunOffer({ keys: ['a1', 'b1', 'b2'], savedSessions: all, liveKeys: new Set(), projects })
    // Not `stale`: a saved row from an earlier run is not a lane from the last session.
    expect(offer?.resumable.map((s) => s.key)).toEqual(['b1', 'b2', 'a1'])
    expect(offer?.projects).toEqual([
      { projectId: 'pB', name: 'Beta', lanes: 2 },
      { projectId: 'pA', name: 'Alpha', lanes: 1 },
    ])
    expect(offer?.blocked).toEqual([])
  })

  it('leaves out lanes already live in this run, and offers nothing once all are', () => {
    const offer = previousRunOffer({ keys: ['a1', 'b1'], savedSessions: all, liveKeys: new Set(['a1']), projects })
    expect(offer?.resumable.map((s) => s.key)).toEqual(['b1'])
    expect(previousRunOffer({ keys: ['a1'], savedSessions: all, liveKeys: new Set(['a1']), projects })).toBeNull()
    expect(previousRunOffer({ keys: [], savedSessions: all, liveKeys: new Set(), projects })).toBeNull()
  })

  it('names the lanes it cannot resume instead of starting them fresh', () => {
    const fresh = saved({ key: 'fresh', roleId: 'design', projectId: 'pA', claudeSessionId: undefined })
    const gone = saved({ key: 'gone', roleId: 'review', projectId: 'pA', cwd: '/gone/review' })
    const offer = previousRunOffer({
      keys: ['a1', 'fresh', 'gone'], savedSessions: [...all, fresh, gone], liveKeys: new Set(), projects,
      missingPaths: new Set(['/gone/review']),
    })
    expect(offer?.resumable.map((s) => s.key)).toEqual(['a1'])
    expect(offer?.blocked).toEqual(expect.arrayContaining([
      { name: 'design', blocker: 'no-conversation' },
      { name: 'review', blocker: 'folder-missing' },
    ]))
  })

  it('a worktree lane whose folder is gone is still offered: the restore rebuilds it', () => {
    const wt = saved({ key: 'wt', roleId: 'code', projectId: 'pA', cwd: '/w/wt-gone', worktreeBranch: 'operator/abc', sourceCwd: '/repo' })
    const offer = previousRunOffer({ keys: ['wt'], savedSessions: [wt], liveKeys: new Set(), projects, missingPaths: new Set(['/w/wt-gone']) })
    expect(offer?.resumable.map((s) => s.key)).toEqual(['wt'])
  })
})
