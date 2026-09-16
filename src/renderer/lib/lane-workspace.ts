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
  return { useWorktree, sharesMainCheckout: !useWorktree && !isCoordinator(roleId) }
}
