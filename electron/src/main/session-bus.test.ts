import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'operator-bus-'))
process.env.HOME = SANDBOX
const { parseBusSession, readBusSessions, addressOf, preferSession, pidAlive } = await import('./session-bus')
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

const DIR = join(SANDBOX, '.claude', 'sessions')
mkdirSync(DIR, { recursive: true })

// A LIVE pid and a socket path that EXISTS, both inside the sandbox.
//
// `readBusSessions` now drops a descriptor whose process is gone or whose socket is missing, and
// the original fixture used pid 19287 with `/tmp/cc-socks/19287.sock` — transcribed from a real
// machine. It passed here for the worst reason available: that pid really was alive on the
// machine the fixture was written on. On any other machine, and in CI, it would have failed.
const LIVE_PID = process.pid
const SOCK_A = join(SANDBOX, 'a.sock')
const SOCK_B = join(SANDBOX, 'b.sock')
writeFileSync(SOCK_A, '')
writeFileSync(SOCK_B, '')
/** A pid that is certainly not running: PID 0 is never a live user process. */
const DEAD_PID = 0

/** Transcribed from a real descriptor — the field set is the live one, not invented. */
const descriptor = (o: Record<string, unknown>) => JSON.stringify({
  pid: LIVE_PID,
  sessionId: '479123b8-bbb4-4813-968f-a88c30876d67',
  cwd: '/Users/dev/.operator/worktrees/el-encanto-3de880',
  messagingSocketPath: SOCK_A,
  startedAt: 1_788_636_700_300,
  status: 'idle',
  name: 'el-encanto-3de880-ea',
  peerProtocol: 1,
  version: '2.1.261',
  ...o,
})

describe('parseBusSession', () => {
  it('reads the fields Operator addresses by', () => {
    const s = parseBusSession(descriptor({}))!
    expect(s.sessionId).toBe('479123b8-bbb4-4813-968f-a88c30876d67')
    expect(s.socketPath).toBe(SOCK_A)
    expect(s.status).toBe('idle')
    expect(s.pid).toBe(LIVE_PID)
    expect(s.startedAt).toBe(1_788_636_700_300)
  })

  it('takes the socket path FROM the descriptor rather than assembling it from the pid', () => {
    // The brief takes the address as computable from the pid. It is — and it is the weaker key:
    // Operator's pty pid is the login shell, which may or may not have exec'd into `claude`.
    const s = parseBusSession(descriptor({ pid: 5, messagingSocketPath: '/tmp/cc-socks/other.sock' }))!
    expect(s.socketPath).toBe('/tmp/cc-socks/other.sock')
  })

  it('refuses a descriptor missing any of the three things an address needs', () => {
    expect(parseBusSession(descriptor({ sessionId: undefined }))).toBeNull()
    expect(parseBusSession(descriptor({ messagingSocketPath: undefined }))).toBeNull()
    expect(parseBusSession(descriptor({ pid: undefined }))).toBeNull()
  })

  it('returns null for a half-written file rather than throwing', () => {
    // These files are owned and constantly rewritten by another program; a torn read is expected.
    expect(parseBusSession('{"pid":19287,"sessi')).toBeNull()
    expect(parseBusSession('')).toBeNull()
  })

  it('reports an unknown status rather than inventing idle', () => {
    expect(parseBusSession(descriptor({ status: undefined }))!.status).toBe('unknown')
  })
})

describe('readBusSessions', () => {
  it('keys live sessions by their Claude session uuid', async () => {
    writeFileSync(join(DIR, 'a.json'), descriptor({}))
    writeFileSync(join(DIR, 'b.json'), descriptor({ sessionId: 'uuid-b', messagingSocketPath: SOCK_B }))
    const m = await readBusSessions()
    expect(m.size).toBe(2)
    expect(m.get('uuid-b')!.socketPath).toBe(SOCK_B)
  })

  it('skips non-json and malformed entries without failing the whole read', () => {
    // One torn descriptor must not cost Operator every address it has.
    writeFileSync(join(DIR, 'notes.txt'), 'ignore me')
    writeFileSync(join(DIR, 'broken.json'), '{"pid":1,"sessi')
    return readBusSessions().then((m) => {
      expect(m.size).toBe(2)
    })
  })

  it('reads as "nobody reachable" when the directory is absent', async () => {
    const prev = process.env.HOME
    process.env.HOME = join(SANDBOX, 'nowhere')
    try {
      expect((await readBusSessions()).size).toBe(0)
    } finally { process.env.HOME = prev }
  })
})

describe('addressOf', () => {
  it('answers a `uds:` address for a session on the bus', async () => {
    const m = await readBusSessions()
    expect(addressOf(m, '479123b8-bbb4-4813-968f-a88c30876d67')).toBe(`uds:${SOCK_A}`)
  })

  it('answers NULL for a session that is not on the bus, and for none at all', async () => {
    // Null is a real answer the caller must render as one: a lane Operator believes is open can
    // be absent because it has not finished starting, or exited without Operator noticing.
    const m = await readBusSessions()
    expect(addressOf(m, 'no-such-uuid')).toBeNull()
    expect(addressOf(m, undefined)).toBeNull()
  })
})

describe('readBusSessions — a descriptor is not proof of life', () => {
  // Finding 7. A descriptor outlives its process: a `claude` killed with SIGKILL never gets to
  // clean up, and the file it leaves makes a dead lane look addressable. Operator would then
  // answer `send` with a socket that refuses to connect — and, since nothing else notices, the
  // dispatch would sit on the board as running forever.
  const DIR2 = join(SANDBOX, 'live', '.claude', 'sessions')
  mkdirSync(DIR2, { recursive: true })
  const withHome = async <T>(home: string, fn: () => Promise<T>): Promise<T> => {
    const prev = process.env.HOME
    process.env.HOME = home
    try { return await fn() } finally { process.env.HOME = prev }
  }
  const home = join(SANDBOX, 'live')

  it('drops a descriptor whose process is gone', async () => {
    writeFileSync(join(DIR2, 'dead.json'), descriptor({ pid: DEAD_PID, sessionId: 'uuid-dead' }))
    writeFileSync(join(DIR2, 'live.json'), descriptor({ sessionId: 'uuid-live' }))
    const m = await withHome(home, readBusSessions)
    expect(m.has('uuid-dead')).toBe(false)
    expect(m.has('uuid-live')).toBe(true)
  })

  it('drops one whose socket is gone even though the process is alive', async () => {
    // The pid can be recycled or the socket cleaned up separately; an address that cannot be
    // connected to is not an address.
    writeFileSync(join(DIR2, 'nosock.json'), descriptor({
      sessionId: 'uuid-nosock', messagingSocketPath: join(SANDBOX, 'gone.sock'),
    }))
    const m = await withHome(home, readBusSessions)
    expect(m.has('uuid-nosock')).toBe(false)
  })
})

describe('preferSession — two descriptors, one session', () => {
  // Operator's restore path spawns with `--resume <same uuid>`, so a crashed process's leftover
  // descriptor and the live one differ only by pid. The winner used to be whichever `readFile`
  // resolved last — nondeterministic, and free to be the dead one.
  const s = (pid: number, startedAt?: number) => ({
    pid, sessionId: 'same', socketPath: `/tmp/${pid}.sock`, status: 'idle', startedAt,
  })

  it('takes the one that started most recently', () => {
    expect(preferSession(s(100, 1_000), s(200, 2_000)).pid).toBe(200)
    expect(preferSession(s(200, 2_000), s(100, 1_000)).pid).toBe(200)
  })

  it('breaks an exact tie by pid, so the answer is at least deterministic', () => {
    expect(preferSession(s(100, 5_000), s(200, 5_000)).pid).toBe(200)
    expect(preferSession(s(200, 5_000), s(100, 5_000)).pid).toBe(200)
  })

  it('prefers a stamped descriptor over an unstamped one', () => {
    // An unstamped file is the older format; the fallback has to be an order, not a coin toss.
    expect(preferSession(s(100, undefined), s(200, 1)).pid).toBe(200)
    expect(preferSession(s(200, 1), s(100, undefined)).pid).toBe(200)
  })
})

describe('pidAlive', () => {
  it('says yes for this very process and no for one that cannot exist', () => {
    expect(pidAlive(process.pid)).toBe(true)
    expect(pidAlive(0)).toBe(false)
    expect(pidAlive(-1)).toBe(false)
  })
})
