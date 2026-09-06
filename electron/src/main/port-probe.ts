// "Is anything listening on this loopback port?" — asked by a plain TCP connect, never by lsof.
//
// Extracted because two callers now need the same answer and it must stay the SAME answer:
// `sessionPorts` (which ports a lane is serving) and the boot reaper (is a leased port still
// held, and therefore worth signalling for). A second copy that probed only one loopback would
// disagree with this one on exactly the machines the v6 note below is about.
//
// This is the TCC-safe way to ask. `lsof -i :PORT` inspects another process's open file
// descriptors, which is the specific thing macOS gates behind an "access data from other apps"
// prompt; a connect() to a port opens a socket of our own and asks the kernel nothing about
// anyone else.

/** Is something listening on this loopback port?
 *
 *  BOTH loopbacks are probed. Vite (via Node's localhost resolution) binds [::1] ONLY on some
 *  machines, so a v4-only probe reads a live server as down — and the caller then starts a
 *  second one on the v4 side of the same port. */
export async function isPortLive(port: number): Promise<boolean> {
  const { createConnection } = await import('node:net')
  const probe = (host: string) => new Promise<boolean>((resolve) => {
    const sock = createConnection({ port, host })
    const done = (v: boolean) => { sock.destroy(); resolve(v) }
    sock.setTimeout(250)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
  return (await probe('127.0.0.1')) || (await probe('::1'))
}

/** Can WE bind this port, on both loopbacks?
 *
 *  The other half of the pair, and not the same question as `isPortLive`. A connect() answers
 *  "is something accepting connections here"; a bind() answers "could I take this port", which is
 *  what an allocator has to know. They disagree in the case that matters: a socket bound and
 *  listening with no accept loop, or bound to one loopback only, answers no to a connect on the
 *  other while still making the port unusable.
 *
 *  BOTH families, mirroring `port_free` in lib.rs, and for the reason recorded there: an orphan
 *  holding only `[::1]` leaves the v4 bind succeeding, Operator calls the port free, and the
 *  Preview — which resolves `localhost` to `[::1]` — then loads the orphan's server. IPv6
 *  loopback is always present on macOS, this app's only target, so a failure there is a busy
 *  port and not a missing stack.
 *
 *  Each listener is closed immediately. The window between this returning true and the lane's
 *  own server binding is real and unavoidable — the same race the Rust side has always had — but
 *  it is milliseconds against a port that has been held for days, which is the actual failure. */
export async function isPortFree(port: number): Promise<boolean> {
  const { createServer } = await import('node:net')
  const canBind = (host: string) => new Promise<boolean>((resolve) => {
    const srv = createServer()
    // A failed listen never bound, so there is nothing to close — `close()` on a server that is
    // not running emits its own error and would take the answer with it.
    srv.once('error', () => resolve(false))
    // `exclusive` so this cannot succeed by SHARING the port with a listener in another process
    // via SO_REUSEPORT, which would report an occupied port as free.
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)))
  })
  const v4 = await canBind('127.0.0.1')
  if (!v4) return false
  const v6 = await canBind('::1')
  if (v6) { v6Failures = 0; return true }
  // THE v6 BIND FAILED WHILE v4 SUCCEEDED. Usually that means an orphan holds `[::1]` only, which
  // is the case this pair exists to catch, and refusing the port is right.
  //
  // But if IPv6 loopback is unavailable ENTIRELY — a machine with it disabled, a container — then
  // every port in the window fails this check, `allocatePort` scans 1420..1520 and returns
  // undefined, and every lane launches with no dev port at all. Silently. So the allocator tells
  // us when a whole scan came back empty and we say why once, then fall back to the v4 answer:
  // a port that is v4-free on a host with no v6 is free.
  v6Failures += 1
  return false
}

/** How many v6 binds have failed since the last successful one. Read by `noteEmptyScan`, which
 *  is the only thing that can tell "one orphan holds [::1]" from "this host has no v6 at all". */
let v6Failures = 0
let v6WarningShown = false

/** Called when a whole port scan came back empty. Distinguishes the two causes and, for the
 *  second, re-probes on v4 alone so a host without IPv6 still gets dev ports.
 *
 *  Separate from `isPortFree` because a single port cannot tell the difference: one refusal is
 *  evidence of an orphan, a hundred consecutive refusals is evidence about the host. */
export async function retryScanWithoutV6(ports: readonly number[]): Promise<number | undefined> {
  if (v6Failures < ports.length || !ports.length) return undefined
  if (!v6WarningShown) {
    v6WarningShown = true
    console.error(
      '[ports] every port in the window failed its ::1 bind while 127.0.0.1 succeeded — '
      + 'IPv6 loopback looks unavailable on this host, so dev ports are being allocated on v4 alone',
    )
  }
  const { createServer } = await import('node:net')
  for (const port of ports) {
    const free = await new Promise<boolean>((resolve) => {
      const srv = createServer()
      srv.once('error', () => resolve(false))
      srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => srv.close(() => resolve(true)))
    })
    if (free) return port
  }
  return undefined
}

/** Reset the v6 tally — a successful v6 bind means the host has it after all. */
export function noteV6Success(): void { v6Failures = 0 }
