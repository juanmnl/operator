// WHAT THE SESSION FOOTER'S READING DECIDES, separated from how it draws.
//
// Design: `dev/results/plan-meter-bottom-bar.md`. The rules here are the ones that are easy to
// get subtly wrong and impossible to see in a screenshot: what "absent" looks like versus "zero",
// which of three limits is marked, and which freshness state suppresses a number entirely.

import type { AgentSession } from '../../shared/types'
import { contextWindowOf } from './model-config'
import {
  bindingLimit, limitRows, freshnessOf, hasCurrentData, windowEnded, type PlanLimits,
} from './plan-limits'

/** What the context cell shows. */
export interface ContextReading {
  /** `value` absent = nothing to measure yet; the cell draws `—` and a bare track. */
  used?: number
  window: number
  pct: number
  /** The word replaces the numbers while a compaction runs. */
  compacting: boolean
  compactions: number
}

/** The context cell's state.
 *
 *  ABSENT IS NOT ZERO, and this is where that is enforced. Before the first assistant turn there
 *  is no prompt to measure, and rendering `0k` under an empty-looking bar would say the context is
 *  fresh when in fact nothing is known — the same rule the plan meter already keeps for a missing
 *  reading, one axis over.
 *
 *  The window comes from the MODEL, so a `[1m]` lane is not reported as 84% full at 840k. */
export function contextReading(session: Pick<AgentSession, 'model' | 'phase' | 'contextTokens' | 'compactions'>): ContextReading {
  const window = contextWindowOf(session.model)
  const used = session.contextTokens && session.contextTokens > 0 ? session.contextTokens : undefined
  return {
    used,
    window,
    pct: used ? (used / window) * 100 : 0,
    compacting: session.phase === 'compacting',
    compactions: session.compactions ?? 0,
  }
}

/** One limit as the plan cell draws it. */
export interface PlanRowReading {
  key: string
  label: string
  pct: number
  resets?: string | null
  /** The row furthest along — the one that can actually stop you. */
  binding: boolean
}

export type PlanCellState = 'loading' | 'no-reading' | 'window-closed' | 'aging' | 'current'

export interface PlanReading {
  state: PlanCellState
  rows: PlanRowReading[]
}

/** The plan cell's state and its rows.
 *
 *  ONLY THE BINDING ROW IS MARKED. Three amber bars would say three separate alarms are ringing
 *  when only one of them can stop you, and the whole reason this reading exists is that a single
 *  unlabelled arc could not say WHICH of the three it had drawn.
 *
 *  NO DATA NEVER RENDERS AS A PERCENTAGE. `no-reading` and `window-closed` return no rows at all,
 *  because by then we genuinely do not know; `aging` keeps its numbers, since they are still the
 *  best thing available and a dot is the only warning a 34px strip has room for. */
export function planReading(limits: PlanLimits | null | undefined, now: number, loading = false): PlanReading {
  if (!hasCurrentData(limits, now)) {
    // `windowEnded` is checked ahead of `loading` deliberately: a reading whose own reset time has
    // passed is provably describing a window that no longer exists, and saying so outranks saying
    // we are busy re-reading it.
    if (windowEnded(limits, now)) return { state: 'window-closed', rows: [] }
    return { state: loading ? 'loading' : 'no-reading', rows: [] }
  }
  const binding = bindingLimit(limits)
  return {
    state: freshnessOf(limits, now) === 'aging' ? 'aging' : 'current',
    rows: limitRows(limits).map((r) => ({ ...r, binding: binding?.key === r.key })),
  }
}
