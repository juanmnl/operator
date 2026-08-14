// The quit dialog's copy and its row list — every string and every ordering decision, pure.
//
// This is driven by the PAYLOAD Rust sends, not by a store read. The accident this guard
// exists for left the webview navigated away, so the count has to survive a frontend that
// knows nothing; a row the frontend cannot match to a session it has still renders, from the
// payload's own project name and phase word. There is therefore no loading state.

/** The preference, stored as '1'/'0' like the app's other switches. Default ON, and unlike
 *  `operator.resumeOnLaunch` that default is not really a choice: a guard nobody armed is not
 *  a guard. Turning it off belongs HERE, in preferences, away from the moment of maximum haste
 *  — which is why the dialog has no "don't ask again" checkbox. ⌥⌘Q is the per-quit bypass. */
export const ASK_BEFORE_QUIT_KEY = 'operator.askBeforeQuit'

export function askBeforeQuitEnabled(): boolean {
  try { return localStorage.getItem(ASK_BEFORE_QUIT_KEY) !== '0' } catch { return true }
}

/** One busy lane, exactly as `quit:requested` carries it (see src-tauri/src/quit.rs). */
export interface QuitLane {
  terminalId: string
  /** Folder name of the lane's cwd — the display fallback. */
  project: string
  /** Canonical project id; empty for an ad-hoc session. */
  projectId: string
  /** `running` | `compacting` | `waiting` (busy lanes only reach the dialog). */
  phase: string
  lastActivityAt: string
}

export interface QuitRequest {
  lanes: QuitLane[]
  /** Live-but-idle lanes. Never rows — one counted line instead. */
  idle: number
}

/** What the frontend knows about a lane the payload named, if it can match it. */
export interface LaneIdentity {
  /** `sessionLabel(...)` — the one label ladder. */
  name?: string
  /** `chatSignal(session).label` — the same vocabulary the chat and sidebar already use. */
  state?: string
  accent?: string
}

export interface QuitRow {
  terminalId: string
  name: string
  /** Right-aligned state text. */
  state: string
  /** Drives StatusWave; motion means busy, which is exactly what these rows are. */
  phase: 'running' | 'compacting' | 'waiting'
  accent?: string
}

/** Six rows, then a count. The list is for RECOGNITION, not inventory — a scroller would
 *  invite reading it, and nothing here is a decision about an individual lane. */
export const ROW_CAP = 6

/** Most consequential first, so the cap can never hide the worst one. */
const PHASE_ORDER = ['running', 'compacting', 'waiting']

/** Used only when the frontend cannot resolve the session behind a terminal id. */
const PHASE_WORD: Record<string, string> = {
  running: 'Working',
  compacting: 'Compacting context',
  waiting: 'Your turn',
}

function rank(phase: string): number {
  const i = PHASE_ORDER.indexOf(phase)
  return i < 0 ? PHASE_ORDER.length : i
}

/** How many distinct projects the busy lanes span. One → the suffix would be noise. */
function projectCount(lanes: QuitLane[]): number {
  return new Set(lanes.map((l) => l.projectId || l.project)).size
}

/** Ordered, capped rows. `identify` is how the caller injects what only it knows (roster,
 *  custom names, accents, the live chat signal) without this file reaching into a store. */
export function quitGuardRows(
  req: QuitRequest,
  identify: (terminalId: string) => LaneIdentity | undefined = () => undefined,
): { rows: QuitRow[]; more: number } {
  const multiProject = projectCount(req.lanes) > 1
  const ordered = [...req.lanes].sort((a, b) => {
    const r = rank(a.phase) - rank(b.phase)
    if (r !== 0) return r
    // Within a bucket, most recently active first.
    return (b.lastActivityAt || '').localeCompare(a.lastActivityAt || '')
  })
  const rows = ordered.slice(0, ROW_CAP).map((lane) => {
    const known = identify(lane.terminalId)
    const base = known?.name || lane.project || 'Agent'
    // The suffix disambiguates a lane NAME across projects. When the name already is the
    // project — the fallback for a lane the frontend can't match — appending it says the same
    // word twice ("herdr · herdr").
    const suffix = multiProject && base !== lane.project ? ` · ${lane.project}` : ''
    return {
      terminalId: lane.terminalId,
      name: `${base}${suffix}`,
      state: known?.state || PHASE_WORD[lane.phase] || 'Working',
      phase: (PHASE_ORDER.includes(lane.phase) ? lane.phase : 'running') as QuitRow['phase'],
      accent: known?.accent,
    }
  })
  return { rows, more: Math.max(0, ordered.length - ROW_CAP) }
}

export interface QuitCopy {
  title: string
  body: string
  /** `and {r} more`, or null when every busy lane got a row. */
  overflow: string | null
  /** The idle addendum, or null when nothing idle will be ended. */
  idle: string | null
  stayVerb: string
  quitVerb: string
  hint: string
}

/** Every string in the dialog.
 *
 *  The body claims exactly what is lost and nothing bigger: quitting kills the pty, so the
 *  turn in flight goes — the transcript and the worktree stay on disk. A guard that overclaims
 *  is one people learn to disbelieve. */
export function quitGuardCopy(req: QuitRequest): QuitCopy {
  const n = req.lanes.length
  const one = n === 1
  // "waiting on you" only when NOTHING is mid-turn — otherwise the working ones are the story.
  const onlyWaiting = n > 0 && req.lanes.every((l) => l.phase === 'waiting')
  const more = Math.max(0, n - ROW_CAP)
  return {
    title: onlyWaiting
      ? (one ? '1 agent is waiting on you' : `${n} agents are waiting on you`)
      : (one ? '1 agent is still working' : `${n} agents are still working`),
    body: one
      ? 'Quitting ends it. Whatever it’s in the middle of is lost — its worktree and transcript stay on disk.'
      : 'Quitting ends all of them. Whatever each one is in the middle of is lost — their worktrees and transcripts stay on disk.',
    overflow: more > 0 ? `and ${more} more` : null,
    idle: req.idle > 0
      ? (req.idle === 1 ? '1 idle agent will be ended too.' : `${req.idle} idle agents will be ended too.`)
      : null,
    stayVerb: 'Stay open',
    quitVerb: one ? 'Quit and end it' : 'Quit and end them',
    hint: '⌥⌘Q quits without asking',
  }
}
