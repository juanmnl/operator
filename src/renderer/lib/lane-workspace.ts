import { isCoordinator } from './roster'

// WHERE A LANE LAUNCHES: its own worktree, or the project's main checkout.
//
// The setting is `Role.useWorktree`, resolved by `resolveAgentConfig` (lane pin → preset → off).
// This decides the launch from that answer and from a suspended record, if the lane has one.

export interface LaunchWorkspace {
  /** Create (or reattach) a worktree for this launch. */
  useWorktree: boolean
  /** The lane runs in the shared main checkout and gets the no-commit line in its brief. */
  sharesMainCheckout: boolean
  /** The lane has its own worktree and gets the `worktree_done` line in its brief. */
  ownWorktree: boolean
}

/** A suspended lane resumes WHERE IT WAS, whatever the setting says now. A worktree lane goes back
 *  onto its branch (its transcript wrote work there); a main-checkout lane stays in the main
 *  checkout. Changing the setting takes effect on the lane's next fresh launch. Pure. */
export function launchWorkspace(
  roleId: string,
  resolvedUseWorktree: boolean,
  suspended?: { worktreeBranch?: string } | null,
): LaunchWorkspace {
  const useWorktree = suspended ? !!suspended.worktreeBranch : resolvedUseWorktree
  const coordinator = isCoordinator(roleId)
  return { useWorktree, sharesMainCheckout: !useWorktree && !coordinator, ownWorktree: useWorktree && !coordinator }
}

/** The suspended record a launch resumes, if any: this role's most recent one in this project.
 *  Most recent wins if a role somehow has several — same rule as `pickLaneTab`.
 *
 *  None when the launch REPLACES a lane the dispatch path just retired (`replacing`): that lane
 *  gave its worktree up with `worktree_done`, and the dispatch asks for a fresh lane on a new
 *  branch, not an older thread reattached to its old one. Without a record, `worktreeCreate` gets
 *  no branch to reuse and makes a new worktree. Pure. */
export function suspendedToResume<S extends { projectId?: string; roleId?: string; suspendedAt?: string; claudeSessionId?: string; lastActiveAt: string }>(
  saved: readonly S[],
  projectId: string,
  roleId: string,
  replacing?: string,
): S | undefined {
  if (replacing) return undefined
  return saved
    .filter((s) => s.projectId === projectId && s.roleId === roleId && s.suspendedAt && s.claudeSessionId)
    .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))[0]
}
