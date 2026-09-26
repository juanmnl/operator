// Notice when a live lane's checkout is removed outside Operator.
//
// dev/results/mantel-55da80-gutted-2026-09-25.md: `gh pr merge --delete-branch`, run by another
// lane, removed a linked worktree that a running Code lane was working in. The removal failed
// halfway, so the directory survived with no `.git` and git's admin entry for it deleted. Nothing
// in Operator noticed; the lane found out hours later from `fatal: not a git repository`, and
// blamed itself.
//
// So main looks, per live lane: on lane activity (at most once per ACTIVITY_CHECK_MS per lane) and
// on the existing ten-minute sweep, which covers a lane that has gone idle. A worktree checkout is
// GONE when its `.git` file is missing (the directory, or everything in it, was deleted) or the
// admin entry the `.git` file names no longer exists. It is reported to the renderer, which shows
// it on that lane, and logged. NOTHING IS REPAIRED: the lane may be mid-command, and what to
// restore (which branch, which files) is not something to guess.
import { appendFile, lstat, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gitdirFromGitFile } from './worktree'
import { operatorDir } from './store'

/** How often lane activity may trigger a check of that lane. Output arrives many times a second;
 *  a checkout that disappeared is worth seeing within seconds, not within milliseconds. */
export const ACTIVITY_CHECK_MS = 20_000

/** What the filesystem says about `<cwd>/.git`, and the admin entry it names. */
export interface CheckoutProbe {
  dotGit: 'file' | 'dir' | 'missing' | 'unreadable'
  /** Contents of the `.git` file, when it is one. */
  gitFile?: string
  /** The admin entry the `.git` file names exists. */
  adminExists?: boolean
  /** Contents of `<admin>/HEAD`, when readable. */
  adminHead?: string
}

export type CheckoutState =
  /** A linked worktree git can use; `branch` from its HEAD (undefined when detached). */
  | { kind: 'worktree'; branch?: string }
  /** Removed from under the lane. */
  | { kind: 'gone'; why: string }
  /** Not a linked worktree (a main checkout, a plain directory) or not readable: nothing to say. */
  | { kind: 'other' }

/** `ref: refs/heads/<b>` → `<b>`; a detached or unreadable HEAD → undefined. Pure. */
export function branchFromHead(head: string | undefined): string | undefined {
  const m = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(head ?? '')
  return m?.[1]
}

/** THE DECISION, pure. `knownWorktree` says the directory was a linked worktree before (seen
 *  healthy by this watcher, or it sits in Operator's worktree root): without that, a missing
 *  `.git` is just a directory that was never a checkout, and must not raise an alarm. */
export function judgeCheckout(p: CheckoutProbe, knownWorktree: boolean): CheckoutState {
  if (p.dotGit === 'file') {
    if (!p.adminExists) return { kind: 'gone', why: 'git’s record of this worktree (its admin entry) was deleted' }
    return { kind: 'worktree', branch: branchFromHead(p.adminHead) }
  }
  if (p.dotGit === 'missing' && knownWorktree) return { kind: 'gone', why: 'its .git file is missing' }
  return { kind: 'other' }
}

/** Read the probe for one directory. Never throws. */
export async function probeCheckout(cwd: string): Promise<CheckoutProbe> {
  const dotGit = join(cwd, '.git')
  let st
  try {
    st = await lstat(dotGit)
  } catch (e) {
    return { dotGit: (e as NodeJS.ErrnoException)?.code === 'ENOENT' || (e as NodeJS.ErrnoException)?.code === 'ENOTDIR' ? 'missing' : 'unreadable' }
  }
  if (st.isDirectory()) return { dotGit: 'dir' }
  if (!st.isFile()) return { dotGit: 'unreadable' }
  const gitFile = await readFile(dotGit, 'utf8').catch(() => undefined)
  if (gitFile === undefined) return { dotGit: 'unreadable' }
  const admin = gitdirFromGitFile(gitFile, cwd)
  if (!admin) return { dotGit: 'unreadable' }
  const adminExists = existsSync(admin)
  const adminHead = adminExists ? await readFile(join(admin, 'HEAD'), 'utf8').catch(() => undefined) : undefined
  return { dotGit: 'file', gitFile, adminExists, adminHead }
}

/** One lane whose checkout is gone. Mirrors `GoneCheckout` in src/shared/types.ts. */
export interface GoneCheckout {
  terminalId: string
  cwd: string
  /** The branch last seen checked out there, when this watcher saw it healthy. */
  branch?: string
  why: string
  /** Epoch ms when it was first noticed. */
  since: number
}

export interface LaneRef { id: string; cwd: string }

const logFile = () => join(operatorDir(), 'checkout-gone.log')

async function logLine(line: string): Promise<void> {
  console.error(`[checkout] ${line}`)
  try {
    await mkdir(operatorDir(), { recursive: true })
    await appendFile(logFile(), `${new Date().toISOString()} ${line}\n`)
  } catch { /* stderr still has it */ }
}

export class CheckoutWatcher {
  /** What each directory looked like the last time it was healthy. */
  private readonly seen = new Map<string, { branch?: string }>()
  private readonly gone = new Map<string, GoneCheckout>()
  private readonly lastCheck = new Map<string, number>()

  constructor(
    private readonly lanes: () => readonly LaneRef[],
    private readonly onChange: (list: GoneCheckout[]) => void,
    private readonly worktreeRoot: () => string = () => join(operatorDir(), 'worktrees'),
    private readonly now: () => number = Date.now,
    private readonly probe: (cwd: string) => Promise<CheckoutProbe> = probeCheckout,
  ) {}

  list(): GoneCheckout[] {
    return [...this.gone.values()]
  }

  /** Output from lane `id`: check it, at most once per ACTIVITY_CHECK_MS. */
  noteActivity(id: string): void {
    const at = this.now()
    const last = this.lastCheck.get(id)
    if (last !== undefined && at - last < ACTIVITY_CHECK_MS) return
    this.lastCheck.set(id, at)
    const lane = this.lanes().find((l) => l.id === id)
    if (lane) void this.check([lane], false)
  }

  /** Check every live lane, and drop entries for lanes that are no longer live. */
  sweep(): Promise<void> {
    return this.check(this.lanes(), true)
  }

  /** The lane ended: forget it. */
  forget(id: string): void {
    this.lastCheck.delete(id)
    if (this.gone.delete(id)) this.onChange(this.list())
  }

  private async check(lanes: readonly LaneRef[], full: boolean): Promise<void> {
    let changed = false
    if (full) {
      const live = new Set(lanes.map((l) => l.id))
      for (const id of [...this.gone.keys()]) if (!live.has(id)) { this.gone.delete(id); changed = true }
    }
    for (const lane of lanes) {
      const probe = await this.probe(lane.cwd).catch((): CheckoutProbe => ({ dotGit: 'unreadable' }))
      const known = this.seen.has(lane.cwd) || dirname(lane.cwd) === this.worktreeRoot()
      const state = judgeCheckout(probe, known)
      if (state.kind === 'worktree') {
        this.seen.set(lane.cwd, { branch: state.branch })
        // Back again (restored by hand): the warning no longer holds.
        if (this.gone.delete(lane.id)) changed = true
      } else if (state.kind === 'gone' && !this.gone.has(lane.id)) {
        const entry: GoneCheckout = { terminalId: lane.id, cwd: lane.cwd, branch: this.seen.get(lane.cwd)?.branch, why: state.why, since: this.now() }
        this.gone.set(lane.id, entry)
        changed = true
        await logLine(`${lane.id}: checkout at ${lane.cwd} was removed outside Operator`
          + `${entry.branch ? ` (branch ${entry.branch})` : ''}: ${state.why}. Not repaired.`)
      }
    }
    if (changed) this.onChange(this.list())
  }
}
