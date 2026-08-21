import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
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
