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
}

export interface PortAllocResult {
  port?: number
  /** Why the shared reservation was not reused, when it was not. Logged, not shown. */
  displaced?: number
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
    if (await deps.isFree(shared) || await deps.sharedHolderIsOurs(shared)) {
      return { port: shared }
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
  if (port !== undefined) portsByCwd.set(cwd, port)
  return { port }
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
