// `quickWorktreeList` against a real directory tree: the Home overview's first paint, which must
// answer from files alone (no git, no `du`).
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'operator-quick-list-'))
process.env.HOME = SANDBOX
process.env.OPERATOR_DIR = join(SANDBOX, 'operator-home')
const { quickWorktreeList } = await import('./worktree-reap')
const { TRASH_DIR_NAME } = await import('./worktree-trash')
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

const OP = process.env.OPERATOR_DIR
const ROOT = join(OP, 'worktrees')
const repo = join(SANDBOX, 'Developer', 'thing')
const goneRepo = join(SANDBOX, 'Developer', 'deleted')

mkdirSync(join(repo, '.git', 'worktrees'), { recursive: true })
const folder = (name: string, gitFile?: string) => {
  mkdirSync(join(ROOT, name), { recursive: true })
  if (gitFile) writeFileSync(join(ROOT, name, '.git'), gitFile)
  return join(ROOT, name)
}
const pointed = folder('thing-abc', `gitdir: ${repo}/.git/worktrees/thing-abc\n`)
const dead = folder('deleted-def', `gitdir: ${goneRepo}/.git/worktrees/deleted-def\n`)
const bare = folder('stray')
const attributed = folder('thing-ghi')
mkdirSync(join(ROOT, TRASH_DIR_NAME), { recursive: true })
writeFileSync(join(OP, 'worktree-provenance.json'), JSON.stringify([{ path: attributed, createdAt: 1, sourceRepo: repo, branch: 'operator/ghi' }]))
writeFileSync(join(OP, 'sessions.json'), JSON.stringify([{ cwd: pointed, terminalId: 't1' }]))
writeFileSync(join(OP, 'worktree-sizes.json'), JSON.stringify({ [pointed]: { bytes: 4096, mtimeMs: 1 } }))

describe('quickWorktreeList', () => {
  it('lists every folder but the trash, with repo, repo existence, lane claim and cached size', async () => {
    const list = await quickWorktreeList()
    const by = new Map(list.map((e) => [e.path, e]))
    expect(list).toHaveLength(4)
    expect(by.get(pointed)).toEqual({ path: pointed, repo, repoExists: true, live: true, cachedBytes: 4096 })
    expect(by.get(dead)).toMatchObject({ repo: goneRepo, repoExists: false, live: false, cachedBytes: undefined })
    expect(by.get(attributed)).toMatchObject({ repo, repoExists: true })
    expect(by.get(bare)).toMatchObject({ repo: undefined, repoExists: true })
  })
})
