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

import type { PreviousRunInfo, SavedSession } from '../../shared/types'

/** What the content area was showing. Mirrors DashboardView's `contentMode`, plus `session`
 *  for "a lane was focused" — which is the one value that cannot be restored as-is. */
export type WorkspaceMode = 'gallery' | 'project' | 'agents' | 'tuning' | 'prefs' | 'globalPrefs' | 'session'

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
  /** projectId → the durable key of the agent last selected IN THAT PROJECT.
   *
   *  ONE record, deliberately: "which session had focus" (restart) and "the last agent for this
   *  project" (switching) are the same fact read at two moments, and building them twice would
   *  give two stores that can disagree. Per project, never a single global last-agent — switching
   *  to B must not land you on A's lane. */
  lastAgentByProject?: Record<string, string>
  /** Durable keys of the sessions that were LIVE at the time. The resume offer has to be "the
   *  six you had", and `savedSessions` alone cannot say that: it holds every session never
   *  explicitly closed, including ones from runs before this one.
   *
   *  This run's lanes, every project's, never one project's (see `carriedLaneKeys`). Not a lane
   *  that ended on its own: the user quit it, or it crashed, and a relaunch must not restart it.
   *  Lanes ended by the quit itself stay, which is why this is not a plain `!ended` filter. */
  liveKeys: string[]
  /** The previous run's lanes not resumed or dismissed in this run. Optional: older snapshots
   *  lack it (`snapshotLaneKeys`). */
  carriedKeys?: string[]
  /** The run before that one's lanes, still not resumed. Dropped at the next relaunch that had
   *  lanes of its own, so the offer covers two runs at most and cannot grow across relaunches. */
  olderKeys?: string[]
  /** The last project the user was IN, kept while they sit on the gallery. The app opens on the
   *  home overview at launch, so `projectId` is null right after every launch; without this the
   *  "Continue in <project>" offer would last one launch only. Optional: older snapshots lack it. */
  lastProjectId?: string | null
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

// ── THE PREVIOUS RUN'S LANES, CARRIED WHOLE ─────────────────────────────────────────────────────
//
// `planRestore` scopes its lanes to the restored project, which is right for "where you were" and
// wrong for "what was running". The carried set used to be taken from the plan, so the first
// snapshot after a launch wrote ONE project's lanes over every project's: on 2026-10-06, 33 keys
// across 7 projects became 5, four seconds after the relaunch
// (dev/results/relaunch-lost-sessions-2026-10-06.md). The carried set is now the whole previous
// run, and the project filter applies only where an offer is built.
//
// TWO RUNS AT MOST. Lanes not resumed are carried into the next run, and once more into the one
// after it, then dropped. Carrying them for as long as they were ignored let the set grow with
// every lane ever live, under a card that said "your last session" (review M2, 2026-10-06). A run
// that started no lanes does not count: relaunching twice without resuming anything must not lose
// the lanes you had.

/** The previous runs' lanes not yet resumed or dismissed. */
export interface PendingLanes {
  /** The run before this one. */
  lastRun: string[]
  /** The run before that, carried once more. */
  older: string[]
}

export const NO_PENDING: PendingLanes = { lastRun: [], older: [] }

/** What this launch owes from earlier runs, unscoped. A key whose SavedSession has been forgotten
 *  (closed, pruned) drops; so does a key live now.
 *
 *  `relaunch`: a new run, so the snapshot's own lanes become "last run" and its carried lanes
 *  become "older"; the snapshot's older lanes drop. A reload of the same run moves nothing. */
export function carriedLaneKeys(workspace: Workspace | null, savedSessions: readonly SavedSession[], opts: {
  relaunch: boolean
  live?: ReadonlySet<string>
}): PendingLanes {
  if (!workspace) return NO_PENDING
  const known = new Set(savedSessions.map((s) => s.key))
  const keep = (keys: readonly string[] | undefined) => [...new Set(keys ?? [])].filter((k) => known.has(k) && !opts.live?.has(k))
  const ran = keep(workspace.liveKeys)
  const carried = keep(workspace.carriedKeys)
  const older = keep(workspace.olderKeys)
  let lastRun: string[]
  let olderRun: string[]
  if (opts.relaunch && ran.length) { lastRun = ran; olderRun = carried }
  else if (opts.relaunch) { lastRun = carried; olderRun = older }
  // A reload: still the same run. Its own lanes that did not come back are owed with the rest.
  else { lastRun = [...new Set([...carried, ...ran])]; olderRun = older }
  const inLast = new Set(lastRun)
  return { lastRun, older: olderRun.filter((k) => !inLast.has(k)) }
}

/** The snapshot's lane fields: this run's lanes, minus the ones that ended on their own, and the
 *  earlier runs' lanes still owed. A lane back in this run is not owed: it is this run's now. */
export function snapshotLaneKeys(
  tabs: ReadonlyArray<{ key: string; selfExited?: boolean }>,
  pending: PendingLanes,
): Pick<Workspace, 'liveKeys' | 'carriedKeys' | 'olderKeys'> {
  const here = new Set(tabs.map((t) => t.key))
  const liveKeys = [...new Set(tabs.filter((t) => !t.selfExited).map((t) => t.key))]
  const carriedKeys = [...new Set(pending.lastRun)].filter((k) => !here.has(k))
  const inCarried = new Set(carriedKeys)
  const olderKeys = [...new Set(pending.older)].filter((k) => !here.has(k) && !inCarried.has(k))
  return { liveKeys, carriedKeys, olderKeys }
}

// ── MAIN'S RECORD OF THE LAST RUN ───────────────────────────────────────────────────────────────
//
// `~/.operator/last-run.json` (electron/src/main/last-run.ts) lists the lanes main's pty table had
// when the last run ended, and whether it ended through teardown. It is the same rule as
// `snapshotLaneKeys` (a lane that ended on its own is out, one ended by the quit is in), taken from
// the process that owns the ptys instead of a renderer that can die. When it exists it replaces
// the snapshot's `liveKeys` as "the lanes the last run had"; everything downstream
// (`carriedLaneKeys`, the card, `planRestore`) is unchanged. Without it (first run with this build,
// the Tauri bridge) the snapshot's own `liveKeys` stand.

/** The snapshot with main's record of the last run as its `liveKeys`. Null only when neither
 *  exists. A snapshot missing while the record exists still lands on the overview with an offer. */
export function withLastRun(stored: Workspace | null, previous: PreviousRunInfo | null | undefined): Workspace | null {
  if (!previous) return stored
  const liveKeys = previous.lanes.map((l) => l.key)
  if (stored) return { ...stored, liveKeys }
  return { v: WORKSPACE_VERSION, projectId: null, mode: 'gallery', projectTab: 'board', liveKeys, at: previous.endedAt }
}

/** The lanes to resume without asking, oldest first: the last run's, when it did not end through
 *  teardown and main hands out the auto-resume (first renderer of the app run only). Exactly the
 *  recorded lanes not marked offer-only, minus the ones the card would leave out (forgotten or
 *  shelved project, folder gone and not rebuildable, released, no conversation); those stay on the
 *  card. Empty after a clean quit, where the auto-resume setting still decides. */
export function crashResumeLanes(input: {
  previous: PreviousRunInfo | null | undefined
  kind: LaunchKind
  savedSessions: readonly SavedSession[]
  projects: ReadonlyArray<{ id: string; name: string; archivedAt?: string }>
  missingPaths?: ReadonlySet<string>
}): SavedSession[] {
  const { previous, kind } = input
  if (!previous || previous.clean || !previous.autoResume || kind === 'reload') return []
  const offer = previousRunOffer({
    // A lane main marked offer-only (carried from a clean quit, or already handed out) stays on
    // the card.
    keys: previous.lanes.filter((l) => !l.offerOnly).map((l) => l.key),
    savedSessions: input.savedSessions,
    liveKeys: new Set(),
    projects: input.projects,
    missingPaths: input.missingPaths,
    releasedKeys: new Set(previous.released),
  })
  return offer?.resumable ?? []
}

/** The toast for a crash resume: which lanes, grouped by project. */
export function describeCrashResume(lanes: readonly SavedSession[], projects: ReadonlyArray<{ id: string; name: string }>): { text: string; detail: string } {
  const groups = new Map<string, string[]>()
  for (const s of lanes) {
    const name = (s.projectId && projects.find((p) => p.id === s.projectId)?.name) || s.projectName || s.cwd.split('/').pop() || s.cwd
    groups.set(name, [...(groups.get(name) ?? []), laneName(s)])
  }
  const n = lanes.length
  return {
    text: `Operator did not quit cleanly. Resuming\u00a0${n}\u00a0lane${n === 1 ? '' : 's'}`,
    detail: [...groups].map(([p, names]) => `${p}: ${names.join(', ')}`).join(' · '),
  }
}

export interface PreviousRunProject {
  projectId: string | null
  name: string
  /** Resumable lanes of this project. Lanes left out are counted in `PreviousRunOffer.blocked`. */
  lanes: number
}

/** Why the card leaves a lane out. `planRestore`'s two, plus what only the card has to say. */
export type OfferBlocker = ResumeBlocker
  /** Its project was forgotten. A resume would bring the project back without being asked. */
  | 'project-forgotten'
  /** Its project is shelved. A resume would lift the shelf without being asked. */
  | 'project-shelved'
  /** It called `worktree_done` and its worktree was removed. Not rebuilt: the task is finished,
   *  and its branch may be merged and deleted, so a rebuild could land on a fresh branch. */
  | 'released'
  /** The card tried it in this run and the spawn failed. Not retried from the card. */
  | 'did-not-start'

export interface PreviousRunOffer {
  /** What the one button resumes, oldest first across every project: the same order
   *  `handleResumeProject` uses, so the sidebar comes back in its usual order. */
  resumable: SavedSession[]
  /** Previous-run lanes the button leaves out, named so the user knows why. */
  blocked: Array<{ name: string; blocker: OfferBlocker }>
  /** Most lanes first. */
  projects: PreviousRunProject[]
}

/** The gallery overview's resume card. Pure: the carried keys and what exists now → what to
 *  offer, or null when there is nothing to offer.
 *
 *  A missing folder blocks a lane only when it cannot be rebuilt. A worktree lane that kept its
 *  branch and source repo is put back by `handleRestoreSession`, and lanes close themselves, so for
 *  those a missing folder is the normal case and not a reason to leave them out. A lane that
 *  released its worktree with `worktree_done` is the exception. */
export function previousRunOffer({ keys, savedSessions, liveKeys, projects, missingPaths, failedKeys, releasedKeys }: {
  keys: readonly string[]
  savedSessions: readonly SavedSession[]
  /** Keys live in this run. Already resumed, so not offered. */
  liveKeys: ReadonlySet<string>
  /** Projects on record. A lane whose project is not here was forgotten. */
  projects: ReadonlyArray<{ id: string; name: string; archivedAt?: string }>
  missingPaths?: ReadonlySet<string>
  /** Lanes whose spawn failed in this run. */
  failedKeys?: ReadonlySet<string>
  /** Lanes main recorded as having called worktree_done (last-run.json), on top of `releasedAt`. */
  releasedKeys?: ReadonlySet<string>
}): PreviousRunOffer | null {
  const byKey = new Map(savedSessions.map((s) => [s.key, s]))
  const lanes = [...new Set(keys)]
    .filter((k) => !liveKeys.has(k))
    .map((k) => byKey.get(k))
    .filter((s): s is SavedSession => !!s)
    .sort((a, b) => a.lastActiveAt.localeCompare(b.lastActiveAt))
  if (!lanes.length) return null

  const byId = new Map(projects.map((p) => [p.id, p]))
  const projectName = (s: SavedSession) => (s.projectId && byId.get(s.projectId)?.name) || s.projectName || s.cwd.split('/').pop() || s.cwd
  const blockerOf = (s: SavedSession): OfferBlocker | undefined => {
    const project = s.projectId ? byId.get(s.projectId) : undefined
    if (!project) return 'project-forgotten'
    if (project.archivedAt) return 'project-shelved'
    if (failedKeys?.has(s.key)) return 'did-not-start'
    if (missingPaths?.has(s.cwd)) {
      if (s.releasedAt || releasedKeys?.has(s.key)) return 'released'
      if (!(s.worktreeBranch && s.sourceCwd)) return 'folder-missing'
    }
    return s.claudeSessionId ? undefined : 'no-conversation'
  }

  const resumable: SavedSession[] = []
  const blocked: PreviousRunOffer['blocked'] = []
  for (const s of lanes) {
    const blocker = blockerOf(s)
    if (!blocker) { resumable.push(s); continue }
    // A project blocker names the project too: the lane name alone does not say which one.
    const name = blocker === 'project-forgotten' || blocker === 'project-shelved' ? `${laneName(s)} in ${projectName(s)}` : laneName(s)
    blocked.push({ name, blocker })
  }

  const groups = new Map<string | null, PreviousRunProject>()
  for (const s of resumable) {
    const id = s.projectId ?? null
    const g = groups.get(id) ?? { projectId: id, name: projectName(s), lanes: 0 }
    g.lanes++
    groups.set(id, g)
  }
  const byCount = [...groups.values()].sort((a, b) => b.lanes - a.lanes || a.name.localeCompare(b.name))
  return { resumable, blocked, projects: byCount }
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

// ── LAUNCH LANDS ON THE HOME OVERVIEW ───────────────────────────────────────────────────────────
//
// User decision, 2026-09-16: every app LAUNCH (cold start, relaunch after quit or update) opens on
// the project gallery's worktree overview, not on the last project. A RELOAD of the renderer inside
// a running app (the stall watchdog's respawn, a crash, ⌘R) still restores where you were: landing
// on the overview then would look like the app losing your place.
//
// Nothing else changes. The plan is still computed, its lanes are still offered and resumed, and
// where you were becomes `continueTo`: one click away, not the first screen.

import type { LaunchKind } from './launch-kind'
export type { LaunchKind }

export interface ContinueTarget {
  projectId: string | null
  mode: RestorePlan['mode']
  projectTab: WorkspaceProjectTab
}

export interface LaunchLanding {
  /** What to show now. */
  view: ContinueTarget
  /** Open the gallery on this tab. */
  galleryTab?: 'overview'
  /** Where "Continue" goes. Null when the place you were IS the gallery and no project is known. */
  continueTo: ContinueTarget | null
}

/** Pure. `unknown` (a shell that cannot tell) keeps the old behaviour: restore the plan. */
export function launchLanding(kind: LaunchKind, plan: RestorePlan, lastProjectId: string | null | undefined, projectIds: readonly string[]): LaunchLanding {
  const was: ContinueTarget = { projectId: plan.projectId, mode: plan.mode, projectTab: plan.projectTab }
  if (kind !== 'launch') return { view: was, continueTo: null }
  const knownLast = lastProjectId && projectIds.includes(lastProjectId) ? lastProjectId : null
  const continueTo = plan.mode !== 'gallery' || plan.projectId
    ? was
    : knownLast ? { projectId: knownLast, mode: 'project' as const, projectTab: plan.projectTab } : null
  return {
    view: { projectId: null, mode: 'gallery', projectTab: plan.projectTab },
    galleryTab: 'overview',
    continueTo,
  }
}

/** The place "Continue in …" names: the project, or the view when there is none. */
export function continueLabel(t: ContinueTarget, projects: ReadonlyArray<{ id: string; name: string }>): string {
  const project = t.projectId ? projects.find((p) => p.id === t.projectId) : undefined
  if (project && (t.mode === 'project' || t.mode === 'gallery')) return project.name
  switch (t.mode) {
    case 'prefs': return 'Preferences'
    case 'globalPrefs': return 'Global settings'
    case 'agents': return 'Agents'
    case 'tuning': return 'Tuning'
    default: return project?.name ?? 'your last project'
  }
}
