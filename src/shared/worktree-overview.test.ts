import { describe, it, expect } from 'vitest'
import { summarizeOverview, fromQuick, fromPlan, formatBytes, type OverviewWorktree } from './worktree-overview'
import type { ReapEntry, WorktreeQuickEntry } from './types'

const ROOT = '/Users/j/.operator/worktrees'
const projects = [
  { id: 'op', name: 'operator', path: '/Users/j/Developer/operator' },
  { id: 'mt', name: 'mantel', path: '/Users/j/Developer/mantel/' },
  { id: 'lost', name: 'gone', path: '' },
]
const wt = (name: string, over: Partial<OverviewWorktree> = {}): OverviewWorktree =>
  ({ path: `${ROOT}/${name}`, repo: '/Users/j/Developer/operator', repoExists: true, live: false, bytes: 100, ...over })

const run = (worktrees: OverviewWorktree[], extra: Partial<Parameters<typeof summarizeOverview>[0]> = {}) =>
  summarizeOverview({ projects, worktrees, sessions: [], suspended: [], detailed: true, ...extra })

describe('summarizeOverview — grouping by source repo', () => {
  it('puts each worktree under the project whose path is its repo, ignoring a trailing slash', () => {
    const o = run([wt('operator-1'), wt('operator-2'), wt('mantel-1', { repo: '/Users/j/Developer/mantel' })])
    const op = o.rows.find((r) => r.projectId === 'op')!
    const mt = o.rows.find((r) => r.projectId === 'mt')!
    expect([op.worktrees, op.bytes]).toEqual([2, 200])
    expect(mt.worktrees).toBe(1)
    expect(o.unknown.worktrees).toBe(0)
    expect(o.total.worktrees).toBe(3)
  })

  it('sends folders whose repo matches no project, or names none, to the unknown bucket', () => {
    const o = run([
      wt('uwazi-1', { repo: '/Users/j/Developer/uwazi', repoExists: false, bytes: 471 }),
      wt('uwazi-2', { repo: '/Users/j/Developer/uwazi/', repoExists: false }),
      wt('debris', { repo: undefined, bytes: 8 }),
    ])
    expect(o.unknown.worktrees).toBe(3)
    expect(o.unknown.repos).toEqual(['/Users/j/Developer/uwazi'])
    expect(o.unknown.deadRepo).toBe(2)
    expect(o.unknown.bytes).toBe(579)
    expect(o.rows.every((r) => r.worktrees === 0)).toBe(true)
  })

  it('never matches a project with no path, so a lost project cannot swallow repo-less folders', () => {
    const o = run([wt('x', { repo: '' })])
    expect(o.rows.find((r) => r.projectId === 'lost')!.worktrees).toBe(0)
    expect(o.unknown.worktrees).toBe(1)
  })

  it('sorts rows by size, then worktree count, then name', () => {
    const o = run([wt('a', { bytes: 5 }), wt('b', { repo: '/Users/j/Developer/mantel', bytes: 50 })])
    expect(o.rows.map((r) => r.projectId)).toEqual(['mt', 'op', 'lost'])
  })
})

describe('summarizeOverview — flags', () => {
  it('counts unsaved work, unknown unsaved state, would-remove, dead repos and live folders', () => {
    const o = run([
      wt('1', { unsaved: true, wouldRemove: false }),
      wt('2', { unsavedUnknown: true }),
      wt('3', { wouldRemove: true }),
      wt('4', { repoExists: false }),
      wt('5', { live: true }),
    ])
    const op = o.rows.find((r) => r.projectId === 'op')!
    expect(op).toMatchObject({ unsaved: 1, unsavedUnknown: 1, wouldRemove: 1, deadRepo: 1, live: 1 })
    expect(o.total).toMatchObject({ worktrees: 5, unsaved: 1, wouldRemove: 1, deadRepo: 1 })
  })

  it('does not count a folder as both unsaved and unknown', () => {
    expect(run([wt('1', { unsaved: true, unsavedUnknown: true })]).total).toMatchObject({ unsaved: 1, unsavedUnknown: 0 })
  })

  it('marks a size total as partial when any folder has no size yet', () => {
    const o = run([wt('1', { bytes: 10 }), wt('2', { bytes: undefined })])
    expect(o.total).toMatchObject({ bytes: 10, bytesPartial: true })
    expect(run([wt('1')]).total.bytesPartial).toBe(false)
  })

  it('carries `detailed` through, so a quick paint never claims zero unsaved', () => {
    expect(run([], { detailed: false }).detailed).toBe(false)
  })
})

describe('summarizeOverview — lanes', () => {
  it('counts live sessions per project and ignores ended ones', () => {
    const o = run([], { sessions: [{ projectId: 'op', status: 'active' }, { projectId: 'op', status: 'ended' }, { projectId: 'mt', status: 'active' }] })
    expect(o.rows.find((r) => r.projectId === 'op')!.running).toBe(1)
    expect(o.rows.find((r) => r.projectId === 'mt')!.running).toBe(1)
  })

  it('counts a suspended session in the project, inside it, or in one of its worktrees', () => {
    const o = run([wt('operator-1')], {
      suspended: [
        { cwd: '/Users/j/Developer/operator' },
        { cwd: '/Users/j/Developer/operator/electron' },
        { cwd: `${ROOT}/operator-1` },
        { cwd: '/Users/j/Developer/operator-fork' },
      ],
    })
    expect(o.rows.find((r) => r.projectId === 'op')!.suspended).toBe(3)
  })

  it('prefers a saved session’s projectId over its path', () => {
    const o = run([], { suspended: [{ cwd: '/elsewhere', projectId: 'mt' }] })
    expect(o.rows.find((r) => r.projectId === 'mt')!.suspended).toBe(1)
  })
})

describe('the two sources', () => {
  const quick: WorktreeQuickEntry[] = [
    { path: `${ROOT}/a`, repo: '/Users/j/Developer/operator', repoExists: true, live: false, cachedBytes: 42 },
    { path: `${ROOT}/b`, repo: '/Users/j/Developer/uwazi', repoExists: false, live: false },
  ]
  const entry = (over: Partial<ReapEntry>): ReapEntry => ({
    path: `${ROOT}/a`, cls: 'unmerged', sizeBytes: 900, auto: false, reason: '', live: false,
    unsavedKnown: true, needsUnsavedConfirm: false, removedWithoutGit: false, ...over,
  })

  it('the quick list carries no git flags and the cached size', () => {
    expect(fromQuick(quick)[0]).toEqual({ path: `${ROOT}/a`, repo: '/Users/j/Developer/operator', repoExists: true, live: false, bytes: 42 })
  })

  it('the plan brings unsaved and would-remove, and keeps repoExists from the quick list', () => {
    const [a, b] = fromPlan([
      entry({ uncommitted: 2, wouldRemove: undefined }),
      entry({ path: `${ROOT}/b`, cls: 'live-claimed', live: true, unsavedKnown: false, wouldRemove: 'Clean' }),
    ], quick, false)
    expect(a).toMatchObject({ unsaved: true, wouldRemove: false, bytes: 900, repoExists: true })
    expect(b).toMatchObject({ unsaved: false, unsavedUnknown: true, wouldRemove: true, repoExists: false, live: true })
  })

  it('uses the cached size when the plan has none', () => {
    expect(fromPlan([entry({ sizeBytes: 0 })], quick, true)[0].bytes).toBe(42)
  })
})

describe('formatBytes', () => {
  it('reads GB, MB, KB, and zero', () => {
    expect(formatBytes(34 * 1024 ** 3)).toBe('34.0 GB')
    expect(formatBytes(512 * 1024 ** 2)).toBe('512 MB')
    expect(formatBytes(8000)).toBe('8 KB')
    expect(formatBytes(0)).toBe('0 KB')
  })
})
