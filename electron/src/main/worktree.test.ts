import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
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
