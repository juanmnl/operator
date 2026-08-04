import type { Project } from '../../shared/types'

// WHERE ENTERING A PROJECT PUTS YOU.
//
// Two answers now, where there were three. It used to be the roster board always; then, once a
// project could have several lanes, "several lanes → the room they talk in" sent you to the
// channel. The channel is deleted, and so is that branch — but not by falling through to
// whatever came next: the destination for a multi-lane project is a real decision, and the
// answer is the BOARD.
//
// That is the same answer as the 0-lane and 1-idle-lane cases, and for the first time it is one
// rule rather than a coincidence of three agreeing: entering a project shows you the WORK. The
// only exception is a project with exactly one live lane, where "the work" and "that agent's
// session" are the same thing and the extra hop is ceremony.
//
// The rule keys off ROSTER SIZE, not on how many lanes happen to be running: "one agent" is a
// property of the project, and a lane being idle changes where you land, not whether it counts.

/** A live pty, as this module needs to see one. */
export interface LandingLane {
  id: string
  projectId?: string
  roleId?: string
  ended?: boolean
  /** The lane's DURABLE key (`SavedSession.key`). Present on real tabs; used to match the
   *  remembered agent, because `id` is a per-run pty id and means nothing after a restart. */
  key?: string
}

export type Landing =
  /** Project home — the board of work. Every case but the one below. */
  | { kind: 'board' }
  /** Exactly one lane, and it's live → straight into it. */
  | { kind: 'session'; terminalId: string }

/** Where opening `project` should land.
 *
 *  | roster | lands on |
 *  |---|---|
 *  | 2+ lanes | board |
 *  | 1 lane, live | that session |
 *  | 1 lane, idle | board — its card and Launch are one tab away, and the work is here |
 *  | 0 lanes | board — its composer is the only place to file the first task |
 *
 *  A single IDLE lane deliberately lands on the board rather than on an empty terminal surface:
 *  the useful next action is saying what you want done. It does NOT launch — landing somewhere is
 *  navigation, starting an agent is a decision that costs a process, a worktree and a dev port. */
export function landingFor(project: Project | null | undefined, lanes: readonly LandingLane[]): Landing {
  const roster = project?.roster ?? []
  if (!project || roster.length !== 1) return { kind: 'board' }
  const only = roster[0]
  const live = lanes.find((l) => l.projectId === project.id && l.roleId === only.id && !l.ended)
  return live ? { kind: 'session', terminalId: live.id } : { kind: 'board' }
}


// ── THE MEMORY IN FRONT OF THE RULE ────────────────────────────────────────────────────────
//
// "when switching projects, show me the last selected agent, not the project itself."
//
// This deliberately REVERSES an earlier decision — `handleOpenProject` used to re-apply the rule
// below rather than restore where you were, on the argument that predictable beats clever. The
// user has now asked for the clever one, per project. So `landingFor` is no longer the rule; it
// is the FALLBACK, and it stays exactly as it was: pure, roster-keyed, and testable on its own.
// The memory sits in front of it rather than inside it, so neither has to know about the other.
//
// The memory only ever wins when it resolves to a lane that is LIVE RIGHT NOW. Every other case
// — lane deleted, session ended, worktree gone, or the app was restarted and nothing is running —
// falls through. That is what stops it landing you on a dead pty, which is the failure the
// restore work already had to answer once: there is no session object for a lane with no pty, so
// "land on the last agent" would otherwise mean "land on nothing".

/** Where opening `project` should land, given the agent last selected IN THAT PROJECT.
 *
 *  `lastKey` is a durable `SavedSession.key`, never a terminal id — a record keyed on a pty id is
 *  worthless the moment the app restarts, which is precisely when it matters most. */
export function landingWithLastAgent(
  project: Project | null | undefined,
  lanes: readonly LandingLane[],
  lastKey: string | undefined,
): Landing {
  if (project && lastKey) {
    const live = lanes.find((l) => l.key === lastKey && l.projectId === project.id && !l.ended)
    if (live) return { kind: 'session', terminalId: live.id }
  }
  return landingFor(project, lanes)
}
