import type { AgentSession, ArtifactReport, DispatchRecord } from '../../shared/types'
import { chipForOutcome, type OutcomeChip } from './dispatch-outcome'

// The per-lane Inbox/Outbox model — pure, so what a lane has sent, received and had blocked is
// one tested function rather than three filters spread across a component.
//
// `dev/results/agent-comms-audit.md`, loss #2: a report that reached the database was exactly as
// invisible as one that was never sent. `artifactReports` was wired at the IPC layer and called
// from NOWHERE in the renderer. The audit is explicit that the fix is a durable per-lane list —
// "sent dispatches + their outcome, received reports + ack state, blocked replies + the specific
// brake that stopped them" — and not a toast on insert:
//
//   > a durable list per lane … is what turns "silence means no report" from a claim the system
//   > can't back up into one it actually can.
//
// ONE CHRONOLOGICAL LIST, settled with Design in `dev/results/inbox-outbox-reconcile.md` (A2):
// the question a user has is "what happened with this lane", and the answer is chronological.
// That also dodges the tab-row width problem the two-segment design was working around.
//
// EVERY OUTCOME LABEL COMES FROM `chipForOutcome`, imported, never rewritten here (D1). A first
// version of this module had a seven-entry copy that DISAGREED with the shared one — it put
// `undelivered` in the blocked set, so a row read "Not delivered — the bytes went out…", which
// contradicts itself in one sentence; and it inked `rejected`/`unassigned` as warnings, so a
// declined dispatch shouted as loudly as a hop limit. `dispatch-outcome.ts`'s own header records
// this exact failure happening once before.

/** The three states a report can honestly be in — §2's table.
 *
 *  `written` should be RARE and short-lived: a row sitting there while the panel is open means
 *  the reader is broken, and the surface says so rather than smoothing it over. That is the
 *  difference between a list and an audit trail. */
export type ReportState = 'written' | 'delivered' | 'acked'

export interface ReceivedRow {
  id: number
  at: string
  /** The lane that reported. */
  from: string
  title: string
  summary: string
  /** `[{name, content}]` — CONTENT, never a path. */
  artifacts: Array<{ name?: string; content?: string }>
  state: ReportState
}

export interface SentRow {
  id: string
  at: string
  to: string
  task: string
  title: string
  chip: OutcomeChip
  /** The brake's OWN sentence, persisted at block time. Shown as the `ⓘ` line. */
  note?: string
}

/** One row in the merged list. `kind` selects which half of the union is populated. */
export type CommsRow =
  | ({ kind: 'received'; at: string } & ReceivedRow)
  | ({ kind: 'sent'; at: string } & SentRow)
  /** This lane's OWN report, and whether anyone opened it — the other half of an ack being worth
   *  having (A3). */
  | { kind: 'reported'; id: number; at: string; to: string; title: string; summary: string; state: ReportState }

/** THE PROJECT SCOPE, applied to a fetched report list.
 *
 *  `~/.operator/artifacts.db` is ONE store for every project on this machine — the fetch has no
 *  project in it and neither did any surface downstream, so an Inbox opened in `operator` listed
 *  and badged reports filed by lanes in `uwazi-app`. Role ids are what make it more than cosmetic:
 *  every project has an `operator` and a `code`, so `unreadByRole` merged two projects' lanes into
 *  one count under the same key.
 *
 *  A report with NO `projectId` passes every scope. It is unattributable rather than foreign, and
 *  a row that belongs to no list is a row nobody ever reads — the failure this module exists to
 *  end. Passing no `projectId` returns the list untouched.
 *
 *  Pure and separate from `inboxFor`/`unreadByRole` so the scope is one tested decision rather
 *  than a `.filter` repeated at three call sites that can drift apart. */
export function forProject(
  reports: readonly ArtifactReport[],
  projectId: string | undefined | null,
): ArtifactReport[] {
  if (!projectId) return [...reports]
  return reports.filter((r) => !r.projectId || r.projectId === projectId)
}

/** The first line of a summary, which is what a list row shows. Reports are written as prose and
 *  routinely open with a heading or a sentence; the rest belongs in the expanded body. */
export function headline(summary: string, max = 120): string {
  const first = summary.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const clean = first.replace(/^#+\s*/, '').replace(/^\*\*(.*)\*\*$/, '$1')
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/** Everything addressed TO this lane: reports whose `toRole` names it, plus the legacy rows that
 *  predate the column and therefore meant the coordinator. */
export function reportState(r: ArtifactReport): ReportState {
  if (r.ackedAt) return 'acked'
  if (r.deliveredAt) return 'delivered'
  return 'written'
}

/** Parse the artifacts blob defensively — it is a JSON string written by another process. */
function parseArtifacts(raw: string): Array<{ name?: string; content?: string }> {
  try {
    const v = JSON.parse(raw || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export function inboxFor(role: string, isCoordinator: boolean, reports: readonly ArtifactReport[]): ReceivedRow[] {
  return reports
    .filter((r) => (r.toRole ? r.toRole === role : isCoordinator))
    .map((r) => ({
      id: r.id,
      at: r.at,
      from: r.roleId || r.terminalId,
      title: headline(r.summary),
      summary: r.summary,
      artifacts: parseArtifacts(r.artifacts),
      state: reportState(r),
    }))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}

/** What this lane SENT — dispatches and replies, with the brake named. §3.
 *
 *  Every label comes from `chipForOutcome`; this function adds no strings of its own. The `ⓘ`
 *  line is the brake's own persisted `note`, which is prose written to a human at block time and
 *  has never been rendered anywhere. */
export function outboxFor(role: string, records: readonly DispatchRecord[]): SentRow[] {
  return records
    .filter((d) => d.fromRoleId === role)
    .map((d) => ({
      id: d.id,
      at: d.at,
      to: d.toRoleId ?? '—',
      task: d.task ?? '',
      title: headline(d.task ?? ''),
      chip: chipForOutcome(d.outcome),
      note: d.note,
    }))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}

/** This lane's own reports out, with whether anyone opened them. */
export function reportedBy(role: string, reports: readonly ArtifactReport[]): CommsRow[] {
  return reports
    .filter((r) => r.roleId === role)
    .map((r) => ({
      kind: 'reported' as const,
      id: r.id,
      at: r.at,
      to: r.toRole || 'operator',
      title: headline(r.summary),
      summary: r.summary,
      state: reportState(r),
    }))
}

/** THE MERGED LIST, newest first. */
export function laneComms(args: {
  role: string
  isCoordinator: boolean
  reports: readonly ArtifactReport[]
  records: readonly DispatchRecord[]
}): CommsRow[] {
  const { role, isCoordinator, reports, records } = args
  return [
    ...inboxFor(role, isCoordinator, reports).map((r) => ({ kind: 'received' as const, ...r })),
    ...reportedBy(role, reports),
    ...outboxFor(role, records).map((r) => ({ kind: 'sent' as const, ...r })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}

/** The count that makes you look at the panel at all: reports for this lane that nobody has
 *  acked. `written` + `delivered`, never `acked`, and never this lane's own outbox — nothing
 *  about what you sent is news to you (§4). */
export function unreadCount(role: string, isCoordinator: boolean, reports: readonly ArtifactReport[]): number {
  return inboxFor(role, isCoordinator, reports).filter((r) => r.state !== 'acked').length
}

/** Unread counts for every lane at once, from ONE report fetch.
 *
 *  D3: `unreadCount` had zero production callers, so the number existed only inside the surface
 *  it was meant to point you toward. The rail marker, the tab badge and the coordinator's toolbar
 *  chip all read this. */
export function unreadByRole(reports: readonly ArtifactReport[], coordinatorRole: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of reports) {
    if (r.ackedAt) continue
    const to = r.toRole || coordinatorRole
    out[to] = (out[to] ?? 0) + 1
  }
  return out
}

/** The one pty line an idle coordinator gets when a report lands.
 *
 *  SHORT ON PURPOSE, and it is not the report. The audit is emphatic that reports must keep the
 *  property `OPERATOR-REPLY` lacks — no racing a paste against the TUI's composer, no truncation
 *  cap standing in for an ack — so this announces and points, and the text stays in the Inbox
 *  where it can be read without a delivery race. */
export function announcement(report: ArtifactReport): string {
  const from = report.roleId || report.terminalId
  return `[Operator] report #${report.id} from ${from}: ${headline(report.summary, 80)} — full text in Inbox`
}

/** Is this lane BETWEEN TURNS, i.e. safe to paste one announcement line into?
 *
 *  `running`/`compacting` means a turn is in flight and the line would land mid-thought; `ended`
 *  means there is nobody to tell; no session at all means the tab is not a lane yet.
 *
 *  A function rather than an inline condition because it has to be asked TWICE — once before the
 *  announce pass starts, and again before EVERY line in it. Announcing wakes the lane, so by the
 *  second report of a batch the answer has usually changed: the first announcement is what put
 *  the lane into `running`, and the batch used to keep typing into it anyway. */
export function canAnnounceTo(session: Pick<AgentSession, 'status' | 'phase'> | undefined): boolean {
  if (!session || session.status === 'ended') return false
  return session.phase === 'idle' || session.phase === 'waiting'
}
