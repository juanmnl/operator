// THE HOME OVERVIEW'S NUMBERS: each project with its lanes and its worktrees, a bucket for worktree
// folders that match no known project, and a machine total. Pure, so the grouping is testable.
//
// TWO SOURCES, ONE SHAPE. The first paint comes from `worktreeQuickList` (no git, no `du`): which
// folder belongs to which repo, whether that repo still exists, lane claims and cached sizes. The
// flags that need git (unsaved work, would remove automatically) arrive with the full reap plan a
// moment later. Both are normalised to `OverviewWorktree` here, and `detailed` says which one the
// numbers came from, so the UI never shows "0 unsaved" when git has not been asked yet.
import type { ReapEntry, WorktreeQuickEntry } from './types'

export interface OverviewWorktree {
  path: string
  repo?: string
  repoExists: boolean
  live: boolean
  /** Undefined when no size is known yet. */
  bytes?: number
  /** From the plan only. */
  unsaved?: boolean
  /** Git could not say whether there is unsaved work. From the plan only. */
  unsavedUnknown?: boolean
  /** From the plan only. */
  wouldRemove?: boolean
}

export function fromQuick(entries: readonly WorktreeQuickEntry[]): OverviewWorktree[] {
  return entries.map((e) => ({ path: e.path, repo: e.repo, repoExists: e.repoExists, live: e.live, bytes: e.cachedBytes }))
}

/** The full plan, joined to the quick list for `repoExists`: the plan's class only says
 *  `dead-source-repo` for folders that are not live and not debris, and the flag must not depend on
 *  that precedence. */
export function fromPlan(entries: readonly ReapEntry[], quick: readonly WorktreeQuickEntry[], sizesOmitted: boolean): OverviewWorktree[] {
  const q = new Map(quick.map((e) => [e.path, e]))
  return entries.map((e) => {
    const known = q.get(e.path)
    return {
      path: e.path,
      repo: e.repo ?? known?.repo,
      repoExists: known ? known.repoExists : e.cls !== 'dead-source-repo',
      live: e.live,
      bytes: sizesOmitted ? known?.cachedBytes : e.sizeBytes,
      unsaved: (e.uncommitted ?? 0) > 0 || (e.unsavedCommits ?? 0) > 0,
      unsavedUnknown: !e.unsavedKnown,
      wouldRemove: !!e.wouldRemove,
    }
  })
}

export interface OverviewCounts {
  worktrees: number
  /** Sum of the sizes that are known. */
  bytes: number
  /** Some folder in the group has no size yet, so `bytes` is a floor. */
  bytesPartial: boolean
  unsaved: number
  unsavedUnknown: number
  wouldRemove: number
  /** Folders whose source repo is gone from disk. */
  deadRepo: number
  /** Folders a lane is open in. */
  live: number
}

export interface OverviewProjectRow extends OverviewCounts {
  projectId: string
  name: string
  path: string
  /** Live lanes in this project. */
  running: number
  /** Saved sessions that can be resumed and are not running. */
  suspended: number
}

export interface OverviewUnknown extends OverviewCounts {
  /** The distinct source repos named by the unmatched folders; folders naming none are not listed. */
  repos: string[]
}

export interface Overview {
  rows: OverviewProjectRow[]
  unknown: OverviewUnknown
  total: OverviewCounts
  /** The flags that need git are in. False on the quick first paint. */
  detailed: boolean
}

export interface OverviewInput {
  projects: ReadonlyArray<{ id: string; name: string; path: string }>
  worktrees: readonly OverviewWorktree[]
  /** Sessions shown in the app. Ended ones are ignored. */
  sessions: ReadonlyArray<{ projectId?: string; status: string }>
  /** Resumable saved sessions. `projectId` wins when present; otherwise matched by working directory. */
  suspended: ReadonlyArray<{ cwd: string; projectId?: string }>
  detailed: boolean
}

const norm = (p: string | undefined): string => (p ?? '').replace(/\/+$/, '')

const empty = (): OverviewCounts => ({
  worktrees: 0, bytes: 0, bytesPartial: false, unsaved: 0, unsavedUnknown: 0, wouldRemove: 0, deadRepo: 0, live: 0,
})

function add(c: OverviewCounts, w: OverviewWorktree): void {
  c.worktrees++
  if (w.bytes === undefined) c.bytesPartial = true
  else c.bytes += w.bytes
  if (w.unsaved) c.unsaved++
  else if (w.unsavedUnknown) c.unsavedUnknown++
  if (w.wouldRemove) c.wouldRemove++
  if (!w.repoExists) c.deadRepo++
  if (w.live) c.live++
}

/** Group worktrees under the project whose path is their source repo.
 *
 *  MATCHED BY PATH, trailing slashes ignored. A worktree records the repo it was made from, and a
 *  project's `path` is its canonical repo root, so the two are the same string for anything Operator
 *  created. A folder whose repo matches no project, or that names no repo at all, goes to `unknown`.
 *
 *  A suspended session counts for a project when its working directory is the project, inside it,
 *  or one of the project's own worktrees. */
export function summarizeOverview(input: OverviewInput): Overview {
  const byPath = new Map<string, OverviewProjectRow>()
  const rows: OverviewProjectRow[] = input.projects.map((p) => {
    const row: OverviewProjectRow = { ...empty(), projectId: p.id, name: p.name, path: p.path, running: 0, suspended: 0 }
    if (p.path) byPath.set(norm(p.path), row)
    return row
  })
  const byId = new Map(rows.map((r) => [r.projectId, r]))
  const unknown: OverviewUnknown = { ...empty(), repos: [] }
  const total = empty()
  const worktreeOwner = new Map<string, OverviewProjectRow>()

  for (const w of input.worktrees) {
    add(total, w)
    const row = w.repo ? byPath.get(norm(w.repo)) : undefined
    if (row) {
      add(row, w)
      worktreeOwner.set(norm(w.path), row)
    } else {
      add(unknown, w)
      if (w.repo && !unknown.repos.includes(norm(w.repo))) unknown.repos.push(norm(w.repo))
    }
  }

  for (const s of input.sessions) {
    if (s.status === 'ended' || !s.projectId) continue
    const row = byId.get(s.projectId)
    if (row) row.running++
  }

  for (const s of input.suspended) {
    const cwd = norm(s.cwd)
    const row = (s.projectId ? byId.get(s.projectId) : undefined) ?? worktreeOwner.get(cwd) ?? byPath.get(cwd)
      ?? rows.find((r) => r.path && cwd.startsWith(`${norm(r.path)}/`))
    if (row) row.suspended++
  }

  unknown.repos.sort()
  // Largest first: the overview is read for "where did the disk go". Ties by worktree count, then name.
  rows.sort((a, b) => b.bytes - a.bytes || b.worktrees - a.worktrees || a.name.localeCompare(b.name))
  return { rows, unknown, total, detailed: input.detailed }
}

const GB = 1024 ** 3
const MB = 1024 ** 2

/** `34.0 GB`, `512 MB`, `8 KB`, and `0 KB` for an empty group. */
export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`
  if (bytes <= 0) return '0 KB'
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}
