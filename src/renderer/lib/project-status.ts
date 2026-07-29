import type { WaveStatus } from '../components/sidebar/StatusWave'
import { sessionWaveStatus } from './session-status'

/** What a project is doing right now, rolled up from its live sessions. */
export interface ProjectActivity {
  /** Sessions currently open for this project (ended ones excluded). */
  live: number
  /** Lanes whose turn it is — the count that actually wants the user. */
  waiting: number
  /** Roster size, so "3 running" can be read against "of 6". */
  lanes: number
  /** The busiest lane's state — the project's own orb. */
  status: WaveStatus
}

// One definition of a project's rolled-up state, shared by the gallery card and the
// switcher popover so the two can't drift. Busiest-wins for the ORB (its job is "is
// anything alive here"); `waiting` is kept as its own count because "your turn" is the
// most actionable thing a project can be, and since the waiting pulse was removed the
// orb alone can no longer say it — the label has to.
const RANK: Record<string, number> = { running: 4, compacting: 3, waiting: 2, error: 1 }

export function projectActivity(
  sessions: Array<{ status: string; phase: string }>,
  lanes = 0,
): ProjectActivity {
  const open = sessions.filter((s) => s.status !== 'ended')
  let status: WaveStatus = 'idle'
  let waiting = 0
  for (const s of open) {
    const w = sessionWaveStatus(s)
    if (w === 'waiting') waiting++
    if ((RANK[w] ?? 0) > (RANK[status] ?? 0)) status = w
  }
  return { live: open.length, waiting, lanes, status }
}

/** The one-phrase read for a project: what it's doing, in words rather than a bare count.
 *  `accent` marks the phrases worth accent ink — activity, never mere existence. */
export function projectActivityLabel(a: ProjectActivity): { text: string; accent: boolean } | null {
  // "Needs you" outranks "running": if a lane is waiting on the user, that's the thing to
  // say, even while others work.
  if (a.waiting > 0) return { text: `${a.waiting} needs you`, accent: true }
  if (a.live > 0) return { text: `${a.live} running`, accent: true }
  if (a.lanes > 0) return { text: `${a.lanes} lane${a.lanes === 1 ? '' : 's'}`, accent: false }
  return null
}
