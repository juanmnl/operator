import { COORDINATOR_ROLE_IDS } from './dispatch'

// TASK-SCOPED LANES: when a lane may be closed, and what "closed" is allowed to mean.
//
// THE INVARIANT THIS FILE SERVES: close means DETACH, never forget. Nothing here decides to
// delete anything — it decides which lanes stop holding a pty. The saved session (its
// `claudeSessionId`, its branch, its worktree provenance) survives every outcome below, which is
// what makes the lane resumable with `--resume` and its transcript still readable.
//
// WHY THIS IS POSSIBLE NOW. `fix-session-task-lifecycle-RESULT.md` concluded, about the ~200
// tasks stuck in `running`: "Completion only fires when a lane DIES… there is no per-turn
// completion signal." That is exactly why auto-close was never viable — the only "done" signal
// was the thing you were trying to trigger. `operator__task_status(id, 'done')` (v0.14.0) IS that
// signal, so this file needs no heuristic for "finished" and deliberately has none.
//
// THE ONE THING IT MUST NOT DO is treat SILENCE as success. A lane that reported done and a lane
// that went quiet are different facts and they get different outcomes: the first closes on the
// short path with its work marked `done`; the second closes only on a much longer backstop, and
// its work is marked `abandoned` (the status that already means "its run ended, but we never saw
// it finish"). See `LaneCloseReason`.

/** Why a lane was closed. Not cosmetic — the caller marks the lane's running tasks differently
 *  per reason, and the toast says which happened. */
export type LaneCloseReason = 'reported-done' | 'went-quiet'

/** What the policy needs to know about one live lane. Assembled by the caller from the terminal
 *  tab, its tracked session, and the project's tasks. */
export interface LaneSnapshot {
  terminalId: string
  roleId?: string
  projectId?: string
  /** The tracked session's phase: `running` | `compacting` | `waiting` | `idle`. Undefined when
   *  the transcript observer has not seen this lane yet — unknown is never closable. */
  phase?: string
  /** The pty already exited; its own exit path owns it. */
  ended?: boolean
  /** Last transcript activity, ISO. The clock the grace window runs on. */
  lastActivityAt?: string
  /** When this lane's most recent `task_status done` landed, ISO. Undefined = it has never
   *  reported, which is the whole point of the distinction. */
  reportedDoneAt?: string
  /** Queued or running tasks still assigned to this lane. Any open work cancels the close —
   *  the lane is not finished, whatever it reported a moment ago. */
  openWork: number
  /** The lane the user is looking at right now. Never yanked out from under them. */
  focused?: boolean
}

export interface LaneClosePolicy {
  /** Grace window after a completion report. `0` disables auto-close ENTIRELY (backstop too). */
  keepWarmMs: number
  /** The went-quiet backstop: silence this long with no report at all. */
  quietMs: number
}

export type LaneCloseDecision =
  | { close: false; why: string }
  | { close: true; reason: LaneCloseReason; why: string }

const BUSY = new Set(['running', 'compacting'])

/** Milliseconds since `iso`, or `undefined` if there is no usable timestamp. */
function ageOf(iso: string | undefined, nowMs: number): number | undefined {
  if (!iso) return undefined
  const t = Date.parse(iso)
  return Number.isNaN(t) ? undefined : nowMs - t
}

/** Should this lane close right now, and on which of the two very different grounds?
 *
 *  The guards are ordered from "not ours to close" to "not finished" to "finished but warm", and
 *  each returns its own reason so the caller can say why nothing happened.
 *
 *  `waiting` IS THE ONE THAT WILL BITE, and it has its own guard for that reason: a lane sitting
 *  on a permission prompt is indistinguishable from a lane with nothing to do, and closing it
 *  kills a turn mid-flight. Operator's status vocabulary already separates `waiting` (your turn)
 *  from `idle`, so this respects it rather than collapsing the two.
 *
 *  THE GRACE WINDOW RUNS FROM THE LATER of the report and the last activity. A lane usually keeps
 *  talking for a few seconds after calling `task_status` — closing from the report alone would
 *  cut the tail of the very turn that reported. */
export function laneCloseDecision(lane: LaneSnapshot, nowMs: number, policy: LaneClosePolicy): LaneCloseDecision {
  if (policy.keepWarmMs <= 0) return { close: false, why: 'auto-close is off' }
  if (lane.ended) return { close: false, why: 'the pty already exited' }
  if (lane.roleId && COORDINATOR_ROLE_IDS.includes(lane.roleId.toLowerCase())) {
    // Out of scope by design: the coordinator runs in the repo and is long-lived. It is the lane
    // that commissions task-scoped work, not one of them.
    return { close: false, why: 'the coordinator is not task-scoped' }
  }
  if (lane.focused) return { close: false, why: 'you are looking at it' }
  if (lane.openWork > 0) return { close: false, why: `${lane.openWork} task(s) still open` }
  if (!lane.phase) return { close: false, why: 'no tracked session yet' }
  if (BUSY.has(lane.phase)) return { close: false, why: `still ${lane.phase}` }
  if (lane.phase === 'waiting') return { close: false, why: 'waiting on you' }

  const idleFor = ageOf(lane.lastActivityAt, nowMs)
  const reportedFor = ageOf(lane.reportedDoneAt, nowMs)

  if (reportedFor !== undefined) {
    // Warm for `keepWarmMs` after the LATER of the two events — which is the SMALLER of the two
    // ages. `idleFor` may be undefined for a lane with no transcript timestamp; the report alone
    // is then the clock.
    const quietFor = idleFor === undefined ? reportedFor : Math.min(idleFor, reportedFor)
    return quietFor >= policy.keepWarmMs
      ? { close: true, reason: 'reported-done', why: 'reported done and went quiet for the grace window' }
      : { close: false, why: 'reported done, still inside the grace window' }
  }

  // NEVER REPORTED. This is the charter-dependency risk named honestly in the spike — "the same
  // risk as sentinels, moved, not removed": a lane that never calls `task_status` would never
  // close. So there is a backstop, and it is deliberately much longer than the grace window and
  // deliberately NOT called completion. Silence is a bug signal, not a lifecycle event.
  if (idleFor !== undefined && idleFor >= policy.quietMs) {
    return { close: true, reason: 'went-quiet', why: 'silent past the backstop without ever reporting' }
  }
  return { close: false, why: 'has not reported done' }
}

export interface LaneClosePlan {
  /** Lanes to close on this tick, capped at `limit`. */
  close: Array<{ lane: LaneSnapshot; reason: LaneCloseReason }>
  /** How many more are eligible but held for the next tick. NOT a silent cap: the caller says so. */
  deferred: number
}

/** Every eligible lane, oldest-idle first, capped per tick.
 *
 *  THE CAP IS PACING, NOT A LIMIT — the deferred ones close on the next tick. It exists because
 *  every close runs `git` in the same source repo (a WIP commit, then `worktree remove`), and 27
 *  of those firing in one tick after a restart contend on the same index lock. */
export function planLaneCloses(
  lanes: LaneSnapshot[],
  nowMs: number,
  policy: LaneClosePolicy,
  limit = 3,
): LaneClosePlan {
  const eligible: Array<{ lane: LaneSnapshot; reason: LaneCloseReason }> = []
  for (const lane of lanes) {
    const d = laneCloseDecision(lane, nowMs, policy)
    if (d.close) eligible.push({ lane, reason: d.reason })
  }
  // Quietest first, so a restart's oldest strays go before a lane that finished a minute ago.
  eligible.sort((a, b) => (ageOf(b.lane.lastActivityAt, nowMs) ?? 0) - (ageOf(a.lane.lastActivityAt, nowMs) ?? 0))
  return { close: eligible.slice(0, limit), deferred: Math.max(0, eligible.length - limit) }
}

// --- the setting -------------------------------------------------------------------------

/** Minutes of quiet after a completion report before the lane closes. */
export const KEEP_WARM_KEY = 'operator.lane.keepWarmMinutes'
/** Minutes of silence with NO report before the backstop closes the lane. */
export const QUIET_KEY = 'operator.lane.quietMinutes'

/** THE GRACE WINDOW, and why ten minutes.
 *
 *  A live pty is instant; a spawned one pays process start plus context rehydration on every
 *  dispatch, so closing the moment a lane reports done would thrash on bursty traffic — spawn,
 *  work, close, spawn again — and pay that cost repeatedly for lanes that were about to be used.
 *  Ten minutes is longer than the gap inside a burst (a coordinator's follow-up dispatch, a
 *  human reading a result and replying) and far shorter than the gaps that actually cost memory
 *  (the overnight lanes: the measured baseline was 27 lanes with 2 working, renderer peaking
 *  1.1–1.2GB and being killed hourly). It is the smallest window that keeps the common
 *  re-dispatch warm.
 *
 *  Configurable in Preferences, including OFF — see `laneCloseDecision`, where 0 disables the
 *  backstop too. */
export const DEFAULT_KEEP_WARM_MINUTES = 10

/** The went-quiet backstop. Two hours, because it is answering a different question: not "is this
 *  lane done" but "has this lane stopped being a lane". Long enough that a slow human turn-around
 *  on a `waiting` lane never reaches it (and `waiting` is guarded anyway), short enough that a
 *  crashed or wedged lane does not hold a pty and a worktree overnight. */
export const DEFAULT_QUIET_MINUTES = 120

function readMinutes(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n >= 0 ? n : fallback
  } catch {
    return fallback
  }
}

export function getKeepWarmMinutes(): number {
  return readMinutes(KEEP_WARM_KEY, DEFAULT_KEEP_WARM_MINUTES)
}

export function setKeepWarmMinutes(minutes: number): void {
  try { localStorage.setItem(KEEP_WARM_KEY, String(Math.max(0, Math.round(minutes)))) } catch { /* quota */ }
}

export function getQuietMinutes(): number {
  return readMinutes(QUIET_KEY, DEFAULT_QUIET_MINUTES)
}

/** The policy as the effect reads it, once per tick. */
export function laneClosePolicy(): LaneClosePolicy {
  return { keepWarmMs: getKeepWarmMinutes() * 60_000, quietMs: getQuietMinutes() * 60_000 }
}
