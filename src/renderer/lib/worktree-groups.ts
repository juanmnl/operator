import type { ReapClass, ReapEntry } from '../../shared/types'

// The Worktrees page, grouped by the repository each directory came from. Pure, so the grouping
// and the selection rules are testable without rendering the page.

export interface WorktreeGroup {
  /** The source repo path, or '' for directories nothing names a repo for. */
  key: string
  label: string
  rows: ReapEntry[]
  bytes: number
}

const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p

/** Groups by `entry.repo`, largest first; the unknown-repo group always last. Rows within a group
 *  are largest first, then by path. */
export function groupWorktrees(entries: readonly ReapEntry[]): WorktreeGroup[] {
  const byKey = new Map<string, ReapEntry[]>()
  for (const e of entries) {
    const key = e.repo ?? ''
    const rows = byKey.get(key)
    if (rows) rows.push(e)
    else byKey.set(key, [e])
  }
  return [...byKey]
    .map(([key, rows]) => ({
      key,
      label: key ? baseName(key) : 'Unknown source repository',
      rows: [...rows].sort((a, b) => b.sizeBytes - a.sizeBytes || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      bytes: rows.reduce((n, r) => n + r.sizeBytes, 0),
    }))
    .sort((a, b) => (a.key === '' ? 1 : 0) - (b.key === '' ? 1 : 0) || b.bytes - a.bytes || a.label.localeCompare(b.label))
}

/** A row with a lane open in it can never be selected. */
export const isSelectable = (e: ReapEntry): boolean => !e.live

/** Select-all for one group: selects every selectable row, or clears them all when every one is
 *  already selected. Rows outside the group keep their state. */
export function toggleGroup(selected: ReadonlySet<string>, group: WorktreeGroup): Set<string> {
  const paths = group.rows.filter(isSelectable).map((r) => r.path)
  const next = new Set(selected)
  const all = paths.length > 0 && paths.every((p) => next.has(p))
  for (const p of paths) {
    if (all) next.delete(p)
    else next.add(p)
  }
  return next
}

/** Drop selections that are no longer on the page or no longer selectable (a lane opened). */
export function pruneSelection(selected: ReadonlySet<string>, entries: readonly ReapEntry[]): Set<string> {
  const ok = new Set(entries.filter(isSelectable).map((e) => e.path))
  return new Set([...selected].filter((p) => ok.has(p)))
}

/** HEAD is detached: its commits are on no branch, and removing the folder drops the record that
 *  holds them, so they become unreachable. */
export const isDetached = (e: ReapEntry): boolean => e.branch === 'HEAD'

/** What would be lost, in words, for the row and the confirm list. */
export function unsavedLabel(e: ReapEntry): string {
  if (!e.unsavedKnown) return 'Unsaved work unknown — git cannot read it'
  const parts: string[] = []
  if (e.uncommitted) {
    parts.push(e.uncommittedIsNonWork
      ? `${e.uncommitted} untracked, all copies of files that exist elsewhere`
      : `${e.uncommitted} uncommitted file${e.uncommitted === 1 ? '' : 's'}`)
  }
  if (e.unsavedCommits) {
    const n = `${e.unsavedCommits} commit${e.unsavedCommits === 1 ? '' : 's'}`
    parts.push(isDetached(e) ? `${n} on a detached HEAD, on no branch` : `${n} on no other branch or remote`)
  }
  if (e.removedWithoutGit) parts.push('git does not recognise it as a worktree')
  if (e.rescuedTo && parts.length) parts.push(`rescued to ${e.rescuedTo.replace(/^.*\/\.operator\//, '~/.operator/')}`)
  return parts.length ? parts.join(' · ') : 'No unsaved work'
}

/** Rescue is offered where it can stand in for the work: git can read the folder and name what is
 *  unsaved, nothing is open in it, and it has not already been rescued as it is now. */
export function canRescue(e: ReapEntry): boolean {
  return !e.live && e.unsavedKnown && !e.removedWithoutGit && !e.rescuedTo
    && ((!!e.uncommitted && !e.uncommittedIsNonWork) || !!e.unsavedCommits)
}

/** The consequence sentence above the second confirmation, true for the rows actually listed.
 *  "Commits stay on their branches" is only said when it holds for every listed row (Review M3). */
export function unsavedConsequence(rows: readonly ReapEntry[]): string {
  const out: string[] = []
  if (rows.some((r) => r.uncommitted && !r.uncommittedIsNonWork)) out.push('Uncommitted files will be lost.')
  const detached = rows.filter((r) => isDetached(r) && r.unsavedCommits)
  if (detached.length) {
    out.push(`${detached.length === 1 ? 'One folder has' : `${detached.length} folders have`} commits on a detached HEAD, on no branch. Those commits will be lost.`)
  }
  const unknown = rows.filter((r) => !r.unsavedKnown || r.removedWithoutGit)
  if (unknown.length) {
    out.push(`Git cannot say what ${unknown.length === 1 ? 'one folder holds' : `${unknown.length} folders hold`}; ${unknown.length === 1 ? 'it is' : 'they are'} deleted outright, and anything not already on a branch is lost.`)
  }
  if (rows.some((r) => r.unsavedCommits && !isDetached(r))) out.push('Commits on a named branch stay on that branch.')
  return out.join(' ')
}

const CLASS_LABEL: Record<ReapClass, string> = {
  'merged-clean': 'Merged and clean',
  'merged-dirty': 'Merged, uncommitted changes',
  'debris': 'Creation debris',
  'unmerged': 'Not merged',
  'unattributed': 'No provenance record',
  'corrupt': 'Not a valid worktree',
  'dead-source-repo': 'Source repo is gone',
  'live-claimed': 'A lane is open here',
}

/** The row's class line. Debris is called creation debris only in the proved interrupted-create
 *  shape, which is what puts it in the automatic tier; any other small git-less folder is not
 *  claimed to be a leftover (Review finding 2). */
export function classLabel(e: ReapEntry): string {
  if (e.cls === 'debris' && !e.auto) return 'Small folder, not a worktree'
  return CLASS_LABEL[e.cls]
}
