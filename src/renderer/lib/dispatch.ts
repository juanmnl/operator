import { presetFor } from './roster'
import type { Role } from '../../shared/types'

// Pure dispatch-routing logic, extracted from DashboardView's onOrchestratorDispatch
// handler so the routing DECISION is unit-testable (the handler keeps the side effects:
// terminalWrite / addTask / toast / feedback). An agent emitted `OPERATOR-DISPATCH
// [role] task`; given the project's roster + its live tabs, decide where it goes.

/** The coordinator lanes. `orchestrator` is the pre-rename id, still present on old rosters.
 *  Membership is by ROLE ID, not by charter text: charters are advisory and models route around
 *  them — Research's says "never change code" and it complied literally, then wrote an
 *  implementation brief and dispatched Code to build it. 23 of 100 dispatches in the real store
 *  came from non-coordinator lanes. */
export const COORDINATOR_ROLE_IDS = ['operator', 'orchestrator']

/** Does this dispatch deliver on its own, or does it need a human to approve it first?
 *
 *  Only the coordinator commissions work unsupervised — that IS its job. Every other lane's
 *  dispatch is held for approval, which is not the same as blocking it: lanes still talk to each
 *  other, they just cannot SILENTLY commission work.
 *
 *  An unknown sender (`undefined` — an ad-hoc session with no lane) needs approval too. It is
 *  still an agent emitting a directive, and defaulting an unidentified sender to "trusted" is
 *  the wrong way round. */
export function dispatchNeedsApproval(fromRoleId: string | undefined): boolean {
  return !fromRoleId || !COORDINATOR_ROLE_IDS.includes(fromRoleId.toLowerCase())
}

/** The minimum a tab must expose to be routable — the handler passes full TerminalTabs. */
export interface RoutableTab {
  id: string
  projectId?: string
  roleId?: string
  /** Pty exited but the pane is still mounted — an ended lane is NOT a live target. */
  ended?: boolean
  /** The lane's last activity, used ONLY to break a duplicate tie deterministically. */
  lastActivityAt?: string
}

/** THE resolution of "which terminal is this role's lane", used by dispatch routing and by the
 *  launch path's reuse guard. One function on purpose: if the two disagreed, a dispatch and a
 *  relaunch could pick different duplicates of the same role and each would look correct.
 *
 *  Duplicates should not exist — the launch path now reuses a live lane instead of spawning a
 *  second — but the real store held 4-5 per role, so this has to be defined for them rather
 *  than left to `find()`'s array order, which is whatever the reattach happened to produce.
 *  Most recently ACTIVE wins: of several live lanes on one role, the one that spoke last is the
 *  one the user is actually working with. Ties fall to the latest in input order. */
export function pickLaneTab<T extends RoutableTab>(tabs: T[], projectId: string, roleId: string): T | undefined {
  let best: T | undefined
  for (const t of tabs) {
    if (t.projectId !== projectId || t.roleId !== roleId || t.ended) continue
    if (!best) { best = t; continue }
    // >= so a later tab wins an exact tie (and an undefined timestamp loses to a real one).
    if ((t.lastActivityAt ?? '') >= (best.lastActivityAt ?? '')) best = t
  }
  return best
}

/** Tabs that are ALIVE but unroutable — the bug state, named so it can be reported.
 *
 *  `pickLaneTab` requires `projectId` AND `roleId`. A tab missing either is invisible to it, so
 *  `routeDispatch` answers `queue` — the same answer it gives for a lane that simply is not
 *  running. Those two are not the same thing at all: one is "nothing to send to", the other is
 *  "there is a live agent here and we have lost its label". Six el-encanto lanes sat in the second
 *  state and the only signal was the user noticing they had gone quiet.
 *
 *  Deliberately NOT project-scoped: an orphan has no project by definition, so scoping the query
 *  by the thing that is missing would return nothing. */
export function orphanTabs<T extends RoutableTab>(tabs: T[]): T[] {
  return tabs.filter((t) => !t.ended && (!t.projectId || !t.roleId))
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
  const tab = pickLaneTab(tabs, projectId, role.id)
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
