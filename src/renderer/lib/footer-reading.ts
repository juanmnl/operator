// WHAT THE SESSION FOOTER'S READING DECIDES, separated from how it draws.
//
// Design: `dev/results/plan-meter-bottom-bar.md`. The rules here are the ones that are easy to
// get subtly wrong and impossible to see in a screenshot: what "absent" looks like versus "zero",
// which of three limits is marked, and which freshness state suppresses a number entirely.

import type { AgentSession } from '../../shared/types'
import { inferContextWindow } from './model-config'
import {
  bindingLimit, limitRows, freshnessOf, hasCurrentData, windowEnded, toneFor, type LimitTone, type PlanLimits,
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
  return `${shortLimitLabel(binding.label)} ${pct}`
}

/** `Current week` → `Week`, `Current week (Fable)` → `Week (Fable)`.
 *
 *  The full labels read as a list where every row starts the same way; alone in one cell that first
 *  word carries nothing and costs a third of the space. The per-model part is the CLI's own label
 *  and is kept exactly as it arrives. Shared by the rail foot and the collapsed footer cell, so the
 *  two never name the same limit differently. */
export function shortLimitLabel(label: string): string {
  const l = label.replace(/^Current /, '')
  return `${l.charAt(0).toUpperCase()}${l.slice(1)}`
}

// ── The collapsed plan cell and its panel ────────────────────────────────────────────────────
//
// The footer used to carry every limit inline — `Current session 6% · Current week 83% · Current
// week (Fable) 97%`, three bars — which took most of the bar's right end. It is now ONE cell that
// names the limit closest to its cap, and a panel above it that lists everything. Result:
// `dev/results/plan-meter-collapse-RESULT.md`.

/** What the collapsed cell shows. */
export interface PlanSummary {
  state: PlanCellState
  /** The binding limit, shortened. Absent whenever there is no percentage to stand behind. */
  label?: string
  pct?: number
  tone: LimitTone
  /** Limits OTHER than the binding one that are at or past the warn line. */
  alsoHigh: PlanRowReading[]
  /** The worst tone among `alsoHigh`, for the ink of the `+N` marker. */
  alsoHighTone: LimitTone
}

/** The collapsed cell's reading.
 *
 *  THE BINDING LIMIT, NAMED. Collapsing keeps the one limit that can stop you first, with its
 *  name, so the "it only shows Fable" misreading that moved the reading out of the rail cannot come
 *  back through a bare percentage.
 *
 *  A SECOND HIGH LIMIT IS NOT HIDDEN. Week at 83% under Fable at 97% is two limits past the warn
 *  line, and showing only the higher one would say the other is fine. `alsoHigh` carries them, so
 *  the cell can add `+1` without the panel being opened.
 *
 *  ROUNDED ONCE, and the tone is taken from the rounded number, so the cell can never print `75%`
 *  in normal ink.
 *
 *  No rows, no label: the "absent is not zero" rule `planReading` already keeps. */
export function planSummary(limits: PlanLimits | null | undefined, now: number, loading = false): PlanSummary {
  const { state, rows } = planReading(limits, now, loading)
  const binding = rows.find((r) => r.binding)
  if (!binding) return { state, tone: 'normal', alsoHigh: [], alsoHighTone: 'normal' }
  const pct = Math.round(binding.pct)
  const alsoHigh = rows.filter((r) => !r.binding && toneFor(Math.round(r.pct)) !== 'normal')
  return {
    state,
    label: shortLimitLabel(binding.label),
    pct,
    tone: toneFor(pct),
    alsoHigh,
    alsoHighTone: toneFor(Math.max(0, ...alsoHigh.map((r) => Math.round(r.pct)))),
  }
}

/** The collapsed cell's tooltip. Written without sentence breaks, so no word can be stranded
 *  after a full stop. */
export function planCellTitle(s: PlanSummary, age: string | null): string {
  if (s.label == null) {
    if (s.state === 'window-closed') return 'The plan window this reading described has closed — click for details'
    if (s.state === 'loading') return 'Reading plan limits…'
    return 'No plan reading right now — click for details'
  }
  const parts = [`Highest limit: ${s.label} ${s.pct}%`]
  for (const r of s.alsoHigh) parts.push(`${shortLimitLabel(r.label)} ${Math.round(r.pct)}% is also high`)
  if (s.state === 'aging' && age) parts.push(`updated ${age}`)
  return `${parts.join(' · ')} — click for every limit`
}

/** The panel's status line. Same rule: no sentence breaks. */
export function planPanelStatus(state: PlanCellState, age: string | null): string {
  switch (state) {
    case 'loading': return 'Reading plan limits…'
    case 'no-reading': return 'No plan reading right now'
    case 'window-closed': return 'The session window this reading described has closed'
    case 'aging': return age ? `Updated ${age} · may be out of date` : 'May be out of date'
    default: return age ? `Updated ${age}` : 'Current reading'
  }
}

/** The trigger's box, in window coordinates. */
export interface AnchorRect { left: number; right: number; top: number }

export interface PanelPlacement { left: number; bottom: number; width: number; maxHeight: number }

export const PLAN_PANEL_W = 320

/** Where the plan panel sits: ABOVE its cell (the footer is the bottom of the window, so there is
 *  nowhere below), right edges aligned (the cell is the last thing on the bar), and always inside
 *  the window.
 *
 *  Narrower than the panel plus both margins, the panel narrows rather than hanging off an edge.
 *  `maxHeight` is the room between the trigger and the top of the window, and the panel scrolls
 *  inside that rather than growing past it. Fixed-position numbers, so the panel can live in a
 *  portal and no ancestor's `overflow: hidden` can clip it. */
export function planPanelPlacement(
  anchor: AnchorRect,
  viewport: { w: number; h: number },
  width = PLAN_PANEL_W,
  gap = 6,
  margin = 8,
): PanelPlacement {
  const w = Math.max(0, Math.min(width, viewport.w - 2 * margin))
  const left = Math.max(margin, Math.min(anchor.right - w, viewport.w - margin - w))
  return {
    left,
    bottom: Math.max(margin, viewport.h - anchor.top + gap),
    width: w,
    maxHeight: Math.max(0, anchor.top - gap - margin),
  }
}

/** What the panel says about the plan the reading was taken under.
 *
 *  THE CLI'S LINE IS A SENTENCE, NOT A LABEL: `You are currently using your subscription to power
 *  your Claude Code usage`. It used to sit in an uppercase chip beside the panel title, where it
 *  pushed the title onto two lines and was clipped at the panel edge. The main process only keeps
 *  a line that mentions a subscription, so the common case collapses to one word that fits beside
 *  the title; the full line stays available as the tooltip.
 *
 *  Anything else is shown whole, on its own line, and wraps. Its last two words are bound with a
 *  non-breaking space so the line never ends on one stranded word. */
export function planBasis(plan: string | null | undefined): { short: string | null; full: string | null } {
  const full = plan?.replace(/\s+/g, ' ').trim() || null
  if (!full) return { short: null, full: null }
  if (/\bsubscription\b/i.test(full)) return { short: 'Subscription', full }
  return { short: null, full: full.replace(/ (\S+)$/, ' $1') }
}
