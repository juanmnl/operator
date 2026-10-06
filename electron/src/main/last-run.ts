// LAST RUN — which lanes this app run had, written by main to `~/.operator/last-run.json`.
//
// The renderer's snapshot (`operator.workspace.liveKeys` in localStorage) was the only record of
// "what was running", and it is written by a persist effect in a renderer that can die: on
// 2026-10-06 the renderer crashed after 7.8 days, the window stayed black, and the relaunch had
// only that snapshot to go on (dev/results/relaunch-lost-sessions-2026-10-06.md). Main owns the
// ptys, so main writes the list.
//
// The set is main's live pty table: every lane that has not exited. A lane that ended on its own,
// was closed or retired (killed by the renderer), or called worktree_done leaves the list. Lanes
// killed by teardown do not: `freeze()` stops the list changing before `killAll` runs, so a clean
// quit records the lanes it ended. It is not derived from the `appPid` stamps in sessions.json,
// which `stampSessionClaims` puts on old rows that share a recycled terminal id.
//
// `clean` is false while the app runs and true once teardown has started, written with the frozen
// list before anything is killed. Teardown can take seconds (`killAll` waits on the lanes' process
// trees), and an update install or a macOS logout can end the app inside them; that is still a
// quit, not a crash (review M2). The next boot reads a false value whose app is no longer running
// as a crash (or a force quit, or the machine going down), and the renderer then resumes those
// lanes on its own, unless the record is older than `RESUME_MAX_AGE_MS`: then they are offered. A
// renderer crash writes nothing here: main is still running and so are the lanes.
//
// THE PREVIOUS RUN, CARRIED. Boot claims the file for this run straight away, and this run's own
// list starts empty. If main then died before its renderer had saved the previous run's lanes in
// its own snapshot, the next boot would find an empty list and those lanes would be gone (review
// M1). So the record carries the previous run's lanes (`carried`) until the renderer says it has
// them (`previousRunTaken`), and the next boot reads them as part of the run they were carried by.
//
// TWO BOOTS. A second Operator on the same OPERATOR_DIR must neither take the file from the one
// running nor read the running one's lanes as a crash. Boot reads, judges and claims the file under
// an exclusive lock file, and a boot that finds the recorded app still running does not own the
// file for its whole run.

import { open, readFile, rename, stat, unlink, writeFile, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { operatorDir } from './store'
import type { PreviousRunInfo } from '../../../src/shared/types'

export const LAST_RUN_VERSION = 1

export interface LastRunLane {
  /** `SavedSession.key`: the durable key the renderer resumes by. */
  key: string
  /** Per run; kept to match worktree_release rows of that run at the next boot. */
  terminalId: string
  claudeSessionId?: string
  projectId?: string
  roleId?: string
  cwd: string
  startedAt: string
  /** Carried lanes only: offered on the card, never auto-resumed (they came from a clean quit, or
   *  their auto-resume was already handed out). */
  offerOnly?: boolean
}

export interface LastRun {
  v: typeof LAST_RUN_VERSION
  appPid: number
  /** When that app process started. With the pid it tells a running app from a recycled pid. */
  appStartedAt: string
  clean: boolean
  lanes: LastRunLane[]
  /** Lanes that called worktree_done in this run, with when. */
  released: Array<{ key: string; at: string }>
  /** This run auto-resumed a crashed run's lanes and has not yet run `CRASH_LOOP_MS` past the end
   *  of that resume, so a crash with it still set reads as a crash loop. */
  crashResumed?: boolean
  /** The previous run's lanes and releases, until this run's renderer has saved them (see the top
   *  of this file). A lane live in this run is in `lanes` instead. */
  carried?: { lanes: LastRunLane[]; released: Array<{ key: string; at: string }> }
  updatedAt: string
}

export const lastRunFile = (): string => join(operatorDir(), 'last-run.json')

/** A run that crashed this soon after it auto-resumed lanes may have crashed because of them, so
 *  the next boot offers them instead of resuming them again. */
export const CRASH_LOOP_MS = 2 * 60 * 1000

/** The crash-loop flag's limit when the renderer never reports the resume queue finished (it died,
 *  or a reload did not run the queue). */
export const CRASH_LOOP_MAX_MS = 30 * 60 * 1000

/** An unclean record older than this is offered on the card, not resumed: lanes from a crash a
 *  day or more ago are not what the user expects to see start on their own. */
export const RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** How often an unchanged record is still rewritten, so `updatedAt` stays within this of the end
 *  of a run whose lanes did not change for days. The age limit reads it. */
export const HEARTBEAT_MS = 10 * 60 * 1000

/** How far `ps`'s start time (1 s resolution, taken at exec) may sit from the recorded one
 *  (taken from `process.uptime()` once Node is up). */
const START_SLACK_MS = 10_000

const LOCK_STALE_MS = 10_000
const LOCK_WAIT_MS = 3_000

export function parseLastRun(raw: string | null | undefined): LastRun | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<LastRun>
    if (v?.v !== LAST_RUN_VERSION || typeof v.appPid !== 'number' || typeof v.appStartedAt !== 'string'
        || typeof v.clean !== 'boolean' || !Array.isArray(v.lanes)) return null
    return { ...v, released: Array.isArray(v.released) ? v.released : [] } as LastRun
  } catch {
    return null
  }
}

export type PreviousVerdict =
  /** No file, or one this build cannot read. The renderer falls back to its own snapshot. */
  | 'none'
  /** The previous run went through teardown. Offer its lanes. */
  | 'clean'
  /** It did not, and it is not running. Resume its lanes. */
  | 'unclean'
  /** The app that wrote the file is still running: another instance on this OPERATOR_DIR. */
  | 'other-instance'

/** Pure: what the record on disk means for this boot. */
export function judgePreviousRun(prev: LastRun | null, self: { pid: number; startedAt: string }, recordedAppRunning: boolean): PreviousVerdict {
  if (!prev) return 'none'
  const isSelf = prev.appPid === self.pid && prev.appStartedAt === self.startedAt
  if (!isSelf && recordedAppRunning) return 'other-instance'
  return prev.clean ? 'clean' : 'unclean'
}

/** Pure: the record's lanes with the ones it carried from the run before, and its releases with
 *  that run's. A carried lane that is also in `lanes` or `released` was taken up by the run that
 *  carried it. */
export function withCarried(prev: LastRun): LastRun {
  if (!prev.carried) return prev
  const own = new Set([...prev.lanes.map((l) => l.key), ...prev.released.map((r) => r.key)])
  const ownReleased = new Set(prev.released.map((r) => r.key))
  return {
    ...prev,
    lanes: [...prev.lanes, ...prev.carried.lanes.filter((l) => !own.has(l.key))],
    released: [...prev.released, ...prev.carried.released.filter((r) => !ownReleased.has(r.key))],
    carried: undefined,
  }
}

/** Pure: auto-resume after an unclean end, unless that run itself crashed within `CRASH_LOOP_MS`
 *  of finishing its own auto-resume (its flag was still set), or it ended more than
 *  `RESUME_MAX_AGE_MS` before `now`. `prev` has its carried lanes merged (`withCarried`). */
export function shouldAutoResume(prev: LastRun, verdict: PreviousVerdict, now: string): boolean {
  if (verdict !== 'unclean' || prev.crashResumed) return false
  if (!(Date.parse(now) - Date.parse(prev.updatedAt) <= RESUME_MAX_AGE_MS)) return false
  return prev.lanes.some((l) => !l.offerOnly)
}

/** Pure: a crashed run's lanes, with the ones that called worktree_done after its last write moved
 *  to `released`. `releases` are that run's worktree_release rows; a cancelled one does not count. */
export function withLateReleases(prev: LastRun, releases: ReadonlyArray<{ terminalId: string; at: string; outcome: string | null }>): LastRun {
  const done = releases.filter((r) => !(r.outcome ?? '').startsWith('cancelled'))
  if (!done.length) return prev
  const lanes: LastRunLane[] = []
  const released = [...prev.released]
  for (const l of prev.lanes) {
    const r = done.find((x) => x.terminalId === l.terminalId && x.at >= l.startedAt)
    if (r) { if (!released.some((x) => x.key === l.key)) released.push({ key: l.key, at: r.at }) } else lanes.push(l)
  }
  return { ...prev, lanes, released }
}

/** Pure: what the renderer is handed. */
export function previousRunInfo(prev: LastRun, autoResume: boolean): PreviousRunInfo {
  return {
    clean: prev.clean,
    lanes: [...prev.lanes]
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map(({ key, claudeSessionId, projectId, roleId, startedAt, offerOnly }) => ({ key, claudeSessionId, projectId, roleId, startedAt, ...(offerOnly ? { offerOnly } : {}) })),
    released: prev.released.map((r) => r.key),
    endedAt: prev.updatedAt,
    autoResume,
  }
}

/** Is `pid` the process that started at `startedAt`? A pid alone can be recycled. Unknown
 *  (`ps` failed) answers true: not resuming a crashed run's lanes costs a press on the card,
 *  resuming a running one's would start a second process on each conversation. */
export async function processIsRunning(pid: number, startedAt: string, ps: (pid: number) => Promise<string> = psStart): Promise<boolean> {
  try { process.kill(pid, 0) } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false
  }
  let out: string
  try { out = (await ps(pid)).trim() } catch { return true }
  if (!out) return false
  const t = Date.parse(out)
  if (Number.isNaN(t)) return true
  return Math.abs(t - Date.parse(startedAt)) <= START_SLACK_MS
}

function psStart(pid: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // LC_ALL=C: `lstart` follows the locale, and Date.parse cannot read de_DE or pt_BR output.
    execFile('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' } }, (err, stdout) => {
      // `ps -p` exits 1 (a numeric code) for a pid that does not exist, with empty output. A string
      // code is `ps` itself failing to run.
      if (err && typeof (err as { code?: unknown }).code !== 'number') return reject(err)
      resolve(String(stdout ?? ''))
    })
  })
}

function pidExists(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH' }
}

/** Run `fn` holding `<file>.lock`. Answers 'locked' when another boot holds it past the wait. */
export async function withBootLock<T>(file: string, fn: () => Promise<T>, opts: { waitMs?: number; staleMs?: number } = {}): Promise<T | 'locked'> {
  const lock = `${file}.lock`
  const deadline = Date.now() + (opts.waitMs ?? LOCK_WAIT_MS)
  await mkdir(dirname(file), { recursive: true }).catch(() => {})
  for (;;) {
    try {
      const h = await open(lock, 'wx')
      await h.writeFile(String(process.pid)).catch(() => {})
      await h.close()
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return fn() // no lock possible here; go on without one
      // Stale: its boot died holding it (its pid is gone), or it is older than any boot takes.
      const holder = Number(await readFile(lock, 'utf8').catch(() => ''))
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0)
      if (age > (opts.staleMs ?? LOCK_STALE_MS) || (holder > 0 && !pidExists(holder))) { await unlink(lock).catch(() => {}); continue }
      if (Date.now() > deadline) return 'locked'
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  try { return await fn() } finally { await unlink(lock).catch(() => {}) }
}

export interface LiveLane {
  terminalId: string
  key: string
  cwd: string
  claudeSessionId?: string
  projectId?: string
  roleId?: string
  startedAt: string
}

export interface RecorderDeps {
  file: string
  self: { pid: number; startedAt: string }
  /** Main's live lanes (`TerminalManager.liveLanes`). */
  lanes: () => LiveLane[]
  /** Terminal ids with an open worktree_release in this run. */
  openReleases: () => ReadonlySet<string>
  now?: () => string
}

/** Keeps last-run.json equal to this run's live lanes. Writes are serialized and skipped when
 *  nothing changed (up to `HEARTBEAT_MS`). Nothing is written before `open()` has claimed the file,
 *  and nothing at all when another instance owns it. */
export class LastRunRecorder {
  private frozen = false
  private owner = false
  private clean = false
  private crashResumed = false
  private crashTimer: ReturnType<typeof setTimeout> | null = null
  private lanes: LastRunLane[] = []
  private readonly released = new Map<string, string>()
  /** The previous run's lanes, until the renderer has saved them (`previousRunTaken`). */
  private carried: { lanes: LastRunLane[]; released: Array<{ key: string; at: string }> } | null = null
  private chain: Promise<void>
  private opened: () => void = () => {}
  private lastBody = ''
  private lastWriteAt = 0
  private previous: { info: LastRun; verdict: PreviousVerdict; autoResume: boolean } | null = null
  private autoResumeClaimed = false

  private readonly openedPromise: Promise<void>

  constructor(private readonly d: RecorderDeps) {
    this.openedPromise = new Promise<void>((r) => { this.opened = r })
    this.chain = this.openedPromise
  }

  /** Settles once `open()` has read and claimed the file (or given up). */
  ready(): Promise<void> { return this.openedPromise }

  private now(): string { return this.d.now?.() ?? new Date().toISOString() }

  /** Boot: read the previous run's record, judge it, and claim the file for this run. */
  async open(deps: {
    isRunning?: (pid: number, startedAt: string) => Promise<boolean>
    /** That run's worktree_release rows, for lanes that released after its last write. */
    releasesOf?: (appPid: string, since: string) => ReadonlyArray<{ terminalId: string; at: string; outcome: string | null }>
  } = {}): Promise<PreviousVerdict> {
    const isRunning = deps.isRunning ?? processIsRunning
    try {
      const got = await withBootLock(this.d.file, async () => {
        const prev = parseLastRun(await readFile(this.d.file, 'utf8').catch(() => null))
        const running = prev ? await isRunning(prev.appPid, prev.appStartedAt) : false
        const verdict = judgePreviousRun(prev, this.d.self, running)
        if (verdict === 'other-instance') return verdict
        if (prev) {
          let info = prev
          // Late releases first: they are that run's rows, and match only its own lanes' terminal ids.
          if (verdict === 'unclean' && deps.releasesOf) {
            try { info = withLateReleases(prev, deps.releasesOf(String(prev.appPid), prev.appStartedAt)) } catch { /* store unreadable: keep the file's view */ }
          }
          info = withCarried(info)
          const autoResume = shouldAutoResume(info, verdict, this.now())
          this.previous = { info, verdict, autoResume }
          // Carried until the renderer has them. Lanes whose auto-resume is not owed stay offer-only.
          this.carried = {
            lanes: info.lanes.map((l) => (autoResume && !l.offerOnly ? l : { ...l, offerOnly: true })),
            released: info.released,
          }
        }
        this.owner = true
        // Claim it now, under the lock, so a racing boot finds a running app's record.
        await this.writeNow()
        return verdict
      })
      if (got === 'locked') {
        console.error('[last-run] another Operator boot holds the lock; this run does not record its lanes')
        return 'other-instance'
      }
      if (got === 'other-instance') console.error('[last-run] the app that wrote last-run.json is still running; this run does not record its lanes')
      return got
    } catch (e) {
      console.error('[last-run] could not read or claim last-run.json:', e)
      return 'none'
    } finally {
      this.opened()
    }
  }

  /** For the renderer. `autoResume` is answered true once per app run, so a reload of the renderer
   *  cannot start the same lanes a second time. */
  previousRun(): PreviousRunInfo | null {
    if (!this.previous || this.previous.verdict === 'other-instance' || this.previous.verdict === 'none') return null
    const autoResume = this.previous.autoResume && !this.autoResumeClaimed
    if (autoResume) {
      this.autoResumeClaimed = true
      this.crashResumed = true
      // Handed out: a crash from here on must not auto-resume the carried lanes again. The
      // crash-loop flag decides for the lanes this run brings back.
      if (this.carried) this.carried = { ...this.carried, lanes: this.carried.lanes.map((l) => (l.offerOnly ? l : { ...l, offerOnly: true })) }
      void this.sync()
      // Until the renderer reports the queue finished (`crashResumeDone`); this limit is for a
      // renderer that never does.
      this.armCrashTimer(CRASH_LOOP_MAX_MS)
    }
    return previousRunInfo(this.previous.info, autoResume)
  }

  /** The renderer's crash resume queue has finished: the flag stays for `CRASH_LOOP_MS` more, so a
   *  lane that crashes the app as it comes up is not resumed again at the next boot (review L1). */
  crashResumeDone(): void {
    if (!this.crashResumed) return
    this.armCrashTimer(CRASH_LOOP_MS)
  }

  /** The renderer has saved the previous run's lanes in its own snapshot, or resumed them: main
   *  stops carrying them (review M1). */
  previousRunTaken(): Promise<void> {
    if (!this.carried) return this.chain
    this.carried = null
    return this.sync()
  }

  private armCrashTimer(ms: number): void {
    if (this.crashTimer) clearTimeout(this.crashTimer)
    this.crashTimer = setTimeout(() => { this.crashTimer = null; this.crashResumed = false; void this.sync() }, ms)
    this.crashTimer.unref?.()
  }

  /** Recompute from the pty table and write if it changed. A no-op once frozen. */
  sync(): Promise<void> {
    if (this.frozen) return this.chain
    this.recompute()
    return this.enqueue()
  }

  /** Teardown is starting: take the set one last time, stop it changing, and mark the run clean,
   *  before anything is killed. The kills that follow (quit, update install) do not empty it, and
   *  an app ended in the middle of them still reads as a quit (review M2). */
  freeze(): Promise<void> {
    if (this.frozen) return this.chain
    this.recompute()
    this.frozen = true
    this.clean = true
    if (this.crashTimer) { clearTimeout(this.crashTimer); this.crashTimer = null }
    return this.enqueue()
  }

  private recompute(): void {
    let open: ReadonlySet<string>
    try { open = this.d.openReleases() } catch { open = new Set() }
    const now = this.now()
    const lanes: LastRunLane[] = []
    for (const l of this.d.lanes()) {
      if (open.has(l.terminalId)) {
        // worktree_done: finished. It stays released after its pty is gone.
        if (!this.released.has(l.key)) this.released.set(l.key, now)
        continue
      }
      // Live and not released: a release it had was cancelled by new work, or it was resumed.
      this.released.delete(l.key)
      lanes.push({ key: l.key, terminalId: l.terminalId, cwd: l.cwd, claudeSessionId: l.claudeSessionId, projectId: l.projectId, roleId: l.roleId, startedAt: l.startedAt })
    }
    this.lanes = lanes
    // A carried lane that came back in this run is this run's lane now; it is not carried again
    // after it exits.
    if (this.carried) {
      const here = new Set([...lanes.map((l) => l.key), ...this.released.keys()])
      if (this.carried.lanes.some((l) => here.has(l.key))) this.carried = { ...this.carried, lanes: this.carried.lanes.filter((l) => !here.has(l.key)) }
    }
  }

  private record(): LastRun {
    const carried = this.carried && (this.carried.lanes.length || this.carried.released.length) ? this.carried : null
    return {
      v: LAST_RUN_VERSION,
      appPid: this.d.self.pid,
      appStartedAt: this.d.self.startedAt,
      clean: this.clean,
      lanes: this.lanes,
      released: [...this.released].map(([key, at]) => ({ key, at })),
      ...(this.crashResumed ? { crashResumed: true } : {}),
      ...(carried ? { carried } : {}),
      updatedAt: this.now(),
    }
  }

  private enqueue(): Promise<void> {
    this.chain = this.chain.then(() => this.writeNow(), () => this.writeNow())
    return this.chain
  }

  private async writeNow(): Promise<void> {
    if (!this.owner) return
    const rec = this.record()
    const body = JSON.stringify({ ...rec, updatedAt: undefined })
    const at = Date.parse(rec.updatedAt)
    if (body === this.lastBody && !(at - this.lastWriteAt >= HEARTBEAT_MS)) return
    try {
      const tmp = `${this.d.file}.tmp`
      await writeFile(tmp, JSON.stringify(rec, null, 2), 'utf8')
      await rename(tmp, this.d.file)
      this.lastBody = body
      this.lastWriteAt = at
    } catch (e) {
      console.error('[last-run] write failed:', e)
    }
  }
}
