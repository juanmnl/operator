import type { ProjectTask } from '../../shared/types'

// Task lifecycle rules, kept pure and tested because the durable store got them wrong for
// months: 56 tasks across two projects sat in `running`, one project with 126 done and 18
// running that had all finished.
//
// TWO causes, and only the second is fixable here.
//
// 1. LIVENESS WAS KEYED ON A COLLIDING ID. `ProjectTask.terminalId` is a pty id from the
//    current backend run — a counter, `t0`/`t1`/… — so it repeats every launch. Measured in
//    the real store: `t5` is held by three different sessions (uwazi qa on Jul 21, operator qa
//    on Jul 23, operator code today). Every "is this lane still alive?" test keyed on it, so a
//    task stamped `t5` last week looked alive today merely because this run also had a `t5`.
//    That is why reconciliation never caught these. The fix is `claudeSessionId`: a UUID, one
//    per session, stable across restarts. It is now the liveness key, and `terminalId` is
//    demoted to what it's actually good for (the diff link).
//
// 2. COMPLETION ONLY FIRES WHEN A LANE DIES. `running → done` has exactly two triggers —
//    the pty exiting, and closing a session through the app. There is no per-turn completion
//    signal, so a long-lived lane accumulates every dispatch it was ever sent as `running`
//    even though it finished each one. NOT FIXED HERE and not fixable by reconciliation: those
//    tasks' lanes are alive, so leaving them `running` is the honest answer. Closing them
//    needs a real completion signal, which is separate work.
//
// The rule these functions encode: **a task is only `running` if the lane that claimed it is
// still alive in this run.** Anything else is history, and is reconciled on load.

/** A live lane, as the hydrate path knows it: a terminal tab paired with its session. */
export interface LiveLane {
  /** The lane's Claude session id — the liveness key. Absent for an untracked session. */
  claudeSessionId?: string
  terminalId: string
  roleId?: string
  projectId?: string
}

/** Lifecycle status, with the schema's "absent = queued" default applied. */
export function statusOf(t: ProjectTask): 'queued' | 'running' | 'done' | 'abandoned' {
  return t.status ?? 'queued'
}

/** Genuinely queued — the only tasks a lane can still be asked to pick up. */
export function isQueued(t: ProjectTask): boolean {
  return statusOf(t) === 'queued'
}

/** Closed out, either way: finished, or its run ended without us seeing it finish. Neither is
 *  actionable, and both should stay out of "what's left to do". */
export function isClosed(t: ProjectTask): boolean {
  const s = statusOf(t)
  return s === 'done' || s === 'abandoned'
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

/** The live lane a running task belongs to, or undefined if its lane is gone.
 *
 *  `lanes` must already be scoped to the task's own project — a ProjectTask carries no project
 *  id (it lives inside one), and the callers all loop per project anyway.
 *
 *  Keyed on `claudeSessionId` whenever the task has one. A task stamped before that field
 *  existed falls back to terminal + role, deliberately BOTH, because `terminalId` alone
 *  collides across runs and role narrows it to a lane that could plausibly own the task. That
 *  fallback is a ONE-TIME bridge: `reconcileStaleRunning` stamps the id it resolves, so a task
 *  takes this path at most once. It can still adopt wrongly — an old task whose (terminal,
 *  role, project) triple happens to match a live lane — and the cost of that is the task stays
 *  `running`, i.e. the status quo, never a wrong close. */
export function liveLaneOf(t: ProjectTask, lanes: LiveLane[]): LiveLane | undefined {
  if (t.claudeSessionId) {
    return lanes.find((l) => !!l.claudeSessionId && l.claudeSessionId === t.claudeSessionId)
  }
  if (!t.terminalId) return undefined
  return lanes.find((l) => l.terminalId === t.terminalId && (!t.roleId || l.roleId === t.roleId))
}

/** True when a task claims to be running on a lane that no longer exists in this run. */
export function isStaleRunning(t: ProjectTask, lanes: LiveLane[]): boolean {
  if (statusOf(t) !== 'running') return false
  return !liveLaneOf(t, lanes)
}

/** Reconcile every running task against the live lanes, on load.
 *
 *  Two outcomes, and the split is the whole point:
 *
 *  • ADOPTED — its lane IS alive, and the task predates `claudeSessionId`. Stamp the lane's id
 *    and leave it running. This is what stops a live lane's in-flight work being closed out
 *    from under it, and it's why the terminalId fallback exists at all.
 *  • ABANDONED — its lane is gone. `abandoned`, not `done`: these tasks WERE dispatched and the
 *    work probably happened, but what we actually know is only that their run ended without a
 *    completion record. Writing `done` claimed the stronger thing, and 56 tasks is far too many
 *    to quietly relabel as finished. `reconciledAt` records when we closed it.
 *
 *  Idempotent: after one pass every running task either carries a live `claudeSessionId` or is
 *  abandoned, so a second pass finds nothing to change and returns the same array reference. */
export function reconcileStaleRunning(
  tasks: ProjectTask[] | undefined,
  lanes: LiveLane[],
  now: string,
): ProjectTask[] | undefined {
  if (!tasks?.length) return tasks
  let changed = false
  const next = tasks.map((t) => {
    if (statusOf(t) !== 'running') return t
    const lane = liveLaneOf(t, lanes)
    if (lane) {
      // Alive. Backfill the liveness key if this task predates it; otherwise untouched.
      if (t.claudeSessionId || !lane.claudeSessionId) return t
      changed = true
      return { ...t, claudeSessionId: lane.claudeSessionId }
    }
    changed = true
    return { ...t, status: 'abandoned' as const, reconciledAt: now }
  })
  return changed ? next : tasks
}

/** Phases in which a lane is DOING something. The app's one motion rule uses the same pair:
 *  only running and compacting animate. */
const BUSY = new Set(['running', 'compacting'])

/** Did this lane just finish a turn?
 *
 *  THE BUG THIS EXISTS FOR: a running task was only ever closed when its lane's SESSION ENDED
 *  (`exitCompleteRef` → `completeTerminalTasks`). Lanes are long-lived and take task after task,
 *  so nothing closed while a lane stayed alive. Measured 2026-08-04 across the real store: 72
 *  tasks `running`, ZERO done, every one stamped with a LIVE terminal id — not the old stale-id
 *  leak, simply a lifecycle with no exit. The board reads as a wall of running work because it
 *  is one, and the Done column stays empty forever.
 *
 *  The signal already existed and was used for something else: the "ready for review" toast
 *  watches exactly this `running → waiting` edge. An agent leaving the busy phases is the only
 *  observable "it stopped working" this app has.
 *
 *  WHAT IT CANNOT KNOW: whether the work was actually finished, or whether the agent stopped to
 *  ask a question mid-task. Both look identical from outside. Closing is still right — Running
 *  must mean "an agent is working on this right now", and after the turn ends that is false
 *  whatever the reason. A task closed early is visible in Done and can be requeued; a task that
 *  never leaves Running is invisible work that no count can be trusted about, which is the
 *  failure we actually have.
 *
 *  Deliberately NOT an edge into `ended`: a lane whose session ends is already handled by the
 *  exit path, and firing both would run the diff capture and checks twice for one lane. */
export function finishedTurn(prev: string | undefined, next: string): boolean {
  return !!prev && BUSY.has(prev) && !BUSY.has(next) && next !== 'ended'
}
