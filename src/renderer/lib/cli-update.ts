// A LANE ON AN OLDER CLAUDE CODE THAN THE ONE INSTALLED NOW, and what may be done about it.
//
// Claude Code updates itself underneath running lanes (`~/.local/share/claude/versions/<v>`, and
// the `claude` link moves). A lane keeps its old binary until its process restarts, and the only
// remedy was to end it and resume it by hand, once per lane. Main records the version each lane was
// spawned on and watches the installed one (electron/src/main/claude-version.ts). These are the
// decisions the view makes from those two readings, pure so they are tested rather than clicked.

import type { AgentSession } from '../../shared/types'
import { canAnnounceTo } from './comms'

/** Compare `major.minor.patch` numerically; a release outranks its own prerelease. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const s = v.trim()
    const dash = s.indexOf('-')
    const core = dash < 0 ? s : s.slice(0, dash)
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: dash < 0 ? '' : s.slice(dash + 1) }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d !== 0) return Math.sign(d)
  }
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre < y.pre ? -1 : 1
}

/** Is this lane running an older Claude Code than the one installed?
 *
 *  Unknown on either side is NOT out of date. A lane spawned before versions were recorded, or a
 *  watcher that could not read the link, must not grow a Restart button on a guess. */
export function isOutOfDate(spawned: string | null | undefined, installed: string | null | undefined): boolean {
  if (!spawned || !installed) return false
  return compareVersions(spawned, installed) < 0
}

/** May this lane be restarted now?
 *
 *  BETWEEN TURNS ONLY, by the same predicate that gates a typed announcement (`canAnnounceTo`).
 *  That excludes a lane mid-turn or compacting, and a lane blocked on a permission prompt: an
 *  unanswered `tool_use` derives as `running`, not `waiting`. It also excludes a lane with a prompt
 *  still in the submit queue, which the restart would drop. */
export function canRestartLane(
  session: Pick<AgentSession, 'status' | 'phase'> | undefined,
  pendingSubmission: boolean,
): boolean {
  return canAnnounceTo(session) && !pendingSubmission
}

export interface RestartCandidate {
  terminalId: string
  claudeVersion?: string | null
  ended?: boolean
  session?: Pick<AgentSession, 'status' | 'phase'>
  pendingSubmission: boolean
  /** Has a Claude session id to `--resume`. A lane without one would restart into a blank session. */
  resumable: boolean
}

/** Can this lane be restarted onto the installed version right now? */
export function restartable(lane: RestartCandidate, installed: string | null | undefined): boolean {
  return !lane.ended
    && lane.resumable
    && isOutOfDate(lane.claudeVersion, installed)
    && canRestartLane(lane.session, lane.pendingSubmission)
}

/** The lane auto-restart takes next, or null.
 *
 *  ONE AT A TIME: nothing while a restart is in flight, so a fleet never restarts at once, and the
 *  first eligible lane in rail order goes next. */
export function pickAutoRestart(
  lanes: readonly RestartCandidate[],
  installed: string | null | undefined,
  restarting: boolean,
): string | null {
  if (restarting || !installed) return null
  return lanes.find((l) => restartable(l, installed))?.terminalId ?? null
}

/** How often auto-restart looks for a lane to take. One lane per tick at most. */
export const AUTO_RESTART_TICK_MS = 30_000

/** Launch options for a restart: the same lane, resumed. The same keys the launch and restore paths
 *  send, so `buildArgs` produces `--resume <id>` and the lane's own model, effort and permission
 *  mode; `projectId`/`roleId` keep its reports and replies stamped as that lane. */
export function restartLaunchOptions(
  lane: { model?: string; effort?: string; permissionMode?: string; projectId?: string; roleId?: string },
  claudeSessionId: string,
  extra: { orchestrationNote?: string; remoteControl: boolean; remoteControlName?: string },
): Record<string, unknown> {
  const o: Record<string, unknown> = { resumeSessionId: claudeSessionId }
  if (lane.permissionMode && lane.permissionMode !== 'default') o.permissionMode = lane.permissionMode
  if (lane.model) o.model = lane.model
  if (lane.effort) o.effort = lane.effort
  if (lane.projectId) o.projectId = lane.projectId
  if (lane.roleId) o.roleId = lane.roleId
  if (extra.orchestrationNote) o.orchestrationNote = extra.orchestrationNote
  o.remoteControl = extra.remoteControl
  if (extra.remoteControlName) o.remoteControlName = extra.remoteControlName
  return o
}

/** Swap a restarted lane's tab IN PLACE, so it keeps its slot in the rail. */
export function replaceTab<T extends { id: string }>(tabs: readonly T[], oldId: string, next: T): T[] {
  return tabs.map((t) => (t.id === oldId ? next : t))
}

/** Tasks stamped with the old terminal id follow the lane to the new one. Tasks keyed by Claude
 *  session id already match, because `--resume` keeps the id; this covers terminal-only stamps.
 *  Returns the same array when nothing changed, so a caller can skip the state update. */
export function rekeyTasks<T extends { terminalId?: string }>(tasks: readonly T[], oldId: string, newId: string): readonly T[] {
  if (!tasks.some((t) => t.terminalId === oldId)) return tasks
  return tasks.map((t) => (t.terminalId === oldId ? { ...t, terminalId: newId } : t))
}

/** The header affordance's text. */
export function cliUpdateLabel(installed: string): string {
  return `Claude Code ${installed} available · Restart`
}

export const AUTO_RESTART_KEY = 'operator.autoRestartOnCliUpdate'

/** Auto-restart idle lanes onto a new Claude Code. Off unless the user turned it on. */
export function autoRestartEnabled(): boolean {
  try { return localStorage.getItem(AUTO_RESTART_KEY) === '1' } catch { return false }
}

export function setAutoRestartEnabled(on: boolean): void {
  try { localStorage.setItem(AUTO_RESTART_KEY, on ? '1' : '0') } catch { /* quota */ }
}
