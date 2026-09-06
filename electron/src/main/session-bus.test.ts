import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'operator-bus-'))
process.env.HOME = SANDBOX
const { parseBusSession, readBusSessions, addressOf } = await import('./session-bus')
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

const DIR = join(SANDBOX, '.claude', 'sessions')
mkdirSync(DIR, { recursive: true })

/** Transcribed from a real descriptor — the field set is the live one, not invented. */
const descriptor = (o: Record<string, unknown>) => JSON.stringify({
  pid: 19287,
  sessionId: '479123b8-bbb4-4813-968f-a88c30876d67',
  cwd: '/Users/dev/.operator/worktrees/el-encanto-3de880',
  messagingSocketPath: '/tmp/cc-socks/19287.sock',
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
    expect(s.socketPath).toBe('/tmp/cc-socks/19287.sock')
    expect(s.status).toBe('idle')
    expect(s.pid).toBe(19287)
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
    writeFileSync(join(DIR, '19287.json'), descriptor({}))
    writeFileSync(join(DIR, '2004.json'), descriptor({ pid: 2004, sessionId: 'uuid-b', messagingSocketPath: '/tmp/cc-socks/2004.sock' }))
    const m = await readBusSessions()
    expect(m.size).toBe(2)
    expect(m.get('uuid-b')!.pid).toBe(2004)
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
    expect(addressOf(m, '479123b8-bbb4-4813-968f-a88c30876d67')).toBe('uds:/tmp/cc-socks/19287.sock')
  })

  it('answers NULL for a session that is not on the bus, and for none at all', async () => {
    // Null is a real answer the caller must render as one: a lane Operator believes is open can
    // be absent because it has not finished starting, or exited without Operator noticing.
    const m = await readBusSessions()
    expect(addressOf(m, 'no-such-uuid')).toBeNull()
    expect(addressOf(m, undefined)).toBeNull()
  })
})
