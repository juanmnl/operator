import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

// A live lane's checkout removed outside Operator (dev/results/mantel-55da80-gutted-2026-09-25.md),
// against real git in a temp OPERATOR_DIR. Real path: macOS's tmpdir is a symlink.
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), 'operator-checkout-')))
process.env.OPERATOR_DIR = join(SANDBOX, 'home')

const wt = await import('./worktree')
const { CheckoutWatcher, judgeCheckout, branchFromHead, probeCheckout, ACTIVITY_CHECK_MS } = await import('./checkout-health')
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
function scratchRepo(): string {
  const dir = mkdtempSync(join(SANDBOX, 'repo-'))
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.email', 't@t'])
  git(dir, ['config', 'user.name', 't'])
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'seed'])
  return dir
}

describe('judgeCheckout — pure', () => {
  it('a .git file whose admin entry exists is a worktree, with the branch from HEAD', () => {
    expect(judgeCheckout({ dotGit: 'file', adminExists: true, adminHead: 'ref: refs/heads/ops/nat-cool-cero\n' }, false))
      .toEqual({ kind: 'worktree', branch: 'ops/nat-cool-cero' })
  })
  it('a .git file whose admin entry is gone is a removed checkout', () => {
    expect(judgeCheckout({ dotGit: 'file', adminExists: false }, false).kind).toBe('gone')
  })
  it('a missing .git is a removed checkout only where a worktree is known to have been', () => {
    expect(judgeCheckout({ dotGit: 'missing' }, true).kind).toBe('gone')
    expect(judgeCheckout({ dotGit: 'missing' }, false).kind).toBe('other')
  })
  it('a main checkout (.git directory) or an unreadable probe says nothing', () => {
    expect(judgeCheckout({ dotGit: 'dir' }, true).kind).toBe('other')
    expect(judgeCheckout({ dotGit: 'unreadable' }, true).kind).toBe('other')
  })
  it('reads the branch off a symbolic HEAD, and none off a detached one', () => {
    expect(branchFromHead('ref: refs/heads/feat/puerta-home')).toBe('feat/puerta-home')
    expect(branchFromHead('8e52de15aa\n')).toBeUndefined()
  })
})

describe('CheckoutWatcher — against real git', () => {
  function watch(lanes: Array<{ id: string; cwd: string }>) {
    const events: Array<Array<{ terminalId: string; branch?: string; why: string }>> = []
    const w = new CheckoutWatcher(() => lanes, (list) => events.push(list))
    return { w, events }
  }
  const logFile = () => join(process.env.OPERATOR_DIR!, 'checkout-gone.log')

  it('reproduces the incident: `git worktree remove --force` under a live lane is reported once, with its branch', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    git(lane.path, ['checkout', '-q', '-b', 'ops/nat-cool-cero'])
    const { w, events } = watch([{ id: 't2', cwd: lane.path }])
    await w.sweep()
    expect(w.list()).toEqual([])
    expect(events).toEqual([])

    // What gh 2.100 runs for `gh pr merge --delete-branch` when a linked worktree has the branch.
    git(repo, ['worktree', 'remove', '--force', lane.path])
    await w.sweep()
    expect(w.list()).toHaveLength(1)
    expect(w.list()[0]).toMatchObject({ terminalId: 't2', cwd: lane.path, branch: 'ops/nat-cool-cero' })
    expect(w.list()[0].why).toMatch(/\.git file is missing/)
    expect(events).toHaveLength(1)
    expect(readFileSync(logFile(), 'utf8')).toMatch(new RegExp(`t2: checkout at .*${basename(lane.path)} was removed outside Operator \\(branch ops/nat-cool-cero\\)`))

    // Reported once, not on every sweep.
    await w.sweep()
    expect(events).toHaveLength(1)
  })

  it('reports the half-failed removal: the directory stays, git\'s admin entry is gone', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    const { w } = watch([{ id: 't4', cwd: lane.path }])
    await w.sweep()
    rmSync(join(repo, '.git', 'worktrees', basename(lane.path)), { recursive: true, force: true })
    await w.sweep()
    expect(w.list()[0]).toMatchObject({ terminalId: 't4', branch: lane.branch })
    expect(w.list()[0].why).toMatch(/admin entry/)
  })

  it('reports a checkout in Operator\'s worktree root even if it was never seen healthy this run', async () => {
    const dir = join(process.env.OPERATOR_DIR!, 'worktrees', 'mantel-55da80b')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'CLAUDE.md'), 'left behind\n')
    const { w } = watch([{ id: 't9', cwd: dir }])
    await w.sweep()
    expect(w.list()[0]).toMatchObject({ terminalId: 't9', branch: undefined })
  })

  it('never reports a lane that runs in a main checkout or a plain directory', async () => {
    const repo = scratchRepo()
    const plain = mkdtempSync(join(SANDBOX, 'plain-'))
    const { w, events } = watch([{ id: 't1', cwd: repo }, { id: 't3', cwd: plain }])
    await w.sweep()
    expect(w.list()).toEqual([])
    expect(events).toEqual([])
  })

  it('drops the entry when the checkout comes back, when the lane ends, and when it is no longer live', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    const lanes = [{ id: 't6', cwd: lane.path }]
    const { w, events } = watch(lanes)
    await w.sweep()
    const gitFile = readFileSync(join(lane.path, '.git'), 'utf8')

    rmSync(join(lane.path, '.git'))
    await w.sweep()
    expect(w.list()).toHaveLength(1)
    writeFileSync(join(lane.path, '.git'), gitFile) // restored by hand
    await w.sweep()
    expect(w.list()).toEqual([])

    rmSync(join(lane.path, '.git'))
    await w.sweep()
    w.forget('t6') // the lane's pty exited
    expect(w.list()).toEqual([])
    expect(events.at(-1)).toEqual([])

    await w.sweep() // reported again while it is still live…
    expect(w.list()).toHaveLength(1)
    lanes.length = 0 // …and dropped by the sweep once it is not
    await w.sweep()
    expect(w.list()).toEqual([])
  })

  it('checks on lane activity at most once per ACTIVITY_CHECK_MS per lane', async () => {
    let now = 1_000_000
    let probes = 0
    const w = new CheckoutWatcher(() => [{ id: 't2', cwd: '/nowhere' }], () => {}, () => '/root', () => now,
      async (cwd) => { probes++; return probeCheckout(cwd) })
    w.noteActivity('t2')
    w.noteActivity('t2')
    now += ACTIVITY_CHECK_MS - 1
    w.noteActivity('t2')
    expect(probes).toBe(1)
    now += 1
    w.noteActivity('t2')
    expect(probes).toBe(2)
    w.noteActivity('t-unknown') // not a live lane: nothing to check
    expect(probes).toBe(2)
  })
})
