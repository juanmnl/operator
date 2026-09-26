// The Diff panel's Merge and Discard, with the bridge calls injected so the panel's part is testable
// without rendering it.
//
// THE ORDER LIVES IN MAIN (Review N1). Merge must stop the lane before committing, so nothing it
// writes afterwards is left behind (Review finding 1), and it must stop the lane only once nothing
// can refuse: a refused merge (another lane in the worktree, a dirty source repo, a missing branch)
// used to stop the lane for nothing. Only main can do both in one step, so the panel passes its
// lane's id and main runs refusals, then the stop, then the commit, then the merge
// (`mergeBranch` in electron/src/main/worktree.ts). Discard is the same.

export interface LaneMergeCalls {
  merge: (path: string, sourceRoot: string, branch: string, baseBranch: string, ownTerminalId?: string, commitMessage?: string) => Promise<{ ok: boolean; message?: string }>
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

/** The lane's id goes to main only while it runs: main stops that terminal, after its refusals. */
const ownId = (lane: LaneRef) => (lane.laneRunning ? lane.terminalId : undefined)

export async function mergeLane(calls: LaneMergeCalls, lane: LaneRef, baseBranch: string, commitMessage: string): Promise<StepResult> {
  const r = await calls.merge(lane.worktreePath, lane.sourceRoot, lane.branch, baseBranch, ownId(lane), commitMessage)
  return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.message || 'Merge failed' }
}

export async function discardLane(calls: LaneMergeCalls, lane: LaneRef): Promise<StepResult> {
  const r = await calls.discard(lane.worktreePath, lane.sourceRoot, lane.branch, ownId(lane))
  return r.ok ? { ok: true } : { ok: false, error: r.error || 'Discard failed' }
}

/** The confirmation Discard shows first: it deletes the branch, and the lane may be running. */
export function discardConfirmText(branch: string, laneRunning: boolean): string {
  return `Delete branch ${branch} and its worktree? Commits only on that branch are lost.`
    + (laneRunning ? ' The lane is still running; it will be stopped once nothing refuses the discard.' : '')
}
