import type { ProjectTask } from '../../shared/types'

// Task lifecycle rules, kept pure and tested because the durable store got them wrong for
// months: ~200 tasks across four projects sat in `running` forever, and one project had 26
// running with ZERO done.
//
// The root cause is a status that outlives the process that set it. `ProjectTask.terminalId`
// is a pty id from the CURRENT backend run — `shared/types.ts` says outright it is stale after
// a restart — and `markTasksRunning` stamps it onto the task. After a restart nothing can
// match that id again, and the roleId fallback couldn't rescue it either because that branch
// required the task to have NO terminalId, which is the very field that was stamped. So every
// restart permanently stranded the whole in-flight set.
//
// The rule these functions encode: **a task is only `running` if the terminal that claimed it
// is still alive in this run.** Anything else is history, and is reconciled on load.

/** Lifecycle status, with the schema's "absent = queued" default applied. */
export function statusOf(t: ProjectTask): 'queued' | 'running' | 'done' {
  return t.status ?? 'queued'
}

/** Genuinely queued — the only tasks a lane can still be asked to pick up. */
export function isQueued(t: ProjectTask): boolean {
  return statusOf(t) === 'queued'
}

/** Tasks per lane that are actually QUEUED. The roster chip used to count every task ever
 *  filed against a lane — running and done included — and label the total "QUEUED", so a
 *  lane showing "28 QUEUED" was really 23 running + 7 done, and its idle-lane button offered
 *  to `Launch 28 →` tasks that had already finished. */
export function queuedCountsByRole(tasks: ProjectTask[] | undefined): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const t of tasks ?? []) {
    if (!t.roleId || !isQueued(t)) continue
    counts[t.roleId] = (counts[t.roleId] ?? 0) + 1
  }
  return counts
}

/** True when a task claims to be running on a terminal that no longer exists in this run.
 *  A task claimed at pickup but never stamped with a terminal (the launch path claims first,
 *  stamps once the pty exists) is also stale once we know the live set — it can only belong
 *  to a run that is over. */
export function isStaleRunning(t: ProjectTask, liveTerminalIds: Set<string>): boolean {
  if (statusOf(t) !== 'running') return false
  return !t.terminalId || !liveTerminalIds.has(t.terminalId)
}

/** Close out every task whose lane is gone, so `running` can't accumulate across restarts.
 *
 *  They become `done` rather than `queued` on purpose. These tasks WERE dispatched — the work
 *  most likely happened; what went missing is the completion record, because completion is
 *  only written when a lane is closed through the app (`completeTerminalTasks`) and quitting
 *  never runs that path. Re-queuing ~200 of them would re-dispatch finished work at every
 *  lane on the next launch; marking them done keeps them in the record and out of the way.
 *  `reconciledAt` is what keeps that honest — it says "closed because its run ended", never
 *  "verified complete", so the done row can admit the difference.
 *
 *  Returns the same array reference when nothing changed, so callers can skip a write. */
export function reconcileStaleRunning(
  tasks: ProjectTask[] | undefined,
  liveTerminalIds: Set<string>,
  now: string,
): ProjectTask[] | undefined {
  if (!tasks?.length) return tasks
  let changed = false
  const next = tasks.map((t) => {
    if (!isStaleRunning(t, liveTerminalIds)) return t
    changed = true
    return { ...t, status: 'done' as const, doneAt: t.doneAt ?? now, reconciledAt: now }
  })
  return changed ? next : tasks
}
