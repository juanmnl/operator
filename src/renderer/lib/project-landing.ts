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
