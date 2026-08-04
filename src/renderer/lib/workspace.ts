// WHERE YOU WERE, so a restart puts you back there.
//
// "if i restart the app, everything should open where it was" — and the settled shape of that is
// narrower than it sounds: **restore the UI exactly, do NOT auto-spawn agents.** Reopening the
// app and having it silently start six Claude processes, six worktrees and six dev ports is a
// worse surprise than being shown where you were with a resume control waiting. Auto-resume is a
// setting, default off.
//
// This module is the DECISION, kept pure: persisted workspace + what actually exists now → what
// to show. It knows nothing about React, the bridge or the pty, which is what makes every failure
// mode below testable — a missing folder and a first launch are the same kind of input here.
//
// ⚠ THE HARD PART, and the honest answer to it. You cannot focus a dead pty, and in this app that
// is stronger than it sounds: `allSidebarSessions` is `terminals.map(...)` in DashboardView, so
// EVERY session object in the UI is derived from a live terminal tab. With no ptys at launch
// there is no `AgentSession` at all — not an empty one, none — so the chat view has nothing to
// render and the sidebar has only idle lane rows. Restoring "the lane you were in" as a readable
// transcript would need a synthetic session fed from the durable store, which is a different and
// much larger feature. So a session you were looking at restores as PROJECT HOME with that lane
// named and one press away, and never as something that looks live.

import type { SavedSession } from '../../shared/types'

/** What the content area was showing. Mirrors DashboardView's `contentMode`, plus `session`
 *  for "a lane was focused" — which is the one value that cannot be restored as-is. */
export type WorkspaceMode = 'gallery' | 'project' | 'agents' | 'prefs' | 'globalPrefs' | 'session'

export type WorkspaceProjectTab = 'board' | 'team' | 'moodboard'

/** The snapshot, written on change (never only at quit — an app that records where you were
 *  solely on a clean exit loses exactly the case this feature exists for). */
export interface Workspace {
  /** Schema version. A shape change bumps it and older snapshots are IGNORED rather than
   *  half-read: landing somewhere wrong is worse than landing at the gallery. */
  v: 1
  projectId: string | null
  mode: WorkspaceMode
  projectTab: WorkspaceProjectTab
  /** Durable key (`SavedSession.key`) of the lane that had focus. NOT a terminal id — those are
   *  per-run and meaningless after a restart, which `SavedSession.terminalId`'s own doc-comment
   *  already says about itself. */
  focusedKey?: string
  /** Durable keys of the sessions that were LIVE at the time. The resume offer has to be "the
   *  six you had", and `savedSessions` alone cannot say that: it holds every session never
   *  explicitly closed, including ones from runs before this one. */
  liveKeys: string[]
  at: string
}

export const WORKSPACE_VERSION = 1

/** Why a session can't simply be resumed. Each of these has to be VISIBLE — a silent skip is how
 *  "restore" quietly becomes "start something else". */
export type ResumeBlocker =
  /** The folder (or worktree) it lived in is gone. Nothing to spawn into. */
  | 'folder-missing'
  /** No `claudeSessionId`, so `--resume` is impossible: this can only be a FRESH session. Say so
   *  before doing it — silently starting a new agent where someone expected their conversation
   *  back is the bad outcome. */
  | 'no-conversation'

export interface RestorableLane {
  saved: SavedSession
  blocked?: ResumeBlocker
}

export interface RestoreInput {
  workspace: Workspace | null
  /** Project ids that still exist. */
  projectIds: string[]
  savedSessions: SavedSession[]
  /** Paths known to be GONE. Absent from this set means "assume present" — the check is async
   *  and best-effort, and a restore that waits on the filesystem before drawing anything is a
   *  slow launch for a rare case. */
  missingPaths?: ReadonlySet<string>
}

export interface RestorePlan {
  projectId: string | null
  /** Never `session`: see the note at the top of this file. */
  mode: Exclude<WorkspaceMode, 'session'>
  projectTab: WorkspaceProjectTab
  /** The lanes that were live, oldest-first — the same order `handleResumeProject` uses, so the
   *  sidebar comes back in its familiar order. */
  lanes: RestorableLane[]
  /** The lane that had focus, if it is still identifiable. Named so the user can be told what
   *  they are one press away from, rather than being dropped somewhere with no explanation. */
  focused?: RestorableLane
  /** Everything the restore could NOT do, in the order it decided. Rendered by the caller. */
  notes: RestoreNote[]
}

export type RestoreNote =
  | { kind: 'first-run' }
  | { kind: 'project-gone'; projectId: string }
  | { kind: 'session-not-live'; name?: string }
  | { kind: 'lane-blocked'; name: string; blocker: ResumeBlocker }

const DEFAULT_PLAN: RestorePlan = { projectId: null, mode: 'gallery', projectTab: 'board', lanes: [], notes: [] }

/** Is this snapshot one we understand? Anything else is treated as absent. */
export function isWorkspace(v: unknown): v is Workspace {
  if (!v || typeof v !== 'object') return false
  const w = v as Partial<Workspace>
  return w.v === WORKSPACE_VERSION && Array.isArray(w.liveKeys) && typeof w.mode === 'string'
}

export function readWorkspace(raw: string | null): Workspace | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isWorkspace(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** A lane's display name, for a note the user reads. */
function laneName(s: SavedSession): string {
  return s.customName || s.roleId || s.projectName || s.cwd.split('/').pop() || s.cwd
}

/** THE DECISION. Pure: same inputs, same plan, no clock and no filesystem. */
export function planRestore({ workspace, projectIds, savedSessions, missingPaths }: RestoreInput): RestorePlan {
  if (!workspace) return { ...DEFAULT_PLAN, notes: [{ kind: 'first-run' }] }

  const notes: RestoreNote[] = []
  const known = new Set(projectIds)

  // A project that is no longer on record can't be scoped to. This is not only "the user
  // deleted it" — a project whose FOLDER is gone is still on record, and that case is handled
  // per-lane below, because the project screen itself is still readable.
  let projectId = workspace.projectId
  if (projectId && !known.has(projectId)) {
    notes.push({ kind: 'project-gone', projectId })
    projectId = null
  }

  const byKey = new Map(savedSessions.map((s) => [s.key, s]))
  const gone = (s: SavedSession) => !!missingPaths?.has(s.cwd)
  const blockerFor = (s: SavedSession): ResumeBlocker | undefined =>
    gone(s) ? 'folder-missing' : (s.claudeSessionId ? undefined : 'no-conversation')

  // "The ones you had", not "every session this project has ever had". A key in `liveKeys` whose
  // SavedSession has since been forgotten (closed from another window, pruned) simply drops.
  const lanes: RestorableLane[] = workspace.liveKeys
    .map((k) => byKey.get(k))
    .filter((s): s is SavedSession => !!s)
    .filter((s) => !projectId || s.projectId === projectId)
    .sort((a, b) => a.lastActiveAt.localeCompare(b.lastActiveAt))
    .map((saved) => ({ saved, blocked: blockerFor(saved) }))

  for (const l of lanes) {
    if (l.blocked) notes.push({ kind: 'lane-blocked', name: laneName(l.saved), blocker: l.blocked })
  }

  const focusedSaved = workspace.focusedKey ? byKey.get(workspace.focusedKey) : undefined
  const focused = focusedSaved ? { saved: focusedSaved, blocked: blockerFor(focusedSaved) } : undefined

  // A focused session cannot come back as a focused session — there is no pty and therefore no
  // session object to focus. It becomes Project Home with that lane named, which is honest and
  // still one press from being live.
  let mode: RestorePlan['mode']
  if (workspace.mode === 'session') {
    mode = projectId ? 'project' : 'gallery'
    notes.push({ kind: 'session-not-live', name: focusedSaved ? laneName(focusedSaved) : undefined })
  } else if (workspace.mode === 'project' && !projectId) {
    mode = 'gallery'
  } else {
    mode = workspace.mode
  }

  return { projectId, mode, projectTab: workspace.projectTab ?? 'board', lanes, focused, notes }
}

/** One line for the user, or null when there is nothing worth saying. Kept here rather than in
 *  the view so the wording is testable next to the rules that produce it. */
export function describeRestore(plan: RestorePlan): string | null {
  const blocked = plan.notes.filter((n): n is Extract<RestoreNote, { kind: 'lane-blocked' }> => n.kind === 'lane-blocked')
  if (blocked.length) {
    const missing = blocked.filter((b) => b.blocker === 'folder-missing').map((b) => b.name)
    const fresh = blocked.filter((b) => b.blocker === 'no-conversation').map((b) => b.name)
    const parts: string[] = []
    if (missing.length) parts.push(`${missing.join(', ')} — folder gone`)
    if (fresh.length) parts.push(`${fresh.join(', ')} — no saved conversation, would start fresh`)
    return parts.join(' · ')
  }
  if (plan.notes.some((n) => n.kind === 'project-gone')) return 'That project is no longer on record'
  const live = plan.lanes.length
  if (live) {
    const was = plan.notes.find((n): n is Extract<RestoreNote, { kind: 'session-not-live' }> => n.kind === 'session-not-live')
    return was?.name
      ? `You were in ${was.name}. ${live} agent${live > 1 ? 's' : ''} ready to resume.`
      : `${live} agent${live > 1 ? 's' : ''} ready to resume.`
  }
  return null
}

/** Where the snapshot lives. One key: the workspace is one fact ("where you were"), and
 *  splitting it across keys is how half a restore becomes possible. */
export const WORKSPACE_KEY = 'operator.workspace'

/** The setting. Default OFF, and that default is the decision, not an accident — see the top
 *  of this file. Stored as '1'/'0' like the app's other switches. */
export const RESUME_ON_LAUNCH_KEY = 'operator.resumeOnLaunch'

export function resumeOnLaunchEnabled(): boolean {
  try { return localStorage.getItem(RESUME_ON_LAUNCH_KEY) === '1' } catch { return false }
}
