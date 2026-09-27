import { presetFor } from './roster'
import { isBetweenTurns } from './comms'
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
  /** Where its pty runs, and for a worktree lane the repo the worktree came from. Checked against
   *  the project's path, so a tab LABELLED with a project it does not run in is never picked. */
  cwd?: string
  sourceCwd?: string
  /** The tracked session's phase (`running` | `compacting` | `waiting` | `asking` | `idle`), or
   *  undefined when no transcript has been seen. Read only for a released lane. */
  phase?: string
  /** This lane called `worktree_done` and main holds an open release for it (`markReleased`). */
  released?: boolean
  /** Something happened at this lane in the last few seconds that the transcript may not show
   *  yet: a keystroke, a transcript record, a submission awaiting its turn. Read only for a
   *  released lane, which is then not retired until it has been quiet for a moment. */
  settling?: boolean
}

/** Case-insensitive, like the default macOS volume, and ignoring a trailing slash. */
const norm = (p: string): string => p.replace(/\/+$/, '').toLowerCase()
const within = (path: string, root: string): boolean => {
  const p = norm(path), r = norm(root)
  return p === r || p.startsWith(r + '/')
}

/** Where a project lives, for `tabRunsIn`: this project's path and every other project's. */
export interface ProjectPaths { own?: string; others?: readonly string[] }

/** May this tab be treated as a lane of the project it is labelled with? Pure.
 *
 *  X6 in dev/results/lane-instances-and-message-mixing-2026-09-25.md: routing trusted the tab's
 *  project LABEL alone, so a tab labelled (uwazi, design) while its pty ran in mantel would be picked
 *  as uwazi's Design and handed that mantel session's address.
 *
 *  REFUSED ONLY WHEN THE TAB PROVABLY RUNS IN ANOTHER PROJECT: its directory (or a worktree lane's
 *  source repo) lies inside another known project's path, and that path is the most specific match.
 *  Anything else keeps the label: a tab with no directory, and one whose directory matches no project
 *  at all, which is what a project whose path was moved or edited while its lanes run looks like.
 *  Requiring a match with the project's own path instead (the first version) stopped routing to
 *  those lanes and made the reuse check launch a second one (review-xproject-devports, A5). */
export function tabRunsIn(t: { cwd?: string; sourceCwd?: string }, paths: ProjectPaths | string | undefined): boolean {
  const { own, others = [] } = typeof paths === 'string' ? { own: paths } : paths ?? {}
  const dirs = [t.cwd, t.sourceCwd].filter((d): d is string => !!d)
  if (!dirs.length) return true
  // The most specific project path containing one of the tab's directories decides.
  let best: { length: number; own: boolean } | undefined
  for (const [root, isOwn] of [...(own ? [[own, true] as const] : []), ...others.map((o) => [o, false] as const)]) {
    if (!dirs.some((d) => within(d, root))) continue
    const length = norm(root).length
    if (!best || length > best.length) best = { length, own: isOwn }
  }
  return !best || best.own
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
export function pickLaneTab<T extends RoutableTab>(tabs: T[], projectId: string, roleId: string, projectPath?: ProjectPaths | string): T | undefined {
  let best: T | undefined
  for (const t of tabs) {
    if (t.projectId !== projectId || t.roleId !== roleId || t.ended) continue
    if (!tabRunsIn(t, projectPath)) continue
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
  /** The role's live lane released its worktree and is between turns → end that session the way
   *  a user's close does, then launch a fresh lane with the task as its opening brief. */
  | { kind: 'retire'; role: Role; tab: T }
  /** The role's live lane released its worktree but is still mid-turn → nothing is sent and
   *  nothing is ended; Operator tells the dispatcher once the lane is idle (lib/retire-watch).
   *  `unseen`: Operator has no phase for it at all, so it can neither end it nor watch it. */
  | { kind: 'finishing'; role: Role; tab: T; unseen: boolean }
  /** The role is defined but has no live lane → queue for it. */
  | { kind: 'queue'; role: Role }
  /** The roster has no such lane, but the token names one of the preset TEMPLATES → add the
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
  /** Where this project and the others live: a tab that runs in another project is not its lane
   *  (`tabRunsIn`, X6). */
  projectPath?: ProjectPaths | string,
): DispatchRoute<T> {
  const token = roleToken.toLowerCase()
  const role = roster.find((r) => r.id === roleToken || r.name.toLowerCase() === token)
  // No such lane YET. If the token names one of the preset templates, the dispatch itself is the
  // demand — create the lane from its preset and run the task on it. That keeps an unattended
  // orchestration run working against an empty roster without reintroducing auto-seeding: a
  // lane only appears because work was explicitly addressed to it. A token that matches no
  // preset (a typo like `[cod]`) must NOT invent a junk lane — it falls through to unassigned,
  // which is visible and reassignable.
  if (!role) {
    const preset = presetFor(roleToken)
    return preset ? { kind: 'create', role: preset } : { kind: 'unassigned' }
  }
  const tab = pickLaneTab(tabs, projectId, role.id, projectPath)
  if (!tab) return { kind: 'queue', role }
  // A LANE THAT RELEASED ITS WORKTREE IS FINISHED, and new work must not go into it: it runs in a
  // directory that is removed when it ends, and its brief tells it never to branch again there.
  // Only the release record qualifies (`markReleased`); nothing else ends a lane from here.
  // An unknown phase is never ended: a lane Operator cannot see is reported as unseen instead.
  if (tab.released) {
    if (!tab.phase) return { kind: 'finishing', role, tab, unseen: true }
    return isBetweenTurns(tab.phase) && !tab.settling
      ? { kind: 'retire', role, tab }
      : { kind: 'finishing', role, tab, unseen: false }
  }
  return { kind: 'send', role, tab }
}

/** The live lane a launch should reuse instead of spawning. None when the launch REPLACES a lane
 *  the dispatch path just retired: that dispatch asked for a fresh lane, and any other live tab on
 *  the role (a duplicate, possibly released or mid-turn itself) is not one. Pure. */
export function reusableLane<T extends RoutableTab>(tabs: T[], projectId: string, roleId: string, projectPath?: ProjectPaths | string, replacing?: string): T | undefined {
  return replacing ? undefined : pickLaneTab(tabs, projectId, roleId, projectPath)
}

/** How long a released lane must have been quiet before a dispatch retires it. The transcript
 *  shows a prompt about a second after it is submitted, and the phase is a one-second snapshot,
 *  so a lane that did anything in the last few seconds may be taking work Operator cannot see yet
 *  (review L2). A keystroke gets longer: a person mid-sentence has not submitted anything. */
export const RETIRE_ACTIVITY_QUIET_MS = 3_000
export const RETIRE_TYPING_QUIET_MS = 10_000

/** Stamp `released` on the tabs main holds an open `worktree_done` release for. Pure.
 *
 *  Matched on terminal id AND directory: the rows are already scoped to this app run, and the
 *  directory check keeps a row from marking a tab that is not the lane that released it. Only a
 *  worktree lane (its own branch, a directory other than its source repo) can qualify. */
export function markReleased<T extends RoutableTab & { worktreeBranch?: string }>(
  tabs: readonly T[],
  releases: ReadonlyArray<{ terminalId: string; projectId?: string | null; path: string }>,
): T[] {
  return tabs.map((t) => {
    const worktreeLane = !!t.worktreeBranch && !!t.cwd && !!t.sourceCwd && norm(t.cwd) !== norm(t.sourceCwd)
    const released = worktreeLane && releases.some((r) => (
      r.terminalId === t.id && norm(r.path) === norm(t.cwd!) && (!r.projectId || r.projectId === t.projectId)
    ))
    return released ? { ...t, released: true } : t
  })
}

/** `markReleased` for one tab, as a yes/no. */
export function isReleased(
  tab: RoutableTab & { worktreeBranch?: string },
  releases: ReadonlyArray<{ terminalId: string; projectId?: string | null; path: string }>,
): boolean {
  return markReleased([tab], releases)[0].released === true
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
