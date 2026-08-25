// WHOSE SERVER IS THAT? — deciding whether a live port belongs to this lane.
//
// The bug this exists for: `sessionPorts` returned the reserved port whenever *anything* was
// listening on it, with a comment claiming "every port here belongs to THIS session". It did not.
// A lane reserves 1422; its dev server dies; a stale orphan or another lane binds 1422; the
// preview shows that server as this lane's app. Same shape as the orphan problem the reaper was
// built for — 60 tagged strays were live on this machine while it was written — so the reserved
// port being answered is evidence of very little on its own.
//
// NO `lsof`. The one call that would answer "which process holds this socket" is the one this
// codebase forbids: per-pid `lsof` fires a macOS TCC prompt per inspected process, and `lsof -i
// :PORT` is the same thing in kind. So the answer here is INFERRED from the `ps -E` snapshot the
// reaper already takes, and the inference is stated honestly rather than dressed up as proof:
//
//   - `sniffed`  the port came out of THIS pty's own bytes. Proof, not inference — the session
//                announced it itself, and no other process can put bytes in our pty.
//   - `reserved` the port is our reservation AND a process in our own subtree carries it in its
//                environment AND no other lane's process claims it. Strong evidence.
//   - `foreign`  everything else that is nonetheless answering. Not ours as far as we can tell.
//
// THE SUBTLE PART, and the reason a naive env check does not work: `OPERATOR_DEV_PORT` is set on
// the pty itself, so the lane's login shell and its `claude` child ALWAYS carry it — even when the
// dev server is long dead. Matching on the env var alone would call every reserved port `reserved`
// forever, which is exactly the bug. So the claimant has to be a process DEEPER than `claude`:
// something the lane actually started, not the lane itself.
import { descendantsOf, snapshotPs, sweepTagged, type PsRow, type TaggedRow } from './reap'

/** The evidence tiers, from `dev/results/preview-address-bar-design.md` §1. Naming them is what
 *  makes the selection rule writable — `session_ports` used to return bare numbers, so the
 *  frontend had nothing better to reason with than "is the reserved one in the list".
 *
 *  - `sniffed`  a banner printed in THIS lane's pty. Proof.
 *  - `reserved` Operator allocated it to this lane ALONE and something we started claims it.
 *  - `shared`   the reservation is shared with a sibling in the same cwd. `alloc_port` does this
 *               deliberately — "same cwd → same port" — so for N lanes in one root the reserved
 *               value is IDENTICAL and cannot distinguish them. Actively ambiguous, and the root
 *               of the wrong-server report: the old rule ranked exactly this signal highest.
 *  - `claimed`  another live lane claims it. Evidence it is NOT ours.
 *  - `orphan`   alive, and nobody claims it. A previous run's leftover, or an unrelated app. */
export type PortAttribution = 'sniffed' | 'reserved' | 'shared' | 'claimed' | 'orphan'

export interface SessionPort {
  port: number
  attributed: PortAttribution
  /** How many lanes hold this reservation, when it is shared. Drives "shared with 2 lanes". */
  sharedWith?: number
  /** The lane that claims it, when another one does — so the UI can name it rather than saying
   *  "another lane" and leaving the user to guess which. */
  claimedBy?: string
}

export interface AttributionInput {
  port: number
  /** This port came out of this pty's own output. */
  sniffed: boolean
  /** The port Operator reserved for this lane, if any. */
  reservedPort?: number
  /** How many lanes hold that same reservation. >1 means `alloc_port` shared it across a cwd. */
  reservationHolders?: number
  terminalId: string
  /** `ps -E` rows whose `OPERATOR_DEV_PORT` equals `port` — i.e. processes that were TOLD to
   *  serve it, whichever lane told them. */
  claimants: ReadonlyArray<{ pid: number; terminalId?: string }>
  /** Pids in this lane's subtree, excluding the pty shell and its direct children — see the
   *  header. A claimant here is something the lane STARTED. */
  ownDeepPids: ReadonlySet<number>
}

/** The decision. Pure, so every branch is exercised against a fabricated table rather than
 *  against whatever happened to be running. */
export function attributePort(input: AttributionInput): PortAttribution {
  // Our own bytes said so. Nothing below can outrank that, and nothing needs to: no other
  // process can write into this pty.
  if (input.sniffed) return 'sniffed'

  const theirs = input.claimants.filter((c) => c.terminalId != null && c.terminalId !== input.terminalId)

  if (input.reservedPort == null || input.port !== input.reservedPort) {
    // Not ours to begin with. Someone else's claim is worth reporting as such rather than
    // flattening into "not ours" — the UI names the lane.
    return theirs.length ? 'claimed' : 'orphan'
  }

  // ANOTHER LANE WAS TOLD TO SERVE THIS PORT. Two processes cannot both hold it, and we cannot
  // see which one won — so the honest answer is that we do not know it is ours. Deciding this
  // BEFORE the positive check is the whole point: a contested port shown as this lane's app is
  // the original bug, and "we are not sure" must lose to nothing.
  if (theirs.length) return 'claimed'

  // THE RESERVATION IS SHARED. `alloc_port` hands one port to every lane in a cwd on purpose, so
  // this signal cannot tell those lanes apart — and the old rule ranked it highest, which is the
  // wrong-server bug at its root. Ambiguous is its own answer, not a weaker kind of ours.
  if ((input.reservationHolders ?? 1) > 1) return 'shared'

  if (input.claimants.some((c) => input.ownDeepPids.has(c.pid))) return 'reserved'
  // Something is listening, our reservation is the port, and nothing we can see accounts for it.
  return 'orphan'
}

/** The pids that count as "something this lane started": its subtree, minus the pty shell and
 *  minus the shell's direct children (which is `claude` itself).
 *
 *  Pure over a `ps` snapshot, so the exclusion rule is testable without a process table. */
export function ownDeepPids(rows: readonly PsRow[], shellPid: number | undefined): Set<number> {
  if (!shellPid) return new Set()
  const all = descendantsOf(rows as PsRow[], shellPid)
  const out = new Set(all)
  out.delete(shellPid)
  for (const r of rows) {
    if (r.ppid === shellPid) out.delete(r.pid)
  }
  return out
}

/** Index the tagged sweep by the port each process was told to serve. */
export function claimantsByPort(tagged: readonly TaggedRow[]): Map<number, Array<{ pid: number; terminalId?: string }>> {
  const out = new Map<number, Array<{ pid: number; terminalId?: string }>>()
  for (const r of tagged) {
    if (r.devPort == null) continue
    const list = out.get(r.devPort)
    if (list) list.push({ pid: r.pid, terminalId: r.terminalId })
    else out.set(r.devPort, [{ pid: r.pid, terminalId: r.terminalId }])
  }
  return out
}

// ── the evidence snapshot, cached ────────────────────────────────────────────────────────────
//
// `sessionPorts` is POLLED — the preview panel every 4s, the toolbar chip every 5s, per session.
// Answering each poll with a fresh `ps -eww -o pid,pgid,command -E` would dump every process's
// entire environment several times a second on a machine with a dozen lanes open, which is a real
// cost for evidence that changes on the timescale of a dev server starting up.
//
// So the pair is cached for a beat. The TTL is short enough that "I just started my server" shows
// up on the next poll rather than the one after, and long enough that N sessions polling in
// parallel share one sweep instead of taking one each.

const EVIDENCE_TTL_MS = 3000

interface Evidence {
  psRows: PsRow[]
  claimants: Map<number, Array<{ pid: number; terminalId?: string }>>
}

let cached: { at: number; value: Promise<Evidence> } | null = null

/** The `ps` evidence attribution needs, at most once per `EVIDENCE_TTL_MS`.
 *
 *  The PROMISE is cached, not the result, so concurrent callers that arrive during the sweep
 *  await the same one instead of each starting another — which is the exact shape of the polling
 *  this exists for (two pollers per session, all firing on their own timers). */
export function evidenceSnapshot(now: () => number = Date.now): Promise<Evidence> {
  const t = now()
  if (cached && t - cached.at < EVIDENCE_TTL_MS) return cached.value
  const value = Promise.all([snapshotPs(), sweepTagged()])
    .then(([psRows, tagged]) => ({ psRows, claimants: claimantsByPort(tagged) }))
    // A failed sweep must not poison the cache for its whole TTL — the next poll should try again.
    .catch(() => { cached = null; return { psRows: [] as PsRow[], claimants: new Map() } })
  cached = { at: t, value }
  return value
}

/** Drop the cache. For tests, and for the one case where staleness would be visible: a lane that
 *  has just spawned should not be judged against a snapshot taken before it existed. */
export function resetEvidenceCache(): void {
  cached = null
}
