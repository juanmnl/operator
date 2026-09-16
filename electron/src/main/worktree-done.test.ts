import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `worktree_done`, end to end through the real MCP `handle()`, a real store and real git — all in
// a temp OPERATOR_DIR, never ~/.operator.
const SANDBOX = mkdtempSync(join(tmpdir(), 'operator-wtdone-'))
process.env.OPERATOR_DIR = join(SANDBOX, 'home')
process.env.OPERATOR_TERMINAL_ID = 't4'
process.env.OPERATOR_PROJECT_ID = 'p1'
process.env.OPERATOR_ROLE_ID = 'code'
process.env.OPERATOR_APP_PID = String(process.pid)

const wt = await import('./worktree')
const reap = await import('./worktree-reap')
const { handle } = await import('./mcp-serve')
const { ArtifactStore } = await import('./chat-store')
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

type ToolResult = { content: Array<{ text: string }>; isError?: boolean }
async function callDone(laneCwd: string | undefined): Promise<ToolResult> {
  if (laneCwd === undefined) delete process.env.OPERATOR_LANE_CWD
  else process.env.OPERATOR_LANE_CWD = laneCwd
  const res = await handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'worktree_done', arguments: {} } }) as { result: ToolResult }
  return res.result
}

let store: InstanceType<typeof ArtifactStore>
beforeEach(() => { store = new ArtifactStore() })

describe('worktree_done — caller resolution', () => {
  it('is listed as a bare tool name', async () => {
    const res = handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as { result: { tools: Array<{ name: string }> } }
    expect(res.result.tools.map((t) => t.name)).toContain('worktree_done')
  })

  it('refuses a caller with no terminal id, and changes nothing', async () => {
    const saved = process.env.OPERATOR_TERMINAL_ID
    delete process.env.OPERATOR_TERMINAL_ID
    try {
      const r = await callDone('/anything')
      expect(r.isError).toBe(true)
      expect(r.content[0].text).toMatch(/unattributable call/)
    } finally {
      process.env.OPERATOR_TERMINAL_ID = saved
    }
  })

  it('refuses a lane launched without OPERATOR_LANE_CWD (an older build)', async () => {
    const r = await callDone(undefined)
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/not told its directory/)
  })

  it('resolves the worktree from the lane environment, never from an argument', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    const other = await wt.createWorktree(repo)
    writeFileSync(join(other.path, 'dirty.txt'), 'x')
    process.env.OPERATOR_LANE_CWD = lane.path
    const res = await handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'worktree_done', arguments: { path: other.path } } }) as { result: ToolResult }
    expect(res.result.isError).not.toBe(true)
    expect(res.result.content[0].text).toContain(lane.path)
    expect(res.result.content[0].text).not.toContain(other.path)
  })
})

describe('worktree_done — refusals', () => {
  it('a lane with no worktree (main checkout)', async () => {
    const repo = scratchRepo()
    const r = await callDone(repo)
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/has no worktree of its own/)
    expect(existsSync(join(repo, 'a.txt'))).toBe(true)
  })

  it('a worktree Operator has no provenance record for', async () => {
    const repo = scratchRepo()
    const path = join(process.env.OPERATOR_DIR!, 'worktrees', 'made-by-hand')
    mkdirSync(join(process.env.OPERATOR_DIR!, 'worktrees'), { recursive: true })
    git(repo, ['worktree', 'add', '-q', '-b', 'by-hand', path])
    const r = await callDone(path)
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/no record of creating/)
  })

  it('uncommitted files, listed', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    writeFileSync(join(lane.path, 'notes.md'), 'draft')
    const r = await callDone(lane.path)
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/Uncommitted files \(1\):\n {2}\?\? notes\.md/)
    expect(r.content[0].text).toMatch(/Nothing was changed/)
    expect(store.openReleases('t4', lane.path, String(process.pid))).toEqual([])
  })

  // User decision 2026-09-16: commits that exist only on the kept lane branch do not block this tool.
  it('commits only on the lane branch (unmerged, unpushed) do not block the release', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    writeFileSync(join(lane.path, 'feature.txt'), 'done')
    git(lane.path, ['add', '-A'])
    git(lane.path, ['commit', '-qm', 'the feature'])
    const r = await callDone(lane.path)
    expect(r.isError).not.toBe(true)
    expect(r.content[0].text).toContain(lane.branch)
  })

  it('a detached HEAD with commits on no branch still refuses', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    git(lane.path, ['checkout', '-q', '--detach'])
    writeFileSync(join(lane.path, 'orphan.txt'), 'x')
    git(lane.path, ['add', '-A'])
    git(lane.path, ['commit', '-qm', 'on no branch'])
    const r = await callDone(lane.path)
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/HEAD is detached.*no branch would keep your commits/)
  })
})

describe('release on exit', () => {
  it('a clean release: the reply says it waits for exit, the lane is marked done, and the directory goes on exit with the branch kept', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    const r = await callDone(lane.path)
    expect(r.isError).not.toBe(true)
    expect(r.content[0].text).toMatch(/will be removed when this session ends/)
    expect(r.content[0].text).toContain(lane.branch)
    // Not removed under the running agent.
    expect(existsSync(lane.path)).toBe(true)
    expect(store.pendingStatus().some((s) => s.terminalId === 't4' && s.taskId === 'worktree_done' && s.status === 'done')).toBe(true)

    expect(await reap.releaseWorktreeOnExit('t4', lane.path, store)).toBe('removed')
    expect(existsSync(lane.path)).toBe(false)
    expect(git(repo, ['branch', '--list', lane.branch])).toContain(lane.branch)
    expect(store.openReleases('t4', lane.path, String(process.pid))).toEqual([])
  })

  it('dirty at exit: the directory is kept and the row records why', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    const r = await callDone(lane.path)
    expect(r.isError).not.toBe(true)
    writeFileSync(join(lane.path, 'late-edit.txt'), 'after the call')
    const [row] = store.openReleases('t4', lane.path, String(process.pid))
    expect(await reap.releaseWorktreeOnExit('t4', lane.path, store)).toBe('kept')
    expect(existsSync(join(lane.path, 'late-edit.txt'))).toBe(true)
    expect(store.releaseOutcome(row.id)?.outcome).toMatch(/^kept: 1 uncommitted file\(s\) at exit/)
  })

  it('a commit made on the branch after the call is removed on exit, with the commit kept on the branch', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    expect((await callDone(lane.path)).isError).not.toBe(true)
    writeFileSync(join(lane.path, 'final.txt'), 'last word')
    git(lane.path, ['add', '-A'])
    git(lane.path, ['commit', '-qm', 'final commit'])
    expect(await reap.releaseWorktreeOnExit('t4', lane.path, store)).toBe('removed')
    expect(existsSync(lane.path)).toBe(false)
    expect(git(repo, ['log', '-1', '--format=%s', lane.branch])).toBe('final commit')
  })

  it('a HEAD detached after the call keeps the directory at exit', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    const r = await callDone(lane.path)
    expect(r.isError).not.toBe(true)
    git(lane.path, ['checkout', '-q', '--detach'])
    const [row] = store.openReleases('t4', lane.path, String(process.pid))
    expect(await reap.releaseWorktreeOnExit('t4', lane.path, store)).toBe('kept')
    expect(existsSync(lane.path)).toBe(true)
    expect(store.releaseOutcome(row.id)?.outcome).toMatch(/^kept: HEAD is detached/)
  })

  it('does nothing for another terminal, another app run, or a lane that never released', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    expect(await reap.releaseWorktreeOnExit('t4', lane.path, store)).toBe('none')
    await callDone(lane.path)
    expect(await reap.releaseWorktreeOnExit('t5', lane.path, store)).toBe('none')
    expect(await reap.releaseWorktreeOnExit('t4', lane.path, store, '999999')).toBe('none')
    expect(existsSync(lane.path)).toBe(true)
  })

  it('a directory already removed by the lane-close path is settled as already gone, and a second close removal is not an error', async () => {
    const repo = scratchRepo()
    const lane = await wt.createWorktree(repo)
    await callDone(lane.path)
    await reap.removeWorktreeDurably(lane.path, repo)
    expect(await reap.releaseWorktreeOnExit('t4', lane.path, store)).toBe('already-gone')
    await expect(reap.removeWorktreeDurably(lane.path, repo)).resolves.toBeUndefined()
  })
})
