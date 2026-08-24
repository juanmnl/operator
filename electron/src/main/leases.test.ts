import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'operator-leases-test-'))
process.env.OPERATOR_DIR = SANDBOX
const leases = await import('./leases')
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

const lease = (over: Partial<import('./leases').DevLease> = {}): import('./leases').DevLease => ({
  sessionId: 's1', terminalId: 't0', devPort: 1420, cwd: '/w', appPid: 400,
  startedAt: '2026-08-24T00:00:00.000Z', ...over,
})

describe('the dev-port lease file', () => {
  beforeEach(async () => {
    for (const l of await leases.loadLeases()) await leases.releaseLease(l.sessionId)
  })

  it('round-trips a claim', async () => {
    await leases.claimLease(lease())
    expect(await leases.loadLeases()).toEqual([lease()])
  })

  it('replaces a previous claim by the same session rather than duplicating it', async () => {
    await leases.claimLease(lease())
    await leases.claimLease(lease({ devPort: 1421 }))
    const all = await leases.loadLeases()
    expect(all).toHaveLength(1)
    expect(all[0].devPort).toBe(1421)
  })

  it('keeps claims from different sessions side by side', async () => {
    await leases.claimLease(lease())
    await leases.claimLease(lease({ sessionId: 's2', devPort: 1421 }))
    expect((await leases.loadLeases()).map((l) => l.sessionId).sort()).toEqual(['s1', 's2'])
  })

  it('REMOVES the file once the last lease is released — absent and empty are the same state', async () => {
    await leases.claimLease(lease())
    await leases.releaseLease('s1')
    expect(await leases.loadLeases()).toEqual([])
    expect(existsSync(join(SANDBOX, 'dev-leases.json'))).toBe(false)
  })

  it('releases every lease belonging to one Operator instance', async () => {
    await leases.claimLease(lease())
    await leases.claimLease(lease({ sessionId: 's2', appPid: 400 }))
    await leases.claimLease(lease({ sessionId: 's3', appPid: 999 }))
    await leases.releaseLeasesOf(400)
    expect((await leases.loadLeases()).map((l) => l.sessionId)).toEqual(['s3'])
  })

  it('reads a MISSING file as empty — a boot that cannot read this must still boot', async () => {
    const prev = process.env.OPERATOR_DIR
    process.env.OPERATOR_DIR = join(SANDBOX, 'nothing-here')
    expect(await leases.loadLeases()).toEqual([])
    process.env.OPERATOR_DIR = prev
  })

  it('drops junk entries rather than handing a malformed lease to the reaper', async () => {
    await leases.claimLease(lease())
    // A record with no port is not a lease; reaping on it would signal a group chosen at random.
    await leases.claimLease({ sessionId: 's2' } as unknown as import('./leases').DevLease)
    expect((await leases.loadLeases()).map((l) => l.sessionId)).toEqual(['s1'])
  })
})

describe('staleLeases — which leases have no live lane behind them', () => {
  const all = [
    lease({ sessionId: 'crashed', appPid: 400 }),
    lease({ sessionId: 'other-instance', appPid: 999 }),
    lease({ sessionId: 'ours', appPid: 111 }),
  ]
  const isAppAlive = (pid: number) => pid === 999 || pid === 111

  it('is exactly the leases whose Operator is gone', () => {
    const stale = leases.staleLeases(all, { selfPid: 111, isAppAlive })
    expect(stale.map((l) => l.sessionId)).toEqual(['crashed'])
  })

  it('never reaps a port a SECOND running Operator is using — the worse bug than the one being fixed', () => {
    const stale = leases.staleLeases(all, { selfPid: 111, isAppAlive })
    expect(stale.some((l) => l.sessionId === 'other-instance')).toBe(false)
  })

  it('spares a lease whose session is live in this run', () => {
    const stale = leases.staleLeases(all, {
      selfPid: 111, isAppAlive: () => false, liveSessionIds: new Set(['crashed']),
    })
    expect(stale.map((l) => l.sessionId)).toEqual(['other-instance'])
  })
})
