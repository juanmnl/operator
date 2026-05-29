import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { join, basename } from 'path'

const exec = promisify(execFile)

const WORKTREE_ROOT = join(homedir(), '.operator', 'worktrees')

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 1024 * 1024 })
  return stdout.trim()
}

export interface RepoInfo {
  isRepo: boolean
  /** Top level of the working tree (only present when isRepo). */
  root?: string
  /** Currently checked-out branch (only present when isRepo and on a branch). */
  branch?: string
}

export async function inspectRepo(cwd: string): Promise<RepoInfo> {
  try {
    const root = await git(cwd, 'rev-parse', '--show-toplevel')
    let branch: string | undefined
    try {
      const b = await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')
      if (b && b !== 'HEAD') branch = b
    } catch { /* detached or empty repo */ }
    return { isRepo: true, root, branch }
  } catch {
    return { isRepo: false }
  }
}

export interface WorktreeCreateResult {
  path: string
  branch: string
  baseBranch?: string
}

/**
 * Create an isolated worktree for an agent session.
 *
 * Worktrees live under `~/.operator/worktrees/<project>-<short>` on a new
 * branch `operator/<short>`. If the source folder isn't a git repo, this
 * throws — callers should `inspectRepo` first.
 */
export async function createWorktree(sourceCwd: string): Promise<WorktreeCreateResult> {
  const info = await inspectRepo(sourceCwd)
  if (!info.isRepo || !info.root) {
    throw new Error('Not a git repository')
  }

  // Ensure the repo has at least one commit; `git worktree add` from an empty
  // repo fails in confusing ways.
  try {
    await git(info.root, 'rev-parse', 'HEAD')
  } catch {
    throw new Error('Repository has no commits yet — make an initial commit before using worktrees')
  }

  const projectName = basename(info.root)
  const short = Math.random().toString(36).slice(2, 8)
  const branch = `operator/${short}`
  const path = join(WORKTREE_ROOT, `${projectName}-${short}`)

  await fs.mkdir(WORKTREE_ROOT, { recursive: true })

  // Branch from current HEAD of the source repo.
  await git(info.root, 'worktree', 'add', '-b', branch, path, 'HEAD')

  return { path, branch, baseBranch: info.branch }
}

export interface WorktreeStatus {
  branch?: string
  /** Count of changed paths (porcelain output lines). */
  changes: number
  /** Whether the worktree directory exists and is a valid git checkout. */
  valid: boolean
}

export async function worktreeStatus(path: string): Promise<WorktreeStatus> {
  try {
    const [porcelain, branch] = await Promise.all([
      git(path, 'status', '--porcelain'),
      git(path, 'rev-parse', '--abbrev-ref', 'HEAD').catch(() => ''),
    ])
    const changes = porcelain ? porcelain.split('\n').filter(Boolean).length : 0
    return { valid: true, branch: branch || undefined, changes }
  } catch {
    return { valid: false, changes: 0 }
  }
}

export interface FileChange {
  path: string
  status: string // 2-char porcelain code, e.g. " M", "??", "A "
  added: number
  removed: number
}

export interface WorktreeDiff {
  branch?: string
  files: FileChange[]
  /** Unified diff text (no color). Untracked files included with synthetic +lines. */
  diff: string
}

export async function worktreeDiff(path: string): Promise<WorktreeDiff> {
  let branch: string | undefined
  try {
    branch = await git(path, 'rev-parse', '--abbrev-ref', 'HEAD')
  } catch { /* detached */ }

  // Porcelain status to identify per-file state including untracked.
  const porcelain = await git(path, 'status', '--porcelain').catch(() => '')
  const files: FileChange[] = []
  const untracked: string[] = []
  for (const line of porcelain.split('\n')) {
    if (!line) continue
    const status = line.slice(0, 2)
    const file = line.slice(3).trim()
    if (status === '??') untracked.push(file)
    files.push({ path: file, status, added: 0, removed: 0 })
  }

  // Per-file +/- line counts via numstat (tracked changes only).
  const numstat = await git(path, 'diff', 'HEAD', '--numstat').catch(() => '')
  for (const line of numstat.split('\n')) {
    if (!line) continue
    const [add, rem, p] = line.split('\t')
    const entry = files.find((f) => f.path === p)
    if (entry) {
      entry.added = Number(add) || 0
      entry.removed = Number(rem) || 0
    }
  }

  // Full unified diff for tracked changes.
  let diff = await git(path, 'diff', 'HEAD', '--no-color').catch(() => '')

  // Append synthetic +diffs for untracked files so the user sees new file contents too.
  for (const u of untracked) {
    try {
      const content = await git(path, 'show', `:0:${u}`).catch(async () => {
        // File isn't staged; read from disk.
        const buf = await fs.readFile(`${path}/${u}`, 'utf-8').catch(() => '')
        return buf
      })
      const lines = content.split('\n').length
      const header = `diff --git a/${u} b/${u}\nnew file\n--- /dev/null\n+++ b/${u}\n@@ -0,0 +1,${lines} @@\n`
      const body = content.split('\n').map((l) => '+' + l).join('\n')
      diff += (diff ? '\n' : '') + header + body
      const entry = files.find((f) => f.path === u)
      if (entry) entry.added = lines
    } catch { /* ignore */ }
  }

  return { branch, files, diff }
}

/**
 * Remove a worktree. The branch is left intact — the user may have work
 * to merge or review. Caller is responsible for any branch cleanup.
 */
export async function removeWorktree(path: string, sourceRoot: string): Promise<void> {
  try {
    await git(sourceRoot, 'worktree', 'remove', path)
  } catch {
    // Force-remove if the directory was deleted out from under git
    await git(sourceRoot, 'worktree', 'remove', '--force', path).catch(() => undefined)
  }
}

/**
 * Stage all changes and commit. Returns the new commit SHA on success.
 */
export async function commitAll(path: string, message: string): Promise<string> {
  await git(path, 'add', '-A')
  // Check whether there's anything to commit; if not, return the current HEAD.
  const status = await git(path, 'status', '--porcelain').catch(() => '')
  if (!status) {
    return await git(path, 'rev-parse', 'HEAD')
  }
  await git(path, 'commit', '-m', message)
  return await git(path, 'rev-parse', 'HEAD')
}

export interface MergeResult {
  ok: boolean
  /** Diagnostic message — populated on failure (e.g. conflicts). */
  message?: string
}

/**
 * Fast-forward or no-ff merge the worktree branch into the base branch in the
 * source repo. The worktree is removed on success. On failure (conflicts, etc.)
 * the worktree and branch are left intact for the user to fix.
 */
export async function mergeBranch(
  worktreePath: string,
  sourceRoot: string,
  branch: string,
  baseBranch: string,
): Promise<MergeResult> {
  // Refuse if the source repo's working tree is dirty — merging would mix changes.
  try {
    const dirty = await git(sourceRoot, 'status', '--porcelain')
    if (dirty) {
      return { ok: false, message: 'Source repo has uncommitted changes — commit or stash before merging.' }
    }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }

  // Switch source repo to base branch if needed.
  try {
    const current = await git(sourceRoot, 'rev-parse', '--abbrev-ref', 'HEAD')
    if (current !== baseBranch) {
      await git(sourceRoot, 'checkout', baseBranch)
    }
  } catch (e) {
    return { ok: false, message: `Could not switch to ${baseBranch}: ${(e as Error).message}` }
  }

  // Merge the worktree branch.
  try {
    await git(sourceRoot, 'merge', '--no-ff', '-m', `Merge ${branch}`, branch)
  } catch (e) {
    // Conflicts or other merge failure — abort and bail.
    await git(sourceRoot, 'merge', '--abort').catch(() => undefined)
    return { ok: false, message: `Merge failed: ${(e as Error).message}` }
  }

  // Success — clean up the worktree.
  await removeWorktree(worktreePath, sourceRoot)
  return { ok: true }
}

/**
 * Delete the worktree's branch outright. Removes the worktree first so git
 * lets us drop the branch ref. Use after a session ends and the work is junk.
 */
export async function discardBranch(
  worktreePath: string,
  sourceRoot: string,
  branch: string,
): Promise<void> {
  await removeWorktree(worktreePath, sourceRoot)
  await git(sourceRoot, 'branch', '-D', branch).catch(() => undefined)
}
