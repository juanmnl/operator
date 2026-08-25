// Git worktrees — the lane isolation model. Mirrors `src-tauri/src/worktree.rs`.
//
// Everything here shells out to `git`, exactly as the Rust does, so this is a port of argument
// marshalling and output parsing rather than of logic. What is NOT mechanical is the removal
// guard, and it is ported deliberately rather than trimmed: `remove` deletes a directory tree,
// and every rule in `dangerousRemovalReason` is there because some path shape would otherwise
// have taken something that was not a worktree with it.
import { execFile } from 'node:child_process'
import { loginShell } from './login-shell'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve as resolvePath, sep } from 'node:path'
import { promisify } from 'node:util'
import { operatorDir } from './store'

const execFileAsync = promisify(execFile)

const worktreeRoot = () => join(operatorDir(), 'worktrees')

/** Run git in `cwd`. Resolves with trimmed stdout, rejects with trimmed stderr — the same
 *  Ok/Err split the Rust helper has, so the call sites read the same way. */
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    // 16MB: a `git diff` of a large lane can be big, and the default 1MB truncates it into
    // something that looks like a smaller diff rather than an error.
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 })
    return stdout.trim()
  } catch (e) {
    const err = e as { stderr?: string; message?: string }
    throw new Error((err.stderr ?? err.message ?? String(e)).trim())
  }
}
/** `git(...)` but "did it work" — for the many probes where failure is a normal answer. */
const gitOk = async (cwd: string, args: string[]): Promise<string | null> =>
  git(cwd, args).then((s) => s, () => null)

export interface RepoInfo { isRepo: boolean; root?: string; branch?: string }

export async function inspectRepo(cwd: string): Promise<RepoInfo> {
  const root = await gitOk(cwd, ['rev-parse', '--show-toplevel'])
  if (root == null) return { isRepo: false }
  const branch = await gitOk(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return { isRepo: true, root, branch: branch && branch !== 'HEAD' ? branch : undefined }
}

const shortId = () => (BigInt(Date.now()) * 1000000n & 0xffffffn).toString(16)

/** THE BRANCH A NEW LANE FORKS FROM — the repository's default branch, resolved, never the
 *  caller's HEAD.
 *
 *  `worktree add … HEAD` took the head of *the checkout that asked*, so a coordinator sitting in
 *  its own stale worktree handed that staleness to every lane it launched. Measured 2026-08-05:
 *  branches 30–137 commits behind main.
 *
 *  Two steps, two different questions. The NAME is a property of the repository and is derived,
 *  never hardcoded — `origin/HEAD` is what a clone records, with `main`/`master` only as the
 *  fallback for a repo that never had a remote. Then the COMMIT-ISH, and there the LOCAL branch
 *  wins: this project merges lane branches locally and pushes later, so `origin/main` can be
 *  behind by exactly the work just merged, and forking from the remote ref would drop it.
 *
 *  `null` when nothing resolves, and the caller falls back to HEAD: a lane on a stale base beats
 *  a launch that fails. */
async function defaultBase(root: string): Promise<string | null> {
  const named = (await gitOk(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']))?.split('/').pop()
  for (const name of [named, 'main', 'master'].filter((n): n is string => !!n)) {
    if (await gitOk(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]) != null) return name
    if (await gitOk(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`]) != null) return `origin/${name}`
  }
  return null
}

export interface WorktreeCreateResult { path: string; branch: string; baseBranch?: string }

interface Provenance { path: string; createdAt: number; createdBy: string; sourceRepo: string; branch: string; laneId?: string }

const provenanceFile = () => join(operatorDir(), 'worktree-provenance.json')

/** The reaper may only remove what Operator can PROVE it made. That proof is this file, so a
 *  failure to record it is logged rather than swallowed — an unrecorded worktree is one the
 *  cleanup will refuse to touch forever. */
async function recordProvenance(entry: Provenance): Promise<void> {
  try {
    const existing = JSON.parse(await readFile(provenanceFile(), 'utf8').catch(() => '[]')) as Provenance[]
    existing.push(entry)
    await mkdir(operatorDir(), { recursive: true })
    await writeFile(provenanceFile(), JSON.stringify(existing, null, 2), 'utf8')
  } catch (e) {
    console.error('[worktree] failed to record provenance:', e)
  }
}

/** REATTACHING A SUSPENDED LANE TO ITS OWN BRANCH.
 *
 *  Task-scoped lanes remove the worktree DIRECTORY on close and keep the branch, so resuming one
 *  has to put a directory back on the branch its transcript thinks it is working in. A fresh
 *  branch instead would hand the resumed conversation a tree without its own committed work —
 *  the transcript says "I edited X" and the file is back at base, which is worse than a cold
 *  start because it looks correct.
 *
 *  `worktree prune` first: a directory removed by anything other than `git worktree remove`
 *  leaves an admin record, and that record alone makes `worktree add` refuse the branch as
 *  already checked out. */
async function reattachWorktree(root: string, branch: string): Promise<WorktreeCreateResult | null> {
  if (await gitOk(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) == null) return null
  await gitOk(root, ['worktree', 'prune'])
  const project = basename(root) || 'project'
  const short = branch.split('/').pop() || shortId()
  const path = join(worktreeRoot(), `${project}-${short}`)
  if (existsSync(path)) return null
  await mkdir(worktreeRoot(), { recursive: true })
  if (await gitOk(root, ['worktree', 'add', path, branch]) == null) return null
  return { path, branch, baseBranch: (await defaultBase(root)) ?? undefined }
}

export async function createWorktree(sourceCwd: string, reuseBranch?: string | null, laneId?: string | null): Promise<WorktreeCreateResult> {
  const info = await inspectRepo(sourceCwd)
  if (!info.isRepo || !info.root) throw new Error('Not a git repository')
  const root = info.root
  if (await gitOk(root, ['rev-parse', 'HEAD']) == null) {
    throw new Error('Repository has no commits yet — make an initial commit before using worktrees')
  }

  if (reuseBranch?.trim()) {
    const reattached = await reattachWorktree(root, reuseBranch.trim())
    if (reattached) {
      await recordProvenance({ path: reattached.path, createdAt: Date.now(), createdBy: 'operator', sourceRepo: root, branch: reattached.branch, laneId: laneId ?? undefined })
      return reattached
    }
  }

  const project = basename(root) || 'project'
  const short = shortId()
  const branch = `operator/${short}`
  const path = join(worktreeRoot(), `${project}-${short}`)
  await mkdir(worktreeRoot(), { recursive: true })
  const base = await defaultBase(root)
  const baseRef = base ?? 'HEAD'
  await git(root, ['worktree', 'add', '-b', branch, path, baseRef])
  await recordProvenance({ path, createdAt: Date.now(), createdBy: 'operator', sourceRepo: root, branch, laneId: laneId ?? undefined })
  return { path, branch, baseBranch: baseRef }
}

export interface WorktreeStatus { branch?: string; changes: number; valid: boolean }

export async function worktreeStatus(path: string): Promise<WorktreeStatus> {
  const porcelain = await gitOk(path, ['status', '--porcelain'])
  if (porcelain == null) return { valid: false, changes: 0 }
  const branch = await gitOk(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return { valid: true, branch: branch || undefined, changes: porcelain.split('\n').filter(Boolean).length }
}

interface FileChange { path: string; status: string; added: number; removed: number }
export interface WorktreeDiff { branch?: string; files: FileChange[]; diff: string }

export async function worktreeDiff(path: string, base?: string): Promise<WorktreeDiff> {
  // Against HEAD by default. With a `base`, diff from the MERGE-BASE instead, which spans the
  // lane's committed work too — an agent that commits would otherwise read as "no changes".
  const against = (base ? await gitOk(path, ['merge-base', base, 'HEAD']) : null) ?? 'HEAD'
  const branch = await gitOk(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const porcelain = (await gitOk(path, ['status', '--porcelain'])) ?? ''

  const files: FileChange[] = []
  const untracked: string[] = []
  for (const line of porcelain.split('\n')) {
    if (!line) continue
    const status = line.slice(0, 2)
    const file = line.slice(3).trim()
    if (status === '??') untracked.push(file)
    files.push({ path: file, status, added: 0, removed: 0 })
  }

  const numstat = await gitOk(path, ['diff', against, '--numstat'])
  for (const line of (numstat ?? '').split('\n')) {
    const cols = line.split('\t')
    if (cols.length !== 3) continue
    const entry = files.find((f) => f.path === cols[2])
    const added = Number.parseInt(cols[0], 10) || 0
    const removed = Number.parseInt(cols[1], 10) || 0
    if (entry) { entry.added = added; entry.removed = removed }
    else files.push({ path: cols[2], status: 'M ', added, removed })
  }

  let diff = (await gitOk(path, ['diff', against, '--no-color'])) ?? ''
  // git diff says nothing about untracked files, so a brand-new file — which is most of what a
  // fresh lane produces — would show in the file list with an empty diff. Synthesize one.
  for (const u of untracked) {
    const content = await readFile(join(path, u), 'utf8').catch(() => '')
    const lines = Math.max(content.split('\n').filter((_, i, a) => i < a.length - 1 || a[i] !== '').length, 1)
    const header = `diff --git a/${u} b/${u}\nnew file\n--- /dev/null\n+++ b/${u}\n@@ -0,0 +1,${lines} @@\n`
    const body = content.split('\n').filter((_, i, a) => i < a.length - 1 || a[i] !== '').map((l) => `+${l}`).join('\n')
    if (diff) diff += '\n'
    diff += header + body
    const entry = files.find((f) => f.path === u)
    if (entry) entry.added = lines
  }

  return { branch: branch || undefined, files, diff }
}

/** The DURABLE diff for a done task, from the source repo, after the worktree directory is gone
 *  (close removes the dir and keeps the branch). Three dots: the branch's own work, not the
 *  base's movement since. */
export async function branchDiff(sourceRoot: string, branch: string, baseBranch: string): Promise<WorktreeDiff> {
  const range = `${baseBranch}...${branch}`
  const files: FileChange[] = []
  const nameStatus = await gitOk(sourceRoot, ['diff', range, '--name-status'])
  for (const line of (nameStatus ?? '').split('\n')) {
    const cols = line.split('\t')
    if (cols.length < 2) continue
    files.push({ path: cols[cols.length - 1], status: `${cols[0]} `, added: 0, removed: 0 })
  }
  const numstat = await gitOk(sourceRoot, ['diff', range, '--numstat'])
  for (const line of (numstat ?? '').split('\n')) {
    const cols = line.split('\t')
    if (cols.length !== 3) continue
    const entry = files.find((f) => f.path === cols[2])
    const added = Number.parseInt(cols[0], 10) || 0
    const removed = Number.parseInt(cols[1], 10) || 0
    if (entry) { entry.added = added; entry.removed = removed }
    else files.push({ path: cols[2], status: 'M ', added, removed })
  }
  return { branch, files, diff: (await gitOk(sourceRoot, ['diff', range, '--no-color'])) ?? '' }
}

// --- removal, and the guard that has to come with it ---------------------------------------

/** Resolve a path to its real form, INCLUDING paths that do not exist yet.
 *
 *  `realpathSync` throws on a missing path, and the obvious fallback — return the lexical path —
 *  is a trap: on macOS `/tmp` really is `/private/tmp`, so comparing a resolved `/tmp` against a
 *  lexical `/tmp/repo` finds no relationship and `containsPath` answers "no". That answer is a
 *  lie in the direction of DELETION, which is the one direction this file must never lie in.
 *  (Caught by a test: `dangerousRemovalReason('/tmp', '/tmp/repo')` returned null.)
 *
 *  So: resolve the deepest ancestor that does exist, then re-append the rest. Both paths then
 *  live in the same namespace whether or not they exist. */
function realOf(p: string): string {
  const abs = resolvePath(p)
  const tail: string[] = []
  let cur = abs
  for (;;) {
    try { return tail.length ? join(realpathSync(cur), ...tail) : realpathSync(cur) } catch { /* walk up */ }
    const parent = resolvePath(cur, '..')
    if (parent === cur) return abs // reached the root without finding anything real
    tail.unshift(cur.slice(parent.length).replace(/^[/\\]/, ''))
    cur = parent
  }
}
const samePath = (a: string, b: string) => realOf(a) === realOf(b)
const containsPath = (parent: string, child: string) => {
  const p = realOf(parent), c = realOf(child)
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/** WHY A REMOVAL MIGHT BE REFUSED. `null` = safe to proceed.
 *
 *  Every rule is a path shape that would otherwise have deleted something that is not a
 *  worktree. The home-shaped rules run on the LEXICAL path as well as the resolved one, because
 *  macOS firmlinks `/home` to `/System/Volumes/Data/home` and a resolved-only check waves
 *  `/home` straight through. */
export function dangerousRemovalReason(worktreePath: string, repo?: string): string | null {
  if (!worktreePath.trim()) return 'path is empty'
  if (repo && samePath(worktreePath, repo)) return 'path is the repository itself'
  const real = realOf(worktreePath)
  if (real === sep) return 'path is the filesystem root'
  if (repo && containsPath(worktreePath, repo)) return `path contains the repository (${realOf(repo)})`
  const home = homedir()
  if (home.trim() && containsPath(worktreePath, home)) return `path contains $HOME (${realOf(home)})`
  for (const form of [resolvePath(worktreePath), real]) {
    if (form === '/home' || form === '/root') return `path is ${form}`
    const c = form.split(sep).filter(Boolean)
    if (c.length === 2 && (c[0].toLowerCase() === 'home' || c[0].toLowerCase() === 'users')) {
      return `path is a user home directory (${form})`
    }
  }
  return null
}

/** Three answers, not two. `null` used to mean four different things — the walk finished, it hit
 *  a budget, it hit a depth limit, or it could not open a directory. Three of those are "I do
 *  not know" wearing the costume of "nothing is nested", and the lie is in the direction of
 *  deletion. So an unknown is its own answer and the caller refuses on it. */
type Nesting = { kind: 'clean' } | { kind: 'nested'; what: string } | { kind: 'unknown'; why: string }

/** Registered worktrees of `repo`, straight from git. A THROW when git cannot answer, which is
 *  the point: an empty list would read as "nothing is nested" to every caller. */
async function registeredWorktrees(repo: string): Promise<string[]> {
  const out = await git(repo, ['worktree', 'list', '--porcelain'])
  return out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length).trim())
}

/** Is another registered worktree of this repo living INSIDE the one we are about to remove? */
async function nestedRegisteredWorktree(worktreePath: string, repo: string): Promise<Nesting> {
  let list: string[]
  try { list = await registeredWorktrees(repo) } catch (e) { return { kind: 'unknown', why: `git could not list worktrees: ${e}` } }
  for (const other of list) {
    if (samePath(other, worktreePath)) continue
    if (containsPath(worktreePath, other)) return { kind: 'nested', what: `another registered worktree (${other})` }
  }
  return { kind: 'clean' }
}

/** A budgeted walk for a `.git` that is not ours. The budget is REPORTED when it runs out —
 *  see the note on Nesting. */
async function nestedCheckout(root: string, budget = 4000, maxDepth = 8): Promise<Nesting> {
  let seen = 0
  const walk = async (dir: string, depth: number): Promise<Nesting> => {
    if (depth > maxDepth) return { kind: 'unknown', why: `depth limit ${maxDepth} reached under ${dir}` }
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch (e) { return { kind: 'unknown', why: `cannot read ${dir}: ${e}` } }
    for (const e of entries) {
      if (++seen > budget) return { kind: 'unknown', why: `scan budget ${budget} exhausted` }
      if (!e.isDirectory()) continue
      const p = join(dir, e.name)
      if (e.name === '.git' && dir !== root) return { kind: 'nested', what: `a nested checkout (${p})` }
      if (e.name === '.git' || e.name === 'node_modules' || e.name === 'target') continue
      const r = await walk(p, depth + 1)
      if (r.kind !== 'clean') return r
    }
    return { kind: 'clean' }
  }
  return walk(root, 0)
}

/** Remove the DIRECTORY. The branch always survives — that is what lets a suspended lane's
 *  reattach path put a directory back on it later.
 *
 *  THE GUARD BELOW IS UNTOUCHED. Every rule in it exists because some path shape would otherwise
 *  have taken something that was not a worktree, and the lifecycle audit named it the one piece
 *  of this system that is already solid. The reaper reuses it rather than reimplementing it.
 *
 *  The durable half of a lane close lives in `worktree-reap.ts`, not here — see
 *  `removeWorktreeDurably` below for why this function is not the one the renderer should call. */
export async function removeWorktree(path: string, sourceRoot: string): Promise<void> {
  const reason = dangerousRemovalReason(path, sourceRoot)
  if (reason) throw new Error(`Refusing to remove worktree ${path}: ${reason}`)
  for (const scan of [await nestedRegisteredWorktree(path, sourceRoot), await nestedCheckout(path)]) {
    if (scan.kind === 'nested') throw new Error(`Refusing to remove worktree ${path}: it contains ${scan.what}`)
    if (scan.kind === 'unknown') throw new Error(`Refusing to remove worktree ${path}: cannot rule out a nested checkout — ${scan.why}`)
  }
  if (await gitOk(sourceRoot, ['worktree', 'remove', path]) == null) {
    await git(sourceRoot, ['worktree', 'remove', '--force', path])
  }
}

/** Commit everything. A clean tree is NOT an error — it returns the existing HEAD, so a caller
 *  that commits before merging works whether or not there was anything to commit. */
export async function commitAll(path: string, message: string): Promise<string> {
  await git(path, ['add', '-A'])
  const status = (await gitOk(path, ['status', '--porcelain'])) ?? ''
  if (!status) return git(path, ['rev-parse', 'HEAD'])
  await git(path, ['commit', '-m', message])
  return git(path, ['rev-parse', 'HEAD'])
}

export async function mergeBranch(worktreePath: string, sourceRoot: string, branch: string, baseBranch: string): Promise<{ ok: boolean; message?: string }> {
  let dirty: string
  try { dirty = await git(sourceRoot, ['status', '--porcelain']) } catch (e) { return { ok: false, message: String(e) } }
  if (dirty) return { ok: false, message: 'Source repo has uncommitted changes — commit or stash before merging.' }

  const current = await gitOk(sourceRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (current && current !== baseBranch) {
    try { await git(sourceRoot, ['checkout', baseBranch]) } catch (e) { return { ok: false, message: `Could not switch to ${baseBranch}: ${e}` } }
  }
  try {
    await git(sourceRoot, ['merge', '--no-ff', '-m', `Merge ${branch}`, branch])
  } catch (e) {
    // Leave the repo as we found it rather than mid-conflict.
    await gitOk(sourceRoot, ['merge', '--abort'])
    return { ok: false, message: `Merge failed: ${e}` }
  }
  // Best-effort: the merge is what the caller asked for and it succeeded; a worktree that
  // refuses to be removed (the guard above) must not turn that into a failure.
  await removeWorktree(worktreePath, sourceRoot).catch(() => {})
  return { ok: true }
}

export async function discardBranch(worktreePath: string, sourceRoot: string, branch: string): Promise<void> {
  await removeWorktree(worktreePath, sourceRoot).catch(() => {})
  await gitOk(sourceRoot, ['branch', '-D', branch])
}

/** The verification gate: run a project's check command in a lane's directory.
 *
 *  THE USER'S login shell (`-lc`, as `lib.rs:1228` runs it) because the command is the project's
 *  own (`npm test`, `cargo test`) and usually needs a PATH only a login shell sets up — an
 *  nvm-managed `node` is exactly as invisible to `/bin/sh` as `claude` was. 10-minute cap, and
 *  the OUTPUT COMES BACK EITHER WAY — a check that fails is the interesting case, and its output
 *  is the reason. */
export async function runCheck(cwd: string, command: string): Promise<{ ok: boolean; code?: number; output: string }> {
  return new Promise((resolve) => {
    const child = execFile(loginShell(), ['-lc', command], { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 600_000 },
      (err, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim()
        if (!err) return resolve({ ok: true, code: 0, output })
        const code = (err as NodeJS.ErrnoException & { code?: number }).code
        resolve({ ok: false, code: typeof code === 'number' ? code : undefined, output: output || String(err) })
      })
    child.stdin?.end()
  })
}

/** Does this path still exist AS A DIRECTORY? Deliberately not `worktreeStatus`, which conflates
 *  "deleted" with "not a git repo". */
export async function pathExists(path: string): Promise<boolean> {
  return stat(path).then((s) => s.isDirectory(), () => false)
}
