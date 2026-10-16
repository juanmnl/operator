import { COORDINATOR_ROLE_IDS } from './dispatch'
import type { DispatchRecord } from '../../shared/types'

// SUSPENDING IDLE LANES: which lanes may have their CLI ended to free memory, and how a message
// reaches one that is coming back.
//
// On 2026-10-16 the Mac ran out of memory with 19 lane CLIs running at 220–330 MB each, most of
// them idle. A lane's conversation lives in its transcript, so an idle CLI can be ended and started
// again with `--resume <claudeSessionId>` without losing the thread. The tab stays in the roster,
// marked suspended; its worktree, branch, role and saved record are untouched.
//
// NOT the task-scoped close in lib/lane-lifecycle. That one removes the tab and the worktree
// directory and marks the saved row `suspendedAt`, for a lane that finished. This one keeps all of
// it and only ends the process, for a lane that went quiet. The saved row says `idleSuspendedAt`.
//
// Every rule below errs toward keeping a lane running. A lane kept up costs memory; a lane ended
// at the wrong moment loses a turn, a draft, a background task or a dev server.

/** What the decision needs to know about one live lane. Assembled by the caller from the tab, its
 *  tracked session, the submit queue, the project's dispatch log and the lane's ports. */
export interface SuspendCandidate {
  terminalId: string
  roleId?: string
  /** The tracked session's phase. Undefined: the observer has not seen this lane, so nothing is
   *  known about it and it is kept. */
  phase?: string
  /** The pty already exited, or the lane is already suspended. */
  ended?: boolean
  /** Last transcript activity, ISO. */
  lastActivityAt?: string
  /** Last keystroke into the pane, epoch ms. */
  lastKeystrokeAt?: number
  /** When Operator spawned this pty, epoch ms: a launch, a restart or a resume. A `--resume` with
   *  no prompt writes no transcript record, so without this a lane resumed by focus reads as quiet
   *  for as long as it was suspended. Undefined for a pty Operator did not start in this run. */
  spawnedAt?: number
  /** The pane the user is looking at. */
  focused?: boolean
  /** Text typed into the composer and not sent (lib/lane-keystrokes). */
  unsentInput?: boolean
  /** A submission in the submit queue still waiting for its turn. */
  pendingSubmission?: boolean
  /** Messages for this lane waiting for it to be ready (`whenLaneReady`) before they are typed.
   *  They are not in the submit queue yet, so `pendingSubmission` does not see them. */
  awaitingDelivery?: number
  /** Dispatches and replies to this lane that are queued or held (`heldDeliveriesFor`). */
  heldDeliveries?: number
  /** Background Bash commands and background agents started by this CLI and not finished. Ending
   *  the CLI ends them. */
  backgroundTasks?: number
  /** Subagents running in this CLI. */
  activeSubagents?: number
  /** A dev server answering on one of this lane's ports. Undefined: not checked yet. Ending the CLI
   *  ends the server, which is its grandchild. */
  devServer?: boolean
  /** It called `worktree_done`. Ending it settles the release and removes the worktree, which is
   *  the retire path's job, not this one's. */
  released?: boolean
  /** It has a Claude session id to `--resume`. Without one it would come back as a blank session. */
  resumable: boolean
  /** A restart, retire, close or resume of this lane is in flight. */
  inFlight?: boolean
}

export type SuspendDecision =
  | { suspend: true; why: string }
  /** `checkPorts`: every other rule passed, and the lane's ports have not been read yet. */
  | { suspend: false; why: string; checkPorts?: true }

/** Milliseconds since `iso`, or undefined when there is no usable timestamp. */
function ageOf(iso: string | undefined, nowMs: number): number | undefined {
  if (!iso) return undefined
  const t = Date.parse(iso)
  return Number.isNaN(t) ? undefined : nowMs - t
}

/** How long the lane has been quiet: since the latest of its last transcript record, its last
 *  keystroke and its spawn. Undefined when the transcript has no timestamp. */
export function quietFor(c: Pick<SuspendCandidate, 'lastActivityAt' | 'lastKeystrokeAt' | 'spawnedAt'>, nowMs: number): number | undefined {
  const transcript = ageOf(c.lastActivityAt, nowMs)
  if (transcript === undefined) return undefined
  let quiet = transcript
  if (c.lastKeystrokeAt !== undefined) quiet = Math.min(quiet, nowMs - c.lastKeystrokeAt)
  if (c.spawnedAt !== undefined) quiet = Math.min(quiet, nowMs - c.spawnedAt)
  return quiet
}

const BETWEEN_TURNS = new Set(['idle', 'waiting'])

/** May this lane's CLI be ended now? Ordered from "not ours to end" to "not quiet long enough",
 *  each rule with its own reason so a caller can say why nothing happened. */
export function suspendDecision(c: SuspendCandidate, nowMs: number, idleMs: number): SuspendDecision {
  if (idleMs <= 0) return { suspend: false, why: 'suspending idle lanes is off' }
  if (c.ended) return { suspend: false, why: 'not running' }
  if (!c.resumable) return { suspend: false, why: 'no conversation to resume' }
  if (c.roleId && COORDINATOR_ROLE_IDS.includes(c.roleId.toLowerCase())) {
    // Coordinators receive every lane's reports and answer the user from the phone. Kept up in v1.
    return { suspend: false, why: 'the coordinator stays running' }
  }
  if (c.focused) return { suspend: false, why: 'you are looking at it' }
  if (c.inFlight) return { suspend: false, why: 'a restart or resume is in flight' }
  if (c.released) return { suspend: false, why: 'it released its worktree' }
  if (!c.phase) return { suspend: false, why: 'no tracked session yet' }
  // `running` covers a lane blocked on a permission prompt: an unanswered tool_use derives as
  // running (lib/cli-update). `asking` is an open AskUserQuestion.
  if (!BETWEEN_TURNS.has(c.phase)) return { suspend: false, why: `it is ${c.phase}` }
  if (c.pendingSubmission) return { suspend: false, why: 'a message to it has not become a turn yet' }
  if ((c.awaitingDelivery ?? 0) > 0) return { suspend: false, why: 'a message to it is waiting for it to be ready' }
  if (c.unsentInput) return { suspend: false, why: 'it has unsent text in its input' }
  if ((c.heldDeliveries ?? 0) > 0) return { suspend: false, why: 'a dispatch or reply to it is queued or held' }
  if ((c.backgroundTasks ?? 0) > 0) return { suspend: false, why: 'it has background tasks running' }
  if ((c.activeSubagents ?? 0) > 0) return { suspend: false, why: 'it has subagents running' }
  const quiet = quietFor(c, nowMs)
  if (quiet === undefined) return { suspend: false, why: 'no activity timestamp' }
  if (quiet < idleMs) return { suspend: false, why: 'not idle long enough' }
  if (c.devServer === undefined) return { suspend: false, why: 'its ports have not been checked', checkPorts: true }
  if (c.devServer) return { suspend: false, why: 'it is serving a dev server' }
  return { suspend: true, why: 'idle past the threshold' }
}

/** Every lane to suspend on this tick, quietest first, capped. The cap is pacing: each suspend is
 *  a kill and a state write, and the rest go on the next tick. */
export function planSuspends(lanes: readonly SuspendCandidate[], nowMs: number, idleMs: number, limit = 2): SuspendCandidate[] {
  return lanes
    .filter((l) => suspendDecision(l, nowMs, idleMs).suspend)
    .sort((a, b) => (quietFor(b, nowMs) ?? 0) - (quietFor(a, nowMs) ?? 0))
    .slice(0, limit)
}

/** Lanes whose ports should be read before the next decision: everything else already passed. */
export function needsPortCheck(lanes: readonly SuspendCandidate[], nowMs: number, idleMs: number): SuspendCandidate[] {
  return lanes.filter((l) => {
    const d = suspendDecision(l, nowMs, idleMs)
    return !d.suspend && d.checkPorts === true
  })
}

/** Does a port list from `sessionPorts` mean the lane is serving something? A port another lane
 *  claims is that lane's and survives this one ending; every other live port counts, including a
 *  shared reservation, which may be this lane's. */
export function servesDevServer(ports: ReadonlyArray<{ attributed: string }>): boolean {
  return ports.some((p) => p.attributed !== 'claimed')
}

// ── held deliveries ───────────────────────────────────────────────────────────────────────────

/** Dispatch-log outcomes that mean a message to the lane is still owed or held: waiting for
 *  approval, stopped by a brake, waiting on a `finishing` watch or a retire, or typed and never seen
 *  as a turn (so it may sit in the composer the new process would start without). Not `queued` or
 *  `not-retired`: that task waits on the board, and a suspended lane loses nothing of it. */
const HELD_OUTCOMES: ReadonlySet<DispatchRecord['outcome']> = new Set<DispatchRecord['outcome']>([
  'pending-approval', 'undelivered', 'hop-limit', 'pair-brake', 'paused', 'finishing', 'retiring',
])

/** How far back a held record keeps a lane up. Records never expire on their own, and a lane with
 *  one held record from last week would otherwise never be suspended again. */
export const HELD_RECORD_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** Dispatches and replies addressed to `roleId` that are queued or held, from the last day. */
export function heldDeliveriesFor(records: readonly DispatchRecord[] | undefined, roleId: string | undefined, nowMs: number): number {
  if (!roleId || !records) return 0
  let n = 0
  for (const r of records) {
    if (r.toRoleId !== roleId || !HELD_OUTCOMES.has(r.outcome)) continue
    const age = ageOf(r.at, nowMs)
    if (age !== undefined && age < HELD_RECORD_MAX_AGE_MS) n++
  }
  return n
}

// ── coming back ───────────────────────────────────────────────────────────────────────────────

/** A restored suspended lane has no pty in this app run. Its tab carries this id until it is
 *  resumed, so it can never collide with a live pty's per-run id (`t0`, `t1`, …). */
export const SUSPENDED_ID_PREFIX = 'suspended:'

export const suspendedTabId = (key: string): string => `${SUSPENDED_ID_PREFIX}${key}`

/** Is this tab id a placeholder with no pty behind it? */
export const isPlaceholderId = (id: string): boolean => id.startsWith(SUSPENDED_ID_PREFIX)

/** How long after its spawn a resumed CLI is given before a second message is typed into it. The
 *  transcript is read again as soon as the pty is registered, before the TUI has drawn, so seeing
 *  the session is not enough on its own. */
export const LANE_SETTLE_MS = 4_000
/** After this, a message is typed in anyway; the submit queue reports it if it never became a turn.
 *  It is what a lane launched with no prompt waits for: it has no transcript until its first one. */
export const LANE_READY_TIMEOUT_MS = 15_000

/** Is a just-spawned lane ready for a typed message? Pure. `observed`: its tracked session has
 *  been seen. Unknown spawn time (a lane Operator did not just start) is ready. */
export function laneReady(o: { spawnedAt?: number; observed: boolean }, nowMs: number): boolean {
  if (o.spawnedAt === undefined) return true
  const age = nowMs - o.spawnedAt
  if (age >= LANE_READY_TIMEOUT_MS) return true
  return o.observed && age >= LANE_SETTLE_MS
}

// ── ending the CLI ────────────────────────────────────────────────────────────────────────────

/** The steps of one suspend, from the view. */
export interface SuspendSteps {
  /** Re-checks what can change while the suspend runs: a message arrived, someone typed or looked. */
  stillIdle: () => boolean
  /** Tell main the suspended set, with this lane in it (`true`) or not. */
  report: (withThisLane: boolean) => Promise<void>
  /** Mark the pty's coming exit as not the lane finishing (`true`), or take that back. */
  guardExit: (on: boolean) => void
  kill: () => Promise<void>
  /** Show the tab as suspended. From here routing wakes it, and the wake waits for the kill
   *  (`LaneGate`); a message already owed to the old pty goes through the wake too. */
  markSuspended: () => void
  /** The kill failed: the tab is a live lane again, and messages that waited on the kill are typed
   *  into it. */
  unmarkSuspended: () => void
}

/** One suspend, in the order that keeps a message from starting a second CLI (review M4) and from
 *  being typed into the dying one (review N1).
 *
 *  Main is told first, so a crash before the kill still restores the lane suspended; main ignores
 *  a suspended key whose pty is still alive. The re-check after the report cancels the suspend if a
 *  message arrived meanwhile. From the moment it passes, the tab reads as suspended: a message routed
 *  during the kill wakes the lane, and the view holds that wake until the kill has settled (the kill
 *  takes a `ps` snapshot and waits on the process tree, so it is never instant). Before, the tab read
 *  as live until the kill returned, and a message in that window was typed into a CLI that was being
 *  reaped. A kill that fails leaves the lane running and not suspended. */
export async function runSuspend(st: SuspendSteps): Promise<'suspended' | 'cancelled' | 'kill-failed'> {
  if (!st.stillIdle()) return 'cancelled'
  await st.report(true)
  if (!st.stillIdle()) {
    await st.report(false)
    return 'cancelled'
  }
  st.guardExit(true)
  st.markSuspended()
  try {
    await st.kill()
  } catch {
    st.unmarkSuspended()
    st.guardExit(false)
    await st.report(false)
    return 'kill-failed'
  }
  return 'suspended'
}

/** Ends of a lane in flight, by lane key: a suspend's kill (review N1) or the close of a suspended
 *  lane (review N2). A wake waits for every one of them and then looks at the lane again, so it
 *  never resumes a CLI that is still being reaped, nor one whose tab and worktree are being removed. */
export class LaneGate {
  private readonly holds = new Map<string, Set<Promise<void>>>()

  /** Hold `key` until the returned function is called. Calling it twice is harmless. */
  hold(key: string): () => void {
    let open!: () => void
    const held = new Promise<void>((r) => { open = r })
    const set = this.holds.get(key) ?? new Set<Promise<void>>()
    set.add(held)
    this.holds.set(key, set)
    let done = false
    return () => {
      if (done) return
      done = true
      set.delete(held)
      if (!set.size && this.holds.get(key) === set) this.holds.delete(key)
      open()
    }
  }

  /** Is anything holding `key`? */
  busy(key: string): boolean {
    return (this.holds.get(key)?.size ?? 0) > 0
  }

  /** Run `go` once nothing holds `key`: at once when free, else after every hold now in place and
   *  any taken while waiting. Callers waiting on the same key run in the order they called. */
  after<T>(key: string, go: () => Promise<T>): Promise<T> {
    const set = this.holds.get(key)
    if (!set?.size) return go()
    return Promise.all([...set]).then(() => this.after(key, go))
  }
}

/** When each pty Operator is running started, from main's list (review N6). The renderer's own
 *  spawn stamps die with it, so after a reload a lane resumed a moment earlier read as quiet since
 *  its last transcript record and was suspended on the next tick. Scratch shells are not lanes. */
export function spawnStampsFromList(list: ReadonlyArray<{ id: string; alive: boolean; startedAt?: string }>): Array<[string, number]> {
  const out: Array<[string, number]> = []
  for (const t of list) {
    if (!t.alive || t.id.startsWith('sh')) continue
    const at = t.startedAt ? Date.parse(t.startedAt) : NaN
    if (!Number.isNaN(at)) out.push([t.id, at])
  }
  return out
}

// ── a resume that did not come back ──────────────────────────────────────────────────────────

/** How long after a resume an exit on its own counts as the resume failing. `--resume` of a
 *  transcript Claude Code has deleted (`cleanupPeriodDays`) prints "No conversation found" and
 *  exits within a second or two. */
export const RESUME_CONFIRM_MS = 60_000

/** Did a resumed CLI exit without coming back? `tookTurn`: its transcript gained a record after the
 *  spawn. `selfExit`: it exited on its own, not by Operator's kill. Such an exit is not the lane
 *  finishing, so its tasks are not completed, and the message it carried was never delivered. */
export function failedResume(w: { spawnedAt: number; tookTurn: boolean }, exitMs: number, selfExit: boolean): boolean {
  return selfExit && !w.tookTurn && exitMs - w.spawnedAt < RESUME_CONFIRM_MS
}

/** Has a resumed lane's transcript moved since its spawn? */
export function tookTurnSince(lastActivityAt: string | undefined, spawnedAt: number): boolean {
  const t = lastActivityAt ? Date.parse(lastActivityAt) : NaN
  return !Number.isNaN(t) && t >= spawnedAt
}

// ── restoring suspended tabs at launch ───────────────────────────────────────────────────────

/** Which saved rows come back as suspended tabs. One tab per key: a key that already has a tab, or
 *  whose restore is in flight, gets none, and nor does a key main saw live at the end of the last
 *  run (crash auto-resume owns that one). */
export function suspendedRowsToRestore<R extends { key: string; idleSuspendedAt?: string; claudeSessionId?: string; releasedAt?: string }>(
  rows: readonly R[],
  o: { tabs: Iterable<string>; restoring: Iterable<string>; fromMain: Iterable<string>; liveAtEnd: Iterable<string> },
): R[] {
  const taken = new Set([...o.tabs, ...o.restoring, ...o.liveAtEnd])
  const fromMain = new Set(o.fromMain)
  const out: R[] = []
  for (const r of rows) {
    if (!(r.idleSuspendedAt || fromMain.has(r.key)) || !r.claudeSessionId || r.releasedAt) continue
    if (taken.has(r.key)) continue
    taken.add(r.key)
    out.push(r)
  }
  return out
}

/** The tab a restored suspended row comes back as: no pty, a placeholder id, and everything the
 *  resume needs to start the CLI as it was, the fan-out index included, since the lane's bus name is
 *  built from it (review L5). The effort is the row's as written; the view migrates it. */
export function placeholderTab<R extends {
  key: string; cwd: string; model?: string; effortLevel?: string; permissionMode?: string
  worktreeBranch?: string; worktreeBase?: string; sourceCwd?: string; projectId?: string; roleId?: string
  fanIndex?: number; claudeVersion?: string | null; idleSuspendedAt?: string; claudeSessionId?: string
}>(sv: R, nowIso: string) {
  return {
    id: suspendedTabId(sv.key),
    key: sv.key,
    cwd: sv.cwd,
    model: sv.model,
    effortLevel: sv.effortLevel,
    permissionMode: sv.permissionMode,
    worktreeBranch: sv.worktreeBranch,
    worktreeBase: sv.worktreeBase,
    sourceCwd: sv.sourceCwd,
    projectId: sv.projectId,
    roleId: sv.roleId,
    fanIndex: sv.fanIndex,
    claudeVersion: sv.claudeVersion ?? null,
    ended: true as const,
    idleSuspendedAt: sv.idleSuspendedAt ?? nowIso,
    resumeSessionId: sv.claudeSessionId,
  }
}

// ── keys typed at the suspended pane ─────────────────────────────────────────────────────────

/** What a key typed at the suspended pane does to the text held for the resumed lane. Printable
 *  keys are kept and Backspace takes one back, so the resumed composer gets what was typed. Enter
 *  only resumes: the held text is typed into the composer and not sent, so nothing is submitted
 *  that the person has not seen. Null: the key is not ours (a shortcut, an arrow). */
export function overlayKey(held: string, e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }): { held: string; resume: boolean } | null {
  if (e.metaKey || e.ctrlKey) return null
  if (e.key === 'Enter') return { held, resume: true }
  if (e.key === 'Backspace') return { held: held.slice(0, -1), resume: true }
  if (e.key.length === 1) return { held: held + e.key, resume: true }
  return null
}

/** Keys held at suspended panes, per lane key, until they are typed into the resumed lane.
 *
 *  TAKEN WHEN WRITTEN, NOT WHEN ASKED (review N3). The overlay hands over the text after each burst
 *  of typing and once more when it unmounts, and every hand-over asks for it to be typed. The text
 *  is read at the write, so the last hand-over wins and it is typed once, whichever ask gets there
 *  first. It is written after every message that was already waiting on the lane's readiness, so a
 *  dispatch that joined the same resume is submitted on its own and the person's text stays in the
 *  composer, unsent. */
export class HeldKeys {
  private readonly held = new Map<string, string>()

  /** The overlay's latest text for `key`; empty clears it. */
  set(key: string, text: string): void {
    if (text) this.held.set(key, text)
    else this.held.delete(key)
  }

  has(key: string): boolean { return this.held.has(key) }

  /** Once `ready` resolves, and one task later, write what is held for `key` with `write` (the
   *  submit queue's chain). False when there was nothing left to write. */
  async typeInto(key: string, ready: Promise<void>, write: (text: string) => Promise<void> | void): Promise<boolean> {
    if (!this.held.has(key)) return false
    await ready
    // Messages waiting on the same readiness continue in microtasks; a timer runs after all of
    // them, so they are queued before this text.
    await new Promise<void>((r) => setTimeout(r, 0))
    const text = this.held.get(key)
    if (!text) return false
    this.held.delete(key)
    await write(text)
    return true
  }
}

/** What resuming a suspended lane needs from the view. */
export interface WakeDeps<T> {
  /** Start the lane's CLI again with `--resume`. `firstMessage` goes on its command line as the
   *  opening prompt, so it cannot arrive before the CLI can take it. Resolves to the live tab, or
   *  null when the spawn failed (the tab stays suspended). */
  resume: (terminalId: string, firstMessage?: string) => Promise<T | null>
  /** Resolves once the resumed lane can take a typed message (`laneReady`). */
  ready: (tab: T) => Promise<void>
  /** Type a message into a live lane (the submit queue). */
  submit: (tab: T, text: string) => void
}

/** Resumes suspended lanes, one resume per lane, and orders the messages behind it.
 *
 *  THE FIRST MESSAGE RIDES THE SPAWN. A second message to a lane that is still starting was lost
 *  before (memory note "Dispatch #2 lost at lane launch"): typed into a pty whose TUI had not drawn,
 *  it vanished. So the message that wakes a lane is its opening prompt, and any message that arrives
 *  while the resume is in flight waits for it and then for `ready` before it is typed. Messages
 *  that join are typed in the order they arrived. */
export class LaneWaker<T> {
  private readonly inflight = new Map<string, Promise<T | null>>()

  constructor(private readonly deps: WakeDeps<T>) {}

  /** Is a resume of this lane in flight? */
  waking(key: string): boolean { return this.inflight.has(key) }

  /** Resume the lane keyed `key` (its saved-session key) whose tab is `terminalId`, delivering
   *  `message` if given. Resolves to the live tab, or null when the lane did not come back. */
  wake(key: string, terminalId: string, message?: string): Promise<T | null> {
    const pending = this.inflight.get(key)
    // Nothing to deliver: the resume in flight is the answer.
    if (pending && !message) return pending
    if (pending) {
      // Chained on the previous message, so two joiners are typed in the order they arrived.
      const next = pending.then(async (tab) => {
        if (tab && message) {
          await this.deps.ready(tab)
          this.deps.submit(tab, message)
        }
        return tab
      })
      this.inflight.set(key, next)
      void next.finally(() => { if (this.inflight.get(key) === next) this.inflight.delete(key) })
      return next
    }
    const first = this.deps.resume(terminalId, message).catch(() => null)
    this.inflight.set(key, first)
    void first.finally(() => { if (this.inflight.get(key) === first) this.inflight.delete(key) })
    return first
  }
}
