import type { ArtifactReport, DispatchRecord } from '../../shared/types'

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

export type InboxItemKind = 'report' | 'sent' | 'blocked'

export interface InboxItem {
  kind: InboxItemKind
  /** Stable within a kind — report id, or the dispatch record's own id. */
  id: string
  at: string
  /** Who it came from (a report) or went to (a dispatch). */
  who: string
  /** The one-line headline. */
  title: string
  /** The rest, when there is more than the headline. */
  body?: string
  /** Reports only. */
  delivered?: boolean
  acked?: boolean
  /** Blocked replies only — WHICH brake, named. "It was blocked" without the reason is the
   *  thing this panel exists to stop. */
  blockedBy?: string
  /** Dispatches only: what actually happened to it. */
  outcome?: string
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
export function inboxFor(role: string, isCoordinator: boolean, reports: readonly ArtifactReport[]): InboxItem[] {
  return reports
    .filter((r) => (r.toRole ? r.toRole === role : isCoordinator))
    .map((r) => ({
      kind: 'report' as const,
      id: `report:${r.id}`,
      at: r.at,
      who: r.roleId || r.terminalId,
      title: headline(r.summary),
      body: r.summary,
      delivered: !!r.deliveredAt,
      acked: !!r.ackedAt,
    }))
}

/** Everything this lane SENT — its own reports, so a worker can see that its result actually
 *  landed and whether anyone has opened it. That is the other half of an ack being worth having. */
export function outboxFor(role: string, reports: readonly ArtifactReport[]): InboxItem[] {
  return reports
    .filter((r) => r.roleId === role)
    .map((r) => ({
      kind: 'sent' as const,
      id: `sent:${r.id}`,
      at: r.at,
      who: r.toRole || 'operator',
      title: headline(r.summary),
      body: r.summary,
      delivered: !!r.deliveredAt,
      acked: !!r.ackedAt,
    }))
}

/** Dispatches and replies involving this lane, with their outcome — including the blocked ones
 *  and WHICH brake stopped them. */
export function trafficFor(role: string, records: readonly DispatchRecord[]): InboxItem[] {
  return records
    .filter((d) => d.fromRoleId === role || d.toRoleId === role)
    .map((d) => {
      const blocked = BLOCKED_OUTCOMES.has(d.outcome)
      const mine = d.fromRoleId === role
      return {
        kind: (blocked ? 'blocked' : 'sent') as InboxItemKind,
        id: `dispatch:${d.id}`,
        at: d.at,
        who: mine ? `→ ${d.toRoleId ?? 'unassigned'}` : `← ${d.fromRoleId ?? 'human'}`,
        title: headline(d.task ?? ''),
        body: d.task,
        outcome: d.outcome,
        blockedBy: blocked ? BLOCK_REASON[d.outcome] : undefined,
      }
    })
}

/** The outcomes that mean NOTHING WAS TYPED ANYWHERE. Named as a set rather than tested with a
 *  string match so a new outcome has to be classified deliberately rather than defaulting to
 *  "delivered". */
const BLOCKED_OUTCOMES = new Set<DispatchRecord['outcome']>([
  'unassigned', 'pending-approval', 'rejected', 'hop-limit', 'pair-brake', 'paused', 'undelivered',
])

/** WHICH BRAKE, in words. "It was blocked" without the reason is precisely what this panel
 *  exists to stop — the audit's whole complaint about the delivery brakes is that they are
 *  silent, so a row that says only "blocked" would reproduce the problem in a new place. */
const BLOCK_REASON: Record<string, string> = {
  'unassigned': 'no lane matched that role',
  'pending-approval': 'a non-coordinator asked for this — it waits for you',
  'rejected': 'declined; terminal, never delivered',
  'hop-limit': 'the chain hit its hop budget with no human in it',
  'pair-brake': 'that pair was sending too fast and is suspended',
  'paused': 'the kill switch was on',
  'undelivered': 'the bytes went out but no turn followed — it is sitting in the composer',
}

/** The whole panel's contents, newest first.
 *
 *  ONE SORTED LIST rather than three columns: the question a user has when they open this is
 *  "what happened with this lane", and the answer is chronological. The kind is a mark on the
 *  row, not a separate place to look. */
export function laneTraffic(args: {
  role: string
  isCoordinator: boolean
  reports: readonly ArtifactReport[]
  records: readonly DispatchRecord[]
}): InboxItem[] {
  const { role, isCoordinator, reports, records } = args
  return [
    ...inboxFor(role, isCoordinator, reports),
    ...outboxFor(role, reports),
    ...trafficFor(role, records),
  ]
    // Dedupe: a coordinator's own report to itself would otherwise appear in both halves.
    .filter((item, i, all) => all.findIndex((o) => o.id === item.id) === i)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}

/** How many reports are waiting for this lane and have not been opened. Drives the tab's badge —
 *  the number that makes "silence means no report" checkable instead of assumed. */
export function unackedCount(role: string, isCoordinator: boolean, reports: readonly ArtifactReport[]): number {
  return inboxFor(role, isCoordinator, reports).filter((i) => !i.acked).length
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
