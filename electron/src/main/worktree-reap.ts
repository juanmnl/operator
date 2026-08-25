// Worktree reaping — the classifier, the plan, and the two triggers that were missing.
//
// Built from `dev/results/worktree-lifecycle-audit.md`, which measured the damage: 107
// directories, 34.0 GB, up from 66/21 GB three weeks earlier. 71 of those (28.4 GB) had no
// session record at all — directories that survived because nothing ever ran a removal, not
// because a removal was refused.
//
// THE AUDIT'S CENTRAL FINDING SHAPES THIS FILE: the removal logic is not what is broken.
// `dangerousRemovalReason` and `removeWorktree` in `worktree.ts` are careful and well-tested and
// are reused here UNTOUCHED. What was missing was every trigger that should have called them —
// nothing on quit, nothing at boot, nothing durable behind the one renderer-JS call site — and a
// classifier to decide what may be touched at all. That is what this module adds.
//
// WHAT IS SAFE TO REMOVE WITHOUT ASKING, restated from the audit's policy section:
//   merged into the source repo's default branch + clean (after `commitAll`, which is a no-op on
//   a clean tree) + attributable to a provenance record + not live-claimed, plus pure creation
//   debris. Everything else is an ASK — returned in the plan, never removed.
//
// PROVENANCE IS THE PROOF. `worktree.ts:79-81` states the rule this file obeys: "the reaper may
// only remove what Operator can PROVE it made." A directory with no provenance record is not
// silently skipped forever (that was defect #6) — it is surfaced as `unattributed` for a human
// to stand in for the missing proof.
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rename, writeFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { operatorDir } from './store'
import { commitAll, dangerousRemovalReason, removeWorktree } from './worktree'

const execFileAsync = promisify(execFile)

/** ARMED? No — and this is the one switch that decides whether this module can delete anything.
 *
 *  The reaper was built and landed dry-run-only on purpose: the plan it produces is a claim about
 *  34 GB of the user's work, and the right order is to look at the claim before acting on it. The
 *  Settings page renders the plan; the boot and quit triggers compute it and log it; nothing
 *  calls `removeWorktree` until this is flipped or a caller passes `dryRun: false` explicitly
 *  (which today only the Settings button does, and only when the user presses it).
 *
 *  Flip to `true` after the plan has been reviewed on a real machine and the auto tier looks
 *  right. Nothing else needs to change. */
const AUTO_REAP_ON_TRIGGERS = false

const worktreeRoot = () => join(operatorDir(), 'worktrees')
const provenanceFile = () => join(operatorDir(), 'worktree-provenance.json')
const pendingFile = () => join(operatorDir(), 'worktree-pending.json')

/** Anything at or under this is "no real content" for debris purposes. A `.vite` cache dir or a
 *  single stray `a.txt` from an interrupted `worktree add` lands well inside it; a real checkout
 *  never does — the smallest real worktree in the audit's snapshot was orders of magnitude
 *  larger. */
const DEBRIS_MAX_BYTES = 2 * 1024 * 1024

/** The eight classes.
 *
 *  The audit names seven; `corrupt` is the eighth and it comes from the audit's own policy
 *  section ("git-corrupt but registered or provenance-attributable … something is wrong with
 *  these that a script shouldn't paper over silently"). Folding it into one of the other seven
 *  would have meant labelling it with a reason that isn't true. */
export type ReapClass =
  /** A lane is open in it right now, per `sessions.json`. Never touched, under any policy. */
  | 'live-claimed'
  /** Merged into the source repo's default branch, working tree clean. THE AUTO TIER. */
  | 'merged-clean'
  /** Merged, but with uncommitted changes. Auto too — but only after `commitAll` preserves
   *  them, which is what stops a blunt "any porcelain output = don't touch" rule from
   *  quarantining 35 directories over a single modified `CLAUDE.md`. */
  | 'merged-dirty'
  /** A real, unlanded branch. Only the person who wrote it can say whether it is still wanted. */
  | 'unmerged'
  /** No provenance record — Operator cannot prove it made this. Surfaced, never auto-removed. */
  | 'unattributed'
  /** Interrupted `worktree add` leftovers: git-invalid, no provenance, unregistered, ~empty. */
  | 'debris'
  /** The source repo is gone from disk. No git command can ever reason about these again. */
  | 'dead-source-repo'
  /** git-invalid, but with a live source repo or a provenance record behind it. */
  | 'corrupt'

/** Everything the classifier needs about one directory, and nothing it doesn't.
 *
 *  A plain data record on purpose: the classification rules are the part most likely to be wrong
 *  and the part hardest to exercise against a real disk, so they are a pure function of this
 *  table and the tests hand it fabricated rows. */
export interface WorktreeFacts {
  path: string
  /** Bytes on disk. `0` when sizes were not collected (the boot/quit sweeps skip them). */
  sizeBytes: number
  /** `git rev-parse HEAD` works inside the directory. */
  gitValid: boolean
  branch?: string
  /** `git status --porcelain` produced output. */
  dirty: boolean
  /** Listed by `git worktree list` in its source repo. */
  registered: boolean
  /** Branch is an ancestor of the source repo's default branch. `undefined` = could not tell. */
  merged?: boolean
  /** The provenance record, if `worktree-provenance.json` has one for this path. */
  provenance?: { sourceRepo: string; createdAt: number; branch: string }
  /** The source repo still exists on disk. */
  sourceRepoExists: boolean
  /** `sessions.json` has a session in this directory carrying a `terminalId`. */
  liveTerminalId?: string
  /** `dangerousRemovalReason(path, sourceRepo)` — reused untouched from `worktree.ts`. */
  guardReason: string | null
}

export interface ReapEntry {
  path: string
  cls: ReapClass
  sizeBytes: number
  branch?: string
  sourceRepo?: string
  /** True when this entry is in the automatic tier. */
  auto: boolean
  /** Why it is not in the automatic tier — shown verbatim in the Settings list. */
  reason: string
  /** `commitAll` must run before removal to preserve uncommitted work. */
  needsCommit: boolean
}

export interface ReapPlan {
  entries: ReapEntry[]
  /** The automatic tier, split out because it is what the one button acts on. */
  auto: ReapEntry[]
  asks: ReapEntry[]
  totalBytes: number
  autoBytes: number
  /** Set when sizes were not collected, so the UI does not render "0 GB" as a fact. */
  sizesOmitted: boolean
}

/** THE CLASSIFIER. Pure, and the order of these rules is the policy.
 *
 *  Precedence matters more than the individual rules and is worth stating outright:
 *
 *  1. `live-claimed` first, so nothing below can ever out-argue an open lane.
 *  2. `debris` next — the ONE class that is not a git question. Size and provenance separate an
 *     interrupted create from a real worktree that broke, and neither test needs the source repo,
 *     so an 8 KB husk stays an automatic removal even when its repo is also gone.
 *  3. `dead-source-repo`, because every rule after it asks git something that needs the source
 *     repo to exist — answering those with "no" would call a dead directory unmerged and be
 *     wrong twice.
 *  4. `corrupt` for what is left that git cannot read: a real worktree that broke.
 *  5. `unattributed` before any merge-based class, because attribution is the GATE on the
 *     automatic tier. A merged, clean, unattributable directory is an ask, not an auto — the
 *     codebase's own stated rule is that the reaper removes only what it can prove it made. */
export function classify(f: WorktreeFacts): ReapClass {
  if (f.liveTerminalId) return 'live-claimed'
  // Debris is tested BEFORE the dead-repo rule, and only because it is not a git question.
  // A directory that is git-invalid, unregistered, unattributed AND under a couple of megabytes
  // is an interrupted `worktree add` whatever its `.git` pointer names — the audit's phrase is
  // "zero risk, zero value in asking". Ordering it after the dead-repo rule turned
  // `.tmpIBNq7t-d96ee0` (8 KB, one stray file) into something a human has to adjudicate, which
  // is the opposite of the point.
  const inert = !f.gitValid && f.sizeBytes <= DEBRIS_MAX_BYTES && !f.provenance && !f.registered
  if (inert) return 'debris'
  if (!f.sourceRepoExists) return 'dead-source-repo'
  if (!f.gitValid) return 'corrupt'
  if (!f.provenance) return 'unattributed'
  // `merged === undefined` means git could not answer. An unknown is not a "no" — but it is
  // certainly not grounds to delete, and `unmerged` is the class whose whole meaning is "ask a
  // human", which is the right destination for a question we could not answer.
  if (f.merged !== true) return 'unmerged'
  return f.dirty ? 'merged-dirty' : 'merged-clean'
}

/** One sentence per class, written here so the Settings list and any log line say the same
 *  thing. The auto tier's sentences describe what WILL happen; the asks describe what is
 *  blocking. */
function describe(cls: ReapClass, f: WorktreeFacts): string {
  switch (cls) {
    case 'live-claimed': return `A lane is open here (${f.liveTerminalId}).`
    case 'merged-clean': return 'Merged and clean — safe to remove; the branch is kept.'
    case 'merged-dirty': return 'Merged, with uncommitted changes — they are committed to the branch first, then the directory goes.'
    case 'unmerged': return f.merged === undefined
      ? `Could not tell whether ${f.branch ?? 'this branch'} is merged.`
      : `${f.branch ?? 'This branch'} is not merged into the default branch.`
    case 'unattributed': return 'No provenance record — Operator cannot prove it created this.'
    case 'debris': return 'Leftover from an interrupted worktree creation.'
    case 'dead-source-repo': return 'Its source repository no longer exists on disk; git cannot reason about it.'
    case 'corrupt': return 'Not a valid git worktree any more.'
  }
}

/** Which classes the automatic tier contains — and every other condition it also requires.
 *
 *  The guard is checked HERE, not only at removal time, so a directory the guard would refuse
 *  never appears in the plan's auto count. A button that says "Remove 24 safe worktrees" and
 *  then removes 23 is a worse button than one that says 23. */
function isAuto(cls: ReapClass, f: WorktreeFacts): boolean {
  if (f.guardReason) return false
  if (f.liveTerminalId) return false
  return cls === 'merged-clean' || cls === 'merged-dirty' || cls === 'debris'
}

/** Build the plan from a fabricated or gathered table. Pure. */
export function reapPlanFrom(facts: readonly WorktreeFacts[], sizesOmitted = false): ReapPlan {
  const entries: ReapEntry[] = facts.map((f) => {
    const cls = classify(f)
    const auto = isAuto(cls, f)
    return {
      path: f.path,
      cls,
      sizeBytes: f.sizeBytes,
      branch: f.branch ?? f.provenance?.branch,
      sourceRepo: f.provenance?.sourceRepo,
      auto,
      // The guard's own sentence wins when it is the blocker: it is more specific than anything
      // the class could say, and it is the reason a human most needs to see.
      reason: f.guardReason ? `Refused: ${f.guardReason}` : describe(cls, f),
      needsCommit: cls === 'merged-dirty',
    }
  })
  const auto = entries.filter((e) => e.auto)
  return {
    entries,
    auto,
    asks: entries.filter((e) => !e.auto),
    totalBytes: entries.reduce((n, e) => n + e.sizeBytes, 0),
    autoBytes: auto.reduce((n, e) => n + e.sizeBytes, 0),
    sizesOmitted,
  }
}

// ── gathering the facts ──────────────────────────────────────────────────────────────────────

const git = async (cwd: string, args: string[]): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 })
    return stdout.trim()
  } catch {
    return null
  }
}

/** `du -sk` over the worktree root's children in ONE call.
 *
 *  Per-directory `du` across 107 trees of `node_modules` is a full stat walk each time; one call
 *  is the same work once. Skipped entirely by the boot and quit sweeps — the auto tier's decision
 *  does not depend on size, only its presentation does, and quit must not wait on a 34 GB stat
 *  walk. */
async function sizesOf(root: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  try {
    const { stdout } = await execFileAsync('/bin/sh', ['-c', `du -sk "${root}"/* 2>/dev/null`], {
      maxBuffer: 8 * 1024 * 1024,
    })
    for (const line of stdout.split('\n')) {
      const m = /^(\d+)\s+(.*)$/.exec(line.trim())
      if (m) out.set(m[2], Number(m[1]) * 1024)
    }
  } catch { /* sizes are presentation, never a blocker */ }
  return out
}

/** The source repo a worktree points at, read from its OWN `.git` file.
 *
 *  A linked worktree's `.git` is not a directory — it is a one-line file:
 *
 *      gitdir: /Users/j/Developer/repo/.git/worktrees/repo-abc123
 *
 *  This is the ONLY way to name the source repo of a directory that has no provenance record,
 *  and without it the `dead-source-repo` class is unreachable for exactly the directories it was
 *  written for. The audit's four `uwazi_2026-*` dirs (471 MB, source repo deleted) have no
 *  provenance — they predate the current scheme — so a provenance-only lookup classified them as
 *  merely `corrupt`, which is both wrong and, worse, wrong in a way that hides the one case the
 *  audit says a human must decide.
 *
 *  Pure, so the parse is testable without a filesystem. */
export function sourceRepoFromGitFile(contents: string): string | undefined {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(contents)
  if (!m) return undefined
  // `<repo>/.git/worktrees/<name>` → `<repo>`. Anything else is not a linked worktree pointer.
  const at = m[1].indexOf('/.git/worktrees/')
  return at > 0 ? m[1].slice(0, at) : undefined
}

interface ProvenanceRecord { path: string; createdAt: number; sourceRepo: string; branch: string }

async function loadProvenance(): Promise<Map<string, ProvenanceRecord>> {
  const out = new Map<string, ProvenanceRecord>()
  try {
    const raw = JSON.parse(await readFile(provenanceFile(), 'utf8')) as ProvenanceRecord[]
    // LAST entry wins: a reattached worktree appends a second record for the same path, and the
    // newer one names the branch it actually came back on.
    for (const r of Array.isArray(raw) ? raw : []) {
      if (r && typeof r.path === 'string') out.set(r.path, r)
    }
  } catch { /* absent or corrupt = nothing is attributable, which the classifier handles */ }
  return out
}

/** Directories with a live lane in them, from `sessions.json`.
 *
 *  THE HONEST LIMITATION, restated from the audit so it is not lost: this is "sessions.json said
 *  so as of its last write", not a re-verification against the live process table. Verifying that
 *  would need per-pid `lsof`, which this project forbids for the TCC-prompt reason. It is
 *  therefore a FLOOR on what is live — which is the safe direction for it to be wrong in. */
async function liveClaims(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  try {
    const raw = JSON.parse(await readFile(join(operatorDir(), 'sessions.json'), 'utf8')) as unknown[]
    for (const s of Array.isArray(raw) ? raw : []) {
      const r = s as { cwd?: unknown; terminalId?: unknown }
      if (typeof r?.cwd === 'string' && typeof r.terminalId === 'string' && r.terminalId) {
        out.set(r.cwd, r.terminalId)
      }
    }
  } catch { /* no roster = nothing claimed */ }
  return out
}

/** Read the disk and answer the classifier's questions for every worktree directory.
 *
 *  Never throws: this runs at boot and on quit, and a reaper that can throw is a launch or a quit
 *  that can hang. Every probe that fails answers in the direction of "do not touch". */
export async function gatherFacts(opts: { withSizes?: boolean } = {}): Promise<WorktreeFacts[]> {
  const root = worktreeRoot()
  let names: string[]
  try {
    names = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
  const [provenance, claims, sizes] = await Promise.all([
    loadProvenance(),
    liveClaims(),
    opts.withSizes ? sizesOf(root) : Promise.resolve(new Map<string, number>()),
  ])

  // One `git branch --merged` per SOURCE REPO, not per worktree: 107 directories share a handful
  // of repos, and the merged set is a property of the repo.
  const mergedCache = new Map<string, Set<string> | null>()
  const registeredCache = new Map<string, Set<string> | null>()

  return Promise.all(names.map(async (name): Promise<WorktreeFacts> => {
    const path = join(root, name)
    const prov = provenance.get(path)
    // Provenance first (it is the attribution record), then the directory's own `.git` pointer.
    // The second is not attribution — it does not make a directory removable — but it is what
    // makes `dead-source-repo` reachable for the directories that have no provenance at all.
    const pointedAt = await readFile(join(path, '.git'), 'utf8').then(sourceRepoFromGitFile).catch(() => undefined)
    const sourceRepo = prov?.sourceRepo ?? pointedAt
    const sourceRepoExists = sourceRepo ? existsSync(sourceRepo) : true

    const head = await git(path, ['rev-parse', 'HEAD'])
    const gitValid = head != null
    const branch = gitValid ? (await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])) ?? undefined : undefined
    const status = gitValid ? await git(path, ['status', '--porcelain']) : null

    let merged: boolean | undefined
    let registered = false
    if (gitValid && sourceRepo && sourceRepoExists) {
      if (!mergedCache.has(sourceRepo)) mergedCache.set(sourceRepo, await mergedBranches(sourceRepo))
      if (!registeredCache.has(sourceRepo)) registeredCache.set(sourceRepo, await registeredPaths(sourceRepo))
      const mergedSet = mergedCache.get(sourceRepo)
      merged = mergedSet && branch ? mergedSet.has(branch) : undefined
      registered = registeredCache.get(sourceRepo)?.has(path) ?? false
    }

    return {
      path,
      sizeBytes: sizes.get(path) ?? 0,
      gitValid,
      branch,
      dirty: !!status,
      registered,
      merged,
      provenance: prov ? { sourceRepo: prov.sourceRepo, createdAt: prov.createdAt, branch: prov.branch } : undefined,
      sourceRepoExists,
      liveTerminalId: claims.get(path),
      // REUSED UNTOUCHED from worktree.ts. It is the one piece of this system the audit calls
      // already solid, and the plan asks it the same question the removal will ask.
      guardReason: dangerousRemovalReason(path, sourceRepo),
    }
  }))
}

/** Branch names already merged into the repo's default branch. `null` when git could not say,
 *  which the classifier reads as "ask a human" rather than as "not merged". */
async function mergedBranches(repo: string): Promise<Set<string> | null> {
  const base = await defaultBranchOf(repo)
  if (!base) return null
  const out = await git(repo, ['branch', '--merged', base, '--format=%(refname:short)'])
  if (out == null) return null
  return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))
}

async function defaultBranchOf(repo: string): Promise<string | null> {
  const named = (await git(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']))?.split('/').pop()
  for (const name of [named, 'main', 'master'].filter((n): n is string => !!n)) {
    if (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]) != null) return name
  }
  return null
}

async function registeredPaths(repo: string): Promise<Set<string> | null> {
  const out = await git(repo, ['worktree', 'list', '--porcelain'])
  if (out == null) return null
  return new Set(out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9).trim()))
}

/** The plan, gathered and classified. This is what the bridge call returns. */
export async function reapPlan(opts: { withSizes?: boolean } = {}): Promise<ReapPlan> {
  const facts = await gatherFacts(opts)
  return reapPlanFrom(facts, !opts.withSizes)
}

// ── the pending-removal record ───────────────────────────────────────────────────────────────
//
// DEFECT #2 IN THE AUDIT, and the reason this is a file rather than a promise: lane-close removal
// lived entirely in an un-awaited `void finishTasks.then(...)` chain in renderer JS. The renderer
// is killed and respawned under memory pressure roughly hourly on this machine, and anything in
// that chain when it happens is simply gone — a directory correctly scheduled for removal and
// then orphaned forever.
//
// So the DURABLE part moves to main: before a removal is attempted, the intent is written here;
// after it succeeds, the record is dropped. Anything still in this file at boot or at quit is a
// removal that was requested and never finished, and it is retried.

export interface PendingRemoval {
  path: string
  sourceRepo: string
  branch?: string
  requestedAt: number
  /** Why it was queued, for the log — a lane close, a dismissed ended tab, a boot sweep. */
  reason: string
}

export async function loadPending(): Promise<PendingRemoval[]> {
  try {
    const raw = JSON.parse(await readFile(pendingFile(), 'utf8')) as PendingRemoval[]
    return Array.isArray(raw) ? raw.filter((r) => r && typeof r.path === 'string' && typeof r.sourceRepo === 'string') : []
  } catch {
    return []
  }
}

async function writePending(list: PendingRemoval[]): Promise<void> {
  const path = pendingFile()
  try {
    if (!list.length) { await unlink(path).catch(() => {}); return }
    await mkdir(operatorDir(), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
    await rename(tmp, path)
  } catch (e) {
    console.error('[reap] could not write the pending-removal record:', e)
  }
}

/** Record the INTENT to remove, before anything is attempted. Idempotent per path. */
export async function queueRemoval(entry: PendingRemoval): Promise<void> {
  const existing = await loadPending()
  if (existing.some((e) => e.path === entry.path)) return
  await writePending([...existing, entry])
}

export async function clearPending(path: string): Promise<void> {
  const existing = await loadPending()
  const next = existing.filter((e) => e.path !== path)
  if (next.length !== existing.length) await writePending(next)
}

/** Retry every removal that was requested and never finished.
 *
 *  A record whose directory is already gone is simply dropped — the removal did happen, we just
 *  never got to clear the record, which is the ordinary outcome of the crash this exists for. */
export async function drainPending(dryRun: boolean): Promise<{ removed: string[]; failed: string[]; pending: number }> {
  const list = await loadPending()
  const removed: string[] = []
  const failed: string[] = []
  for (const entry of list) {
    if (!existsSync(entry.path)) { await clearPending(entry.path); continue }
    if (dryRun) continue
    try {
      await removeWorktree(entry.path, entry.sourceRepo)
      await clearPending(entry.path)
      removed.push(entry.path)
    } catch (e) {
      // Left in the file deliberately: a removal the guard refuses is not a transient failure,
      // and it will be refused again — but it is also exactly the thing a human should see in
      // the plan rather than have retried silently into the void.
      console.error(`[reap] pending removal of ${entry.path} failed:`, e)
      failed.push(entry.path)
    }
  }
  return { removed, failed, pending: (await loadPending()).length }
}

// ── the reap itself ──────────────────────────────────────────────────────────────────────────

export interface ReapResult {
  plan: ReapPlan
  removed: string[]
  failed: Array<{ path: string; error: string }>
  bytesFreed: number
  dryRun: boolean
}

/** Remove the automatic tier. `dryRun` computes and reports without touching anything.
 *
 *  `commitAll` runs on EVERY entry, not just the dirty ones — it is a documented no-op on a clean
 *  tree, and running it unconditionally means the "was it clean?" answer cannot go stale between
 *  the plan and the removal. If the commit fails, the directory is skipped rather than removed:
 *  the whole point of committing first is that no uncommitted work is lost, and a failed commit
 *  means that promise cannot be kept. */
export async function reap(opts: { dryRun?: boolean; withSizes?: boolean } = {}): Promise<ReapResult> {
  const dryRun = opts.dryRun !== false
  const plan = await reapPlan({ withSizes: opts.withSizes })
  const result: ReapResult = { plan, removed: [], failed: [], bytesFreed: 0, dryRun }
  if (dryRun) return result

  for (const entry of plan.auto) {
    if (!entry.sourceRepo) {
      // Debris has no source repo and no git to remove it with; it is also the only class where
      // that is expected. Everything else in the auto tier is attributable by construction.
      result.failed.push({ path: entry.path, error: 'no source repo recorded' })
      continue
    }
    try {
      if (entry.cls !== 'debris') {
        await commitAll(entry.path, 'WIP preserved before reaping this worktree')
      }
      await removeWorktree(entry.path, entry.sourceRepo)
      result.removed.push(entry.path)
      result.bytesFreed += entry.sizeBytes
    } catch (e) {
      result.failed.push({ path: entry.path, error: String(e) })
    }
  }
  return result
}

/** Queue a removal for every ended session that has no lane running in it.
 *
 *  DEFECT #3: `onTerminalExit` deliberately leaves an ended tab mounted so its final output stays
 *  readable, and the only thing that can remove its worktree afterwards is the user dismissing
 *  that tab — renderer-only state that does not survive a restart. So at boot, a session whose
 *  worktree still exists and which is not claimed by any live lane has already lost its last
 *  chance; queueing it here is that chance, moved somewhere durable.
 *
 *  The BRANCH SURVIVES either way — this queues the same directory-only removal a lane close
 *  performs, which is what a suspended lane's reattach path expects to find. */
export async function queueEndedSessions(): Promise<number> {
  try {
    const raw = JSON.parse(await readFile(join(operatorDir(), 'sessions.json'), 'utf8')) as unknown[]
    if (!Array.isArray(raw)) return 0
    let queued = 0
    for (const s of raw) {
      const r = s as { cwd?: unknown; sourceCwd?: unknown; worktreeBranch?: unknown; terminalId?: unknown }
      if (typeof r?.cwd !== 'string' || typeof r.sourceCwd !== 'string') continue
      if (typeof r.worktreeBranch !== 'string' || !r.worktreeBranch) continue
      // A `terminalId` means the roster believes a lane is open in it. At boot that belief is
      // stale by definition — but it is the same floor the classifier uses, and erring toward
      // "leave it alone" is the correct direction here too.
      if (r.terminalId) continue
      if (!existsSync(r.cwd)) continue
      await queueRemoval({
        path: r.cwd,
        sourceRepo: r.sourceCwd,
        branch: r.worktreeBranch,
        requestedAt: Date.now(),
        reason: 'ended session with no open tab (boot reconciliation)',
      })
      queued++
    }
    return queued
  } catch {
    return 0
  }
}

/** Boot reconciliation — defect #5. Never throws; boot does not depend on it. */
export async function reconcileAtBoot(): Promise<void> {
  try {
    const queued = await queueEndedSessions()
    const drained = await drainPending(!AUTO_REAP_ON_TRIGGERS)
    const result = await reap({ dryRun: !AUTO_REAP_ON_TRIGGERS })
    const gb = (n: number) => (n / 1024 ** 3).toFixed(2)
    console.error(
      `[reap] boot: ${result.plan.entries.length} worktrees, ${result.plan.auto.length} in the auto tier`
      + `${result.plan.sizesOmitted ? '' : ` (${gb(result.plan.autoBytes)} GB of ${gb(result.plan.totalBytes)} GB)`}`
      + `, ${result.plan.asks.length} need a decision; ${queued} ended session(s) queued, ${drained.pending} pending`
      + `${AUTO_REAP_ON_TRIGGERS ? `; removed ${result.removed.length}` : ' — DRY RUN, nothing removed'}`,
    )
  } catch (e) {
    console.error('[reap] boot reconciliation failed:', e)
  }
}

/** The quit trigger — defect #1. Called from `teardown()` and AWAITED there, in main, so a
 *  renderer respawn cannot lose it (which is the half of defect #2 that quit is responsible for).
 *
 *  Bounded by the caller's teardown deadline: an app that cannot be quit is worse than a
 *  worktree that survives one more launch, and boot will find it again anyway. */
export async function reapOnQuit(): Promise<void> {
  try {
    const drained = await drainPending(!AUTO_REAP_ON_TRIGGERS)
    const result = await reap({ dryRun: !AUTO_REAP_ON_TRIGGERS })
    console.error(
      `[reap] quit: ${result.plan.auto.length} in the auto tier, ${drained.pending} pending`
      + `${AUTO_REAP_ON_TRIGGERS ? `, removed ${result.removed.length}` : ' — DRY RUN, nothing removed'}`,
    )
  } catch (e) {
    console.error('[reap] quit reap failed:', e)
  }
}

/** THE CALL THE RENDERER SHOULD MAKE — `removeWorktree`, with the intent written down first.
 *
 *  Defect #2 in the audit: lane close removed the directory from an un-awaited promise chain in
 *  renderer JS, and the renderer is killed and respawned under memory pressure roughly hourly. A
 *  close interrupted anywhere in that chain left a directory scheduled for removal and orphaned
 *  forever, with nothing anywhere that could resume it.
 *
 *  Writing the record BEFORE attempting the removal is the whole fix, and the order is the
 *  point: a crash after the record and before the removal is recoverable (boot retries it); a
 *  crash after the removal and before the record is cleared is also recoverable (the retry finds
 *  the directory gone and drops the record). The only unrecoverable order is the one this
 *  replaces — no record at all.
 *
 *  Throws on failure exactly as `removeWorktree` does, so the existing caller's error handling is
 *  unchanged; the record stays behind precisely because it failed. */
export async function removeWorktreeDurably(
  path: string,
  sourceRepo: string,
  opts: { branch?: string; reason?: string } = {},
): Promise<void> {
  await queueRemoval({
    path,
    sourceRepo,
    branch: opts.branch,
    requestedAt: Date.now(),
    reason: opts.reason ?? 'lane close',
  })
  await removeWorktree(path, sourceRepo)
  await clearPending(path)
}
