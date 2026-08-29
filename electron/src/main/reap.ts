// Reaping the process TREE under a lane, not just the shell we spawned.
//
// THE BUG THIS EXISTS FOR. `TerminalManager` knows exactly one pid per lane — the login shell
// node-pty returned — and `UnixTerminal.kill()` is `process.kill(this.pid, 'SIGHUP')`: a
// SINGLE-pid signal, not a group signal (that needs a NEGATIVE pid). Everything under the
// shell — `claude`, and the `npm run dev` / `vite` / `esbuild` tree it started — was never
// signalled at all. The kernel's automatic SIGHUP-on-session-leader-death only reaches the
// FOREGROUND process group of the controlling tty, and a backgrounded dev server is in its own
// group, so it survived every lane close, every project close, and every clean app quit alike.
// See `dev/results/devserver-orphans-research.md` for the live `ps` evidence.
//
// WHY PROCESS GROUPS AND NOT SESSIONS. Once the login shell is gone the pty's session is gone
// with it (`SESS=0` on every orphan in the research snapshot) — there is nothing left to
// address. The process GROUP id survives as a live tag on the surviving members even after the
// group leader itself has exited, and POSIX `kill(-pgid, sig)` signals by that tag rather than
// by requiring the leader to exist. That is the one handle that still works.
//
// WHY THE TREE IS WALKED AT KILL TIME. The groups are assigned by the shell's job control at
// spawn time and Operator never sees them, so they cannot be pre-recorded — but at the instant
// BEFORE anything is signalled every descendant is still attached to the shell's subtree by
// `ppid`, whatever its own pgid is. One snapshot taken first is therefore the whole map.
//
// WHY `ps` AND NEVER `lsof`. Per-pid `lsof` fires a macOS TCC prompt ("would like to access
// data from other apps") once per inspected process — the standing rule in this codebase
// (`noteSessionPort` below in terminals.ts exists because of it). `lsof -i :PORT` is the same
// thing in kind. `ps` reads the public kernel process table and prompts for nothing, so the
// port is never how we find the process: the tree is.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isPortLive } from './port-probe'

const run = promisify(execFile)

/** Grace period between SIGTERM and SIGKILL. Vite/esbuild/node teardown is well under a second
 *  in practice; this gives a slow file-watcher flush headroom. We POLL inside it rather than
 *  sleeping it out, so the common case (everything gone in ~100ms) costs ~100ms — closing a
 *  lane must not feel like it hangs, and a fixed sleep here is felt on every close. */
const GRACE_MS = 1500
const POLL_MS = 100

/** One row of `ps -axo pid,ppid,pgid,command`. */
export interface PsRow {
  pid: number
  ppid: number
  pgid: number
  command: string
}

/** Parse `ps -axo pid,ppid,pgid,command` output.
 *
 *  The header line is dropped and malformed rows are skipped rather than throwing: this runs on
 *  the quit path, and a reaper that can throw is a quit that can hang. `command` keeps its
 *  internal spacing — it is only ever used for logging and for the env-tag scan, never parsed
 *  into argv. */
export function parsePsTable(stdout: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue // header, blank line, or a row `ps` truncated
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4] })
  }
  return rows
}

/** Every live descendant of `rootPid`, plus `rootPid` itself when it is present in the table.
 *
 *  Breadth-first over `ppid`, with a seen-set: a `ps` snapshot is not guaranteed to be a
 *  consistent instant, so a row whose parent has already been re-parented can in principle
 *  produce a cycle, and an infinite loop here would hang the quit path.
 *
 *  pid 0 and pid 1 are never followed. `launchd` is pid 1 and EVERY orphan re-parents to it —
 *  walking from it would collect the whole machine. */
export function descendantsOf(rows: PsRow[], rootPid: number): Set<number> {
  const out = new Set<number>()
  if (!Number.isInteger(rootPid) || rootPid <= 1) return out

  const byParent = new Map<number, PsRow[]>()
  for (const r of rows) {
    const kids = byParent.get(r.ppid)
    if (kids) kids.push(r)
    else byParent.set(r.ppid, [r])
  }

  if (rows.some((r) => r.pid === rootPid)) out.add(rootPid)
  const queue = [rootPid]
  while (queue.length) {
    const pid = queue.shift()!
    for (const kid of byParent.get(pid) ?? []) {
      if (kid.pid <= 1 || out.has(kid.pid)) continue
      out.add(kid.pid)
      queue.push(kid.pid)
    }
  }
  return out
}

/** The distinct process groups present among `pids`, minus the ones it would be catastrophic to
 *  signal.
 *
 *  `selfPgid` is OUR OWN group: a pty child gets a fresh session and group at `forkpty`, so it
 *  should never match — but "should never" is not a reason to leave `kill(-ourOwnGroup,
 *  SIGKILL)` reachable, because reaching it kills Operator itself mid-quit. pgid 0 and 1 are
 *  excluded for the same reason at a larger scale: 0 means "the caller's group" to `kill(2)`,
 *  and 1 is launchd's.
 *
 *  Sorted so the signalling order — and the tests — are deterministic. */
export function pgidsFor(rows: PsRow[], pids: Set<number>, selfPgid?: number): number[] {
  const out = new Set<number>()
  for (const r of rows) {
    if (!pids.has(r.pid)) continue
    if (r.pgid <= 1) continue
    if (selfPgid != null && r.pgid === selfPgid) continue
    out.add(r.pgid)
  }
  return [...out].sort((a, b) => a - b)
}

/** Our own process group, read out of the same snapshot rather than from a syscall — Node
 *  exposes `getpgid(2)` nowhere, and we already have the table in hand. */
export function selfPgidFrom(rows: PsRow[], selfPid: number): number | undefined {
  return rows.find((r) => r.pid === selfPid)?.pgid
}

/** Is this pid still around?
 *
 *  Signal 0 performs the permission and existence checks without delivering anything, so it is
 *  free and — unlike `lsof` — inspects nothing about the process. EPERM means the process
 *  EXISTS and is not ours to signal, which for our purposes is "alive"; only ESRCH is dead. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** One `ps -axo pid,ppid,pgid,command` snapshot. Empty on failure — a reaper that throws is a
 *  quit that hangs, and every caller treats "no rows" as "nothing to reap". */
export async function snapshotPs(): Promise<PsRow[]> {
  try {
    const { stdout } = await run('/bin/ps', ['-axo', 'pid,ppid,pgid,command'], { maxBuffer: 16 * 1024 * 1024 })
    return parsePsTable(stdout)
  } catch (e) {
    console.error('[reap] ps snapshot failed:', e)
    return []
  }
}

/** SIGTERM a process group, then a pid. Both swallow ESRCH: between the snapshot and the signal
 *  the target is very often already gone, which is success, not an error. */
function signal(target: number, sig: NodeJS.Signals): void {
  try {
    process.kill(target, sig)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ESRCH') console.error(`[reap] kill(${target}, ${sig}):`, code ?? e)
  }
}

export interface ReapResult {
  /** Pids found under the root at snapshot time, including the root and any `alsoReap` strays. */
  found: number[]
  /** Groups signalled. */
  pgids: number[]
  /** Pids still alive after the grace period — these got SIGKILL. */
  escalated: number[]
}

export interface ReapOptions {
  selfPid?: number
  /** Pids to reap ALONGSIDE the tree — reparented strays that `ppid` can no longer reach (see
   *  `laneStrays`). Their groups are signalled together with the tree's in the SAME pass, so a
   *  lane close still costs one grace period rather than two. */
  alsoReap?: ReadonlySet<number>
}

/** TERM the tree, wait out the grace period, KILL what is left.
 *
 *  `rows` is passed in rather than taken here so that `killAll` can reap every lane from ONE
 *  snapshot: the whole point of the design is one `ps` per kill event, not one per lane.
 *
 *  Survivors are re-checked with `kill(pid, 0)` against the ORIGINAL pid set rather than with a
 *  second `ps`. It is the same answer for a fraction of the cost, and it cannot accidentally
 *  widen the blast radius to a pid that appeared after the snapshot. */
export async function reapTree(rootPid: number, rows: PsRow[], opts: ReapOptions = {}): Promise<ReapResult> {
  const selfPid = opts.selfPid ?? process.pid
  const selfPgid = selfPgidFrom(rows, selfPid)
  const found = descendantsOf(rows, rootPid)
  // The strays join the tree BEFORE the groups are collected, so one `pgidsFor` pass covers
  // both and a stray sharing a group with the tree is signalled once, not twice.
  for (const pid of opts.alsoReap ?? []) if (pid > 1) found.add(pid)
  const pgids = pgidsFor(rows, found, selfPgid)
  const result: ReapResult = { found: [...found].sort((a, b) => a - b), pgids, escalated: [] }
  if (!found.size && !Number.isInteger(rootPid)) return result

  // The groups first, then the shell by pid. The shell's own group is normally among them, but
  // a pty whose child re-grouped and then exited can leave the shell outside every collected
  // group, and it is the one pid we are certain about.
  for (const pgid of pgids) signal(-pgid, 'SIGTERM')
  if (rootPid > 1) signal(rootPid, 'SIGTERM')

  const deadline = Date.now() + GRACE_MS
  let survivors = [...found]
  while (survivors.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    survivors = survivors.filter(isPidAlive)
  }
  if (!survivors.length) return result

  result.escalated = survivors
  // Escalate by GROUP, not by the individual survivors: a survivor is usually a supervisor that
  // will re-spawn its worker if we take them one at a time.
  const stubbornPgids = pgidsFor(rows, new Set(survivors), selfPgid)
  for (const pgid of stubbornPgids) signal(-pgid, 'SIGKILL')
  if (survivors.includes(rootPid)) signal(rootPid, 'SIGKILL')
  return result
}

// ── The next-launch sweep ────────────────────────────────────────────────────────────────────
//
// After a restart there is no live pty pid to walk down from, so the tree-walk above has no
// root. The way back to "this process belongs to a lane Operator started" is the env tag every
// lane is already spawned with (`OPERATOR_TERMINAL_ID`, set in terminals.ts and inherited by
// every descendant), read with `ps -E`. That form is expensive enough — it dumps every
// process's whole environment — that it is used ONLY here, once, at boot.

/** One row of `ps -eww -o pid,pgid,command -E`, with the env tags we care about pulled out.
 *  `command` is the argv AND the environment run together, which is exactly what `-E` prints. */
export interface TaggedRow {
  pid: number
  pgid: number
  command: string
  terminalId?: string
  devPort?: number
  /** pid of the Operator instance that spawned this lane. */
  appPid?: number
}

/** Read `KEY=value` out of a `ps -E` row.
 *
 *  Anchored on a word boundary so `OPERATOR_TERMINAL_ID` cannot be matched inside
 *  `NOT_OPERATOR_TERMINAL_ID`, and stopped at whitespace because that is how `ps` separates env
 *  entries — a value containing a space is not recoverable from this format at all, which is
 *  fine for the three numeric/opaque ids we read. */
export function envTag(row: string, key: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${key}=(\\S*)`).exec(row)
  return m ? m[1] : undefined
}

/** Parse `ps -eww -o pid,pgid,command -E`, keeping only rows carrying an Operator lane tag. */
export function parseTaggedTable(stdout: string): TaggedRow[] {
  const rows: TaggedRow[] = []
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const command = m[3]
    const terminalId = envTag(command, 'OPERATOR_TERMINAL_ID')
    if (!terminalId) continue
    const port = envTag(command, 'OPERATOR_DEV_PORT')
    const appPid = envTag(command, 'OPERATOR_APP_PID')
    rows.push({
      pid: Number(m[1]),
      pgid: Number(m[2]),
      command,
      terminalId,
      devPort: port && /^\d+$/.test(port) ? Number(port) : undefined,
      appPid: appPid && /^\d+$/.test(appPid) ? Number(appPid) : undefined,
    })
  }
  return rows
}

/** Which tagged survivors are safe to reap.
 *
 *  THE ENV TAG ALONE IS NOT EVIDENCE OF AN ORPHAN, and a live sweep of this machine is what
 *  settled it. `OPERATOR_TERMINAL_ID` is inherited by EVERYTHING a lane ever starts, including
 *  things that are emphatically not dev servers and not dead:
 *
 *    93190 93190 /Applications/Operator.app/Contents/MacOS/Operator   OPERATOR_TERMINAL_ID=t0
 *    93276 93276 claude                                               OPERATOR_TERMINAL_ID=t0
 *     9061  9061 postgres -D /opt/homebrew/var/postgresql@16 -p 5433  OPERATOR_TERMINAL_ID=t0
 *
 *  The first is the RUNNING OPERATOR (launched from a tagged shell, so it inherited the tag);
 *  `kill(-93190)` on it is the app killing itself at boot. The second is a live lane. The third
 *  is the user's database, which a lane happened to start months ago. A rule of "tagged and not
 *  obviously ours ⇒ reap" destroys all three.
 *
 *  So the rule is INVERTED from the obvious one: a row is a candidate only when it positively
 *  identifies its owner as a DEAD Operator. `OPERATOR_APP_PID` is that proof.
 *  - no app tag at all ⇒ SKIPPED. It predates this field, and there is no way to tell a live
 *    Operator's lane from a dead one's leavings. Refusing to guess is the whole point; the cost
 *    is that orphans created before this shipped are never auto-reaped, which is the right
 *    trade against killing a running app.
 *  - app tag naming a live pid ⇒ skipped. Someone owns it — a second instance, or us.
 *
 *  Candidacy is still not sufficient: `reapOrphanedDevServers` additionally requires a stale
 *  LEASE naming the same terminal and port, and requires that port to still be bound. This
 *  function is only the first of the three gates.
 *
 *  Pure, so the decision is testable without a process table. */
export function staleTaggedRows(
  rows: TaggedRow[],
  opts: { selfPid: number; isAppAlive: (pid: number) => boolean; liveTerminalIds?: ReadonlySet<string> },
): TaggedRow[] {
  return rows.filter((r) => {
    if (r.pid <= 1 || r.pgid <= 1) return false
    if (r.pid === opts.selfPid || r.pgid === opts.selfPid) return false
    if (r.appPid == null) return false // unprovable owner — see above
    if (r.appPid === opts.selfPid) return false // ours, right now
    if (opts.isAppAlive(r.appPid)) return false // another live Operator's
    if (r.terminalId && opts.liveTerminalIds?.has(r.terminalId)) return false
    return true
  })
}

// ── Strays the tree walk cannot reach ────────────────────────────────────────────────────────
//
// THE TREE WALK HAS A HOLE, and it is the one that produced the 24 orphans measured on this
// machine on 2026-08-29 (oldest 11 days; one had squatted port 1420 since Aug 20 and blocked a
// new lane from taking its own reservation). `reapTree` walks DOWN from the pty shell, which is
// complete only for processes still attached to it. A dev server the AGENT starts — `npm run
// dev &`, `nohup`, a backgrounded Bash tool call — outlives the intermediate shell that launched
// it, and at THAT moment, not at close time, it reparents to launchd. By the time the lane
// closes there is no longer any `ppid` path from the shell to it, so the walk cannot see it and
// the SIGTERM never arrives. One measured orphan, `ps -eww -E`:
//
//   29977  ppid=1  pgid=29958  OPERATOR_TERMINAL_ID=t0 OPERATOR_DEV_PORT=1420 OPERATOR_APP_PID=28793
//
// ppid 1 — and 28793 was the RUNNING Operator. So this is not a crash leftover that the boot
// sweep would eventually collect: it is a live app leaking while it is still up, which nothing
// in the lifecycle ever revisited. The env tag is the only handle that still points home. It
// rides on every descendant and SURVIVES reparenting, which is exactly what `ppid` does not.
//
// WHY `OPERATOR_APP_PID` IS NOT OPTIONAL HERE. Terminal ids are `t0`, `t1`, … from `nextId()`,
// assigned per app RUN — so `t0` in this run and `t0` from a run eleven days ago are the same
// string and a different lane. In the measured snapshot they were a different PROJECT as well
// (`operator` now, `mantel` then). Matching on the terminal id alone would make closing a lane
// here kill a stranger's server over there, which is the cross-project accident this must never
// cause. The app pid is what disambiguates the id, so a row that carries none is REFUSED rather
// than guessed at — the same inversion `staleTaggedRows` makes, for the same reason.
//
// The cost of that refusal is that the pre-tag orphans already on this machine are never reaped
// by a lifecycle close; they carry no app pid, so nothing can prove whose they are. Clearing
// those is a deliberate user action, not something to infer during a close.

/** What a lane stamps on everything it starts, as the reaper needs to match it. */
export interface LaneTag {
  terminalId: string
  /** The lane's reservation, when it has one. */
  devPort?: number
  /** THIS Operator's pid — `process.pid`. See the header for why it is required. */
  appPid: number
}

export interface StraySelection {
  /** Attributable to this lane, and not already reachable through the tree. */
  reap: TaggedRow[]
  /** Rows that named this lane's terminal id and were still refused, with the reason, so the
   *  close can say what it left alone and why. Only NEAR MISSES are collected: a row belonging
   *  to another lane is not evidence of anything, and logging every tagged process on the
   *  machine would bury the one line that matters. */
  refused: Array<{ pid: number; why: string }>
}

/** Why this row is not this lane's to kill, or `null` when it is. Ordered cheapest-first, and
 *  every branch returns a sentence rather than a boolean so the caller can log it verbatim. */
function refuseStray(r: TaggedRow, lane: LaneTag, selfPid: number, selfPgid?: number): string | null {
  if (r.pid <= 1 || r.pgid <= 1) return 'pid or pgid is launchd — never signallable'
  if (r.pid === selfPid || r.pgid === selfPgid) return 'that is Operator itself'
  if (r.appPid == null) return 'no OPERATOR_APP_PID — predates the tag, so its owner is unprovable'
  if (r.appPid !== lane.appPid) return `OPERATOR_APP_PID=${r.appPid} belongs to another Operator run`
  if (lane.devPort != null && r.devPort !== lane.devPort) {
    return `OPERATOR_DEV_PORT=${r.devPort ?? 'unset'} is not this lane's ${lane.devPort}`
  }
  return null
}

/** The tagged survivors this lane may reap, and the near misses it must not.
 *
 *  Pure over a `ps -E` sweep, so every branch of the attribution is exercised against a
 *  fabricated table rather than against whatever happens to be running — which matters more
 *  here than usual, because the failure mode of a wrong answer is killing someone else's
 *  server.
 *
 *  `treePids` are the pids `reapTree` will reach on its own; a row already in the tree is not a
 *  stray and is dropped silently rather than reported as refused. */
export function laneStrays(
  tagged: readonly TaggedRow[],
  lane: LaneTag,
  opts: { treePids: ReadonlySet<number>; selfPid: number; selfPgid?: number },
): StraySelection {
  const reap: TaggedRow[] = []
  const refused: Array<{ pid: number; why: string }> = []
  for (const r of tagged) {
    if (r.terminalId !== lane.terminalId) continue // another lane's, or not a lane's at all
    if (opts.treePids.has(r.pid)) continue // the tree walk already has it
    const why = refuseStray(r, lane, opts.selfPid, opts.selfPgid)
    if (why) refused.push({ pid: r.pid, why })
    else reap.push(r)
  }
  return { reap, refused }
}

/** A stray plus its own descendants.
 *
 *  A reparented `npm exec vite` still has its `node vite` and `esbuild` children under it, and
 *  those may have re-grouped since. Expanding here means `reapTree` collects THEIR groups too,
 *  from the same snapshot, instead of trusting that one group covers the family. */
export function expandStrays(rows: PsRow[], strays: readonly TaggedRow[]): Set<number> {
  const out = new Set<number>()
  for (const s of strays) {
    if (s.pid <= 1) continue
    out.add(s.pid)
    for (const d of descendantsOf(rows, s.pid)) out.add(d)
  }
  return out
}

/** One `ps -eww -o pid,pgid,command -E | grep OPERATOR_TERMINAL_ID=` sweep.
 *
 *  The `grep` runs in the pipeline rather than in JS on purpose: the unfiltered output is every
 *  process's entire environment on the machine, and it is worth not carrying that into this
 *  process's heap. `grep` exits 1 when nothing matches, which is the ordinary "no orphans" case
 *  and not an error. */
export async function sweepTagged(): Promise<TaggedRow[]> {
  try {
    const { stdout } = await run(
      '/bin/sh',
      ['-c', 'ps -eww -o pid,pgid,command -E | grep OPERATOR_TERMINAL_ID='],
      { maxBuffer: 32 * 1024 * 1024 },
    )
    return parseTaggedTable(stdout)
  } catch (e) {
    // grep's exit 1 = no matches. Anything else is a real failure and is reported, but still
    // yields "nothing to reap" — boot must not depend on this succeeding.
    const code = (e as { code?: unknown }).code
    if (code === 1) return []
    console.error('[reap] tagged sweep failed:', e)
    return []
  }
}

/** The boot reap: kill dev servers left behind by an Operator that is no longer running.
 *
 *  Called ONCE, before `TerminalManager` starts handing out ports again — reusing a port range
 *  that a previous run's orphan is still bound to is how "port already in use" becomes the
 *  user's problem instead of ours.
 *
 *  Two sources, cross-referenced, because each covers the other's blind spot:
 *  - the LEASE FILE says which ports a previous run claimed and never released, and survives the
 *    crash that stopped `kill()` from running at all;
 *  - the `ps -E` SWEEP says what is actually still alive, and finds it even if the lease file
 *    was lost, because the env tag rides on every descendant.
 *
 *  THREE GATES, ALL OF WHICH MUST PASS before anything is signalled. The env tag on its own is
 *  not evidence of an orphan — a live sweep of this machine found the running `Operator.app`
 *  itself, eleven live `claude` lanes, and a `postgres` database all carrying
 *  `OPERATOR_TERMINAL_ID`, because everything a lane ever starts inherits it:
 *
 *    1. the process must name a DEAD Operator in `OPERATOR_APP_PID` (`staleTaggedRows`);
 *    2. a stale LEASE must name that same terminal id and port — proof that this exact lane was
 *       never shut down cleanly, rather than that some lane once touched this process;
 *    3. the leased port must STILL BE HELD, by loopback connect. If nothing answers, there is
 *       nothing to free and we do not signal.
 *
 *  The cost of gate 1 is that orphans predating this build are never auto-reaped (they carry no
 *  app pid, so their owner is unprovable). That is the correct trade: the alternative rule kills
 *  a running app.
 *
 *  Never throws. Boot does not depend on this working. */
export async function reapOrphanedDevServers(loadSessionsFn: () => Promise<unknown[]>): Promise<number> {
  try {
    const { loadLeases, staleLeases, releaseLeasesOf } = await import('./leases')
    const [leases, tagged, sessions] = await Promise.all([loadLeases(), sweepTagged(), loadSessionsFn()])
    if (!leases.length && !tagged.length) return 0

    // WHAT IS STILL LIVE, from the two records read together.
    //
    // A tagged survivor whose `OPERATOR_APP_PID` is still running belongs to an Operator that is
    // open right now — a second instance, or (if this is ever called outside boot) this one. Its
    // terminal ids are live, and `sessions.json` maps those back to session uuids, which is the
    // key the lease file is filed under. That join is what lets a lease be spared on the
    // strength of the ROSTER rather than only on the strength of its own `appPid` field — which
    // matters for a lease written by a build that predates that field.
    const liveTerminalIds = new Set<string>()
    for (const r of tagged) {
      if (r.terminalId && r.appPid != null && isPidAlive(r.appPid)) liveTerminalIds.add(r.terminalId)
    }
    const liveSessionIds = new Set<string>()
    for (const raw of sessions) {
      const s = raw as { id?: unknown; terminalId?: unknown }
      if (typeof s?.id === 'string' && typeof s.terminalId === 'string' && liveTerminalIds.has(s.terminalId)) {
        liveSessionIds.add(s.id)
      }
    }

    const stale = staleLeases(leases, { selfPid: process.pid, isAppAlive: isPidAlive, liveSessionIds })
    const staleRows = staleTaggedRows(tagged, { selfPid: process.pid, isAppAlive: isPidAlive, liveTerminalIds })
    if (!stale.length) return 0

    // GATE 3 — the leased port must still be HELD. A lease whose port answers nothing has
    // nothing left to free, and signalling on the strength of the env tag alone is how a lane's
    // long-lived side-effects get killed: the live sweep that informed this design found a
    // `postgres -p 5433` carrying `OPERATOR_TERMINAL_ID` because a lane started it once. It is
    // not a dev server, it is not on the leased port, and it is not ours to end.
    //
    // A loopback connect, never `lsof` — see `port-probe.ts`.
    const held = (await Promise.all(stale.map(async (l) => (await isPortLive(l.devPort)) ? l : null)))
      .filter((l): l is NonNullable<typeof l> => l != null)

    // GATE 2 — a tagged survivor is only reaped when a STILL-HELD stale lease names its terminal
    // AND its port. The env tag says "some lane started this once"; the lease says "this exact
    // lane, on this exact port, was never shut down cleanly". Only the second is grounds to act.
    const claimed = new Map<string, number>() // terminalId → port
    for (const l of held) claimed.set(l.terminalId, l.devPort)
    const doomed = staleRows.filter((r) => r.terminalId != null && r.devPort != null
      && claimed.get(r.terminalId) === r.devPort)

    // The tree-walk has no root after a restart (the shell died first — that is what orphaned
    // these), so the surviving PROCESS GROUP is the handle, exactly as it is at kill time.
    const rows = doomed.length ? await snapshotPs() : []
    const selfPgid = selfPgidFrom(rows, process.pid)
    const pgids = new Set<number>()
    const pids = new Set<number>()
    for (const r of doomed) {
      if (r.pgid <= 1 || r.pgid === selfPgid) continue
      pgids.add(r.pgid)
      pids.add(r.pid)
      // A survivor's own descendants may have been re-parented into other groups.
      for (const d of descendantsOf(rows, r.pid)) {
        pids.add(d)
        const pg = rows.find((x) => x.pid === d)?.pgid
        if (pg != null && pg > 1 && pg !== selfPgid) pgids.add(pg)
      }
    }

    if (pgids.size) {
      const ports = [...new Set(held.map((l) => l.devPort))].sort((a, b) => a - b)
      console.error(`[reap] boot: ${pids.size} orphaned process(es) in ${pgids.size} group(s), ports ${ports.join(', ')}`)
      for (const pgid of pgids) signal(-pgid, 'SIGTERM')
      const deadline = Date.now() + GRACE_MS
      let survivors = [...pids]
      while (survivors.length && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_MS))
        survivors = survivors.filter(isPidAlive)
      }
      if (survivors.length) {
        for (const pgid of pgidsFor(rows, new Set(survivors), selfPgid)) signal(-pgid, 'SIGKILL')
      }
    }

    // The claims are settled either way: a stale lease whose process was already gone is just as
    // finished as one we had to signal, and leaving it would have every future boot re-hunt it.
    for (const appPid of new Set(stale.map((l) => l.appPid))) await releaseLeasesOf(appPid)
    return pids.size
  } catch (e) {
    console.error('[reap] boot sweep failed:', e)
    return 0
  }
}
