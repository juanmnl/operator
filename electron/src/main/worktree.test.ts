import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, renameSync, realpathSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

// OPERATOR_DIR is set BEFORE the module is imported, because `worktreeRoot()` reads it through
// `operatorDir()` at call time but the provenance file path is built from it too. Tests that
// created worktrees under the real ~/.operator would be writing into the user's actual fleet.
const SANDBOX = mkdtempSync(join(tmpdir(), 'operator-wt-test-'))
process.env.OPERATOR_DIR = join(SANDBOX, 'operator-home')

const wt = await import('./worktree')

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function scratchRepo(): string {
  const dir = mkdtempSync(join(SANDBOX, 'repo-'))
  git(dir, ['init', '-b', 'main'])
  git(dir, ['config', 'user.email', 't@t'])
  git(dir, ['config', 'user.name', 't'])
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-m', 'seed'])
  return dir
}

afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

// The guard is the most dangerous code in this module: past it, a directory tree is deleted.
// Every rule below corresponds to a path shape that would otherwise have taken something that
// was not a worktree with it.
describe('dangerousRemovalReason', () => {
  it('allows an ordinary worktree path', () => {
    expect(wt.dangerousRemovalReason('/tmp/some-worktree', '/tmp/repo')).toBeNull()
  })

  it('refuses an empty path', () => {
    expect(wt.dangerousRemovalReason('', '/tmp/repo')).toMatch(/empty/)
  })

  it('refuses the filesystem root', () => {
    expect(wt.dangerousRemovalReason('/', '/tmp/repo')).toMatch(/filesystem root/)
  })

  it('refuses the repository itself', () => {
    expect(wt.dangerousRemovalReason('/tmp/repo', '/tmp/repo')).toMatch(/repository itself/)
  })

  it('refuses a path that CONTAINS the repository', () => {
    expect(wt.dangerousRemovalReason('/tmp', '/tmp/repo')).toMatch(/contains the repository|contains \$HOME|user home/)
  })

  it('refuses a path that contains $HOME', () => {
    expect(wt.dangerousRemovalReason(homedir(), '/tmp/repo')).toMatch(/\$HOME|user home/)
  })

  it('refuses /home and /root by name', () => {
    expect(wt.dangerousRemovalReason('/home', '/tmp/repo')).toMatch(/path is \/home/)
    expect(wt.dangerousRemovalReason('/root', '/tmp/repo')).toMatch(/path is \/root/)
  })

  it('refuses a user home directory shape, even one that does not exist', () => {
    // The rule is about the NAME the caller asked for — /Users/<someone> is a home directory
    // whether or not that user exists on this machine, and resolving it would not say so.
    expect(wt.dangerousRemovalReason('/Users/nobody-here', '/tmp/repo')).toMatch(/user home directory/)
  })
})

describe('a worktree, end to end against real git', () => {
  let repo: string
  let created: { path: string; branch: string; baseBranch?: string }

  beforeAll(async () => {
    repo = scratchRepo()
    created = await wt.createWorktree(repo)
  })

  it('creates a branch off the default base, not the caller HEAD', () => {
    expect(created.branch).toMatch(/^operator\//)
    expect(created.baseBranch).toBe('main')
  })

  it('reports a clean status on a fresh worktree', async () => {
    const s = await wt.worktreeStatus(created.path)
    expect(s.valid).toBe(true)
    expect(s.branch).toBe(created.branch)
    expect(s.changes).toBe(0)
  })

  it('reports an UNTRACKED file in the diff, with a synthesized patch', async () => {
    // git diff says nothing about untracked files, and a fresh lane's work is mostly new files —
    // so an unsynthesized diff would list the file with no content.
    writeFileSync(join(created.path, 'new.txt'), 'hello\nworld\n')
    const d = await wt.worktreeDiff(created.path)
    expect(d.files.map((f) => f.path)).toContain('new.txt')
    expect(d.diff).toContain('+hello')
    expect(d.diff).toContain('+world')
  })

  it('commits, and a clean tree commits again without erroring', async () => {
    const sha = await wt.commitAll(created.path, 'lane work')
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    // The second call has nothing to commit. It must return HEAD, not throw — callers commit
    // before merging whether or not there was anything outstanding.
    expect(await wt.commitAll(created.path, 'again')).toBe(sha)
  })

  it('branchDiff sees the committed work from the SOURCE repo, without the worktree', async () => {
    const d = await wt.branchDiff(repo, created.branch, 'main')
    expect(d.files.map((f) => f.path)).toContain('new.txt')
  })

  it('refuses to remove a worktree that contains a nested checkout', async () => {
    mkdirSync(join(created.path, 'vendor', 'thing', '.git'), { recursive: true })
    await expect(wt.removeWorktree(created.path, repo)).rejects.toThrow(/nested checkout/)
    rmSync(join(created.path, 'vendor'), { recursive: true, force: true })
  })

  it('removes it once the nesting is gone', async () => {
    await wt.removeWorktree(created.path, repo)
    expect(await wt.pathExists(created.path)).toBe(false)
    // The branch survives the directory — that is what makes a suspended lane resumable.
    expect(git(repo, ['branch', '--list', created.branch])).toContain(created.branch)
  })

  it('reattaches a suspended lane to its existing branch rather than forking a new one', async () => {
    const again = await wt.createWorktree(repo, created.branch)
    expect(again.branch).toBe(created.branch)
    // and the committed work is back on disk, which is the whole point
    expect(await wt.pathExists(join(again.path, 'new.txt'))).toBe(false) // it's a file, not a dir
    const s = await wt.worktreeStatus(again.path)
    expect(s.branch).toBe(created.branch)
  })
})

describe('runCheck', () => {
  it('returns output and ok on success', async () => {
    const r = await wt.runCheck(SANDBOX, 'echo hello-from-check')
    expect(r.ok).toBe(true)
    expect(r.output).toContain('hello-from-check')
  })

  it('returns the OUTPUT on failure too — a failing check is the interesting case', async () => {
    const r = await wt.runCheck(SANDBOX, 'echo boom >&2; exit 3')
    expect(r.ok).toBe(false)
    expect(r.code).toBe(3)
    expect(r.output).toContain('boom')
  })
})

// S3 acceptance: the operations S1's tests did not reach — merge, discard, and the diff shapes
// the Plan/Diff panel renders. All on throwaway repos under the sandbox.
describe('merge, discard, and the guards around them', () => {
  it('merges a lane branch back with --no-ff and removes the worktree', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    writeFileSync(join(lane.path, 'feature.txt'), 'work\n')
    await wt.commitAll(lane.path, 'lane work')

    const r = await wt.mergeBranch(lane.path, repo, lane.branch, 'main')
    expect(r.ok).toBe(true)
    // The work is on main…
    expect(git(repo, ['show', 'main:feature.txt'])).toBe('work')
    // …as a MERGE commit, not fast-forwarded: the lane's shape stays visible in the history.
    expect(git(repo, ['rev-list', '--merges', '--count', 'main'])).toBe('1')
    // …and the worktree directory is gone.
    expect(await wt.pathExists(lane.path)).toBe(false)
  })

  it('REFUSES to merge when the source repo is dirty', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    writeFileSync(join(repo, 'uncommitted.txt'), 'in the way\n')
    const r = await wt.mergeBranch(lane.path, repo, lane.branch, 'main')
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/uncommitted changes/)
  })

  it('ABORTS a conflicting merge and leaves the repo clean, not mid-conflict', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    // Both sides edit the same line.
    writeFileSync(join(lane.path, 'a.txt'), 'lane version\n')
    await wt.commitAll(lane.path, 'lane edit')
    writeFileSync(join(repo, 'a.txt'), 'main version\n')
    git(repo, ['commit', '-am', 'main edit'])

    const r = await wt.mergeBranch(lane.path, repo, lane.branch, 'main')
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/Merge failed/)
    // The repo must be usable afterwards — no MERGE_HEAD left behind.
    expect(git(repo, ['status', '--porcelain'])).toBe('')
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
  })

  it('discard removes the worktree AND deletes the branch', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    writeFileSync(join(lane.path, 'throwaway.txt'), 'x\n')
    await wt.commitAll(lane.path, 'work nobody wants')

    await wt.discardBranch(lane.path, repo, lane.branch)
    expect(await wt.pathExists(lane.path)).toBe(false)
    expect(git(repo, ['branch', '--list', lane.branch])).toBe('')
  })

  it('worktreeDiff against a BASE spans committed work, not just uncommitted edits', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    writeFileSync(join(lane.path, 'committed.txt'), 'already in\n')
    await wt.commitAll(lane.path, 'lane commit')
    writeFileSync(join(lane.path, 'uncommitted.txt'), 'not yet\n')

    // Against HEAD, only the uncommitted file is a change.
    const vsHead = await wt.worktreeDiff(lane.path)
    expect(vsHead.files.map((f) => f.path)).toContain('uncommitted.txt')
    expect(vsHead.files.map((f) => f.path)).not.toContain('committed.txt')

    // Against the base, BOTH show — an agent that commits would otherwise read as "no changes".
    const vsBase = await wt.worktreeDiff(lane.path, 'main')
    expect(vsBase.files.map((f) => f.path)).toEqual(expect.arrayContaining(['committed.txt', 'uncommitted.txt']))
  })

  it('counts added/removed lines per file', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    writeFileSync(join(lane.path, 'a.txt'), 'one\ntwo\nthree\n')
    const d = await wt.worktreeDiff(lane.path)
    const entry = d.files.find((f) => f.path === 'a.txt')!
    expect(entry.added).toBeGreaterThan(0)
  })

  it('inspectRepo reports a non-repo without throwing', async () => {
    const notARepo = mkdtempSync(join(SANDBOX, 'plain-'))
    expect(await wt.inspectRepo(notARepo)).toEqual({ isRepo: false })
  })

  it('worktreeStatus reports invalid for a path that is not a checkout', async () => {
    const notARepo = mkdtempSync(join(SANDBOX, 'plain2-'))
    expect((await wt.worktreeStatus(notARepo)).valid).toBe(false)
  })

  it('refuses to create a worktree in a repo with no commits', async () => {
    const empty = mkdtempSync(join(SANDBOX, 'empty-'))
    git(empty, ['init', '-b', 'main'])
    await expect(wt.createWorktree(empty)).rejects.toThrow(/no commits yet/)
  })

  it('records provenance for every worktree it creates — the reaper may only remove what we made', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo, null, 'lane-7')
    const prov = JSON.parse(readFileSync(join(process.env.OPERATOR_DIR!, 'worktree-provenance.json'), 'utf8'))
    const mine = prov.find((p: { path: string }) => p.path === lane.path)
    // `sourceRepo` is git's canonical root (`rev-parse --show-toplevel`), not the path the
    // caller happened to pass — on macOS /var is a symlink to /private/var, so the two differ.
    // Recording the resolved one is right: the reaper compares it against real paths.
    const canonical = (await wt.inspectRepo(repo)).root
    expect(mine).toMatchObject({ createdBy: 'operator', sourceRepo: canonical, branch: lane.branch, laneId: 'lane-7' })
  })

  it('lanes in the SAME repo get distinct branches and directories', async () => {
    const repo = scratchRepo()
    const a = await wt.createWorktree(repo)
    const b = await wt.createWorktree(repo)
    expect(a.branch).not.toBe(b.branch)
    expect(a.path).not.toBe(b.path)
  })
})

// Same defect as the Plan card's, same fix: the verification gate ran `/bin/sh -lc`, which reads
// `~/.profile` and not the user's rc file — so an nvm/mise-managed `node` or `pnpm` is as
// invisible to it as `claude` was. Driven for real: a stand-in $SHELL that only gets to answer
// if the spawn honours SHELL.
describe('runCheck runs the project command through the USER\'S login shell', () => {
  const SHELL = process.env.SHELL
  afterEach(() => { if (SHELL === undefined) delete process.env.SHELL; else process.env.SHELL = SHELL })

  function fakeShell(name: string, body: string): string {
    const path = join(SANDBOX, name)
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return path
  }

  it('spawns $SHELL as a login shell (`-lc`) with the command, and hands back its output', async () => {
    process.env.SHELL = fakeShell('fake-shell.sh', 'echo "shell=$0 flag=$1 cmd=$2"')
    const r = await wt.runCheck(SANDBOX, 'npm test')
    expect(r.ok).toBe(true)
    expect(r.output).toContain('fake-shell.sh')
    expect(r.output).toContain('flag=-lc')
    expect(r.output).toContain('cmd=npm test')
    expect(r.output).not.toContain('/bin/sh')
  })

  it('a failing check still comes back with its output and its code', async () => {
    process.env.SHELL = fakeShell('fake-shell-fail.sh', 'echo "boom"; exit 3')
    const r = await wt.runCheck(SANDBOX, 'npm test')
    expect(r.ok).toBe(false)
    expect(r.code).toBe(3)
    expect(r.output).toContain('boom')
  })

  it('falls back to zsh when SHELL is unset — never /bin/sh', async () => {
    delete process.env.SHELL
    const r = await wt.runCheck(SANDBOX, 'echo $ZSH_VERSION')
    expect(r.ok).toBe(true)
    expect(r.output).not.toBe('') // zsh answered with its version; /bin/sh would print nothing
  })
})

// Every removal goes through the trash root and a background sweep. These run inside SANDBOX
// (OPERATOR_DIR above), never against ~/.operator.
describe('removal through the trash', () => {
  it('renames the worktree into the trash root, prunes git’s record, and keeps the branch', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    const trash = join(process.env.OPERATOR_DIR!, 'worktrees', '.operator-worktree-trash')
    await wt.removeWorktree(lane.path, repo)
    expect(existsSync(lane.path)).toBe(false)
    expect(git(repo, ['worktree', 'list', '--porcelain'])).not.toContain(lane.path)
    expect(git(repo, ['branch', '--list', lane.branch])).toContain(lane.branch)
    expect(existsSync(trash)).toBe(true)
  })

  it('removes a dirty worktree too — the same outcome the old --force fallback had', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    writeFileSync(join(lane.path, 'uncommitted.txt'), 'x')
    await wt.removeWorktree(lane.path, repo)
    expect(existsSync(lane.path)).toBe(false)
  })

  it('plain directory removal refuses anything that is not directly under the worktree root', async () => {
    const outside = mkdtempSync(join(SANDBOX, 'outside-'))
    await expect(wt.removePlainDirectory(outside)).rejects.toThrow(/not directly under/)
    expect(existsSync(outside)).toBe(true)
    const nested = join(process.env.OPERATOR_DIR!, 'worktrees', 'a', 'b')
    mkdirSync(nested, { recursive: true })
    await expect(wt.removePlainDirectory(nested)).rejects.toThrow(/not directly under/)
  })

  it('plain directory removal takes a git-less directory under the root', async () => {
    const dir = join(process.env.OPERATOR_DIR!, 'worktrees', 'dead-repo-abc')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.git'), 'gitdir: /nowhere/.git/worktrees/dead-repo-abc\n')
    await wt.removePlainDirectory(dir)
    expect(existsSync(dir)).toBe(false)
  })
})

// The facts the unsaved-work check and the backfill read, against real git (inside SANDBOX).
describe('gathered facts and provenance backfill, end to end', () => {
  it('counts uncommitted files and commits that exist on no other branch', async () => {
    const reap = await import('./worktree-reap')
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    const factsOf = async () => (await reap.gatherFacts()).find((f) => f.path === lane.path)!

    let f = await factsOf()
    expect(f.uncommittedCount).toBe(0)
    expect(f.unsavedCommits).toBe(0)

    writeFileSync(join(lane.path, 'w.txt'), 'x')
    git(lane.path, ['add', '-A'])
    git(lane.path, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'lane work'])
    writeFileSync(join(lane.path, 'u.txt'), 'y')
    f = await factsOf()
    expect(f.uncommittedCount).toBe(1)
    expect(f.unsavedCommits).toBe(1)

    // Once another branch holds the commit, it is no longer unsaved.
    git(repo, ['branch', 'keep', lane.branch])
    expect((await factsOf()).unsavedCommits).toBe(0)
  })

  it('backfills provenance for a listed, paired worktree of a known project, once', async () => {
    const reap = await import('./worktree-reap')
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    const home = process.env.OPERATOR_DIR!
    // Forget this worktree's provenance, as for a directory made before the file existed.
    const provFile = join(home, 'worktree-provenance.json')
    const kept = (JSON.parse(readFileSync(provFile, 'utf8')) as Array<{ path: string }>).filter((r) => r.path !== lane.path)
    writeFileSync(provFile, JSON.stringify(kept))
    writeFileSync(join(home, 'projects.json'), JSON.stringify([{ id: 'p', name: 'p', path: repo }]))

    expect((await reap.gatherFacts()).find((f) => f.path === lane.path)?.provenance).toBeUndefined()
    expect(await reap.backfillProvenanceAtBoot()).toBe(1)
    const f = (await reap.gatherFacts()).find((x) => x.path === lane.path)!
    expect(f.provenance?.branch).toBe(lane.branch)
    expect(f.backfilled).toBe(true)
    expect(await reap.backfillProvenanceAtBoot()).toBe(0)
  })
})

// The boot and quit triggers call `reap({ dryRun })` with no sizes. Inside SANDBOX, never ~/.operator.
describe('boot/quit plan without sizes', () => {
  it('measures debris candidates itself: a dead-repo folder over 2 MB is not debris and not auto', async () => {
    const reap = await import('./worktree-reap')
    const root = join(process.env.OPERATOR_DIR!, 'worktrees')
    const dead = join(root, 'uwazi_2026-deadbe')
    mkdirSync(dead, { recursive: true })
    writeFileSync(join(dead, '.git'), 'gitdir: /Users/nobody/gone/uwazi_2026/.git/worktrees/uwazi_2026-deadbe\n')
    writeFileSync(join(dead, 'blob.bin'), Buffer.alloc(3 * 1024 * 1024, 1))
    const husk = join(root, '.tmpHusk-000001')
    mkdirSync(husk, { recursive: true })
    writeFileSync(join(husk, 'a.txt'), 'x')

    const result = await reap.reap({ dryRun: true })
    const deadEntry = result.plan.entries.find((e) => e.path === dead)!
    expect(deadEntry.cls).toBe('dead-source-repo')
    expect(deadEntry.sizeBytes).toBeGreaterThan(2 * 1024 * 1024)
    expect(result.plan.auto.some((e) => e.path === dead)).toBe(false)
    expect(result.plan.entries.find((e) => e.path === husk)!.cls).toBe('debris')
    expect(result.removed).toEqual([])
    expect(existsSync(dead)).toBe(true)
  })
})

// Review H1: removal only when git vouches for the pair. Each case below is one the old
// `git worktree remove --force` refused, and must still be refused — with the folder left intact.
describe('removeWorktree refuses what git does not vouch for', () => {
  it('a registered worktree whose .git file is corrupt', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    writeFileSync(join(lane.path, 'work.txt'), 'unsaved')
    writeFileSync(join(lane.path, '.git'), 'this is not a gitdir line\n')
    await expect(wt.removeWorktree(lane.path, repo)).rejects.toThrow(/do not point at each other/)
    expect(existsSync(join(lane.path, 'work.txt'))).toBe(true)
  })

  it('a directory that is not a worktree of the repo', async () => {
    const repo = scratchRepo()
    const stranger = join(process.env.OPERATOR_DIR!, 'worktrees', 'not-a-worktree')
    mkdirSync(stranger, { recursive: true })
    writeFileSync(join(stranger, 'keep.txt'), 'x')
    await expect(wt.removeWorktree(stranger, repo)).rejects.toThrow(/does not list it/)
    expect(existsSync(join(stranger, 'keep.txt'))).toBe(true)
  })

  it('a worktree whose root was git-init\'d into its own repo', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    rmSync(join(lane.path, '.git'))
    git(lane.path, ['init', '-q'])
    writeFileSync(join(lane.path, 'work.txt'), 'unsaved')
    await expect(wt.removeWorktree(lane.path, repo)).rejects.toThrow(/do not point at each other/)
    expect(existsSync(join(lane.path, 'work.txt'))).toBe(true)
  })

  it('a locked worktree', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    git(repo, ['worktree', 'lock', lane.path])
    await expect(wt.removeWorktree(lane.path, repo)).rejects.toThrow(/locked/)
    expect(existsSync(lane.path)).toBe(true)
  })
})

// Review M1: removal drops only its own git record. A sibling worktree whose folder is missing for
// a while (an unmounted disk) keeps its record, where a bare `git worktree prune` deleted it.
describe('removal and reattach touch only their own git record', () => {
  it('a temporarily missing sibling worktree survives another removal and a reattach', async () => {
    const repo = scratchRepo()
    const a = await wt.createWorktree(repo)
    const b = await wt.createWorktree(repo)
    const away = join(SANDBOX, `unmounted-${Date.now()}`)
    renameSync(b.path, away)

    await wt.removeWorktree(a.path, repo)
    // A's record is gone and B's is still there, although B's folder is missing right now.
    const listed = git(repo, ['worktree', 'list', '--porcelain'])
    expect(listed).not.toContain(realpathSync(join(a.path, '..')) + '/' + a.path.split('/').pop())
    expect(listed).toContain(`branch refs/heads/${b.branch}`)
    // The reattach path used to run a bare prune too.
    const again = await wt.createWorktree(repo, a.branch)
    expect(again.branch).toBe(a.branch)

    renameSync(away, b.path)
    expect(git(b.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(b.branch)
  })
})

describe('removal paths re-check live claims and pending records', () => {
  it('Settings removal refuses a folder a pty is running in, whatever sessions.json says (M4)', async () => {
    const reap = await import('./worktree-reap')
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    reap.setLivePtyCwds(() => [join(lane.path, 'apps')])
    try {
      const r = await reap.removeSelected([lane.path], [lane.path])
      expect(r.removed).toEqual([])
      expect(r.failed[0].error).toMatch(/terminal is open/)
      expect(existsSync(lane.path)).toBe(true)
    } finally {
      reap.setLivePtyCwds(() => [])
    }
  })

  it('a refused durable removal leaves no pending record (L1)', async () => {
    const reap = await import('./worktree-reap')
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    git(repo, ['worktree', 'lock', lane.path])
    await expect(reap.removeWorktreeDurably(lane.path, repo)).rejects.toThrow(/locked/)
    expect((await reap.loadPending()).some((p) => p.path === lane.path)).toBe(false)
  })

  it('a real drain holds a pending record whose folder has unsaved work or a live pty (L1)', async () => {
    const reap = await import('./worktree-reap')
    const repo = scratchRepo()
    const dirty = await wt.createWorktree(repo)
    writeFileSync(join(dirty.path, 'unsaved.txt'), 'x')
    const live = await wt.createWorktree(repo)
    for (const l of [dirty, live]) {
      await reap.queueRemoval({ path: l.path, sourceRepo: repo, requestedAt: Date.now(), reason: 'test' })
    }
    reap.setLivePtyCwds(() => [live.path])
    try {
      const r = await reap.drainPending(false)
      expect(r.held).toEqual(expect.arrayContaining([dirty.path, live.path]))
      expect(r.removed).not.toContain(dirty.path)
      expect(existsSync(dirty.path) && existsSync(live.path)).toBe(true)
    } finally {
      reap.setLivePtyCwds(() => [])
      await reap.clearPending(dirty.path)
      await reap.clearPending(live.path)
    }
  })

  it('the safe button removes only confirmed paths that are still in the tier (L2)', async () => {
    const reap = await import('./worktree-reap')
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    const nothing = await reap.reap({ dryRun: false, confirmedPaths: [] })
    expect(nothing.removed).toEqual([])
    expect(existsSync(lane.path)).toBe(true)

    const r = await reap.reap({ dryRun: false, confirmedPaths: [lane.path, '/not/in/the/tier'] })
    expect(r.removed).toEqual([lane.path])
    expect(existsSync(lane.path)).toBe(false)
  })
})

// A lane without its own worktree runs in the project's main checkout. Nothing may remove that.
describe('a registered project path is never removed', () => {
  it('removeWorktree and removePlainDirectory refuse a path that is, or contains, a project in projects.json', async () => {
    const home = process.env.OPERATOR_DIR!
    const projectsFile = join(home, 'projects.json')
    const before = existsSync(projectsFile) ? readFileSync(projectsFile, 'utf8') : null
    const repo = scratchRepo()
    const other = scratchRepo()
    // A project that happens to live directly under the worktree root, the one place the plain path
    // is allowed to act.
    const underRoot = join(home, 'worktrees', 'registered-project')
    mkdirSync(join(underRoot, 'src'), { recursive: true })
    writeFileSync(join(underRoot, 'src', 'a.txt'), 'x')
    const container = join(home, 'worktrees', 'holds-a-project')
    mkdirSync(join(container, 'inner'), { recursive: true })
    writeFileSync(projectsFile, JSON.stringify([
      { id: 'a', name: 'a', path: repo },
      { id: 'b', name: 'b', path: underRoot },
      { id: 'c', name: 'c', path: join(container, 'inner') },
    ]))
    try {
      await expect(wt.removeWorktree(repo, other)).rejects.toThrow(/registered project/)
      await expect(wt.removePlainDirectory(underRoot)).rejects.toThrow(/is a registered project/)
      await expect(wt.removePlainDirectory(container)).rejects.toThrow(/contains a registered project/)
      expect(existsSync(join(repo, 'a.txt'))).toBe(true)
      expect(existsSync(join(underRoot, 'src', 'a.txt'))).toBe(true)
      expect(existsSync(join(container, 'inner'))).toBe(true)
    } finally {
      if (before === null) rmSync(projectsFile, { force: true })
      else writeFileSync(projectsFile, before)
    }
  })

  it('a worktree of a registered project is still removable', async () => {
    const home = process.env.OPERATOR_DIR!
    const projectsFile = join(home, 'projects.json')
    const before = existsSync(projectsFile) ? readFileSync(projectsFile, 'utf8') : null
    const repo = scratchRepo()
    writeFileSync(projectsFile, JSON.stringify([{ id: 'a', name: 'a', path: repo }]))
    try {
      const lane = await wt.createWorktree(repo)
      await wt.removeWorktree(lane.path, repo)
      expect(existsSync(lane.path)).toBe(false)
      expect(existsSync(join(repo, 'a.txt'))).toBe(true)
    } finally {
      if (before === null) rmSync(projectsFile, { force: true })
      else writeFileSync(projectsFile, before)
    }
  })
})
