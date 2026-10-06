import { describe, it, expect } from 'vitest'
import { laneIsLive, restoreOnce, restoreCwdPlan, type RestoreOutcome } from './restore-guard'

// Review H1, 2026-10-06: the resume card and Project Home's "Resume N agents" (or auto-resume)
// could both reach one lane and spawn two `claude --resume <id>` into the same conversation.
describe('restoreOnce', () => {
  /** A fake world: tabs by key, and a spawn that takes a tick, like the real one. */
  const world = () => {
    const tabs: Array<{ key: string }> = []
    const spawns: string[] = []
    const inFlight = new Set<string>()
    const restore = (key: string) => restoreOnce(
      inFlight, key,
      () => laneIsLive({ key }, true, () => tabs, async () => []),
      async (isLive) => {
        await new Promise((r) => setTimeout(r, 5)) // folder check, worktree rebuild, project resolve
        if (await isLive()) return 'skipped'
        spawns.push(key)
        tabs.push({ key })
        return 'started'
      },
    )
    return { tabs, spawns, inFlight, restore }
  }

  it('two paths restoring the same lane at once spawn it once', async () => {
    const w = world()
    const out = await Promise.all([w.restore('a'), w.restore('a'), w.restore('b')])
    expect(w.spawns).toEqual(['a', 'b'])
    expect(out.sort()).toEqual<RestoreOutcome[]>(['skipped', 'started', 'started'])
    expect(w.inFlight.size).toBe(0)
  })

  it('a lane already live is skipped, and one that came back mid-restore is not spawned again', async () => {
    const w = world()
    w.tabs.push({ key: 'live' })
    expect(await w.restore('live')).toBe('skipped')
    // Brought back by a path that does not claim the key (a launch reusing it) while this one waits.
    const pending = w.restore('late')
    w.tabs.push({ key: 'late' })
    expect(await pending).toBe('skipped')
    expect(w.spawns).toEqual([])
  })

  it('releases the claim when the restore throws, so a later try can run', async () => {
    const inFlight = new Set<string>()
    await expect(restoreOnce(inFlight, 'x', async () => false, async () => { throw new Error('spawn') })).rejects.toThrow('spawn')
    expect(inFlight.has('x')).toBe(false)
  })
})

describe('laneIsLive', () => {
  it('sees a running pty on the same conversation even with no tab for it', async () => {
    const ptys = async () => [{ alive: true, claudeSessionId: 'conv-1' }, { alive: false, claudeSessionId: 'conv-2' }]
    expect(await laneIsLive({ key: 'k', claudeSessionId: 'conv-1' }, true, () => [], ptys)).toBe(true)
    // An exited pty is not a second process.
    expect(await laneIsLive({ key: 'k', claudeSessionId: 'conv-2' }, true, () => [], ptys)).toBe(false)
    // A fresh start does not resume that conversation, so it does not collide with it.
    expect(await laneIsLive({ key: 'k', claudeSessionId: 'conv-1' }, false, () => [], ptys)).toBe(false)
  })

  it('an unreadable pty list is not a reason to block the restore', async () => {
    expect(await laneIsLive({ key: 'k', claudeSessionId: 'c' }, true, () => [], async () => { throw new Error('ipc') })).toBe(false)
  })
})

// Review R2-1, 2026-10-06: the released-worktree exclusion lived only in the card's offer, and only
// after a launch's folder check, so a reload, Project Home or ⌘K rebuilt a released lane's worktree.
describe('restoreCwdPlan', () => {
  const wt = { key: 'k', worktreeBranch: 'operator/abc', sourceCwd: '/repo' }

  it('rebuilds a worktree lane whose folder is gone', () => {
    expect(restoreCwdPlan(wt, true)).toBe('rebuild')
  })

  it('refuses the rebuild for a lane that called worktree_done (releasedAt on its row)', () => {
    expect(restoreCwdPlan({ ...wt, releasedAt: '2026-10-06T10:00:00Z' }, true)).toBe('released')
  })

  it('refuses it for a lane main recorded as released in last-run.json', () => {
    expect(restoreCwdPlan(wt, true, new Set(['k']))).toBe('released')
  })

  it('a released lane whose folder main kept (unsaved work) resumes in that folder', () => {
    expect(restoreCwdPlan({ ...wt, releasedAt: '2026-10-06T10:00:00Z' }, false)).toBe('as-is')
  })

  it('a plain folder lane is spawned as-is', () => {
    expect(restoreCwdPlan({ key: 'k' }, true)).toBe('as-is')
    expect(restoreCwdPlan({ key: 'k' }, false)).toBe('as-is')
  })
})
