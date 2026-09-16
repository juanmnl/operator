import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { loadOverview, overviewState, resetOverviewForTests, PLAN_DELAY_MS } from './worktree-overview-data'
import type { ReapEntry, ReapPlan, WorktreeQuickEntry } from '../../shared/types'

const quick: WorktreeQuickEntry[] = [{ path: '/w/a', repo: '/r', repoExists: true, live: false, cachedBytes: 10 }]
const entry: ReapEntry = {
  path: '/w/a', cls: 'unmerged', sizeBytes: 99, auto: false, reason: '', live: false,
  unsavedKnown: true, uncommitted: 3, needsUnsavedConfirm: true, removedWithoutGit: false,
}
const plan = (entries: ReapEntry[]): ReapPlan => ({ entries, auto: [], asks: entries, totalBytes: 0, autoBytes: 0, sizesOmitted: false, wouldRemove: [] })
// A few microtask turns: the stubbed bridge calls resolve at once, so their callbacks land here.
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
const stub = (api: unknown) => { (window as { operator?: unknown }).operator = api }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  resetOverviewForTests()
})
afterEach(() => {
  vi.useRealTimers()
  delete (window as { operator?: unknown }).operator
})

describe('the overview loads in two steps', () => {
  it('paints from the quick list at once, and asks git only after the delay', async () => {
    const reap = vi.fn(async () => plan([entry]))
    stub({ worktreeQuickList: async () => quick, worktreeReapPlan: reap })
    loadOverview()
    await flush()
    expect(overviewState()).toMatchObject({ phase: 'quick', loading: true })
    expect(overviewState().worktrees[0].bytes).toBe(10)
    expect(overviewState().worktrees[0].unsaved).toBeUndefined()
    expect(reap).not.toHaveBeenCalled()

    vi.advanceTimersByTime(PLAN_DELAY_MS)
    await flush()
    expect(reap).toHaveBeenCalledWith({ refreshSizes: false })
    expect(overviewState()).toMatchObject({ phase: 'detailed', loading: false })
    expect(overviewState().worktrees[0]).toMatchObject({ bytes: 99, unsaved: true })
  })

  it('keeps the last git flags on screen while a refresh re-reads the folders', async () => {
    stub({ worktreeQuickList: async () => quick, worktreeReapPlan: async () => plan([entry]) })
    loadOverview()
    await flush()
    vi.advanceTimersByTime(PLAN_DELAY_MS)
    await flush()
    loadOverview()
    await flush()
    expect(overviewState()).toMatchObject({ phase: 'detailed', loading: true })
    expect(overviewState().worktrees[0]).toMatchObject({ unsaved: true })
  })

  it('drops a slower, older plan when a newer load has started', async () => {
    let releaseOld: (p: ReapPlan) => void = () => {}
    let calls = 0
    stub({
      worktreeQuickList: async () => quick,
      worktreeReapPlan: () => {
        calls++
        return calls === 1 ? new Promise<ReapPlan>((r) => { releaseOld = r }) : Promise.resolve(plan([]))
      },
    })
    loadOverview()
    await flush()
    vi.advanceTimersByTime(PLAN_DELAY_MS)
    await flush()
    loadOverview()
    await flush()
    vi.advanceTimersByTime(PLAN_DELAY_MS)
    await flush()
    expect(overviewState().worktrees).toEqual([])
    releaseOld(plan([entry]))
    await flush()
    expect(overviewState().worktrees).toEqual([])
  })

  it('without the bridge call (Tauri, mocks) it settles at once with nothing', async () => {
    stub({})
    loadOverview()
    expect(overviewState()).toMatchObject({ phase: 'detailed', loading: false, worktrees: [] })
  })

  it('says so when the quick list fails', async () => {
    stub({ worktreeQuickList: async () => { throw new Error('EACCES') }, worktreeReapPlan: async () => plan([]) })
    loadOverview()
    await flush()
    expect(overviewState()).toMatchObject({ phase: 'error', loading: false })
    expect(overviewState().error).toContain('EACCES')
  })
})
