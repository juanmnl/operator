import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

  it('quit still drains nothing', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    await reap.queueRemoval({ path: lane.path, sourceRepo: repo, branch: lane.branch, requestedAt: Date.now(), reason: 'lane close' })
    await reap.reapOnQuit()
    expect(existsSync(lane.path)).toBe(true)
    await reap.clearPending(lane.path)
  })
})
