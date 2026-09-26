import { describe, it, expect } from 'vitest'
import { discardConfirmText, discardLane, mergeLane, type LaneMergeCalls } from './lane-merge'

// The ORDER (refusals, then stop, then commit, then merge) lives in main and is tested in
// electron/src/main/worktree.test.ts. Here: the panel asks main to do it, in one call, and never
// stops the lane itself (Review N1).
function calls(ok = true) {
  const log: string[] = []
  const c: LaneMergeCalls = {
    merge: async (_p, _s, _b, _base, own, msg) => { log.push(`merge:${own ?? '-'}:${msg}`); return ok ? { ok: true } : { ok: false, message: 'Source repo has uncommitted changes' } },
    discard: async (_p, _s, _b, own) => { log.push(`discard:${own ?? '-'}`); return { ok } },
  }
  return { c, log }
}
const lane = { worktreePath: '/wt', sourceRoot: '/repo', branch: 'operator/abc', terminalId: 't2', laneRunning: true }

describe('mergeLane', () => {
  it('hands the running lane and the commit message to main in one call, and nothing else', async () => {
    const { c, log } = calls()
    await mergeLane(c, lane, 'main', 'msg')
    expect(log).toEqual(['merge:t2:msg'])
  })

  it('reports main\'s refusal as the error; the panel has stopped nothing', async () => {
    const { c, log } = calls(false)
    expect(await mergeLane(c, lane, 'main', 'msg')).toEqual({ ok: false, error: 'Source repo has uncommitted changes' })
    expect(log).toEqual(['merge:t2:msg'])
  })

  it('does not name an ended lane for main to stop', async () => {
    const { c, log } = calls()
    await mergeLane(c, { ...lane, laneRunning: false }, 'main', 'msg')
    expect(log).toEqual(['merge:-:msg'])
  })
})

describe('discardLane', () => {
  it('hands the running lane to main, which stops it only once nothing refuses', async () => {
    const { c, log } = calls()
    await discardLane(c, lane)
    expect(log).toEqual(['discard:t2'])
  })
  it('the confirmation names the branch and says the lane is still running', () => {
    expect(discardConfirmText('operator/abc', true)).toMatch(/operator\/abc.*still running/)
    expect(discardConfirmText('operator/abc', false)).not.toMatch(/running/)
  })
})
