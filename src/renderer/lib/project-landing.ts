import type { Project } from '../../shared/types'

// WHERE ENTERING A PROJECT PUTS YOU.
//
// It used to be the roster board, always. That was the right answer when every project arrived
// with six seeded lanes and the board was the only place that explained them — but the roster is
// now one lane by default (see prune-seeded-lanes / operator-is-the-floor), so the board became a
// screen with a single row on it and nothing to decide.
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
  /** Several lanes → the room they talk in. */
  | { kind: 'channel' }
  /** No lanes, or one that isn't running → the board. It is the only place to add a lane, and for
   *  a single idle lane it is also where its card and its Launch button already are. */
  | { kind: 'roster' }
  /** Exactly one lane, and it's live → straight into it. */
  | { kind: 'session'; terminalId: string }

/** Where opening `project` should land.
 *
 *  | roster | lands on |
 *  |---|---|
 *  | 2+ lanes | channel |
 *  | 1 lane, live | that session |
 *  | 1 lane, idle | roster — its card, with Launch in view |
 *  | 0 lanes | roster — the only place to add one |
 *
 *  A single IDLE lane deliberately lands on the board rather than on an empty terminal surface:
 *  the useful next action is launching it, and the board is where that button is. It does NOT
 *  launch — landing somewhere is navigation, starting an agent is a decision that costs a process,
 *  a worktree and a dev port. That the 0-lane and 1-idle-lane cases share a destination is a
 *  coincidence of it being the right screen for both, not one rule doing double duty. */
export function landingFor(project: Project | null | undefined, lanes: readonly LandingLane[]): Landing {
  const roster = project?.roster ?? []
  if (!project || roster.length === 0) return { kind: 'roster' }
  if (roster.length > 1) return { kind: 'channel' }
  const only = roster[0]
  const live = lanes.find((l) => l.projectId === project.id && l.roleId === only.id && !l.ended)
  return live ? { kind: 'session', terminalId: live.id } : { kind: 'roster' }
}
