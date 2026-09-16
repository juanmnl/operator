import { useCallback, useEffect, useState } from 'react'
import type { ReapPlan, WorktreeQuickEntry } from '../../shared/types'
import { fromPlan, fromQuick, type OverviewWorktree } from '../../shared/worktree-overview'

// THE OVERVIEW'S DATA, loaded in two steps and kept between visits.
//
//   1. `worktreeQuickList` — files only, milliseconds. Paints folders, repos and cached sizes.
//   2. `worktreeReapPlan` — git per folder, `du` only for folders whose mtime moved. Brings the
//      unsaved-work and would-remove flags. Started after a short delay, so it does not compete
//      with the launch's own work (the boot auto-removal check runs the same git calls).
//
// Held at module level: the gallery unmounts every time a project is entered, and coming back
// should show the last reading at once rather than a spinner. A reading younger than `FRESH_MS`
// is not re-fetched on mount; the Refresh button always re-fetches.

export const PLAN_DELAY_MS = 1500
export const FRESH_MS = 60_000

export type OverviewPhase = 'idle' | 'quick' | 'detailed' | 'error'

export interface OverviewData {
  worktrees: OverviewWorktree[]
  phase: OverviewPhase
  /** Both steps are in flight or the second is pending. */
  loading: boolean
  loadedAt: number
  error?: string
}

let state: OverviewData = { worktrees: [], phase: 'idle', loading: false, loadedAt: 0 }
let run = 0
let timer: ReturnType<typeof setTimeout> | null = null
const subs = new Set<(s: OverviewData) => void>()

function set(next: Partial<OverviewData>): void {
  state = { ...state, ...next }
  for (const s of subs) s(state)
}

/** Start a load. A newer load supersedes an older one: its results are dropped when they land. */
export function loadOverview(): void {
  const mine = ++run
  if (timer) { clearTimeout(timer); timer = null }
  const api = window.operator
  if (!api?.worktreeQuickList) {
    set({ phase: 'detailed', loading: false, loadedAt: Date.now(), worktrees: [] })
    return
  }
  set({ loading: true, error: undefined })
  let quick: WorktreeQuickEntry[] = []
  api.worktreeQuickList()
    .then((q) => {
      if (mine !== run) return
      quick = q
      // Keep the flags from the last detailed reading while the plan is re-run, rather than
      // flickering them away: the quick list replaces folders and sizes, not what git said.
      const prev = new Map(state.worktrees.map((w) => [w.path, w]))
      const merged = fromQuick(q).map((w) => {
        const p = prev.get(w.path)
        return p ? { ...w, unsaved: p.unsaved, unsavedUnknown: p.unsavedUnknown, wouldRemove: p.wouldRemove, bytes: w.bytes ?? p.bytes } : w
      })
      set({ worktrees: merged, phase: state.phase === 'detailed' ? 'detailed' : 'quick' })
      timer = setTimeout(() => {
        timer = null
        api.worktreeReapPlan({ refreshSizes: false })
          .then((plan: ReapPlan) => {
            if (mine !== run) return
            set({ worktrees: fromPlan(plan.entries, quick, plan.sizesOmitted), phase: 'detailed', loading: false, loadedAt: Date.now() })
          })
          .catch((e) => { if (mine === run) set({ loading: false, error: String(e), loadedAt: Date.now() }) })
      }, PLAN_DELAY_MS)
    })
    .catch((e) => { if (mine === run) set({ phase: 'error', loading: false, error: String(e) }) })
}

/** The overview's data. Loads on first use and when the last reading is stale. */
export function useOverviewData(): OverviewData & { refresh: () => void } {
  const [s, setS] = useState(state)
  useEffect(() => {
    subs.add(setS)
    setS(state)
    if (!state.loading && Date.now() - state.loadedAt > FRESH_MS) loadOverview()
    return () => { subs.delete(setS) }
  }, [])
  const refresh = useCallback(() => loadOverview(), [])
  return { ...s, refresh }
}

/** The current reading, outside React. */
export function overviewState(): OverviewData { return state }

/** Tests only. */
export function resetOverviewForTests(): void {
  run++
  if (timer) { clearTimeout(timer); timer = null }
  state = { worktrees: [], phase: 'idle', loading: false, loadedAt: 0 }
  subs.clear()
}
