import type { ProjectTask, TaskDiffStat, WorktreeDiff } from '../../shared/types'

// Task ↔ diff linkage. A running/done task carries provenance (cwd + worktree branch/base,
// stamped at dispatch) — these helpers turn that into an actual diff:
//   1. live working dir (worktree or project root), diffed vs the worktree base when known
//      so committed lane work counts too;
//   2. fallback: the surviving branch vs its base from the SOURCE repo (close removes the
//      worktree dir but keeps the branch).

/** Collapse a diff into the compact files/+/− summary stored on a completed task. */
export function summarizeDiff(d: WorktreeDiff | null | undefined): TaskDiffStat | undefined {
  if (!d || !d.files.length) return undefined
  return {
    files: d.files.length,
    added: d.files.reduce((n, f) => n + (f.added || 0), 0),
    removed: d.files.reduce((n, f) => n + (f.removed || 0), 0),
  }
}

/** The provenance fields that locate a task's change (see ProjectTask). */
export type TaskDiffSource = Pick<ProjectTask, 'cwd' | 'sourceCwd' | 'worktreeBranch' | 'worktreeBase'>

/** True when this task's diff could still be resolved (it has a live dir or a branch). */
export function taskHasDiffSource(task: TaskDiffSource): boolean {
  return !!task.cwd || !!(task.sourceCwd && task.worktreeBranch && task.worktreeBase)
}

/** Resolve a task's diff: working dir first, surviving branch as fallback. Null when
 *  neither source yields anything (no changes, or everything is gone). */
export async function fetchTaskDiff(task: TaskDiffSource): Promise<WorktreeDiff | null> {
  if (task.cwd) {
    try {
      const d = await window.operator.worktreeDiff(task.cwd, task.worktreeBase)
      if (d?.files?.length) return d
    } catch { /* dir gone — fall through to the branch */ }
  }
  if (task.sourceCwd && task.worktreeBranch && task.worktreeBase) {
    try {
      const d = await window.operator.branchDiff(task.sourceCwd, task.worktreeBranch, task.worktreeBase)
      if (d?.files?.length) return d
    } catch { /* branch merged/deleted */ }
  }
  return null
}

/** Fetch + summarize in one go — used to stamp `diffStat` when a task completes. */
export async function fetchTaskDiffStat(task: TaskDiffSource): Promise<TaskDiffStat | undefined> {
  return summarizeDiff(await fetchTaskDiff(task))
}
