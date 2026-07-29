import { presetFor } from './roster'
import type { Role } from '../../shared/types'

// Pure dispatch-routing logic, extracted from DashboardView's onOrchestratorDispatch
// handler so the routing DECISION is unit-testable (the handler keeps the side effects:
// terminalWrite / addTask / toast / feedback). An agent emitted `OPERATOR-DISPATCH
// [role] task`; given the project's roster + its live tabs, decide where it goes.

/** The minimum a tab must expose to be routable — the handler passes full TerminalTabs. */
export interface RoutableTab {
  id: string
  projectId?: string
  roleId?: string
  /** Pty exited but the pane is still mounted — an ended lane is NOT a live target. */
  ended?: boolean
}

export type DispatchRoute<T extends RoutableTab> =
  /** A live lane for the target role exists → type the task in. */
  | { kind: 'send'; role: Role; tab: T }
  /** The role is defined but has no live lane → queue for it. */
  | { kind: 'queue'; role: Role }
  /** The roster has no such lane, but the token names one of the six TEMPLATES → add the
   *  lane from its preset, then run the task on it. The dispatch is the demand. */
  | { kind: 'create'; role: Role }
  /** No such role, and no preset by that name → unassigned backlog. */
  | { kind: 'unassigned' }

/** Resolve a dispatch's target role (by id OR case-insensitive name) and decide its route.
 *  A tab counts as the role's live lane only if it's in the project, on that role, and not
 *  ended — an ended tab lingers mounted, so without the `ended` guard a dead lane would be
 *  dispatched into (its pty write is silently lost). */
export function routeDispatch<T extends RoutableTab>(
  roleToken: string,
  roster: Role[],
  tabs: T[],
  projectId: string,
): DispatchRoute<T> {
  const token = roleToken.toLowerCase()
  const role = roster.find((r) => r.id === roleToken || r.name.toLowerCase() === token)
  // No such lane YET. If the token names one of the six templates, the dispatch itself is the
  // demand — create the lane from its preset and run the task on it. That keeps an unattended
  // orchestration run working against an empty roster without reintroducing auto-seeding: a
  // lane only appears because work was explicitly addressed to it. A token that matches no
  // preset (a typo like `[cod]`) must NOT invent a junk lane — it falls through to unassigned,
  // which is visible and reassignable.
  if (!role) {
    const preset = presetFor(roleToken)
    return preset ? { kind: 'create', role: preset } : { kind: 'unassigned' }
  }
  const tab = tabs.find((t) => t.projectId === projectId && t.roleId === role.id && !t.ended)
  return tab ? { kind: 'send', role, tab } : { kind: 'queue', role }
}

/** Names of the lanes currently RUNNING in a project (excluding one tab, usually the
 *  dispatcher), for the feedback note so the orchestrator can reassign informedly. Ended
 *  tabs are excluded — advertising a dead lane as "running" steers work into a corpse. */
export function liveLaneNames<T extends RoutableTab>(
  tabs: T[],
  roster: Role[],
  projectId: string,
  excludeTabId: string,
): string[] {
  return tabs
    .filter((t) => t.projectId === projectId && !!t.roleId && !t.ended && t.id !== excludeTabId)
    .map((t) => roster.find((r) => r.id === t.roleId)?.name)
    .filter((n): n is string => !!n)
}
