import { describe, it, expect } from 'vitest'
import { discardConfirmText, discardLane, mergeLane, type LaneMergeCalls } from './lane-merge'

/** Records every call in order; `changes` is what `status` reports at the moment it is asked. */
function calls(opts: { changes?: () => number; commitOk?: boolean; mergeOk?: boolean } = {}) {
  const log: string[] = []
  const c: LaneMergeCalls = {
    kill: async (id) => { log.push(`kill:${id}`) },
    status: async () => { const n = opts.changes?.() ?? 0; log.push(`status:${n}`); return { changes: n, valid: true } },
    commit: async () => { log.push('commit'); return { ok: opts.commitOk ?? true, error: 'nope' } },
    merge: async (_p, _s, _b, _base, own) => { log.push(`merge:${own ?? '-'}`); return { ok: opts.mergeOk ?? true, message: 'x' } },
    discard: async (_p, _s, _b, own) => { log.push(`discard:${own ?? '-'}`); return { ok: true } },
  }
  return { c, log }
}
const lane = { worktreePath: '/wt', sourceRoot: '/repo', branch: 'operator/abc', terminalId: 't2', laneRunning: true }

describe('mergeLane — Review finding 1', () => {
  it('stops the lane BEFORE reading status, commits what is uncommitted then, and merges last', async () => {
    let written = 0
    const { c, log } = calls({ changes: () => written })
    // The agent writes a file after the panel loaded, before Merge: the kill must come first, and
    // the status read after it must see the file.
    written = 1
    await mergeLane(c, lane, 'main', 'msg')
    expect(log).toEqual(['kill:t2', 'status:1', 'commit', 'merge:t2'])
  })

  it('skips the commit when the worktree is clean after the lane stopped', async () => {
    const { c, log } = calls()
    await mergeLane(c, lane, 'main', 'msg')
    expect(log).toEqual(['kill:t2', 'status:0', 'merge:t2'])
  })

  it('does not kill a lane that is not running, and does not merge after a failed commit', async () => {
    const { c, log } = calls({ changes: () => 2, commitOk: false })
    const r = await mergeLane(c, { ...lane, laneRunning: false }, 'main', 'msg')
    expect(r).toEqual({ ok: false, error: 'nope' })
    expect(log).toEqual(['status:2', 'commit'])
  })
})

describe('discardLane', () => {
  it('stops a running lane first, then discards', async () => {
    const { c, log } = calls()
    await discardLane(c, lane)
    expect(log).toEqual(['kill:t2', 'discard:t2'])
  })
  it('the confirmation names the branch and says the lane is still running', () => {
    expect(discardConfirmText('operator/abc', true)).toMatch(/operator\/abc.*still running/)
    expect(discardConfirmText('operator/abc', false)).not.toMatch(/running/)
  })
})
