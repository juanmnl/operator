// THE TUNING PAGE'S ARITHMETIC — the joins and the one judgement it is allowed to make.
//
// Design: `dev/results/usage-view-design.md`. The rule the whole page obeys is that every number
// sits next to the change it argues for, or it says there is no change to make. This module is
// where "or it says there is no change to make" is enforced, because the alternative — a card
// that always finds something — is how a page stops being trusted.
//
// Everything here is PURE over the IPC payload plus the roster, so the firing rules are exercised
// against fabricated windows rather than against whatever happens to be on this machine today.

import type {
  EffortUsage, Project, SavedSession, SessionUsage, ToolOutputStats,
} from '../../shared/types'
import { EFFORT_LEVELS } from './effort'
import { resolveAgentConfig } from './model-config'
import { modelFamilyLabel } from './roster'

/** Everything the page shows for one lane, after the join. */
export interface LaneRow {
  /** `roleId` for an attributed lane; the sentinel below for everything else. */
  key: string
  name: string
  roleId?: string
  projectId?: string
  projectName: string
  accent?: string
  /** Model as the TRANSCRIPT reports it (the value that actually ran). */
  model: string
  /** Effort as the transcript reports it. */
  effort?: string
  /** Effort the roster would launch this lane at. Shown beside `effort` when they disagree —
   *  which is the case a mid-session `/effort` creates and the pin alone cannot see. */
  pinnedEffort?: string
  /** True when the roster pin is inherited rather than set on the role. */
  effortInherited: boolean
  tokens: number
  cost: number
  turns: number
  share: number
  compactions: number
  reReadTokens: number
  highContextTurns: number
  medianContext: number
  toolP50: number
  toolP90: number
  topTool?: string
  sessions: string[]
  /** Newest `lastTsMs` among this lane's sessions — what "latest" is decided by. */
  lastTsMs: number
}

/** The row that keeps the shares honest. Transcripts no saved session claims — a lane started
 *  outside Operator, or one since forgotten — are counted and SHOWN, never folded into whichever
 *  attributed lane is nearest and never dropped. */
export const UNATTRIBUTED = '__unattributed__'

export interface JoinInput {
  bySession: readonly SessionUsage[]
  byEffort: readonly EffortUsage[]
  toolOutput: readonly ToolOutputStats[]
  projects: readonly Project[]
  saved: readonly SavedSession[]
}

/** Join transcript sessions to lanes.
 *
 *  THE JOIN IS A LOOKUP, NOT NEW CAPTURE: `SessionUsage.session` is the transcript filename stem,
 *  which is the Claude session uuid — exactly what `SavedSession.claudeSessionId` holds, because
 *  every lane Operator launches is started with `claude --session-id <uuid>`.
 *
 *  Two passes, and the second is deliberately weaker. `claudeSessionId` is "latest seen", so a
 *  RESUMED lane loses its earlier uuids; those rows fall through to a `slug` → `cwd` match, which
 *  recovers the project even when it cannot recover the role. Anything neither pass reaches
 *  becomes the unattributed row. Never guess. */
export function joinLanes(input: JoinInput): LaneRow[] {
  const byUuid = new Map<string, SavedSession>()
  const byCwd = new Map<string, SavedSession>()
  for (const s of input.saved) {
    if (s.claudeSessionId) byUuid.set(s.claudeSessionId, s)
    // First writer wins per cwd: an arbitrary pick among several lanes in one directory would
    // attribute tokens to whichever happened to be last, so the weaker pass claims only the
    // project and leaves the role unset below.
    if (s.cwd && !byCwd.has(s.cwd)) byCwd.set(s.cwd, s)
  }
  const projectById = new Map(input.projects.map((p) => [p.id, p]))
  const tools = new Map(input.toolOutput.map((t) => [t.session, t]))

  const total = input.bySession.reduce((n, s) => n + s.tokens, 0)
  const rows = new Map<string, LaneRow>()

  for (const s of input.bySession) {
    const hit = byUuid.get(s.session)
    const weak = hit ? undefined : byCwd.get(slugToPath(s.slug))
    const claim = hit ?? weak
    const project = claim?.projectId ? projectById.get(claim.projectId) : undefined
    // THE ROLE COMES FROM WHICHEVER SAVED SESSION CLAIMED THE ROW, uuid match or cwd match.
    // Reading it from `hit` alone threw away the roleId the cwd match had already found, so a
    // resumed lane — whose uuid has rolled, which is the entire reason the weak pass exists —
    // fell through to the unattributed row while its own saved session sat right there naming
    // the role. The cwd match is weaker about WHICH lane, not about what that lane is.
    const claimedRoleId = claim?.roleId
    const role = claimedRoleId ? project?.roster?.find((r) => r.id === claimedRoleId) : undefined
    const key = role ? `${project?.id ?? ''}:${role.id}` : claimedRoleId ? `${project?.id ?? ''}:${claimedRoleId}` : UNATTRIBUTED
    const t = tools.get(s.session)

    let row = rows.get(key)
    if (!row) {
      row = {
        key,
        name: key === UNATTRIBUTED ? 'Not attributed' : role?.name ?? claimedRoleId ?? 'Unknown',
        roleId: role?.id ?? claimedRoleId,
        projectId: project?.id,
        // THE UNATTRIBUTED ROW NEVER WEARS A PROJECT NAME. It used to fall back to the slug's
        // last path segment, so a transcript nothing claimed was labelled with a real project —
        // which reads as "this project's lane" and is the one thing the row exists not to say.
        projectName: key === UNATTRIBUTED ? '—' : project?.name ?? projectNameFromSlug(s.slug),
        accent: role?.accent,
        model: s.model, effort: s.effort,
        pinnedEffort: undefined, effortInherited: false,
        tokens: 0, cost: 0, turns: 0, share: 0,
        compactions: 0, reReadTokens: 0, highContextTurns: 0, medianContext: 0,
        toolP50: 0, toolP90: 0, topTool: undefined,
        sessions: [], lastTsMs: 0,
      }
      if (role) {
        const resolved = resolveAgentConfig(role, project?.defaults)
        row.pinnedEffort = resolved.effort
        row.effortInherited = role.effort === undefined
      }
      rows.set(key, row)
    }
    row.tokens += s.tokens
    row.cost += s.cost
    row.turns += s.turns
    row.compactions += s.compactions
    row.reReadTokens += s.reReadTokens
    row.highContextTurns += s.highContextTurns
    row.sessions.push(s.session)
    // LATEST BY TIME, and it has to be time. `bySession` arrives sorted by TOKENS, so "latest
    // wins" implemented as last-writer-wins described the BIGGEST session instead — a lane that
    // ran a long stretch on Opus/xhigh and has since been moved to Sonnet/medium would still be
    // reported, and argued about, at its old settings.
    if (s.lastTsMs >= row.lastTsMs) {
      row.lastTsMs = s.lastTsMs
      if (s.medianContext) row.medianContext = s.medianContext
      if (s.model) row.model = s.model
      if (s.effort) row.effort = s.effort
    }
    if (t) {
      // The busiest session's distribution represents the lane. Averaging two sessions'
      // percentiles is not a percentile of anything.
      if (t.totalChars > row.toolP90 * Math.max(1, row.turns)) {
        row.toolP50 = t.p50; row.toolP90 = t.p90; row.topTool = t.topTool
      }
    }
  }

  for (const r of rows.values()) r.share = total > 0 ? r.tokens / total : 0
  return [...rows.values()].sort((a, b) => {
    // The unattributed row always sits last: it is a completeness note, not a lane to tune.
    if (a.key === UNATTRIBUTED) return 1
    if (b.key === UNATTRIBUTED) return -1
    return b.tokens - a.tokens
  })
}

/** `-Users-dev-thing` → `/Users/dev/thing`. Claude Code slugifies a cwd by replacing every `/`
 *  with `-`, which is lossy for a directory whose own name contains a dash — so this is a
 *  best-effort inverse and the reason the cwd pass is the WEAKER of the two joins. */
export function slugToPath(slug: string): string {
  return slug.startsWith('-') ? `/${slug.slice(1).replace(/-/g, '/')}` : slug.replace(/-/g, '/')
}

function projectNameFromSlug(slug: string): string {
  return slug.replace(/^-/, '').split('-').pop() || slug
}

// ── The biggest single change ────────────────────────────────────────────────────────────────

/** The share a lane must hold before the card names it. A judgement, stated here rather than
 *  buried in a comparison: it decides how often the page says "nothing stands out", which is the
 *  difference between a page that is trusted and one that always finds something. */
export const DOMINANT_SHARE = 0.25

export interface ChangeCard {
  kind: 'change' | 'nothing'
  /** The lane the card is about — present in both kinds, since the honest version still names
   *  the top lane. */
  lane?: LaneRow
  /** The step down being suggested, when there is one. */
  step?: { from: string; to: string }
  headline: string
  detail: string
}

/** One step down the effort ladder, or null at the bottom. Model steps are deliberately NOT
 *  offered: the ladder in `ROSTER_MODELS` is ordered by family, not by price, so "one model
 *  down" is not a thing this code can compute without inventing a ranking. */
export function stepDown(effort: string | undefined): string | null {
  if (!effort) return null
  const i = EFFORT_LEVELS.indexOf(effort as (typeof EFFORT_LEVELS)[number])
  return i > 0 ? EFFORT_LEVELS[i - 1] : null
}

/** What the card may say, and it may never say more than this.
 *
 *  It fires only when the top lane is above `DOMINANT_SHARE` AND a step down exists. Otherwise it
 *  renders the honest version naming the same lane and its share.
 *
 *  IT RANKS, IT DOES NOT FORECAST. A step down the effort ladder has no known token multiplier,
 *  and inventing one would be the same class of error as showing 0% for a number that is absent.
 *  Nothing in the returned copy claims a saving. */
export function biggestChange(lanes: readonly LaneRow[], days: number): ChangeCard {
  const ranked = lanes.filter((l) => l.key !== UNATTRIBUTED && l.tokens > 0)
  if (!ranked.length) {
    return { kind: 'nothing', headline: 'Nothing ran in this window.', detail: 'Widen the range, or start a lane.' }
  }
  const top = ranked[0]
  const window = days === 1 ? 'today' : `the last ${days} days`
  const pct = Math.round(top.share * 100)
  const effort = top.effort ?? top.pinnedEffort
  const step = stepDown(effort)
  const model = modelFamilyLabel(top.model)

  if (top.share <= DOMINANT_SHARE || !step) {
    const why = !step && top.share > DOMINANT_SHARE
      ? `already at ${effort ? labelFor(effort) : 'the lowest effort'}`
      : `${pct}% of ${window}`
    return {
      kind: 'nothing',
      lane: top,
      headline: 'Nothing stands out.',
      detail: `The top lane is ${top.name} on ${model}, ${why}.`,
    }
  }

  const next = ranked[1]
  const andNext = next && ranked[2] && top.tokens > next.tokens + ranked[2].tokens
    ? ', more than the next two lanes together'
    : ''
  return {
    kind: 'change',
    lane: top,
    step: { from: effort!, to: step },
    headline: `${top.name} on ${model} at ${labelFor(effort!)} took ${pct}% of ${window}`,
    detail: `${formatTokens(top.tokens)} over ${top.turns} turns${andNext}. `
      + `Dropping it one step to ${labelFor(step)} is the smallest change that moves this.`,
  }
}

function labelFor(effort: string): string {
  return effort === 'xhigh' ? 'Extra high' : effort.charAt(0).toUpperCase() + effort.slice(1)
}

/** Tokens, the page's headline unit. `12.4M`, `938k`, `412` — never a bare integer with eight
 *  digits, which is unreadable in a table column. */
export function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}

/** Cost, the sanity check. Rendered once per row, muted, and never used to rank. */
export function formatCost(n: number): string {
  if (n >= 100) return `$${Math.round(n)}`
  if (n >= 1) return `$${n.toFixed(2)}`
  return `$${n.toFixed(2)}`
}

/** Characters of tool output, for the p50/p90 columns. */
export function formatChars(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(Math.round(n))
}

/** Cache-read share for one model, and the judgement attached to it.
 *
 *  Cache reads bill at roughly a tenth of fresh input, so a high read share is a lane being used
 *  well and a low one usually means sessions are being relaunched instead of continued. The
 *  threshold is a judgement and is stated here rather than tuned invisibly at a call site. */
export const HEALTHY_CACHE_READ = 0.5

export function cacheHealth(readShare: number, tokens: number): 'healthy' | 'low' | 'thin' {
  // Below a real volume the ratio is noise — a model with three calls can read 0% and mean
  // nothing by it.
  if (tokens < 100_000) return 'thin'
  return readShare >= HEALTHY_CACHE_READ ? 'healthy' : 'low'
}
