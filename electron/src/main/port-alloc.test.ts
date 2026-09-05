import { describe, it, expect } from 'vitest'
import { createServer, type Server } from 'node:net'
import { allocatePort, shouldReleaseCwdPort, PORT_BASE, type PortAllocDeps } from './port-alloc'
import { isPortFree } from './port-probe'

/** Deps that say yes to everything — each test overrides only the probe it is about, so the
 *  thing under test in every case is one rule and not a whole fixture. */
function deps(over: Partial<PortAllocDeps> = {}): PortAllocDeps {
  return {
    isFree: async () => true,
    leased: async () => new Set<number>(),
    sharedHolderIsOurs: async () => true,
    ...over,
  }
}

describe('allocatePort — the ordinary case still holds', () => {
  it('hands out the base port to the first lane and records it', async () => {
    const map = new Map<string, number>()
    expect((await allocatePort('/a', map, deps())).port).toBe(PORT_BASE)
    expect(map.get('/a')).toBe(PORT_BASE)
  })

  it('gives a second cwd a different port', async () => {
    const map = new Map<string, number>()
    await allocatePort('/a', map, deps())
    expect((await allocatePort('/b', map, deps())).port).toBe(PORT_BASE + 1)
  })

  it('SHARES a cwd port with a sibling lane — the rule that survives the fix', async () => {
    const map = new Map<string, number>()
    const first = await allocatePort('/a', map, deps())
    // Nothing is serving yet: the sibling has not started its dev server, which is precisely
    // what keying by cwd is for.
    const second = await allocatePort('/a', map, deps({ isFree: async () => true }))
    expect(second.port).toBe(first.port)
    expect(second.displaced).toBeUndefined()
  })

  it('shares a cwd port whose server IS ours, even though the port is bound', async () => {
    const map = new Map<string, number>([['/a', PORT_BASE]])
    const r = await allocatePort('/a', map, deps({
      isFree: async () => false,
      sharedHolderIsOurs: async () => true,
    }))
    expect(r.port).toBe(PORT_BASE)
    expect(r.displaced).toBeUndefined()
  })
})

// The three failures the fix exists for. Each one used to hand out an occupied port.
describe('allocatePort — skipping a port somebody else holds', () => {
  it('SKIPS A BOUND PORT — the 2026-09-05 failure, where a stranger held the reservation', async () => {
    const map = new Map<string, number>()
    const bound = new Set([PORT_BASE, PORT_BASE + 1])
    const r = await allocatePort('/a', map, deps({ isFree: async (p) => !bound.has(p) }))
    expect(r.port).toBe(PORT_BASE + 2)
  })

  it('SKIPS A FOREIGN LEASE — another Operator instance, or an orphan not yet reaped', async () => {
    const map = new Map<string, number>()
    // A leased port can be entirely unbound: the lane holds the reservation but its server has
    // not started, or died and will be restarted. A bind-check alone would hand it away.
    const r = await allocatePort('/a', map, deps({
      leased: async () => new Set([PORT_BASE, PORT_BASE + 1]),
      isFree: async () => true,
    }))
    expect(r.port).toBe(PORT_BASE + 2)
  })

  it('RE-ALLOCATES when the shared holder is a STRANGER, and reports what it walked away from', async () => {
    const map = new Map<string, number>([['/a', PORT_BASE]])
    const r = await allocatePort('/a', map, deps({
      isFree: async (p) => p !== PORT_BASE, // the reservation is bound…
      sharedHolderIsOurs: async () => false, // …and not by us
    }))
    expect(r.port).toBe(PORT_BASE + 1)
    expect(r.displaced).toBe(PORT_BASE)
    // The cwd now points at the NEW port, so the next lane here joins that one rather than
    // re-deciding this against the same stranger.
    expect(map.get('/a')).toBe(PORT_BASE + 1)
  })

  it('never re-picks the port it walked away from, even once that port reads as free', async () => {
    const map = new Map<string, number>([['/a', PORT_BASE]])
    // The stranger exits between the two checks, so the displaced port answers "free" by the
    // time the scan reaches it. Handing it straight back would put this lane on a port a
    // stranger has just proved it wants — and would make `displaced` a lie.
    let asked = 0
    const r = await allocatePort('/a', map, deps({
      isFree: async () => asked++ > 0,
      sharedHolderIsOurs: async () => false,
    }))
    expect(r.port).toBe(PORT_BASE + 1)
    expect(r.displaced).toBe(PORT_BASE)
  })

  it('keeps the old reservation when re-allocation finds nothing — failing must not strip it', async () => {
    const map = new Map<string, number>([['/a', PORT_BASE]])
    const r = await allocatePort('/a', map, deps({
      isFree: async () => false,
      sharedHolderIsOurs: async () => false,
    }))
    expect(r.port).toBeUndefined()
    expect(map.get('/a')).toBe(PORT_BASE)
  })

  it('combines all three exclusions rather than letting one mask another', async () => {
    const map = new Map<string, number>([['/other', PORT_BASE + 1]])
    const r = await allocatePort('/a', map, deps({
      isFree: async (p) => p !== PORT_BASE,               // bound
      leased: async () => new Set([PORT_BASE + 2]),       // leased elsewhere
    }))
    // BASE taken by a bind, +1 by this process's own map, +2 by a lease.
    expect(r.port).toBe(PORT_BASE + 3)
  })

  it('answers undefined when the whole window is spoken for, so the lane still launches', async () => {
    const map = new Map<string, number>()
    const r = await allocatePort('/a', map, deps({ isFree: async () => false }))
    expect(r.port).toBeUndefined()
    expect(map.has('/a')).toBe(false)
  })
})

// `isPortFree` is the one dep that touches the network stack, so it gets a real socket rather
// than a stub — a bind-check that is wrong about a genuinely held port is the whole bug.
describe('isPortFree against a real listener', () => {
  const listen = (host: string, port: number) => new Promise<Server>((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen({ port, host, exclusive: true }, () => resolve(srv))
  })
  const close = (srv: Server) => new Promise<void>((resolve) => srv.close(() => resolve()))

  /** A port nothing else on the machine is using, chosen by binding :0 and giving it back. */
  const freePort = async (): Promise<number> => {
    const srv = await listen('127.0.0.1', 0)
    const port = (srv.address() as { port: number }).port
    await close(srv)
    return port
  }

  it('says free when nothing holds the port', async () => {
    expect(await isPortFree(await freePort())).toBe(true)
  })

  it('says BUSY while a real server holds it, and free again once it closes', async () => {
    const port = await freePort()
    const srv = await listen('127.0.0.1', port)
    try {
      expect(await isPortFree(port)).toBe(false)
    } finally {
      await close(srv)
    }
    expect(await isPortFree(port)).toBe(true)
  })

  it('says busy for a v6-ONLY listener — the case a v4 probe reads as free', async () => {
    // The bug recorded in lib.rs's `port_free`: an orphan holding only [::1] leaves the v4 bind
    // succeeding, Operator calls the port free, and the Preview (which resolves localhost to
    // [::1]) then loads the orphan's server.
    const port = await freePort()
    let srv: Server
    try {
      srv = await listen('::1', port)
    } catch {
      return // no IPv6 loopback on this machine; the assertion would be about the host, not us
    }
    try {
      expect(await isPortFree(port)).toBe(false)
    } finally {
      await close(srv)
    }
  })
})

// The one hazard the async rewrite introduced. The old scan was synchronous, so pick-and-record
// could not interleave; now there are awaits between them.
describe('concurrent allocation', () => {
  it('gives two simultaneous lanes two different ports when serialized', async () => {
    const map = new Map<string, number>()
    // Serialized the way TerminalManager.allocPort does it — the second waits for the first to
    // have written its reservation.
    const a = await allocatePort('/a', map, deps())
    const b = await allocatePort('/b', map, deps())
    expect(a.port).not.toBe(b.port)
  })

  it('WOULD collide unserialized — the reason the gate exists, pinned so nobody removes it', async () => {
    const map = new Map<string, number>()
    // A slow probe widens the window that the real one (a bind syscall pair) also has.
    const slow = deps({ isFree: async () => { await new Promise((r) => setTimeout(r, 5)); return true } })
    const [a, b] = await Promise.all([
      allocatePort('/a', map, slow),
      allocatePort('/b', map, slow),
    ])
    expect(a.port).toBe(b.port)
  })
})

// THE DOUBLE-ALLOCATION, measured on the dev machine 2026-09-05: lanes t8 (uwazi) and t25
// (operator) both alive, both spawned by the same Operator, both carrying OPERATOR_DEV_PORT=1425,
// with t8's vite actually serving it. Same-cwd sharing gives N lanes one port; releasing it when
// the FIRST of them closes is what let the next scan hand a live server's port to another project.
describe('shouldReleaseCwdPort', () => {
  it('releases when the closing lane was the last holder', () => {
    expect(shouldReleaseCwdPort([], '/a', 1425)).toBe(true)
  })

  it('KEEPS the reservation while a sibling in the same cwd still holds it', () => {
    expect(shouldReleaseCwdPort([{ cwd: '/a', devPort: 1425 }], '/a', 1425)).toBe(false)
  })

  it('ignores a sibling that has already exited', () => {
    expect(shouldReleaseCwdPort([{ cwd: '/a', devPort: 1425, exited: true }], '/a', 1425)).toBe(true)
  })

  it('ignores a lane in a different cwd that happens to hold the same number', () => {
    // If this ever happens the allocator has already failed; the release must not paper over it
    // by pinning another directory's reservation.
    expect(shouldReleaseCwdPort([{ cwd: '/b', devPort: 1425 }], '/a', 1425)).toBe(true)
  })

  it('ignores a sibling in the same cwd holding a different port', () => {
    expect(shouldReleaseCwdPort([{ cwd: '/a', devPort: 1499 }], '/a', 1425)).toBe(true)
  })

  it('releases nothing when the lane never had a reservation', () => {
    expect(shouldReleaseCwdPort([], '/a', undefined)).toBe(false)
  })
})
