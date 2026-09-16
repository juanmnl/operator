import type { ArtifactReport, Project, ProjectTask } from '../../shared/types'

// THE COORDINATOR'S DISPATCHED WORK, as the Plan tab lists it.
//
// A coordinator used to print "who is doing what" into chat, because nothing else showed it.
// The board store already holds every task Operator created for an `mcp__operator__dispatch`
// call, with the status `task_status` writes; this reads that store, it does not add one.

export type DispatchedStatus = 'blocked' | 'running' | 'queued' | 'done' | 'abandoned'

export interface DispatchedTaskRow {
  id: string
  roleId?: string
  /** The lane's display name from the roster, or its id when the roster no longer has it. */
  lane: string
  text: string
  status: DispatchedStatus
  /** The newest report that names this task, when one has landed. */
  reportId?: number
}

/** Unfinished work first, and blocked ahead of running because it is waiting on someone. */
const ORDER: Record<DispatchedStatus, number> = { blocked: 0, running: 1, queued: 2, done: 3, abandoned: 4 }

function statusOf(t: ProjectTask): DispatchedStatus {
  const s = t.status ?? 'queued'
  if (t.blockedAt && (s === 'running' || s === 'queued')) return 'blocked'
  return s
}

/** When the task last became active: started if it has, created otherwise. */
const activeAt = (t: ProjectTask) => t.startedAt ?? t.createdAt

/** Tasks created through `mcp__operator__dispatch` in `projectId`, by status (blocked, running,
 *  queued, done, abandoned), newest first within each. Reports count only when they carry this
 *  project's id and the task's exact id — the store is global across projects. */
export function dispatchedTasks(
  projects: readonly Project[],
  projectId: string,
  reports: readonly ArtifactReport[],
): DispatchedTaskRow[] {
  const project = projects.find((p) => p.id === projectId)
  if (!project) return []
  const roster = project.roster ?? []
  const latestReport = new Map<string, ArtifactReport>()
  for (const r of reports) {
    if (!r.taskId || r.projectId !== projectId) continue
    const prev = latestReport.get(r.taskId)
    if (!prev || r.at > prev.at) latestReport.set(r.taskId, r)
  }
  return (project.tasks ?? [])
    .filter((t) => t.source === 'mcp-dispatch')
    .map((t) => ({ t, status: statusOf(t) }))
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || (activeAt(a.t) < activeAt(b.t) ? 1 : activeAt(a.t) > activeAt(b.t) ? -1 : 0))
    .map(({ t, status }) => ({
      id: t.id,
      roleId: t.roleId,
      lane: roster.find((r) => r.id === t.roleId)?.name ?? t.roleId ?? 'unassigned',
      text: t.text,
      status,
      reportId: latestReport.get(t.id)?.id,
    }))
}
