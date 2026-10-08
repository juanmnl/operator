// Git worktrees — the lane isolation model. Mirrors `src-tauri/src/worktree.rs`.
//
// Everything here shells out to `git`, exactly as the Rust does, so this is a port of argument
// marshalling and output parsing rather than of logic. What is NOT mechanical is the removal
// guard, and it is ported deliberately rather than trimmed: `remove` deletes a directory tree,
// and every rule in `dangerousRemovalReason` is there because some path shape would otherwise
// have taken something that was not a worktree with it.
import { execFile } from 'node:child_process'
import { loginShell } from './login-shell'
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve as resolvePath, sep } from 'node:path'
import { promisify } from 'node:util'
import { loadProjects, operatorDir } from './store'
import { moveToTrash, scheduleSweep } from './worktree-trash'

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

export interface WorktreeCreateResult {
  path: string
  branch: string
  baseBranch?: string
  /** What `cloneDependencies` did for this worktree. `note` is the one line for the lane when
   *  something was not cloned. */
  dependencies?: DependencyCloneResult & { note?: string }
}

// --- dependencies: clone node_modules into a new worktree --------------------------------------
//
// A fresh worktree has no `node_modules`, so a lane could not run the project's tests without
// installing or symlinking the main checkout's. Each ignored `node_modules` directory of the source
// checkout is CLONED into the same relative path: on APFS a clone shares every block with the
// original until one side writes, so a 666 MB pair of trees costs a few MB (measured, see the
// 2026-09-16 result). Never a symlink (a lane's install would write into the main checkout) and
// never a full copy (that is the disk cost worktrees are already criticised for).

/** How long the clones may hold up a lane's launch in total. Two trees (13,869 entries) took about
 *  2 s here; the cap is for a much larger monorepo or a slow disk, not the normal case. */
export const DEPENDENCY_CLONE_CAP_MS = 30_000

/** The ignored `node_modules` directories of `root`, relative, without a trailing slash.
 *
 *  `git ls-files --others --ignored --exclude-standard --directory` lists ignored directories and
 *  STOPS at each one, so it never descends into `node_modules`, `.git`, or ignored build output:
 *  a `node_modules` inside `src-tauri/target/…/app.asar.unpacked/` is not reported, because
 *  `target/` is reported instead. That is the bounded walk the task needs, done by git in 29 ms on
 *  this repo, and it answers "is it ignored" in the same pass. A directory is listed with a
 *  trailing slash; a symlink named `node_modules` is listed without one and is dropped here, and
 *  each result is lstat-checked as a real directory, so a symlink is never followed. */
export async function ignoredNodeModules(root: string): Promise<string[]> {
  let out: string
  try {
    const r = await execFileAsync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], {
      cwd: root, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    })
    out = r.stdout
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of out.split('\0')) {
    if (!entry.endsWith('node_modules/')) continue
    const rel = entry.slice(0, -1)
    if (rel !== 'node_modules' && !rel.endsWith('/node_modules')) continue
    if (rel.split('/').some((seg) => seg === '..' || seg === '')) continue
    try {
      const st = await lstat(join(root, rel))
      if (st.isDirectory() && !st.isSymbolicLink()) found.push(rel)
    } catch { /* gone since git listed it */ }
  }
  return found
}

export interface Mount { mountPoint: string; type: string; local: boolean }

/** The lines of macOS `mount`: `<device> on <mount point> (<type>, <option>, ...)`. The device is
 *  matched up to the first ` on ` and the mount point up to the last ` (`, so a mount point with
 *  spaces or ` on ` in it parses. A line that does not fit is dropped. */
export function parseMountTable(out: string): Mount[] {
  const mounts: Mount[] = []
  for (const line of out.split('\n')) {
    const m = /^.+? on (.+) \(([^()]*)\)$/.exec(line.trim())
    if (!m) continue
    const [type, ...options] = m[2].split(',').map((o) => o.trim())
    if (type) mounts.push({ mountPoint: m[1], type, local: options.includes('local') })
  }
  return mounts
}

/** The local mounts, from `/sbin/mount`. Network and autofs mounts are left out, so looking a path
 *  up never stats a mount point that could wait on a server. */
export async function localMounts(): Promise<Mount[]> {
  const { stdout } = await execFileAsync('/sbin/mount', [], { timeout: 5000, maxBuffer: 1024 * 1024 })
  return parseMountTable(stdout).filter((m) => m.local)
}

/** The file system type name ("apfs", "hfs", "devfs", ...) of the volume holding `path`, or `null`
 *  when it is on no local mount.
 *
 *  statfs(2)'s numeric `f_type` cannot answer this: macOS numbers file systems in the order they
 *  register at boot. APFS was 26 on the Mac this was written on and a different number on the
 *  GitHub macos-14 runner (run 37714505956), where a check against 26 refused every clone. Node
 *  does not expose the type NAME (`f_fstypename`), so it comes from the mount table: the volume is
 *  the mount whose mount point has the same device number as `path`. Matching by device and not by
 *  path prefix is what handles firmlinks: `/Users/...` is on the volume mounted at
 *  `/System/Volumes/Data`. Device numbers are compared as bigints because devfs's is near 2^64. */
export async function volumeType(path: string, mounts?: Mount[]): Promise<string | null> {
  const dev = (await stat(path, { bigint: true })).dev
  for (const m of mounts ?? await localMounts()) {
    try {
      if ((await stat(m.mountPoint, { bigint: true })).dev === dev) return m.type
    } catch { /* unmounted since the table was read, or not readable */ }
  }
  return null
}

/** Why a clone from `src` into `destParent` cannot be a real clone, or `null` when it can.
 *
 *  `cp -c` does NOT fail when cloning is impossible: its man page says it falls back to copyfile(2),
 *  a full copy. Node's `COPYFILE_FICLONE_FORCE` would fail properly but returns ENOSYS on macOS
 *  (tried on this machine, same volume). So the guarantee comes from this gate instead: clonefile(2)
 *  works between any two paths on the same APFS volume, which is exactly what is checked. */
export async function cloneBlockedReason(src: string, destParent: string): Promise<string | null> {
  if (process.platform !== 'darwin') return 'cloning needs APFS on macOS'
  try {
    const mounts = await localMounts()
    const [a, b] = await Promise.all([volumeType(src, mounts), volumeType(destParent, mounts)])
    if (a !== 'apfs' || b !== 'apfs') return 'the checkout is not on an APFS volume'
    const [sa, sb] = await Promise.all([stat(src), stat(destParent)])
    if (sa.dev !== sb.dev) return 'the worktree is on a different volume from the checkout'
  } catch (e) {
    return `cannot inspect the volume: ${e instanceof Error ? e.message : e}`
  }
  return null
}

/** Clone one directory. Killable, so the launch cap holds. */
export type DirCloner = (src: string, dst: string, timeoutMs: number) => Promise<void>

const cpClone: DirCloner = async (src, dst, timeoutMs) => {
  await execFileAsync('/bin/cp', ['-cR', src, dst], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 })
}

export interface DependencyCloneResult {
  cloned: string[]
  /** Not cloned, and why. A directory already present in the worktree is not listed. */
  skipped: Array<{ rel: string; reason: string }>
  ms: number
}

/** Clone every ignored `node_modules` of `sourceRoot` into `worktreePath`. Never throws: a
 *  directory that cannot be cloned is skipped (and any partial clone removed), and the worktree is
 *  kept either way. */
export async function cloneDependencies(
  sourceRoot: string,
  worktreePath: string,
  opts: { capMs?: number; cloner?: DirCloner; blockedReason?: typeof cloneBlockedReason } = {},
): Promise<DependencyCloneResult> {
  const started = Date.now()
  const cap = opts.capMs ?? DEPENDENCY_CLONE_CAP_MS
  const cloner = opts.cloner ?? cpClone
  const blocked = opts.blockedReason ?? cloneBlockedReason
  const result: DependencyCloneResult = { cloned: [], skipped: [], ms: 0 }
  for (const rel of await ignoredNodeModules(sourceRoot)) {
    const src = join(sourceRoot, rel)
    const dst = join(worktreePath, rel)
    if (existsSync(dst)) continue
    const left = cap - (Date.now() - started)
    if (left <= 0) { result.skipped.push({ rel, reason: `the ${Math.round(cap / 1000)}s launch cap was reached` }); continue }
    if (!existsSync(dirname(dst))) { result.skipped.push({ rel, reason: 'its parent directory is not in the worktree' }); continue }
    const reason = await blocked(src, dirname(dst))
    if (reason) { result.skipped.push({ rel, reason }); continue }
    try {
      await cloner(src, dst, left)
      result.cloned.push(rel)
    } catch (e) {
      // A killed or failed `cp` can leave half a tree. Only the destination inside the NEW worktree
      // is removed; the source is never touched.
      await rm(dst, { recursive: true, force: true }).catch(() => {})
      const killed = (e as { killed?: boolean }).killed
      result.skipped.push({ rel, reason: killed ? `timed out after ${Math.round(left / 1000)}s` : `clone failed: ${e instanceof Error ? e.message.split('\n')[0] : e}` })
    }
  }
  result.ms = Date.now() - started
  return result
}

/** The one line a lane sees when a dependency directory was not cloned. `undefined` when there is
 *  nothing to say. */
export function dependencyNote(r: DependencyCloneResult): string | undefined {
  if (!r.skipped.length) return undefined
  const what = r.skipped.map((s) => `${s.rel} (${s.reason})`).join('; ')
  return `node_modules not cloned into this worktree: ${what}. Run npm install where you need it.`
}

/** Clone, log, and attach the result to a create result. */
async function withDependencies(sourceRoot: string, created: WorktreeCreateResult): Promise<WorktreeCreateResult> {
  const deps = await cloneDependencies(sourceRoot, created.path)
  const note = dependencyNote(deps)
  if (deps.cloned.length || deps.skipped.length) {
    console.error(
      `[worktree] ${created.path}: cloned ${deps.cloned.length ? deps.cloned.join(', ') : 'nothing'} in ${deps.ms} ms`
      + (deps.skipped.length ? `; not cloned: ${deps.skipped.map((s) => `${s.rel} (${s.reason})`).join('; ')}` : ''),
    )
  }
  return { ...created, dependencies: { ...deps, note } }
}

export interface Provenance { path: string; createdAt: number; createdBy: string; sourceRepo: string; branch: string; laneId?: string }

const provenanceFile = () => join(operatorDir(), 'worktree-provenance.json')

/** The reaper may only remove what Operator can PROVE it made. That proof is this file, so a
 *  failure to record it is logged rather than swallowed — an unrecorded worktree is one the
 *  cleanup will refuse to touch forever. */
async function recordProvenance(entry: Provenance): Promise<void> {
  await appendProvenance([entry])
}

/** Append records in one write. Also the boot backfill's writer (`worktree-reap.ts`). */
export async function appendProvenance(entries: Provenance[]): Promise<void> {
  if (!entries.length) return
  try {
    const existing = JSON.parse(await readFile(provenanceFile(), 'utf8').catch(() => '[]')) as Provenance[]
    existing.push(...entries)
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
  // NOT a bare `worktree prune`: that expires every missing worktree's record at once, including
  // one on a disk that is merely unmounted (see `dropStaleAdminEntry`). Only the record holding
  // THIS branch, and only if its directory is really gone, is dropped.
  await dropStaleRecordForBranch(root, branch)
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
      return withDependencies(root, reattached)
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
  return withDependencies(root, { path, branch, baseBranch: baseRef })
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
export const containsPath = (parent: string, child: string) => {
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

/** A REGISTERED PROJECT IS NEVER A REMOVAL TARGET. Refuses a path that is, or contains, any project
 *  path in `projects.json`. Lanes without their own worktree run in the project's main checkout, so
 *  a close or cleanup that mistook that checkout for a worktree would delete the project itself.
 *  LIMIT: `loadProjects` reads a missing or corrupt file as `[]`, so then this guard has nothing to
 *  compare against. `dangerousRemovalReason` still refuses the source repo itself and `$HOME`. */
export async function projectPathReason(path: string): Promise<string | null> {
  const projects = await loadProjects()
  for (const p of Array.isArray(projects) ? projects : []) {
    const projectPath = (p as { path?: unknown })?.path
    if (typeof projectPath !== 'string' || !projectPath.trim()) continue
    if (containsPath(path, projectPath)) {
      return samePath(path, projectPath)
        ? `path is a registered project (${projectPath})`
        : `path contains a registered project (${projectPath})`
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
 *  THROUGH THE TRASH, not `git worktree remove`. The directory is renamed into the trash root
 *  (`worktree-trash.ts`), `git worktree prune` drops the admin entry that now points nowhere, and
 *  the recursive delete runs in the background sweep. This replaces both `worktree remove` and
 *  its `--force` fallback. The fallback already discarded uncommitted changes whenever the plain
 *  form refused, so the non-force attempt protected nothing; callers that must keep uncommitted
 *  work run `commitAll` first (reap, merge) or ask the user (Settings).
 *
 *  THE GUARD BELOW IS UNTOUCHED. Every rule in it exists because some path shape would otherwise
 *  have taken something that was not a worktree, and the lifecycle audit named it the one piece
 *  of this system that is already solid. The reaper reuses it rather than reimplementing it.
 *
 *  The durable half of a lane close lives in `worktree-reap.ts`, not here — see
 *  `removeWorktreeDurably` below for why this function is not the one the renderer should call. */
export async function removeWorktree(path: string, sourceRoot: string): Promise<void> {
  const reason = dangerousRemovalReason(path, sourceRoot) ?? await projectPathReason(path)
  if (reason) throw new Error(`Refusing to remove worktree ${path}: ${reason}`)
  const vouched = await gitVouches(path, sourceRoot)
  if (!vouched.ok) throw new Error(`Refusing to remove worktree ${path}: ${vouched.why}`)
  for (const scan of [await nestedRegisteredWorktree(path, sourceRoot), await nestedCheckout(path)]) {
    if (scan.kind === 'nested') throw new Error(`Refusing to remove worktree ${path}: it contains ${scan.what}`)
    if (scan.kind === 'unknown') throw new Error(`Refusing to remove worktree ${path}: cannot rule out a nested checkout — ${scan.why}`)
  }
  await moveToTrash(path)
  // Only THIS worktree's record. A bare `git worktree prune` expires every record whose directory
  // is missing right now, with no grace period (`gc` waits `gc.worktreePruneExpire`, 3 months), so
  // it would also delete the record of a worktree on an unmounted disk — its index, HEAD and
  // reflog — and a detached HEAD's commits there become unreachable.
  await dropStaleAdminEntry(vouched.admin, vouched.worktreesDir, vouched.gitFile)
    .catch((e) => console.error(`[worktree] ${path} is in the trash but its git record was kept:`, e))
  void scheduleSweep()
}

/** Reads a file only if it is a regular file (not a symlink, not a directory). */
export type FileReader = (path: string) => string | null

export const regularFile: FileReader = (path) => {
  try {
    return lstatSync(path).isFile() ? readFileSync(path, 'utf8') : null
  } catch {
    return null
  }
}

/** The admin entry a `.git` file names, resolved against the worktree directory. */
export function gitdirFromGitFile(contents: string, worktreePath: string): string | undefined {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(contents)
  return m ? resolvePath(worktreePath, m[1]) : undefined
}

/** `<worktree>/.git` is a file naming an admin entry that is a DIRECT child of `worktreesDir`, and
 *  that entry's `gitdir` points back at `<worktree>/.git`. The back-reference is what a copied
 *  `.git` file cannot fake. Pure given `read`; pass real paths. */
export function provePairing(worktreePath: string, worktreesDir: string, read: FileReader): boolean {
  const marker = read(join(worktreePath, '.git'))
  if (marker == null) return false
  const admin = gitdirFromGitFile(marker, worktreePath)
  if (!admin || dirname(admin) !== resolvePath(worktreesDir)) return false
  const back = read(join(admin, 'gitdir'))?.split('\n')[0]?.trim()
  if (!back) return false
  return resolvePath(admin, back) === join(resolvePath(worktreePath), '.git')
}

type Vouch =
  | { ok: true; admin: string; worktreesDir: string; gitFile: string }
  | { ok: false; why: string }

/** GIT MUST VOUCH FOR THE PAIR before a directory is removed as a worktree of `sourceRoot`.
 *
 *  `git worktree remove` used to do this check, even with `--force`: it refused a directory that
 *  is not a worktree of the repo, a registered worktree whose `.git` file is broken, and a locked
 *  worktree. The trash rename does not ask git anything, so the same three checks are made here
 *  (Review H1, 2026-09-16). Without them a lane whose agent broke or re-`git init`ed its checkout
 *  was deleted on close with its uncommitted work, because the WIP commit is skipped when status is
 *  invalid. Anything refused here can still be removed from Settings, which treats it as a plain
 *  directory with the unknown-unsaved confirmation. */
export async function gitVouches(path: string, sourceRoot: string): Promise<Vouch> {
  const real = realOf(path)
  let listed: string[]
  try { listed = await registeredWorktrees(sourceRoot) } catch (e) { return { ok: false, why: `git could not list the worktrees of ${sourceRoot}: ${e}` } }
  if (!listed.some((p) => samePath(p, real))) return { ok: false, why: `git does not list it as a worktree of ${sourceRoot}` }
  const common = await gitOk(sourceRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common) return { ok: false, why: `cannot resolve the git directory of ${sourceRoot}` }
  const worktreesDir = join(realOf(common), 'worktrees')
  if (!provePairing(real, worktreesDir, regularFile)) {
    return { ok: false, why: 'its .git file and git\'s worktree record do not point at each other' }
  }
  const gitFile = join(real, '.git')
  const admin = gitdirFromGitFile(regularFile(gitFile)!, real)!
  if (existsSync(join(admin, 'locked'))) return { ok: false, why: 'the worktree is locked (git worktree lock)' }
  return { ok: true, admin, worktreesDir, gitFile }
}

/** Delete ONE admin entry, and only when all of this still holds: it is a direct child of
 *  `worktreesDir`, its `gitdir` names `expectedGitFile`, that path no longer exists, and the entry
 *  is not locked. Throws otherwise; nothing is deleted. */
async function dropStaleAdminEntry(admin: string, worktreesDir: string, expectedGitFile: string): Promise<void> {
  if (dirname(admin) !== worktreesDir) throw new Error(`${admin} is not directly under ${worktreesDir}`)
  const back = regularFile(join(admin, 'gitdir'))?.split('\n')[0]?.trim()
  if (!back || resolvePath(admin, back) !== expectedGitFile) throw new Error(`${admin} does not point at ${expectedGitFile}`)
  if (existsSync(expectedGitFile) || existsSync(dirname(expectedGitFile))) throw new Error(`${dirname(expectedGitFile)} still exists`)
  if (existsSync(join(admin, 'locked'))) throw new Error(`${admin} is locked`)
  await rm(admin, { recursive: true, force: true })
}

/** Reattach: drop the stale record that still holds `branch`, so `worktree add` accepts it. Only a
 *  record whose directory is gone; a present directory means the branch is really checked out. */
async function dropStaleRecordForBranch(root: string, branch: string): Promise<void> {
  const out = await gitOk(root, ['worktree', 'list', '--porcelain'])
  const common = await gitOk(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (out == null || !common) return
  const worktreesDir = join(realOf(common), 'worktrees')
  for (const block of out.split(/\n\s*\n/)) {
    const wtPath = /^worktree (.+)$/m.exec(block)?.[1]?.trim()
    if (!wtPath || !block.includes(`\nbranch refs/heads/${branch}\n`) && !block.endsWith(`\nbranch refs/heads/${branch}`)) continue
    if (existsSync(wtPath)) return
    let entries: string[] = []
    try { entries = await readdir(worktreesDir) } catch { return }
    for (const name of entries) {
      const admin = join(worktreesDir, name)
      const back = regularFile(join(admin, 'gitdir'))?.split('\n')[0]?.trim()
      if (back && resolvePath(admin, back) === join(wtPath, '.git')) {
        await dropStaleAdminEntry(admin, worktreesDir, join(wtPath, '.git')).catch(() => {})
      }
    }
  }
}

/** Remove a directory under the worktree root WITHOUT git — for a directory whose source repo is
 *  gone, or that git cannot read. Same guard, same nested-checkout walk, same trash path. Refuses
 *  anything that is not a direct child of `~/.operator/worktrees`. */
export async function removePlainDirectory(path: string): Promise<void> {
  const root = worktreeRoot()
  const real = realOf(path)
  if (realOf(resolvePath(real, '..')) !== realOf(root)) {
    throw new Error(`Refusing to remove ${path}: it is not directly under ${root}`)
  }
  const reason = dangerousRemovalReason(path) ?? await projectPathReason(path)
  if (reason) throw new Error(`Refusing to remove ${path}: ${reason}`)
  const scan = await nestedCheckout(path)
  if (scan.kind === 'nested') throw new Error(`Refusing to remove ${path}: it contains ${scan.what}`)
  if (scan.kind === 'unknown') throw new Error(`Refusing to remove ${path}: cannot rule out a nested checkout — ${scan.why}`)
  await moveToTrash(path)
  void scheduleSweep()
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

/** A running terminal as main's pty table reports it (`TerminalManager.liveTerminals`). */
export interface LivePty { id: string; cwd: string; roleId?: string }

/** Who merge and discard must not pull a checkout out from under. `ptys` is main's pty table, never
 *  `sessions.json`. `exceptTerminalId` is the one lane the caller is merging or discarding ON
 *  PURPOSE and ends straight after (the session's own Diff panel); every other live lane blocks. */
export interface LiveGuard { ptys: readonly LivePty[]; exceptTerminalId?: string }

/** The first live terminal whose cwd is one of `paths` or inside it, other than the exempt one. Pure
 *  given the paths (`containsPath` resolves symlinks). */
export function liveLaneIn(paths: readonly string[], guard: LiveGuard): LivePty | undefined {
  return guard.ptys.find((p) => p.id !== guard.exceptTerminalId && paths.some((path) => path && containsPath(path, p.cwd)))
}

/** The refusal, naming the lane. */
export function liveLaneRefusal(verb: 'merge' | 'discard', lane: LivePty, branch: string): string {
  const who = `lane ${lane.id}${lane.roleId ? ` (${lane.roleId})` : ''}`
  return `Refused to ${verb} ${branch}: ${who} is running in ${lane.cwd}, which has ${branch} checked out, `
    + `and ${verb === 'merge' ? 'merging' : 'discarding'} would remove that checkout from under it. Close that lane first.`
}

/** Every worktree of `sourceRoot` that has `branch` checked out, from git's own list. */
async function checkoutsOf(sourceRoot: string, branch: string): Promise<string[]> {
  const out = await gitOk(sourceRoot, ['worktree', 'list', '--porcelain'])
  if (out == null) return []
  return out.split(/\n\s*\n/)
    .filter((block) => block.split('\n').some((l) => l.trim() === `branch refs/heads/${branch}`))
    .map((block) => /^worktree (.+)$/m.exec(block)?.[1]?.trim())
    .filter((p): p is string => !!p)
}

/** THE LIVE-LANE REFUSAL for merge and discard (dev/results/mantel-55da80-gutted-2026-09-25.md).
 *  Both remove the worktree at `worktreePath`, and a branch can also be checked out in another
 *  worktree than the one the caller named. Either one with a running terminal in it refuses. */
async function liveLaneBlocking(worktreePath: string, sourceRoot: string, branch: string, guard: LiveGuard): Promise<LivePty | undefined> {
  if (!guard.ptys.length) return undefined
  return liveLaneIn([worktreePath, ...await checkoutsOf(sourceRoot, branch)], guard)
}

/** `git` without trimming: `-z` status output starts with a status column that may be a space. */
const gitRawOk = async (cwd: string, args: string[]): Promise<string | null> =>
  execFileAsync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout, () => null)

/** `status --porcelain=v1 -z`: each entry's XY and path; a rename's source path is skipped. */
function statusEntries(out: string): Array<{ xy: string; path: string }> {
  const fields = out.split('\0')
  const entries: Array<{ xy: string; path: string }> = []
  for (let i = 0; i < fields.length; i++) {
    if (fields[i].length < 4) continue
    const xy = fields[i].slice(0, 2)
    entries.push({ xy, path: fields[i].slice(3) })
    if (xy[0] === 'R' || xy[0] === 'C') i++
  }
  return entries
}

/** Every path a merge of `branch` would write into the source checkout, plus the worktree's
 *  uncommitted files when they are about to be committed into it. `null` when git cannot say. */
async function pathsTheMergeWrites(worktreePath: string, sourceRoot: string, branch: string, baseBranch: string, withPending: boolean): Promise<Set<string> | null> {
  const committed = await gitOk(sourceRoot, ['diff', '--name-only', '--no-renames', `${baseBranch}...${branch}`])
  if (committed == null) return null
  const paths = new Set(committed.split('\n').filter(Boolean))
  if (withPending && worktreePath && existsSync(worktreePath)) {
    const pending = await gitRawOk(worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'])
    if (pending == null) return null
    for (const e of statusEntries(pending)) paths.add(e.path)
  }
  return paths
}

/** Why the source checkout is in no state to take this merge; `null` when it is.
 *
 *  A TRACKED change blocks, as before: `git merge` would mix it into the merge result. An UNTRACKED
 *  file blocks only when the merge would write that same path (Review, N1 "related"): the main
 *  checkout of this project always holds untracked `dev/results` files that no lane touches, and
 *  counting them refused nearly every merge. */
async function sourceBlocksMerge(worktreePath: string, sourceRoot: string, branch: string, baseBranch: string, withPending: boolean): Promise<string | null> {
  const status = await gitRawOk(sourceRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (status == null) return `git could not read the status of ${sourceRoot}.`
  const entries = statusEntries(status)
  const tracked = entries.filter((e) => e.xy !== '??')
  if (tracked.length) {
    return `Source repo has uncommitted changes (${tracked.slice(0, 3).map((e) => e.path).join(', ')}${tracked.length > 3 ? ', …' : ''}) — commit or stash before merging.`
  }
  const untracked = entries.filter((e) => e.xy === '??').map((e) => e.path)
  if (!untracked.length) return null
  const writes = await pathsTheMergeWrites(worktreePath, sourceRoot, branch, baseBranch, withPending)
  if (writes == null) return 'git could not list what the merge would write, so the untracked files in the source repo cannot be ruled out.'
  const clash = untracked.filter((p) => writes.has(p))
  return clash.length
    ? `The merge would overwrite untracked file${clash.length === 1 ? '' : 's'} in the source repo: ${clash.slice(0, 3).join(', ')}${clash.length > 3 ? ', …' : ''}. Move or commit ${clash.length === 1 ? 'it' : 'them'} first.`
    : null
}

/** What a merge or discard does to the lane being merged on purpose, AFTER every refusal has passed
 *  (Review N1): stop it, so nothing more is written into the worktree. Absent = no lane to stop.
 *  `commitMessage` asks for the worktree's uncommitted files to be committed after the stop and
 *  before the merge; without it nothing is committed (the caller did its own). */
export interface LaneStop { stopLane?: () => Promise<void>; commitMessage?: string }

export async function mergeBranch(worktreePath: string, sourceRoot: string, branch: string, baseBranch: string, guard: LiveGuard, lane: LaneStop = {}): Promise<{ ok: boolean; message?: string }> {
  // EVERY REFUSAL FIRST (Review N1). A refused merge leaves the repo exactly as it was, and leaves
  // the lane being merged running and untouched: it is stopped only once nothing can refuse.
  const blocking = await liveLaneBlocking(worktreePath, sourceRoot, branch, guard)
  if (blocking) return { ok: false, message: liveLaneRefusal('merge', blocking, branch) }
  for (const ref of [branch, baseBranch]) {
    if (await gitOk(sourceRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`]) == null) {
      return { ok: false, message: `Branch ${ref} does not exist in ${sourceRoot}.` }
    }
  }
  const blocked = await sourceBlocksMerge(worktreePath, sourceRoot, branch, baseBranch, lane.commitMessage !== undefined)
  if (blocked) return { ok: false, message: blocked }
  const current = await gitOk(sourceRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (current && current !== baseBranch) {
    try { await git(sourceRoot, ['checkout', baseBranch]) } catch (e) { return { ok: false, message: `Could not switch to ${baseBranch}: ${e}` } }
  }

  // Nothing refuses from here on. Stop the lane, then commit what the worktree holds NOW — anything it
  // wrote up to the moment it stopped — so the merge takes all of it (Review finding 1).
  if (lane.stopLane) await lane.stopLane()
  if (lane.commitMessage !== undefined && worktreePath && existsSync(worktreePath)) {
    try { await commitAll(worktreePath, lane.commitMessage) } catch (e) {
      return { ok: false, message: `Commit failed: ${e}` }
    }
  }
  try {
    await git(sourceRoot, ['merge', '--no-ff', '-m', `Merge ${branch}`, branch])
  } catch (e) {
    // Leave the repo as we found it rather than mid-conflict.
    await gitOk(sourceRoot, ['merge', '--abort'])
    return { ok: false, message: `Merge failed: ${e}` }
  }
  // KEEP A WORKTREE THAT STILL HOLDS UNCOMMITTED WORK (Review finding 1). The merge took only what
  // was committed; removing the directory now would send anything written since into the trash. A
  // status git cannot read counts as uncommitted.
  if (worktreePath && existsSync(worktreePath)) {
    const left = await gitOk(worktreePath, ['status', '--porcelain'])
    if (left == null || left) {
      const n = left ? left.split('\n').filter(Boolean).length : undefined
      return {
        ok: true,
        message: `Merged ${branch} into ${baseBranch}. The worktree was kept, because ${n === undefined ? 'git could not read its status' : `it has ${n} uncommitted file${n === 1 ? '' : 's'}`}: ${worktreePath}`,
      }
    }
  }
  // Best-effort: the merge is what the caller asked for and it succeeded; a worktree that
  // refuses to be removed (the guard above) must not turn that into a failure.
  await removeWorktree(worktreePath, sourceRoot).catch(() => {})
  return { ok: true }
}

export async function discardBranch(worktreePath: string, sourceRoot: string, branch: string, guard: LiveGuard, lane: LaneStop = {}): Promise<void> {
  // Refusal first; the lane being discarded is stopped only once nothing can refuse (Review N1).
  const blocking = await liveLaneBlocking(worktreePath, sourceRoot, branch, guard)
  if (blocking) throw new Error(liveLaneRefusal('discard', blocking, branch))
  if (lane.stopLane) await lane.stopLane()
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
