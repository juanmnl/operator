import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The gaps in dev/results/worktree-cleanup-audit-2026-09-25.md, against real git in a temp
// OPERATOR_DIR — never ~/.operator. Set BEFORE the modules load: `worktreeRoot()` reads it.
// Real path: macOS's tmpdir is under /var, a symlink to /private/var, and git reports real paths.
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), 'operator-wt-gaps-')))
process.env.OPERATOR_DIR = join(SANDBOX, 'home')

const wt = await import('./worktree')
const reap = await import('./worktree-reap')
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
function scratchRepo(): string {
  const dir = mkdtempSync(join(SANDBOX, 'repo-'))
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.email', 't@t'])
  git(dir, ['config', 'user.name', 't'])
  writeFileSync(join(dir, 'CLAUDE.md'), 'vault: ~/old\n')
  mkdirSync(join(dir, 'docs'))
  writeFileSync(join(dir, 'docs', 'spec.md'), 'the committed spec\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'seed'])
  return dir
}
const factsFor = async (path: string) => (await reap.gatherFacts({ only: [path] }))[0]
const entryFor = async (path: string) => reap.reapPlanFrom([await factsFor(path)]).entries[0]

// ── (1) G2: provably non-work dirt ──────────────────────────────────────────────────────────────

describe('parseStatusZ', () => {
  it('reads each entry, keeps a leading-space status column, and skips a rename\'s source path', () => {
    const out = ' M CLAUDE.md\0R  new.md\0old.md\0?? dev/briefs/a.md\0'
    expect(reap.parseStatusZ(out)).toEqual([
      { xy: ' M', path: 'CLAUDE.md' },
      { xy: 'R ', path: 'new.md' },
      { xy: '??', path: 'dev/briefs/a.md' },
    ])
  })
})

describe('isProvablyNonWork — the rule, pure', () => {
  const probe = (o: Partial<{ symlink: boolean; sameAsSource: boolean; sameAsDefault: boolean }> = {}) =>
    ({ symlink: false, sameAsSource: false, sameAsDefault: false, ...o })

  it('excuses an untracked copy of a source-checkout or default-branch file', () => {
    expect(reap.isProvablyNonWork({ xy: '??', path: 'a.md' }, probe({ sameAsSource: true }))).toBe(true)
    expect(reap.isProvablyNonWork({ xy: '??', path: 'a.md' }, probe({ sameAsDefault: true }))).toBe(true)
  })

  it('excuses an untracked ROOT node_modules symlink, and no other symlink', () => {
    expect(reap.isProvablyNonWork({ xy: '??', path: 'node_modules' }, probe({ symlink: true }))).toBe(true)
    expect(reap.isProvablyNonWork({ xy: '??', path: 'apps/web/node_modules' }, probe({ symlink: true }))).toBe(false)
    expect(reap.isProvablyNonWork({ xy: '??', path: 'link' }, probe({ symlink: true, sameAsSource: true }))).toBe(false)
  })

  it('never excuses a tracked-file change, whatever the probe says', () => {
    for (const xy of [' M', 'M ', 'MM', ' D', 'A ', 'R ']) {
      expect(reap.isProvablyNonWork({ xy, path: 'CLAUDE.md' }, probe({ sameAsSource: true, sameAsDefault: true })), xy).toBe(false)
    }
  })

  it('an untracked file that matches nothing is work', () => {
    expect(reap.isProvablyNonWork({ xy: '??', path: 'notes.md' }, probe())).toBe(false)
    expect(reap.isProvablyNonWork({ xy: '??', path: 'notes.md' }, undefined)).toBe(false)
  })
})

describe('unsavedWorkOf with non-work dirt', () => {
  const base = {
    path: '/x', sizeBytes: 0, gitValid: true, dirty: true, uncommittedCount: 3, unsavedCommits: 0,
    registered: true, sourceRepoExists: true, guardReason: null,
  }
  it('does not count provably non-work dirt, and says why', () => {
    const u = reap.unsavedWorkOf({ ...base, dirtIsNonWork: true })
    expect(u).toMatchObject({ any: false, known: true, uncommitted: 3, uncommittedIsNonWork: true })
    expect(reap.needsUnsavedConfirm(u)).toBe(false)
  })
  it('still counts unsaved commits alongside non-work dirt', () => {
    expect(reap.unsavedWorkOf({ ...base, dirtIsNonWork: true, unsavedCommits: 1 }).any).toBe(true)
  })
  it('counts the dirt when it is not proved non-work', () => {
    expect(reap.unsavedWorkOf({ ...base }).any).toBe(true)
  })
})

describe('dirtIsNonWork — against real git', () => {
  it('excuses copies of source-checkout files and a root node_modules link', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    // A brief copied into the worktree from the main checkout, where it is itself untracked.
    mkdirSync(join(repo, 'dev', 'briefs'), { recursive: true })
    writeFileSync(join(repo, 'dev', 'briefs', 'b.md'), 'the brief\n')
    mkdirSync(join(lane.path, 'dev', 'briefs'), { recursive: true })
    writeFileSync(join(lane.path, 'dev', 'briefs', 'b.md'), 'the brief\n')
    symlinkSync(join(repo, 'docs'), join(lane.path, 'node_modules'))
    expect(await reap.dirtIsNonWork(lane.path, repo)).toBe(true)
    const e = await entryFor(lane.path)
    expect(e.cls).toBe('merged-dirty')
    expect(e.uncommittedIsNonWork).toBe(true)
    expect(e.needsUnsavedConfirm).toBe(false)
    expect(e.reason).toMatch(/copies of files that exist elsewhere/)
  })

  it('excuses a file byte-identical to the default branch when the source checkout differs', async () => {
    const repo = scratchRepo()
    // `docs/extra.md` is on main; the worktree is cut from an older commit where it is absent.
    const older = git(repo, ['rev-parse', 'HEAD'])
    writeFileSync(join(repo, 'docs', 'extra.md'), 'on main\n')
    git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'extra'])
    git(repo, ['branch', 'old', older])
    const lane = await wt.createWorktree(repo, 'old')
    writeFileSync(join(repo, 'docs', 'extra.md'), 'edited in the main checkout, uncommitted\n')
    writeFileSync(join(lane.path, 'docs', 'extra.md'), 'on main\n')
    expect(await reap.dirtIsNonWork(lane.path, repo)).toBe(true)
  })

  it('counts a unique untracked file, a copy at a different path, or a tracked edit as work', async () => {
    const repo = scratchRepo()
    const unique = await wt.createWorktree(repo)
    writeFileSync(join(unique.path, 'notes.md'), 'only here\n')
    expect(await reap.dirtIsNonWork(unique.path, repo)).toBe(false)
    expect((await entryFor(unique.path)).needsUnsavedConfirm).toBe(true)

    const moved = await wt.createWorktree(repo)
    writeFileSync(join(moved.path, 'spec-copy.md'), 'the committed spec\n') // same bytes, different path
    expect(await reap.dirtIsNonWork(moved.path, repo)).toBe(false)

    // The audit's CLAUDE.md vault-path edit: tracked, so it stays unsaved.
    const edited = await wt.createWorktree(repo)
    writeFileSync(join(edited.path, 'CLAUDE.md'), 'vault: ~/Documents/Vaults/Work\n')
    expect(await reap.dirtIsNonWork(edited.path, repo)).toBe(false)
    expect((await entryFor(edited.path)).needsUnsavedConfirm).toBe(true)

    // One non-work copy does not excuse a unique file beside it.
    const mixed = await wt.createWorktree(repo)
    symlinkSync(join(repo, 'docs'), join(mixed.path, 'node_modules'))
    writeFileSync(join(mixed.path, 'notes.md'), 'only here\n')
    expect(await reap.dirtIsNonWork(mixed.path, repo)).toBe(false)
  })

  it('a symlink that is not the root node_modules is work', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    symlinkSync(join(repo, 'docs'), join(lane.path, 'docs-link'))
    expect(await reap.dirtIsNonWork(lane.path, repo)).toBe(false)
  })

  it('answers false, never true, when the source repo is unknown or gone', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    symlinkSync(join(repo, 'docs'), join(lane.path, 'node_modules'))
    expect(await reap.dirtIsNonWork(lane.path, undefined)).toBe(false)
    expect(await reap.dirtIsNonWork(lane.path, join(SANDBOX, 'no-such-repo'))).toBe(false)
  })
})

// ── (2) G6: a sessions.json claim counts only while main's pty table backs it ─────────────────────

describe('stale sessions.json claims', () => {
  const sessionsFile = () => join(process.env.OPERATOR_DIR!, 'sessions.json')
  const writeSessions = (rows: unknown[]) => {
    mkdirSync(process.env.OPERATOR_DIR!, { recursive: true })
    writeFileSync(sessionsFile(), JSON.stringify(rows))
  }
  const record = (cwd: string, repo: string, over: Record<string, unknown> = {}) =>
    ({ cwd, sourceCwd: repo, worktreeBranch: 'b', terminalId: 't20', lastActiveAt: '2026-09-11T10:00:00Z', ...over })

  it('drops a claim no running pty backs, so the folder is no longer "a lane is open here"', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    writeSessions([record(lane.path, repo)])
    reap.setLivePtyCwds(() => [])
    try {
      const f = await factsFor(lane.path)
      expect(f.liveTerminalId).toBeUndefined()
      expect((await entryFor(lane.path)).live).toBe(false)
    } finally { reap.setLivePtyCwds(null) }
  })

  it('keeps the claim while a pty runs in that directory (or inside it)', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    writeSessions([record(lane.path, repo)])
    reap.setLivePtyCwds(() => [join(lane.path, 'docs')])
    try {
      expect((await factsFor(lane.path)).liveTerminalId).toBe('t20')
    } finally { reap.setLivePtyCwds(null) }
  })

  it('keeps every claim where the pty table is not known (the --mcp-serve process)', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    writeSessions([record(lane.path, repo)])
    reap.setLivePtyCwds(null)
    expect((await factsFor(lane.path)).liveTerminalId).toBe('t20')
  })

  // Review finding 3: a second Operator on the same ~/.operator cannot see the first one's ptys.
  it('keeps a claim written by ANOTHER live Operator, and drops one whose writer is dead', async () => {
    const repo = scratchRepo()
    const other = await wt.createWorktree(repo)
    const dead = await wt.createWorktree(repo)
    const DEAD_PID = 99_999_999 // above any real pid, so never alive
    writeSessions([
      record(other.path, repo, { terminalId: 't1', appPid: process.ppid }), // the test runner's parent: alive, not us
      record(dead.path, repo, { terminalId: 't2', appPid: DEAD_PID }),
    ])
    reap.setLivePtyCwds(() => [])
    try {
      expect((await factsFor(other.path)).liveTerminalId).toBe('t1')
      expect((await factsFor(dead.path)).liveTerminalId).toBeUndefined()
      await reap.queueEndedSessions()
      const queued = (await reap.loadPending()).map((p) => p.path)
      expect(queued).not.toContain(other.path)
      expect(queued).toContain(dead.path)
      for (const p of queued) await reap.clearPending(p)
    } finally { reap.setLivePtyCwds(null) }
  })

  it('stampSessionClaims stamps only this process\'s live terminals and leaves the rest as written', () => {
    const rows = [{ terminalId: 't1', cwd: '/a' }, { terminalId: 't9', cwd: '/b', appPid: 42 }, { cwd: '/c' }]
    expect(reap.stampSessionClaims(rows, new Set(['t1']), 777)).toEqual([
      { terminalId: 't1', cwd: '/a', appPid: 777 },
      { terminalId: 't9', cwd: '/b', appPid: 42 },
      { cwd: '/c' },
    ])
  })

  it('queueEndedSessions queues a record whose claim is stale, and leaves a live or unverifiable one alone', async () => {
    const repo = scratchRepo()
    const stale = await wt.createWorktree(repo)
    const running = await wt.createWorktree(repo)
    writeSessions([record(stale.path, repo), record(running.path, repo, { terminalId: 't3' })])
    const queued = async () => (await reap.loadPending()).map((p) => p.path)
    reap.setLivePtyCwds(() => [running.path])
    try {
      await reap.queueEndedSessions()
      expect(await queued()).toContain(stale.path)
      expect(await queued()).not.toContain(running.path)
    } finally { reap.setLivePtyCwds(null) }
    // Un-wired: nothing with a terminal id is queued, as before.
    for (const p of await queued()) await reap.clearPending(p)
    await reap.queueEndedSessions()
    expect(await queued()).toEqual([])
  })
})

// ── (3) G3: boot retries removals someone started, and only those ────────────────────────────────

describe('boot retries interrupted removals', () => {
  const branchExists = (repo: string, b: string) => { try { git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]); return true } catch { return false } }
  const pendingPaths = async () => (await reap.loadPending()).map((p) => p.path)

  it('removes an interrupted lane close at boot, keeps the branch, and clears the record', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    await reap.queueRemoval({ path: lane.path, sourceRepo: repo, branch: lane.branch, requestedAt: Date.now(), reason: 'lane close' })
    reap.setLivePtyCwds(() => [])
    try { await reap.reconcileAtBoot() } finally { reap.setLivePtyCwds(null) }
    expect(existsSync(lane.path)).toBe(false)
    expect(branchExists(repo, lane.branch)).toBe(true)
    expect(await pendingPaths()).not.toContain(lane.path)
  })

  it('holds one with unsaved work, and one a pty is open in, and keeps their records', async () => {
    const repo = scratchRepo()
    const dirty = await wt.createWorktree(repo)
    writeFileSync(join(dirty.path, 'notes.md'), 'only here\n')
    const open = await wt.createWorktree(repo)
    for (const l of [dirty, open]) {
      await reap.queueRemoval({ path: l.path, sourceRepo: repo, branch: l.branch, requestedAt: Date.now(), reason: 'lane close' })
    }
    reap.setLivePtyCwds(() => [open.path])
    try { await reap.reconcileAtBoot() } finally { reap.setLivePtyCwds(null) }
    expect(existsSync(dirty.path)).toBe(true)
    expect(existsSync(open.path)).toBe(true)
    expect(await pendingPaths()).toEqual(expect.arrayContaining([dirty.path, open.path]))
    for (const p of [dirty.path, open.path]) await reap.clearPending(p)
  })

  it('leaves an ended-session record queued by boot reconciliation alone', async () => {
    const repo = scratchRepo()
    const ended = await wt.createWorktree(repo)
    await reap.queueRemoval({ path: ended.path, sourceRepo: repo, branch: ended.branch, requestedAt: Date.now(), reason: reap.ENDED_SESSION_REASON })
    reap.setLivePtyCwds(() => [])
    try { await reap.reconcileAtBoot() } finally { reap.setLivePtyCwds(null) }
    expect(existsSync(ended.path)).toBe(true)
    expect(await pendingPaths()).toContain(ended.path)
    await reap.clearPending(ended.path)
  })

  it('an ARMED quit drains removals someone started and never an ended-session record (Review finding 4)', async () => {
    // Both are clean, with their one commit also on a second branch: no unsaved work, and unmerged,
    // so the auto-tier reap leaves them alone and only the drain decides.
    const repo = scratchRepo()
    const lanes = [await wt.createWorktree(repo), await wt.createWorktree(repo)]
    for (const l of lanes) {
      writeFileSync(join(l.path, 'x.md'), `${l.branch}\n`)
      git(l.path, ['add', '-A']); git(l.path, ['commit', '-qm', 'c'])
      git(l.path, ['branch', `${l.branch}-copy`])
    }
    const [closed, ended] = lanes
    await reap.queueRemoval({ path: closed.path, sourceRepo: repo, branch: closed.branch, requestedAt: Date.now(), reason: 'lane close' })
    await reap.queueRemoval({ path: ended.path, sourceRepo: repo, branch: ended.branch, requestedAt: Date.now(), reason: reap.ENDED_SESSION_REASON })
    reap.setLivePtyCwds(() => [])
    try { await reap.reapOnQuit(true) } finally { reap.setLivePtyCwds(null) }
    expect(existsSync(closed.path)).toBe(false)
    expect(existsSync(ended.path)).toBe(true)
    expect((await reap.loadPending()).map((p) => p.path)).toContain(ended.path)
    await reap.clearPending(ended.path)
  })

  it('a lane close replaces the ended-session record boot queued for the same folder (Review finding 5)', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    const rec = (reason: string) => ({ path: lane.path, sourceRepo: repo, branch: lane.branch, requestedAt: Date.now(), reason })
    await reap.queueRemoval(rec(reap.ENDED_SESSION_REASON))
    await reap.queueRemoval(rec('lane close'))
    const mine = (await reap.loadPending()).filter((p) => p.path === lane.path)
    expect(mine.map((p) => p.reason)).toEqual(['lane close'])
    // …and never the other way round: boot does not demote a removal someone started.
    await reap.queueRemoval(rec(reap.ENDED_SESSION_REASON))
    expect((await reap.loadPending()).filter((p) => p.path === lane.path).map((p) => p.reason)).toEqual(['lane close'])
    // So an interrupted close of a lane that lived across a restart is retried at the next boot.
    reap.setLivePtyCwds(() => [])
    try { await reap.reconcileAtBoot() } finally { reap.setLivePtyCwds(null) }
    expect(existsSync(lane.path)).toBe(false)
  })

  it('quit still drains nothing', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    await reap.queueRemoval({ path: lane.path, sourceRepo: repo, branch: lane.branch, requestedAt: Date.now(), reason: 'lane close' })
    await reap.reapOnQuit()
    expect(existsSync(lane.path)).toBe(true)
    await reap.clearPending(lane.path)
  })
})

// ── (4) Rescue: copy the unsaved work out, then the folder counts as preserved ────────────────────

describe('rescueWorktree', () => {
  /** A lane with every kind of unsaved work: a tracked edit, a deletion, a unique untracked file in
   *  a subdirectory, and a commit no other branch holds. */
  async function busyLane() {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    writeFileSync(join(lane.path, 'committed-here.md'), 'a commit only this branch has\n')
    git(lane.path, ['add', '-A']); git(lane.path, ['commit', '-qm', 'lane work'])
    writeFileSync(join(lane.path, 'CLAUDE.md'), 'vault: ~/new\n')
    rmSync(join(lane.path, 'docs', 'spec.md'))
    mkdirSync(join(lane.path, 'dev', 'results'), { recursive: true })
    writeFileSync(join(lane.path, 'dev', 'results', 'report.md'), 'a report that exists only here\n')
    return { repo, lane }
  }

  it('copies files, a patch and a bundle, and the folder then needs no unsaved-work confirmation', async () => {
    const { lane } = await busyLane()
    expect((await entryFor(lane.path)).needsUnsavedConfirm).toBe(true)

    const r = await reap.rescueWorktree(lane.path, new Date('2026-09-25T12:00:00Z'))
    expect(r.dir).toBe(join(process.env.OPERATOR_DIR!, 'rescued', `${lane.path.split('/').pop()}-2026-09-25`))
    expect(r).toMatchObject({ files: 2, commits: 1, preserved: true }) // CLAUDE.md + report.md; the deletion is in the patch
    expect(readFileSync(join(r.dir, 'files', 'dev', 'results', 'report.md'), 'utf8')).toBe('a report that exists only here\n')
    expect(readFileSync(join(r.dir, 'files', 'CLAUDE.md'), 'utf8')).toBe('vault: ~/new\n')
    const patch = readFileSync(join(r.dir, 'changes.patch'), 'utf8')
    expect(patch).toContain('+vault: ~/new')
    expect(patch).toContain('deleted file mode')
    // The bundle really holds the commit: git can list it.
    expect(git(lane.path, ['bundle', 'list-heads', join(r.dir, 'commits.bundle')])).toMatch(/HEAD/)
    expect(JSON.parse(readFileSync(join(r.dir, 'manifest.json'), 'utf8'))).toMatchObject({ source: lane.path, commits: 1 })

    const e = await entryFor(lane.path)
    expect(e.rescuedTo).toBe(r.dir)
    expect(e.needsUnsavedConfirm).toBe(false)
    // …and removal goes through without the unsaved-work confirmation; the rescue stays.
    const removed = await reap.removeSelected([lane.path], [])
    expect(removed.failed).toEqual([])
    expect(existsSync(lane.path)).toBe(false)
    expect(existsSync(join(r.dir, 'files', 'dev', 'results', 'report.md'))).toBe(true)
  })

  it('a change after the rescue makes the work unsaved again', async () => {
    const { lane } = await busyLane()
    await reap.rescueWorktree(lane.path)
    expect((await entryFor(lane.path)).needsUnsavedConfirm).toBe(false)
    writeFileSync(join(lane.path, 'dev', 'results', 'report.md'), 'edited after the rescue\n')
    const e = await entryFor(lane.path)
    expect(e.rescuedTo).toBeUndefined()
    expect(e.needsUnsavedConfirm).toBe(true)
    expect((await reap.removeSelected([lane.path], [])).failed).toHaveLength(1)
    expect(existsSync(lane.path)).toBe(true)
  })

  it('does not mark a folder preserved when a status entry is a directory it could not copy (Review finding 7)', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    writeFileSync(join(lane.path, 'notes.md'), 'only here\n')
    // A nested repository: git status shows it as one directory entry, `?? nested/`.
    const nested = join(lane.path, 'nested')
    mkdirSync(nested)
    git(nested, ['init', '-q']); writeFileSync(join(nested, 'work.txt'), 'nested work\n')
    const r = await reap.rescueWorktree(lane.path)
    expect(r.preserved).toBe(false)
    expect(r.skipped).toEqual(['nested/'])
    expect(r.files).toBe(1) // notes.md was still copied
    const e = await entryFor(lane.path)
    expect(e.rescuedTo).toBeUndefined()
    expect(e.needsUnsavedConfirm).toBe(true)
  })

  it('never reuses a rescue directory', async () => {
    const { lane } = await busyLane()
    const day = new Date('2026-09-25T09:00:00Z')
    const a = await reap.rescueWorktree(lane.path, day)
    const b = await reap.rescueWorktree(lane.path, day)
    expect(b.dir).toBe(`${a.dir}-2`)
    expect(existsSync(join(a.dir, 'changes.patch'))).toBe(true)
  })

  it('refuses a folder git cannot read, and writes nothing', async () => {
    const dir = join(process.env.OPERATOR_DIR!, 'worktrees', 'not-a-worktree')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'x.txt'), 'x')
    await expect(reap.rescueWorktree(dir)).rejects.toThrow(/git cannot read it/)
    expect(existsSync(join(process.env.OPERATOR_DIR!, 'rescued', 'not-a-worktree-2026-09-25'))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})

// ── (5) G5: merged by squash or rebase is labelled, and only labelled ─────────────────────────────

describe('merged-by-patch label', () => {
  /** A lane with `n` commits of its own; returns their shas, oldest first. */
  async function laneWithCommits(n: number) {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    const shas: string[] = []
    for (let i = 0; i < n; i++) {
      writeFileSync(join(lane.path, `f${i}.md`), `change ${i}\n`)
      git(lane.path, ['add', '-A']); git(lane.path, ['commit', '-qm', `c${i}`])
      shas.push(git(lane.path, ['rev-parse', 'HEAD']))
    }
    return { repo, lane, shas }
  }

  it('labels a rebase-merged branch (its commits cherry-picked onto main), class unchanged', async () => {
    const { repo, lane, shas } = await laneWithCommits(2)
    writeFileSync(join(repo, 'unrelated.md'), 'main moved on\n')
    git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'main moves'])
    git(repo, ['cherry-pick', ...shas])
    const e = await entryFor(lane.path)
    expect(e.mergedByPatch).toBe(true)
    expect(e.cls).toBe('unmerged')
    expect(e.auto).toBe(false)
    expect(e.reason).toMatch(/merged by squash or rebase/)
  })

  it('labels a single-commit squash merge', async () => {
    const { repo, lane } = await laneWithCommits(1)
    git(repo, ['merge', '-q', '--squash', lane.branch]); git(repo, ['commit', '-qm', 'squash'])
    expect((await entryFor(lane.path)).mergedByPatch).toBe(true)
  })

  it('does not label a branch with a change main does not have', async () => {
    const { repo, lane, shas } = await laneWithCommits(2)
    git(repo, ['cherry-pick', shas[0]]) // only one of the two landed
    const e = await entryFor(lane.path)
    expect(e.mergedByPatch).toBeUndefined()
    expect(e.reason).toMatch(/is not merged into the default branch/)
  })

  it('an ancestor-merged branch is plain merged, not "by patch"', async () => {
    const { repo, lane } = await laneWithCommits(1)
    git(repo, ['merge', '-q', '--ff-only', lane.branch])
    const e = await entryFor(lane.path)
    expect(e.cls).toBe('merged-clean')
    expect(e.mergedByPatch).toBeUndefined()
  })
})

// ── (6) G7: debris goes through the plain-directory path, stray files are listed, sweep failures are kept

describe('debris, stray files and the trash log', () => {
  const root = () => join(process.env.OPERATOR_DIR!, 'worktrees')

  it('the "safe" removal takes creation debris of the interrupted-create shape through the plain path', async () => {
    const dir = join(root(), '.tmpABCDEF-d96ee0')
    mkdirSync(dir, { recursive: true })
    // What an interrupted `worktree add` leaves: a pointer to an admin entry that never got made,
    // and one stray file.
    writeFileSync(join(dir, '.git'), `gitdir: ${join(SANDBOX, 'gone-repo', '.git', 'worktrees', 'x')}\n`)
    writeFileSync(join(dir, 'a.txt'), 'x')
    expect(await reap.hasInterruptedCreateShape(dir)).toBe(true)
    const plan = await reap.reapPlan()
    const e = plan.entries.find((x) => x.path === dir)!
    expect(e.cls).toBe('debris')
    expect(e.auto).toBe(true)
    const r = await reap.reap({ dryRun: false, confirmedPaths: [dir] })
    expect(r.removed).toContain(dir)
    expect(existsSync(dir)).toBe(false)
  })

  it('never takes a small non-git folder of any other shape in the one-press removal (Review finding 2)', async () => {
    // A lane's own scratch folder: notes, no .git pointer. Small, git-less, unrecorded — and not ours.
    const notes = join(root(), 'mantel-55da80-notes')
    mkdirSync(notes, { recursive: true })
    writeFileSync(join(notes, 'plan.md'), 'notes\n')
    writeFileSync(join(notes, 'fix.patch'), 'diff\n')
    // A pointer to a missing admin entry, but with more than one file beside it.
    const busy = join(root(), '.tmpBUSY-000000')
    mkdirSync(busy, { recursive: true })
    writeFileSync(join(busy, '.git'), `gitdir: ${join(SANDBOX, 'gone-repo', '.git', 'worktrees', 'y')}\n`)
    writeFileSync(join(busy, 'a.txt'), 'x'); writeFileSync(join(busy, 'b.txt'), 'y')
    for (const d of [notes, busy]) expect(await reap.hasInterruptedCreateShape(d)).toBe(false)
    const plan = await reap.reapPlan()
    for (const d of [notes, busy]) {
      const e = plan.entries.find((x) => x.path === d)!
      expect(e.cls).toBe('debris')
      expect(e.auto).toBe(false)
      expect(e.needsUnsavedConfirm).toBe(true)
    }
    const r = await reap.reap({ dryRun: false, confirmedPaths: [notes, busy] })
    expect(r.removed).toEqual([])
    expect(existsSync(notes) && existsSync(busy)).toBe(true)
    rmSync(notes, { recursive: true, force: true }); rmSync(busy, { recursive: true, force: true })
  })

  it('lists files in the worktree root, and leaves them alone', async () => {
    mkdirSync(root(), { recursive: true })
    writeFileSync(join(root(), 'rv.log'), 'agent run log\n')
    const plan = await reap.reapPlan()
    expect(plan.strayFiles?.map((f) => f.path)).toContain(join(root(), 'rv.log'))
    expect(plan.entries.some((x) => x.path === join(root(), 'rv.log'))).toBe(false)
    await reap.reap({ dryRun: false, confirmedPaths: [join(root(), 'rv.log')] })
    expect(existsSync(join(root(), 'rv.log'))).toBe(true)
  })

  it('writes a sweep failure to ~/.operator/worktree-trash.log, not only to stderr', async () => {
    const trash = await import('./worktree-trash')
    const stuck = join(trash.trashRoot(), 'wt-1789698715623-87f7be40')
    mkdirSync(join(stuck, 'locked'), { recursive: true })
    writeFileSync(join(stuck, 'locked', 'f'), 'x')
    chmodSync(join(stuck, 'locked'), 0o500) // its file cannot be unlinked
    try {
      const report = await trash.sweepTrash()
      expect(report.failed).toBe(1)
      const log = readFileSync(trash.trashLogFile(), 'utf8')
      expect(log).toContain('wt-1789698715623-87f7be40')
      expect(log).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    } finally {
      chmodSync(join(stuck, 'locked'), 0o700)
      rmSync(stuck, { recursive: true, force: true })
    }
  })
})
