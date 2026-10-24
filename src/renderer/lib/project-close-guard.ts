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
}

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

/** Every string in the dialog. `total` and `running` are `closePlan`'s: the lanes Close will end
 *  and how many of them are mid-turn.
 *
 *  The body says what Close does to each lane (lib/project-shelf, DashboardView `closeLane`) and
 *  what it keeps. The first word of every sentence after the first is bound to the next one with a
 *  no-break space, so a wrap never leaves it alone after the full stop. */
export function closeGuardCopy(projectName: string, total: number, running: number): CloseGuardCopy {
  const one = total === 1
  const more = Math.max(0, total - ROW_CAP)
  return {
    title: one ? `Close ${projectName} and end its agent?` : `Close ${projectName} and end ${total} agents?`,
    body: one
      ? 'Its CLI stops and its worktree folder is removed. Unsaved changes are committed to its branch first. Branches, roster, tasks and notes stay.'
      : 'Each agent’s CLI stops and its worktree folder is removed. Unsaved changes are committed to its branch first. Branches, roster, tasks and notes stay.',
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
