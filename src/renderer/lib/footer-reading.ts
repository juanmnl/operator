// WHAT THE SESSION FOOTER'S READING DECIDES, separated from how it draws.
//
// Design: `dev/results/plan-meter-bottom-bar.md`. The rules here are the ones that are easy to
// get subtly wrong and impossible to see in a screenshot: what "absent" looks like versus "zero",
// which of three limits is marked, and which freshness state suppresses a number entirely.

import type { AgentSession } from '../../shared/types'
import { inferContextWindow } from './model-config'
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
 *  THE WINDOW IS INFERRED, not read off the model — see `inferContextWindow`. No transcript
 *  carries the `[1m]` marker, so a lane switched to long context inside Claude Code would
 *  otherwise be measured against 200k and report 200% full. `knownWindow` carries the widest
 *  window this session has already been shown to have, which is what keeps the reading from
 *  narrowing again after a compaction. */
export function contextReading(
  session: Pick<AgentSession, 'model' | 'phase' | 'contextTokens' | 'compactions'>,
  knownWindow?: number,
): ContextReading {
  const used = session.contextTokens && session.contextTokens > 0 ? session.contextTokens : undefined
  const window = inferContextWindow(session.model, used, knownWindow)
  return {
    used,
    window,
    // Capped at 100. With the window inferred this should not bind, but a percentage over 100 is
    // never a thing to render: it was the visible half of the bug, and the cap is what makes that
    // unrepresentable rather than merely unlikely.
    pct: used ? Math.min(100, (used / window) * 100) : 0,
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

/** The rail foot's plan reading, as text — or null when there is nothing honest to say.
 *
 *  WHY THE RAIL STILL CARRIES ONE. Moving the reading into the session bottom bar left no plan
 *  reading at the gallery or on first launch, which is exactly when you are deciding what to
 *  start — the case the deleted `PlanMeter`'s own comment named as its reason to exist. This is
 *  the smaller replacement: the binding limit and its percentage, no ring, no popover.
 *
 *  TEXT, NOT A METER, and that is the point. The old arc was 12px and unlabelled, so it could not
 *  say WHICH of three limits it had drawn — the defect that moved the reading in the first place.
 *  Naming the limit in four characters of type says more than the ring did.
 *
 *  It is also NOT a foot item: `lib/rail-foot` and `dev/drive-rail-invariant.mjs` assert which
 *  items are present at rest, and the fold's cut depends on that count staying at four.
 *
 *  NULL WHEN UNKNOWN, never a zero. `no-reading`, `window-closed` and `loading` all return no
 *  rows, and a plan reading that quietly renders 0% while the data is missing is the failure the
 *  cell states elsewhere it exists to avoid. */
export function railFootPlanText(
  limits: PlanLimits | null | undefined,
  now: number,
  collapsed = false,
): string | null {
  const { rows } = planReading(limits, now)
  const binding = rows.find((r) => r.binding)
  if (!binding) return null
  const pct = `${Math.round(binding.pct)}%`
  // Collapsed the rail is 70px wide and the label will not fit; the number alone still answers
  // "how much is left", which is the question being asked at the gallery.
  if (collapsed) return pct
  // `Current week` → `Week`. The full-cell labels read as a list where every row starts the same
  // way; alone in the rail foot that first word carries nothing and costs a third of the line.
  // The per-model row keeps its own label, which is the CLI's and not ours to trim.
  const label = binding.label.replace(/^Current /, '')
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} ${pct}`
}
