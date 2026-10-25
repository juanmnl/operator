// The Close project dialog's copy and its row list, pure (lifecycle UX audit B2, 2026-10-24).
//
// Close used to confirm with a two-click arm on a menu item whose label carried a count. That arm
// could not say which lanes would end or that some were mid-turn, so the dialog names them, the
// way the quit guard does. The rows are frozen when the dialog opens: a list that re-orders under
// the pointer is a mis-click generator. On End the close plans again, so a lane started while the
// dialog was open is ended too, and the toast reports the real count.

import type { WaveStatus } from '../components/sidebar/StatusWave'
import { ROW_CAP, phaseRank } from './quit-guard'

/** A lane the close will end, as DashboardView knows it when the dialog opens. */
export interface CloseGuardLane {
  terminalId: string
  /** `sessionLabel(...)`, the one label ladder. */
  name: string
  phase: string
  /** Suspended while idle (lib/idle-suspend): no CLI running, the tab and worktree kept. */
  suspended: boolean
  lastActivityAt: string
  accent?: string
  /** What the close does to its folder (DashboardView `closeLane`, review R6): `worktree`, its own
   *  folder is snapshotted and removed; `checkout`, it runs in the project folder and nothing is
   *  removed or committed; `released`, it called `worktree_done` and main removes the folder only
   *  if it is clean. Absent reads as `worktree`. */
  folder?: LaneFolder
}

export type LaneFolder = 'worktree' | 'checkout' | 'released'

export interface CloseGuardRow {
  terminalId: string
  name: string
  /** Right-aligned state word. */
  state: string
  wave: WaveStatus
  accent?: string
}

const STATE_WORD: Record<string, string> = {
  running: 'working',
  compacting: 'compacting',
  asking: 'asking you',
  waiting: 'waiting on you',
  idle: 'idle',
}

/** Mid-turn first (the quit guard's rank), then idle, then suspended; most recent first inside
 *  each bucket. Capped at the quit guard's ROW_CAP, so the cap never hides a mid-turn lane. */
export function closeGuardRows(lanes: readonly CloseGuardLane[]): { rows: CloseGuardRow[]; more: number } {
  const bucket = (l: CloseGuardLane) => (l.suspended ? 99 : phaseRank(l.phase))
  const ordered = [...lanes].sort((a, b) =>
    bucket(a) - bucket(b) || (b.lastActivityAt || '').localeCompare(a.lastActivityAt || ''))
  const rows = ordered.slice(0, ROW_CAP).map((l): CloseGuardRow => ({
    terminalId: l.terminalId,
    name: l.name,
    state: l.suspended ? 'suspended' : STATE_WORD[l.phase] ?? 'idle',
    wave: l.suspended ? 'ended' : ((STATE_WORD[l.phase] ? l.phase : 'idle') as WaveStatus),
    accent: l.accent,
  }))
  return { rows, more: Math.max(0, ordered.length - ROW_CAP) }
}

export interface CloseGuardCopy {
  title: string
  body: string
  /** The mid-turn line, or null when nothing is mid-turn. */
  midTurn: string | null
  /** `and {r} more`, or null when every lane got a row. */
  overflow: string | null
  keepVerb: string
  endVerb: string
  hint: string
}

/** Sentences joined with a space, the first word of each after the first bound to the next one
 *  with a no-break space, so a wrap never leaves it alone after the full stop. */
function sentences(list: readonly string[]): string {
  return list.map((x, i) => (i === 0 ? x : x.replace(' ', ' '))).join(' ')
}

const KEPT = 'Branches, roster, tasks and notes stay.'

/** What Close does to the lanes, true for each kind (review R6, 2026-10-24). It said every lane's
 *  CLI stops, its worktree folder is removed and unsaved changes are committed first. A lane in the
 *  main checkout has no folder of its own and nothing is committed; a released lane's folder is
 *  main's to decide; a suspended lane has no CLI. */
function closeBody(lanes: readonly Pick<CloseGuardLane, 'suspended' | 'folder'>[]): string {
  const total = lanes.length
  const suspended = lanes.filter((l) => l.suspended).length
  const count = (f: LaneFolder) => lanes.filter((l) => (l.folder ?? 'worktree') === f).length
  const wt = count('worktree'), co = count('checkout'), rel = count('released')
  if (total === 1) {
    const folder: LaneFolder = rel ? 'released' : co ? 'checkout' : 'worktree'
    if (!suspended && folder === 'worktree') {
      return sentences(['Its CLI stops and its worktree folder is removed.', 'Unsaved changes are committed to its branch first.', KEPT])
    }
    const cli = suspended ? 'It is suspended, so no CLI is running.' : 'Its CLI stops.'
    const where = folder === 'worktree'
      ? ['Its worktree folder is removed.', 'Unsaved changes are committed to its branch first.']
      : folder === 'checkout'
        ? ['It works in the project folder, so nothing there is removed or committed.']
        : ['It released its worktree, so the folder is removed if clean and kept if anything is unsaved.']
    return sentences([cli, ...where, KEPT])
  }
  if (!suspended && wt === total) {
    return sentences(['Each agent’s CLI stops and its worktree folder is removed.', 'Unsaved changes are committed to its branch first.', KEPT])
  }
  const cli = suspended === 0
    ? 'Each agent’s CLI stops.'
    : suspended === total
      ? 'They are suspended, so no CLI is running.'
      : `Each running agent’s CLI stops, and ${suspended} ${suspended === 1 ? 'is' : 'are'} suspended.`
  let where: string[]
  if (wt === total) where = ['Each worktree folder is removed.', 'Unsaved changes are committed to its branch first.']
  else if (co === total) where = ['They work in the project folder, so nothing there is removed or committed.']
  else if (rel === total) where = ['They released their worktrees, so each folder is removed if clean and kept if anything is unsaved.']
  else {
    where = []
    if (wt) where.push(wt === 1
      ? '1 worktree folder is removed, with unsaved changes committed to its branch first.'
      : `${wt} worktree folders are removed, with unsaved changes committed to their branches first.`)
    if (co) where.push(co === 1
      ? '1 works in the project folder, where nothing is removed or committed.'
      : `${co} work in the project folder, where nothing is removed or committed.`)
    if (rel) where.push(rel === 1
      ? '1 released its worktree: that folder is removed if clean and kept if anything is unsaved.'
      : `${rel} released their worktrees: each folder is removed if clean and kept if anything is unsaved.`)
  }
  return sentences([cli, ...where, KEPT])
}

/** Every string in the dialog. `total` and `running` are `closePlan`'s: the lanes Close will end
 *  and how many of them are mid-turn. `lanes` says what each is (suspended, which folder); absent,
 *  every lane is a running one in its own worktree.
 *
 *  The body says what Close does to each lane (lib/project-shelf, DashboardView `closeLane`) and
 *  what it keeps. */
export function closeGuardCopy(
  projectName: string,
  total: number,
  running: number,
  lanes: readonly Pick<CloseGuardLane, 'suspended' | 'folder'>[] = Array.from({ length: total }, () => ({ suspended: false })),
): CloseGuardCopy {
  const one = total === 1
  const more = Math.max(0, total - ROW_CAP)
  return {
    title: one ? `Close ${projectName} and end its agent?` : `Close ${projectName} and end ${total} agents?`,
    body: closeBody(lanes),
    midTurn: running <= 0
      ? null
      : one
        ? 'It is mid-turn. That turn’s work is lost.'
        : running === 1
          ? '1 is mid-turn. That turn’s work is lost.'
          : `${running} are mid-turn. The work in those turns is lost.`,
    overflow: more > 0 ? `and ${more} more` : null,
    keepVerb: 'Keep running',
    endVerb: one ? 'End it and close' : `End ${total} and close`,
    hint: 'Esc to keep',
  }
}
