import { describe, it, expect } from 'vitest'
import { attributePort, ownDeepPids, claimantsByPort, evidenceSnapshot, resetEvidenceCache, type AttributionInput } from './port-attribution'
import { parsePsTable, parseTaggedTable } from './reap'

const base = (over: Partial<AttributionInput> = {}): AttributionInput => ({
  port: 1422,
  sniffed: false,
  reservedPort: 1422,
  terminalId: 't3',
  claimants: [],
  ownDeepPids: new Set<number>(),
  ...over,
})

describe('attributePort', () => {
  it('SNIFFED is proof and outranks everything — no other process can write into our pty', () => {
    expect(attributePort(base({ sniffed: true }))).toBe('sniffed')
    // …even when the evidence below would have said foreign.
    expect(attributePort(base({ sniffed: true, port: 5173, reservedPort: 1422 }))).toBe('sniffed')
    expect(attributePort(base({ sniffed: true, claimants: [{ pid: 9, terminalId: 't9' }] }))).toBe('sniffed')
  })

  // The tiers split here: `foreign` used to flatten "somebody else's" and "nobody's" into one
  // answer, and the UI needs to tell them apart — one names a lane, the other says `unclaimed`.
  it('a port that is neither sniffed nor our reservation is UNCLAIMED when nobody claims it', () => {
    expect(attributePort(base({ port: 3000, reservedPort: 1422 }))).toBe('orphan')
    expect(attributePort(base({ reservedPort: undefined }))).toBe('orphan')
  })

  it('…and CLAIMED when another lane does, so the row can name which', () => {
    expect(attributePort(base({ port: 3000, reservedPort: 1422, claimants: [{ pid: 9, terminalId: 't9' }] })))
      .toBe('claimed')
  })

  it('the reserved port is OURS when a process we started claims it', () => {
    expect(attributePort(base({
      claimants: [{ pid: 600, terminalId: 't3' }],
      ownDeepPids: new Set([600]),
    }))).toBe('reserved')
  })

  // THE BUG, stated as a test. Something is answering on our reservation and nothing we can see
  // accounts for it — a stale orphan from a previous run, or the user's own server. That is not
  // evidence of ownership, and treating it as such is what showed a stranger's app as this lane's.
  it('is UNCLAIMED when something answers our reserved port and nothing of ours claims it', () => {
    expect(attributePort(base({ claimants: [] }))).toBe('orphan')
  })

  it('is CLAIMED when ANOTHER LANE was told to serve the same port', () => {
    expect(attributePort(base({ claimants: [{ pid: 800, terminalId: 't9' }] }))).toBe('claimed')
  })

  // THE ROOT OF THE WRONG-SERVER REPORT. `allocPort` shares one reservation across a cwd on
  // purpose, so with two lanes in one root the signal cannot distinguish them — and the old rule
  // ranked it highest. Ambiguous is its own answer, not a weaker kind of ours.
  it('is SHARED when the reservation is held by more than one lane', () => {
    expect(attributePort(base({
      reservationHolders: 2,
      claimants: [{ pid: 600, terminalId: 't3' }],
      ownDeepPids: new Set([600]),
    }))).toBe('shared')
  })

  it('a shared reservation is shared even when our own tree claims it', () => {
    // Our tree claiming it proves we were ASKED to serve there, which every sibling was too.
    expect(attributePort(base({ reservationHolders: 3, claimants: [{ pid: 600, terminalId: 't3' }], ownDeepPids: new Set([600]) })))
      .toBe('shared')
  })

  it('a sole holder is not shared', () => {
    expect(attributePort(base({ reservationHolders: 1, claimants: [{ pid: 600, terminalId: 't3' }], ownDeepPids: new Set([600]) })))
      .toBe('reserved')
  })

  // Two processes cannot both hold a port and we cannot see which won, so "we are not sure" has
  // to lose to nothing. Ordering the contested check BEFORE the positive one is what enforces it.
  it('is CLAIMED on a CONTESTED port, even though one of the claimants is ours', () => {
    expect(attributePort(base({
      claimants: [{ pid: 600, terminalId: 't3' }, { pid: 800, terminalId: 't9' }],
      ownDeepPids: new Set([600]),
    }))).toBe('claimed')
  })

  // The trap a naive env check falls into: OPERATOR_DEV_PORT is set on the PTY, so the lane's
  // shell and its `claude` child carry it forever — including long after the dev server died.
  // `ownDeepPids` excludes them, so a claimant that is only the shell proves nothing.
  it('is UNCLAIMED when the only claimant is the lane\'s own shell or claude', () => {
    expect(attributePort(base({
      claimants: [{ pid: 500, terminalId: 't3' }],   // the shell
      ownDeepPids: new Set([600, 601]),               // …which is not in the deep set
    }))).toBe('orphan')
  })
})

// The same shape as the reaper's fixture: a login shell (500), `claude` under it (501), and the
// dev-server tree the lane actually started (600/601/602).
const PS = `  PID  PPID  PGID COMMAND
  400   399   400 /Applications/Operator.app/Contents/MacOS/Operator
  500     1   500 -zsh
  501   500   500 claude --settings /x/settings.json
  600   501   600 npm exec vite --port 1422
  601   600   600 node vite --port 1422
  602   601   600 esbuild --service=0.21.5
  700     1   700 /usr/bin/something-else
`

describe('ownDeepPids — what counts as "something this lane started"', () => {
  const rows = parsePsTable(PS)

  it('excludes the shell AND its direct children, keeping everything deeper', () => {
    // 500 is the shell, 501 is `claude`. Neither is a server; both carry OPERATOR_DEV_PORT.
    expect([...ownDeepPids(rows, 500)].sort((a, b) => a - b)).toEqual([600, 601, 602])
  })

  it('is empty when the lane has no pty yet', () => {
    expect(ownDeepPids(rows, undefined).size).toBe(0)
  })

  it('is empty for a shell that has started nothing', () => {
    expect(ownDeepPids(rows, 700).size).toBe(0)
  })
})

describe('claimantsByPort', () => {
  const tagged = parseTaggedTable(`  PID  PGID COMMAND
  601   600 node vite OPERATOR_TERMINAL_ID=t3 OPERATOR_DEV_PORT=1422 OPERATOR_APP_PID=400
  602   600 esbuild OPERATOR_TERMINAL_ID=t3 OPERATOR_DEV_PORT=1422 OPERATOR_APP_PID=400
  800   800 node vite OPERATOR_TERMINAL_ID=t9 OPERATOR_DEV_PORT=1423 OPERATOR_APP_PID=400
  900   900 old OPERATOR_TERMINAL_ID=t1
`)

  it('groups the processes told to serve each port', () => {
    const byPort = claimantsByPort(tagged)
    expect(byPort.get(1422)?.map((c) => c.pid)).toEqual([601, 602])
    expect(byPort.get(1423)?.map((c) => c.terminalId)).toEqual(['t9'])
  })

  it('ignores a row with no port to claim', () => {
    expect([...claimantsByPort(tagged).values()].flat().some((c) => c.pid === 900)).toBe(false)
  })
})

describe('end to end, over the fixtures', () => {
  const rows = parsePsTable(PS)
  const tagged = parseTaggedTable(`  PID  PGID COMMAND
  601   600 node vite OPERATOR_TERMINAL_ID=t3 OPERATOR_DEV_PORT=1422 OPERATOR_APP_PID=400
`)
  const deep = ownDeepPids(rows, 500)
  const claimants = claimantsByPort(tagged)

  it('attributes the lane\'s own dev server to the lane', () => {
    expect(attributePort(base({ claimants: claimants.get(1422) ?? [], ownDeepPids: deep })))
      .toBe('reserved')
  })

  it('refuses the same port once the lane\'s tree is gone — only the shell would be left', () => {
    expect(attributePort(base({ claimants: claimants.get(1422) ?? [], ownDeepPids: new Set() })))
      .toBe('orphan')
  })
})

describe('evidenceSnapshot — the cache that keeps a polled call cheap', () => {
  // `sessionPorts` is polled twice per session. Without this, a dozen open lanes would each dump
  // the whole process table WITH ITS ENVIRONMENT several times a second.
  it('reuses one snapshot within the TTL and takes a fresh one after it', async () => {
    resetEvidenceCache()
    let now = 1_000_000
    const first = evidenceSnapshot(() => now)
    expect(evidenceSnapshot(() => now)).toBe(first)     // same promise, no second sweep
    now += 2_999
    expect(evidenceSnapshot(() => now)).toBe(first)
    now += 2
    expect(evidenceSnapshot(() => now)).not.toBe(first) // TTL passed
    await first
    resetEvidenceCache()
  })

  it('hands back a usable shape even when the sweep finds nothing', async () => {
    resetEvidenceCache()
    const ev = await evidenceSnapshot()
    expect(Array.isArray(ev.psRows)).toBe(true)
    expect(ev.claimants instanceof Map).toBe(true)
    resetEvidenceCache()
  })
})
