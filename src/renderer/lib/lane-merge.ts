// The Diff panel's Merge and Discard, as ordered steps with the calls injected, so the ORDER is
// testable without rendering the panel.
//
// Review finding 1 (dev/results/review-d91080-2026-09-25.md): the panel merged its own lane while
// that lane was still running, committed only what the diff showed when the panel mounted, and
// killed the lane afterwards. A file the agent wrote in between was in the directory that the merge
// moved to the trash. So: the lane is stopped FIRST, the worktree's status is read AFTER that, and
// everything uncommitted is committed before the merge. Main also keeps the worktree if anything is
// still uncommitted after the merge (worktree.ts `mergeBranch`).

export interface LaneMergeCalls {
  /** Stop the lane's process tree; resolves when it is gone. */
  kill: (terminalId: string) => Promise<void>
  status: (path: string) => Promise<{ changes: number; valid: boolean }>
  commit: (path: string, message: string) => Promise<{ ok: boolean; error?: string }>
  merge: (path: string, sourceRoot: string, branch: string, baseBranch: string, ownTerminalId?: string) => Promise<{ ok: boolean; message?: string }>
  discard: (path: string, sourceRoot: string, branch: string, ownTerminalId?: string) => Promise<{ ok: boolean; error?: string }>
}

export interface LaneRef {
  worktreePath: string
  sourceRoot: string
  branch: string
  /** The lane this panel reviews, and whether its process is still running. */
  terminalId?: string
  laneRunning: boolean
}

export type StepResult = { ok: true; message?: string } | { ok: false; error: string }

export async function mergeLane(calls: LaneMergeCalls, lane: LaneRef, baseBranch: string, commitMessage: string): Promise<StepResult> {
  // 1. Nothing can write into the worktree from here on.
  if (lane.terminalId && lane.laneRunning) await calls.kill(lane.terminalId)
  // 2. What is uncommitted NOW, not what the panel showed when it opened.
  const st = await calls.status(lane.worktreePath)
  if (st.valid && st.changes > 0) {
    const c = await calls.commit(lane.worktreePath, commitMessage)
    if (!c.ok) return { ok: false, error: c.error || 'Commit failed' }
  }
  const r = await calls.merge(lane.worktreePath, lane.sourceRoot, lane.branch, baseBranch, lane.terminalId)
  return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.message || 'Merge failed' }
}

export async function discardLane(calls: LaneMergeCalls, lane: LaneRef): Promise<StepResult> {
  if (lane.terminalId && lane.laneRunning) await calls.kill(lane.terminalId)
  const r = await calls.discard(lane.worktreePath, lane.sourceRoot, lane.branch, lane.terminalId)
  return r.ok ? { ok: true } : { ok: false, error: r.error || 'Discard failed' }
}

/** The confirmation Discard shows first: it deletes the branch, and the lane may be running. */
export function discardConfirmText(branch: string, laneRunning: boolean): string {
  return `Delete branch ${branch} and its worktree? Commits only on that branch are lost.`
    + (laneRunning ? ' The lane is still running; it will be stopped first.' : '')
}
