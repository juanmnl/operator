import type { AgentSession, ArtifactReport, DispatchRecord } from '../../shared/types'
import { chipForOutcome, type OutcomeChip } from './dispatch-outcome'

// THE COMMS RECORD — what was sent, what came back, and what was blocked by which brake. Pure,
// so the timeline is one tested function rather than three filters spread across a component.
//
// WHY IT EXISTS. `dev/results/agent-comms-audit.md`, loss #2: a report that reached the database
// was exactly as invisible as one that was never sent. `artifactReports` was wired at the IPC
// layer and called from NOWHERE in the renderer. The audit is explicit that the fix is a durable
// list — "sent dispatches + their outcome, received reports, blocked replies + the specific brake
// that stopped them" — and not a toast on insert:
//
//   > a durable list … is what turns "silence means no report" from a claim the system can't back
//   > up into one it actually can.
//
// WHAT IT IS NOT, since 2026-08-29: a mailbox. This module used to carry `unreadCount`,
// `unreadByRole` and a third `ReportState` (`acked`) written when someone EXPANDED a row. All
// three are gone, and the reasons are worth keeping written down:
//   1. The reader is usually an AGENT, not the user. "Acked" recorded that an automated read
//      happened — it measured the wrong thing while looking authoritative.
//   2. It was a chore whose only reward was clearing itself. Precedent: undelivered dispatches
//      piled up seven deep and needed a Dismiss bolted on.
//   3. It duplicated task state. "Lane finished, here is the result" is a task moving to Done
//      carrying its output — recording it a second time as mail gave two places that could
//      disagree about one fact.
// `written` vs `delivered` STAYS. A `written` row is a report that reached nobody, and a surface
// that says so is the difference between an audit trail and a list.
//
// PROJECT-WIDE, not per-lane (settled here, 2026-08-29 — see dev/results/inbox-cut-the-mailbox.md
// for the full argument). The failure this repo has actually suffered is a CASCADE: the hop-limit
// budget is one scalar per lane, so a brake in one lane starves the coordinator and the fleet
// goes quiet together. You cannot see that shape one lane at a time. A per-lane record also
// forced its own triage loop — answering "did anything arrive?" meant opening six panels and
// remembering six answers, which is the mailbox chore wearing a navigation costume.
//
// EVERY OUTCOME LABEL COMES FROM `chipForOutcome`, imported, never rewritten here (D1). A first
// version of this module had a seven-entry copy that DISAGREED with the shared one — it put
// `undelivered` in the blocked set, so a row read "Not delivered — the bytes went out…", which
// contradicts itself in one sentence; and it inked `rejected`/`unassigned` as warnings, so a
// declined dispatch shouted as loudly as a hop limit. `dispatch-outcome.ts`'s own header records
// this exact failure happening once before.

/** The two states a report can honestly be in.
 *
 *  `written` should be RARE and short-lived: a row sitting there means the reader is broken, and
 *  the surface says so rather than smoothing it over. There is no third state — nothing in the
 *  system acks any more, so a value that could only ever be produced by the deleted mailbox would
 *  be a label nobody can reach. Legacy rows carrying `ackedAt` map to `delivered`, which is true
 *  of every one of them: they were opened, and opening required being shown. */
export type ReportState = 'written' | 'delivered'

/** THE WORD FOR A REPORT'S STATE, in one place. The dispatch half of this record learned the hard
 *  way that a second copy of a vocabulary disagrees with the first (see this file's header and
 *  `dispatch-outcome.ts`); the report half gets the same treatment before it can happen twice.
 *  Two surfaces print these — the project's Comms log and the task's own result card. */
export const reportStateLabel = (s: ReportState): string =>
  s === 'delivered' ? 'reported' : 'reached nobody'

/** A file a report carried back. `[{name, content}]` — CONTENT, never a path: a path lives in the
 *  reporting lane's own checkout and is unreadable from anywhere else. */
export interface ReportArtifact { name?: string; content?: string }

/** A report, as every surface reads it. One shape for the timeline and for the task card, so the
 *  two can never disagree about what a report says. */
export interface ReportRow {
  kind: 'report'
  id: number
  at: string
  /** The lane that reported. */
  from: string
  /** The lane it was addressed to. Absent on the column's legacy rows meant the coordinator. */
  to: string
  /** The task it answers, when the lane named one. This is the join that puts a result on its
   *  card; see `reportsForTask`. */
  taskId?: string
  title: string
  summary: string
  artifacts: ReportArtifact[]
  state: ReportState
}

export interface DispatchRow {
  kind: 'dispatch'
  id: string
  at: string
  from: string
  to: string
  task: string
  title: string
  /** The RAW outcome, carried alongside its chip. Every LABEL comes from `chipForOutcome`, but a
   *  surface deciding whether to offer Approve must branch on the enum — string-matching the
   *  label is exactly how a second, disagreeing vocabulary gets born (see this file's header). */
  outcome: DispatchRecord['outcome']
  chip: OutcomeChip
  /** The brake's OWN sentence, persisted at block time. Shown as the `ⓘ` line. */
  note?: string
}

/** One row in the merged timeline. `kind` selects which half of the union is populated. */
export type CommsRow = ReportRow | DispatchRow

/** A stable React key. Ids collide across the two halves (`1` is a report id and `d1` a dispatch
 *  id, but a numeric report id and a string dispatch id can still stringify the same way). */
export const rowKey = (r: CommsRow): string => `${r.kind}:${r.id}`

/** The first line of a summary, which is what a list row shows. Reports are written as prose and
 *  routinely open with a heading or a sentence; the rest belongs in the expanded body. */
export function headline(summary: string, max = 120): string {
  const first = summary.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const clean = first.replace(/^#+\s*/, '').replace(/^\*\*(.*)\*\*$/, '$1')
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

export function reportState(r: ArtifactReport): ReportState {
  return r.deliveredAt || r.ackedAt ? 'delivered' : 'written'
}

/** Parse the artifacts blob defensively — it is a JSON string written by another process. */
function parseArtifacts(raw: string): ReportArtifact[] {
  try {
    const v = JSON.parse(raw || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** Absent `toRole` means the coordinator — which is what every one of the ~298 rows written
 *  before the column existed meant implicitly. */
export function toReportRow(r: ArtifactReport, coordinatorRole = 'operator'): ReportRow {
  return {
    kind: 'report',
    id: r.id,
    at: r.at,
    from: r.roleId || r.terminalId,
    to: r.toRole || coordinatorRole,
    taskId: r.taskId ?? undefined,
    title: headline(r.summary),
    summary: r.summary,
    artifacts: parseArtifacts(r.artifacts),
    state: reportState(r),
  }
}

/** Reports belonging to this project.
 *
 *  A row with NO `projectId` is kept rather than dropped: it cannot be attributed, and dropping
 *  it would make the timeline quietly shorter than the truth on exactly the machine with the most
 *  history. The cost is that an unattributable row appears under every project, which is visible
 *  and correctable; a silently missing report is neither. */
export function reportsOfProject(projectId: string | undefined, reports: readonly ArtifactReport[]): ArtifactReport[] {
  return reports.filter((r) => !r.projectId || !projectId || r.projectId === projectId)
}

/** THE TIMELINE, newest first: every report and every dispatch this project has, in one list.
 *
 *  Dispatches arrive already project-scoped (`project.dispatches`); reports come from one
 *  app-wide poll and are scoped here. */
export function projectComms(args: {
  projectId?: string
  reports: readonly ArtifactReport[]
  records: readonly DispatchRecord[]
  coordinatorRole?: string
}): CommsRow[] {
  const { projectId, reports, records, coordinatorRole = 'operator' } = args
  const rows: CommsRow[] = [
    ...reportsOfProject(projectId, reports).map((r) => toReportRow(r, coordinatorRole)),
    ...records.map((d): DispatchRow => ({
      kind: 'dispatch',
      id: d.id,
      at: d.at,
      from: d.fromRoleId ?? '—',
      to: d.toRoleId ?? '—',
      task: d.task ?? '',
      title: headline(d.task ?? ''),
      outcome: d.outcome,
      chip: chipForOutcome(d.outcome),
      note: d.note,
    })),
  ]
  return rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}

/** THE RESULT ON THE TASK. Reports that name this task, oldest first — a lane can report twice
 *  on one task and the second one is not a correction of the first, it is the next instalment.
 *
 *  EXACT `taskId` MATCH ONLY, deliberately. The tempting fallback — "a report from this task's
 *  lane, timestamped between its start and its close" — attaches a result to work that never
 *  claimed it, and a lane running three tasks in an afternoon would get three wrong answers that
 *  look exactly like right ones. A task with no report shows no result section at all, which is
 *  true and checkable; the unattached report is still in the project timeline. */
export function reportsForTask(taskId: string, reports: readonly ArtifactReport[]): ReportRow[] {
  return reports
    .filter((r) => r.taskId === taskId)
    .map((r) => toReportRow(r))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
}

/** The one pty line an idle coordinator gets when a report lands.
 *
 *  SHORT ON PURPOSE, and it is not the report. The audit is emphatic that reports must keep the
 *  property `OPERATOR-REPLY` lacks — no racing a paste against the TUI's composer, no truncation
 *  cap standing in for a receipt — so this announces and points, and the text stays where it can
 *  be read without a delivery race: on the task if the lane named one, in the project's Comms
 *  timeline either way. */
export function announcement(report: ArtifactReport): string {
  const from = report.roleId || report.terminalId
  const where = report.taskId ? 'on its task card' : 'in the project Comms log'
  return `[Operator] report #${report.id} from ${from}: ${headline(report.summary, 80)} — full text ${where}`
}

/** Is this lane BETWEEN TURNS, i.e. safe to paste one announcement line into?
 *
 *  `running`/`compacting` means a turn is in flight and the line would land mid-thought; `ended`
 *  means there is nobody to tell; no session at all means the tab is not a lane yet.
 *
 *  A function rather than an inline condition because it has to be asked TWICE — once before the
 *  announce pass starts, and again before EVERY line in it. Announcing wakes the lane, so by the
 *  second report of a batch the answer has usually changed: the first announcement is what put
 *  the lane into `running`, and the batch used to keep typing into it anyway.
 *
 *  Moved here from `inbox.ts` when the mailbox was cut. It is about the ANNOUNCE path, which
 *  survived the cut intact, not about the mailbox surface that did not — so it lands next to
 *  `announcement`, the line it guards. */
export function canAnnounceTo(session: Pick<AgentSession, 'status' | 'phase'> | undefined): boolean {
  if (!session || session.status === 'ended') return false
  return session.phase === 'idle' || session.phase === 'waiting'
}
