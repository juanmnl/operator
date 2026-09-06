// HANDING OUT A DEV PORT THAT IS ACTUALLY FREE.
//
// The failure this exists for (2026-09-05): Operator reserved 1425 for the operator lane and told
// it so in the system prompt, while pid 93480 — `vite --port 1425 --strictPort` from an unrelated
// project — already held it. The old `allocPort` scanned 1420..1520 and skipped only the ports in
// its OWN in-process `portsByCwd` map, so it could not see:
//
//   - a server started by anything that is not this Operator (the case above),
//   - a lease held by a second Operator instance running right now,
//   - an orphan from a previous run that the boot sweep has not reaped yet.
//
// The lane's startup rule made that worse rather than better. It read "if the port already
// answers, another lane serves the same code — use it", so the lane attached to the stranger's
// server and reported it as its own app. A reservation nobody verified plus a rule that trusts
// the reservation is how you get a preview of someone else's project.
//
// THREE CHECKS, in increasing cost, and the order matters because the cheap ones are exact:
//
//   1. `portsByCwd`   this process's own map. A local lookup.
//   2. `leased()`     `dev-leases.json` — every claim any Operator instance has written and not
//                     released. Covers the two cases a live bind-check cannot: a lease whose
//                     server has not started yet, and one whose server died but whose lane is
//                     still alive and will restart it.
//   3. `isFree()`     a real bind on BOTH loopbacks, mirroring `port_free` in lib.rs. The only
//                     check that sees a process nothing in Operator has ever heard of.
//
// Nothing here calls `lsof`. Per-pid `lsof` fires a macOS TCC prompt per inspected process and is
// forbidden in this codebase; a bind of our own asks the kernel about a socket we are opening,
// not about anyone else's file descriptors.

/** The port window, unchanged: the same 1420..1520 the Rust side scans. */
export const PORT_BASE = 1420
export const PORT_MAX = 1520

export interface PortAllocDeps {
  /** Can we bind this port on both loopbacks right now? False = somebody holds it. */
  isFree(port: number): Promise<boolean>
  /** Every port claimed by a lease — this instance's and any other's, including leases whose
   *  process is already an unreaped orphan. */
  leased(): Promise<ReadonlySet<number>>
  /** For a cwd that already has a reservation: is whatever currently holds that port provably a
   *  server one of OUR lanes started? Only asked when the port is bound — an unbound shared port
   *  is a sibling that has not started its server yet, which is the case sharing exists for. */
  sharedHolderIsOurs(port: number): Promise<boolean>
  /** Called when the whole window scanned empty, with the ports that were considered. Its job is
   *  to say whether that was a real exhaustion or an IPv6-less host failing every `::1` bind —
   *  see `retryScanWithoutV6`. Optional. */
  onEmptyScan?(ports: readonly number[]): Promise<number | undefined>
}

export interface PortAllocResult {
  port?: number
  /** Why the shared reservation was not reused, when it was not. Logged, not shown. */
  displaced?: number
  /** True when the port came from a sibling lane's existing reservation rather than a fresh
   *  scan. The system-prompt hint MUST NOT claim "verified free at launch" for one of these —
   *  see `buildCommand`. */
  shared?: boolean
}

/** Pick a dev port for a lane in `cwd`, and record it in `portsByCwd`.
 *
 *  SAME-CWD SHARING SURVIVES, because the reason for it is still true: two lanes on identical
 *  code serve the identical app, and a second dev server on a second port is a redundant build,
 *  not an isolation win. What changes is that sharing now requires the sharer to be ours. If the
 *  cwd's port has been taken over by a stranger since it was handed out, the new lane gets a
 *  fresh port instead of being pointed at somebody else's server — and the stale entry is
 *  replaced, so the next lane in that cwd joins the new one rather than re-deciding this.
 *
 *  Returns `undefined` when the whole window is spoken for, exactly as before: a lane with no
 *  dev port still launches, it just gets no reservation and no promise in its system prompt. */
export async function allocatePort(
  cwd: string,
  portsByCwd: Map<string, number>,
  deps: PortAllocDeps,
): Promise<PortAllocResult> {
  const shared = portsByCwd.get(cwd)
  if (shared !== undefined) {
    // Free means no server yet — the sibling lane is still starting, and joining it is the whole
    // point of keying by cwd. Bound means somebody is serving, and the only question worth
    // asking is whether that somebody is us.
    // Unbound means no server yet — the sibling is still starting, which is the case sharing
    // exists for. Bound means somebody is serving, and the only question worth asking is whether
    // that somebody is provably us. `sharedHolderIsOurs` fails closed; see `provesOwnServer`.
    if (await deps.isFree(shared) || await deps.sharedHolderIsOurs(shared)) {
      return { port: shared, shared: true }
    }
    // The scan cannot hand `shared` back: `portsByCwd` is NOT edited before it runs, so the
    // stale reservation is still one of its values and `taken` excludes it. Left in deliberately
    // rather than deleted-then-rescanned — a scan that finds nothing must leave the cwd holding
    // the port it had, not strip it as a side effect of failing.
    const fresh = await scan(portsByCwd, deps)
    if (fresh !== undefined) portsByCwd.set(cwd, fresh)
    return { port: fresh, displaced: shared }
  }

  const port = await scan(portsByCwd, deps)
  // A WHOLE SCAN CAME BACK EMPTY. Either the window really is full, or every `::1` bind failed
  // because this host has no IPv6 loopback — and the second is silent and total: every lane
  // launches with no dev port. `onEmptyScan` tells the two apart and, for the second, answers
  // with a v4-only probe. Absent (tests, and the Tauri stub) it stays undefined and the caller
  // behaves exactly as before.
  if (port === undefined && deps.onEmptyScan) {
    const fallback = await deps.onEmptyScan(windowPorts(portsByCwd))
    if (fallback !== undefined) {
      portsByCwd.set(cwd, fallback)
      return { port: fallback }
    }
  }
  if (port !== undefined) portsByCwd.set(cwd, port)
  return { port }
}

/** The candidates a scan would have considered — the window minus what this process already
 *  holds. Handed to `onEmptyScan` so the retry covers the same set. */
function windowPorts(portsByCwd: Map<string, number>): number[] {
  const taken = new Set(portsByCwd.values())
  const out: number[] = []
  for (let p = PORT_BASE; p <= PORT_MAX; p++) if (!taken.has(p)) out.push(p)
  return out
}

/** The window scan: the first port this process has not reserved, no lease claims, and nothing
 *  is bound to. */
async function scan(portsByCwd: Map<string, number>, deps: PortAllocDeps): Promise<number | undefined> {
  const taken = new Set(portsByCwd.values())
  // ONE read of the lease file for the whole scan, not one per candidate: this runs on the spawn
  // path, and re-reading a JSON file a hundred times is a visible pause before a lane appears.
  const leased = await deps.leased()
  for (let p = PORT_BASE; p <= PORT_MAX; p++) {
    if (taken.has(p) || leased.has(p)) continue
    // LAST, because it is the only check that costs a syscall pair. The two above have already
    // removed every port we know about, so in the ordinary case this binds once and succeeds.
    if (await deps.isFree(p)) return p
  }
  return undefined
}

/** Should the cwd's reservation be dropped when this lane closes?
 *
 *  THE DOUBLE-ALLOCATION BUG, measured 2026-09-05: lane t8 (`…/huridocs/uwazi_app/app`) and lane
 *  t25 (the operator checkout) were both alive, both spawned by the same Operator, and both
 *  carrying `OPERATOR_DEV_PORT=1425` — with t8's vite actually serving it. The lane that was told
 *  the port was reserved for it attached to another project's server.
 *
 *  The cause is here rather than in the scan. Same-cwd sharing hands ONE port to every lane in a
 *  directory, so the reservation is shared by N lanes while the map that records it has room for
 *  one entry and no notion of how many hold it. Close released it unconditionally, so the FIRST
 *  lane out of a shared directory dropped the entry while its siblings kept serving — and the
 *  next scan, seeing that port in neither `portsByCwd` nor any lease it recognised, handed it to
 *  a lane in a different project.
 *
 *  So: release only when nobody is left holding it. `stillOpen` is every OTHER live lane; the
 *  closing lane must already be out of the set, because a lane never keeps its own reservation
 *  alive. The bind-check in `allocatePort` would now catch the symptom, but a reservation map
 *  that lies is worth fixing at the source — the check is a backstop, not a bookkeeping system. */
export function shouldReleaseCwdPort(
  stillOpen: ReadonlyArray<{ cwd: string; devPort?: number; exited?: boolean }>,
  cwd: string,
  devPort: number | undefined,
): boolean {
  if (devPort == null) return false
  return !stillOpen.some((o) => !o.exited && o.cwd === cwd && o.devPort === devPort)
}

// ── Does a sibling lane actually serve this port? ────────────────────────────────────────────
//
// THE PREDICATE THIS REPLACES DID NOT PROVE WHAT IT CLAIMED. It asked `claimantsByPort` for the
// processes carrying `OPERATOR_DEV_PORT=<port>` and intersected them with the sibling's deep
// pids — but that variable is set on the PTY, so every descendant inherits it, and `ownDeepPids`
// removes only the shell and its direct children. The `--mcp-serve` helper, every subagent and
// every process a Bash call starts sit at depth >= 2 and satisfy both halves. The question it
// actually answered was "does the sibling have any grandchild", and it never inspected the port.
//
// Which re-created the exact bug this branch exists to fix: a lane mid-build has grandchildren, a
// stranger takes its reservation, and the next lane in that directory is handed the stranger's
// port with a system prompt asserting the port was verified.
//
// So it FAILS CLOSED now. Sharing a bound port needs proof-positive, and proof is two facts that
// a grandchild cannot fake:
//
//   1. a process in the sibling's subtree at depth >= 2 whose command is not the mcp helper,
//      not `claude`, and not a bare shell — i.e. something the lane actually started; and
//   2. a lease naming that lane and that port, which is written at spawn and released on a clean
//      kill, so it says the reservation is still live rather than merely once-issued.
//
// Neither alone is enough. (1) without (2) is the old bug with extra steps; (2) without (1) is a
// reservation with nothing running behind it.

/** Commands that inherit the tag and are never a dev server. `--mcp-serve` is Operator's own
 *  artifact helper riding on every lane; `claude` is the lane itself; a bare login shell is the
 *  pty. All three sit at depth >= 2 and all three fooled the old predicate. */
const NOT_A_LANE_SERVER = /--mcp-serve|Operator Helper|\bclaude\b\s+--settings|^-?(?:\/bin\/)?(?:ba|z|fi|c)?sh\b|\/(?:ba|z|fi|c)?sh\s+-[il]/

/** Operator's own binaries and helpers. Refused by every automatic path REGARDLESS of tags:
 *  they carry the full tag set on every lane, and a sweep that kills them kills the app. */
export const OPERATOR_BINARY_RE = /Operator\.app|Operator Helper|--mcp-serve|\belectron\b/i

/** Anything that looks like a dev server, for the automatic paths that may only act on one. */
export const DEV_SERVER_RE = /\b(vite|next(?:-server)?|astro|webpack(?:-dev-server)?|nuxt|remix|parcel|rollup|tsx\s+watch|nodemon|serve|http-server)\b/

export interface OwnServerEvidence {
  /** `ps` rows, for the ppid walk and the command test. */
  ps: ReadonlyArray<{ pid: number; ppid: number; command: string }>
  /** The sibling lane's pty pid — the root of the walk. */
  shellPid?: number
  /** Ports this app currently holds a lease on, by terminal id. */
  leasedPorts: ReadonlySet<number>
  /** How many live lanes hold this same reservation. More than one and the signal cannot tell
   *  them apart — the same ambiguity `attributePort` reports as `shared`. */
  reservationHolders: number
}

/** Proof-positive that a sibling lane is serving this port, or false.
 *
 *  Pure over a `ps` table so every branch is exercised against a fabricated tree rather than
 *  whatever happens to be running — which matters more here than usual, because a wrong `true`
 *  hands one project's lane another project's server. */
export function provesOwnServer(port: number, ev: OwnServerEvidence): boolean {
  // AMBIGUOUS IS NOT YES. Two lanes in one cwd share the reservation by design, so the evidence
  // cannot say which of them is serving — and "we are not sure" must lose to nothing.
  if (ev.reservationHolders > 1) return false
  if (!ev.shellPid) return false
  if (!ev.leasedPorts.has(port)) return false

  // Depth >= 2 from the pty: the shell is depth 0, `claude` is depth 1, and anything the LANE
  // started is deeper. Walk rather than trust a flat descendant set, so depth is real.
  const kids = new Map<number, Array<{ pid: number; ppid: number; command: string }>>()
  for (const r of ev.ps) {
    const list = kids.get(r.ppid)
    if (list) list.push(r)
    else kids.set(r.ppid, [r])
  }
  let frontier = [ev.shellPid]
  const seen = new Set<number>(frontier)
  for (let depth = 1; depth <= 12 && frontier.length; depth++) {
    const next: number[] = []
    for (const pid of frontier) {
      for (const kid of kids.get(pid) ?? []) {
        if (kid.pid <= 1 || seen.has(kid.pid)) continue
        seen.add(kid.pid)
        next.push(kid.pid)
        if (depth >= 2 && !NOT_A_LANE_SERVER.test(kid.command)) return true
      }
    }
    frontier = next
  }
  return false
}
