// The pty layer — the one piece of the backend this shell implements for real.
//
// Mirrors `src-tauri/src/lib.rs` (`terminal_spawn` / `pump_pty` / `PtyManager`) closely
// enough that the UNMODIFIED `TerminalPane` cannot tell the difference: same `$SHELL -ilc`
// launch, same env, same base64 transport, same retained-history cap, and the same
// DEFERRED LAUNCH — the pty is not exec'd until the pane has fitted and told us its real
// grid size, because Claude Code wraps its output to the pty width at startup and never
// reflows it.
//
// node-pty makes the deferred half CLEANER than the Rust original rather than harder:
// `pty.spawn` takes cols/rows, so "open now, exec later" is just "don't call spawn yet",
// with no pending master/slave pair to hold open.
import { spawn as ptySpawn, type IPty } from 'node-pty'
import { randomUUID } from 'node:crypto'
import { loginShell } from './login-shell'
import { homedir } from 'node:os'
import { buildArgs, mcpConfigArg } from '../../../src/renderer/lib/launch-args'
import { app } from 'electron'
import {
  reapTree, snapshotPs, sweepTagged, descendantsOf, selfPgidFrom, laneStrays, expandStrays,
  abandonedLaneRows,
  type PsRow, type TaggedRow,
} from './reap'
import { claimLease, releaseLease, loadLeases } from './leases'
import { isPortLive, isPortFree, retryScanWithoutV6, beginPortScan } from './port-probe'
import { attributePort, evidenceSnapshot, ownDeepPids, type SessionPort } from './port-attribution'
import { allocatePort, shouldReleaseCwdPort, provesOwnServer, DEV_SERVER_RE, OPERATOR_BINARY_RE } from './port-alloc'
import { writeSessionSettings, type SkillMode } from './session-settings'

/** Same cap as `HISTORY_CAP` in lib.rs — 256KB of retained output per pty, replayed when a
 *  pane re-attaches after a renderer reload. Trimmed with the same hysteresis (let it reach
 *  2× then drain back to 1×) so the O(n) front-drain is rare during heavy streaming. */
const HISTORY_CAP = 256 * 1024

/** How long we wait for the pane's `terminalStart` before launching anyway, so a race or an
 *  older renderer can't leave a session dark. Idempotent with the explicit call. */
const DEFERRED_LAUNCH_FALLBACK_MS = 3000

/** Fallback pty size when the frontend can't measure — the historical 100×30 from lib.rs. */
const DEFAULT_COLS = 100
const DEFAULT_ROWS = 30

export interface SpawnOptions {
  cwd: string
  /** Claude Code CLI args, built by the renderer's own `buildArgs`. */
  args: string[]
  sessionId: string
  tuiMode: 'default' | 'fullscreen'
  colorScheme: 'light' | 'dark'
  orchestrationNote?: string | null
  cols?: number
  rows?: number
  /** Config env resolved from the project layer (S3). Values only — a secret's value never
   *  reaches here, and never reaches the settings file. */
  env?: Record<string, string>
  /** Tombstoned names: masked, so they must be DELETED from the inherited environment. The
   *  settings file cannot express "unset" — a key with any value is a key that gets set — so
   *  the pty env is the only place this can be honoured. */
  unsetEnv?: string[]
  skillOverrides?: Record<string, SkillMode>
  enabledPlugins?: Record<string, boolean>
  /** WHO THIS LANE IS, exported into its environment so `--mcp-serve` can stamp a report without
   *  guessing. Terminal ids repeat across app runs and projects, so the `sessions.json` lookup
   *  they used to be resolved through picked the wrong row — see `resolveCaller`. */
  projectId?: string | null
  roleId?: string | null
  /** Expose this lane to Claude Code's Remote Control (the Claude phone app). Written into the
   *  session settings file EXPLICITLY, false included — see `buildSessionSettings`. */
  remoteControl?: boolean
  /** The Claude Code version this lane launches on, resolved by main just before the spawn (see
   *  claude-version.ts). Only recorded and reported back, so the renderer can tell a lane running
   *  an older binary than the one installed now. */
  claudeVersion?: string | null
}

interface Managed {
  id: string
  cwd: string
  /** Claude session uuid — the durable key the dev-port lease is filed under. */
  sessionId?: string
  pty: IPty | null
  /** Set while the pty is open but the command has not been exec'd (deferred launch). */
  pending: { spawn: (cols: number, rows: number) => void; timer: NodeJS.Timeout } | null
  history: Buffer[]
  historyBytes: number
  devPort?: number
  /** Ports seen in this session's OWN output (dev-server banners). */
  sniffedPorts: Set<number>
  /** Claude Code version at spawn — see `SpawnOptions.claudeVersion`. */
  claudeVersion: string | null
  /** ms of the last pty chunk, for `activeWithin`. */
  lastActivityAt?: number
  exited: boolean
  /** A reap is in flight. `kill()` now runs for up to the grace period before it does its
   *  bookkeeping, so the map entry is still present in that window and a second `kill(id)` —
   *  the frontend closes a lane and then the project containing it — would otherwise signal the
   *  same tree twice and double-free the port. */
  killing?: Promise<void>
}

type DataSink = (id: string, base64: string) => void
type ExitSink = (id: string, exitCode: number, signal: number) => void

export class TerminalManager {
  private readonly terminals = new Map<string, Managed>()
  private readonly portsByCwd = new Map<string, number>()
  private next = 0

  constructor(private readonly onData: DataSink, private readonly onExit: ExitSink) {}

  /** `t0`, `t1`, … — the same id scheme the renderer's saved sessions already key on. */
  private nextId(): string {
    return `t${this.next++}`
  }

  /** Keyed by CWD, not by terminal id: lanes in the same directory serve identical code, so
   *  the second lane joins the first's server rather than starting a redundant one.
   *
   *  The DECISION lives in `port-alloc.ts`, pure over the three probes below, because it is the
   *  part with branches worth testing and this class needs a pty and an Electron `app` to exist
   *  at all. What is left here is supplying reality: a real bind, the real lease file, and the
   *  real process table. */
  private async allocPort(cwd: string): Promise<{ port?: number; shared: boolean }> {
    // SERIALIZED, and this is the one thing making the decision async cost us. The old scan was
    // synchronous, so "pick a port" and "record it" could not be interleaved. Now there are
    // awaits between them — a lease read and a bind per candidate — and two lanes launching at
    // once (open a project, click Start all) would both scan the same window, both find the same
    // first free port, and both take it, which is the collision this whole change is about.
    //
    // A promise chain rather than a lock: each allocation waits for the previous one to have
    // WRITTEN its reservation into `portsByCwd`, which is what makes the next scan see it. The
    // `catch` keeps one failed allocation from wedging every later launch.
    const run = this.allocGate.then(() => this.allocPortLocked(cwd))
    this.allocGate = run.then(() => undefined, () => undefined)
    return run
  }

  private allocGate: Promise<unknown> = Promise.resolve()

  private async allocPortLocked(cwd: string): Promise<{ port?: number; shared: boolean }> {
    const { port, displaced, shared } = await allocatePort(cwd, this.portsByCwd, {
      isFree: isPortFree,
      leased: async () => new Set((await loadLeases()).map((l) => l.devPort)),
      sharedHolderIsOurs: (p) => this.sharedHolderIsOurs(cwd, p),
      onEmptyScan: retryScanWithoutV6,
      beginScan: beginPortScan,
    })
    if (displaced !== undefined) {
      // Visible on purpose. This is the 2026-09-05 failure being caught rather than repeated —
      // a stranger holding a port we had already promised to a cwd.
      console.error(
        `[ports] ${cwd}: reservation ${displaced} is held by a server that is not ours; ` +
        `allocated ${port ?? 'none'} instead`,
      )
    }
    return { port, shared: shared === true }
  }

  /** Is the server on this cwd's reserved port one WE started?
   *
   *  The same inference `attributePort` makes for the preview, and it has to be: the env tag
   *  alone proves nothing, because `OPERATOR_DEV_PORT` is set on the pty itself and so the
   *  lane's own shell and its `claude` child carry it forever, dev server or no dev server. The
   *  claimant must therefore be DEEPER than `claude` — something a lane actually started.
   *
   *  Fails CLOSED. If the process table cannot be read, we do not know the holder is ours, and
   *  handing the lane a port on the strength of an unanswered question is the bug. */
  private async sharedHolderIsOurs(cwd: string, port: number): Promise<boolean> {
    try {
      // The SAME 3s-cached snapshot the preview's attribution polls on, rather than a fresh
      // `ps -E` pair per allocation — that form dumps every process's environment, and a lane
      // launch should not pay for it twice.
      const { psRows } = await evidenceSnapshot()
      const leasedPorts = new Set((await loadLeases()).map((l) => l.devPort))
      const holders = [...this.terminals.values()].filter((o) => !o.exited && o.cwd === cwd && o.devPort === port)
      for (const sibling of holders) {
        if (provesOwnServer(port, {
          ps: psRows,
          shellPid: sibling.pty?.pid,
          leasedPorts,
          reservationHolders: holders.length,
        })) return true
      }
      return false
    } catch {
      // Fails closed: not knowing is not the same as knowing it is ours, and the cost of the
      // wrong answer here is one project's lane pointed at another project's server.
      return false
    }
  }

  /** Build the login-shell command line exactly as `terminal_spawn` does. The `-ilc` form is
   *  not incidental: Claude Code is usually on a PATH that only an interactive login shell
   *  sets up, and dropping to a bare exec is how a build "can't find claude" while the real
   *  app can. */
  private async buildCommand(o: SpawnOptions): Promise<{ shell: string; argv: string[]; env: NodeJS.ProcessEnv; devPort?: number; id: string }> {
    const id = this.nextId()
    const { port: devPort, shared: sharedPort } = await this.allocPort(o.cwd)
    // S0 — a settings FILE, not an inline JSON string.
    //
    // The inline form (`--settings {"tui":"default"}`) works for exactly one scalar and nothing
    // else: env blocks, skill overrides and plugin toggles are objects, and a growing JSON
    // literal inside an `-ilc` command line is one quoting bug away from a lane that will not
    // start. The file is also the only form the user can read afterwards to see what a lane was
    // actually given. `--settings` MERGES at highest precedence (verified, not assumed — see
    // session-settings.ts), so writing only our keys does not drop the user's global model or
    // permissions.
    //
    // The fallback to the inline form is deliberate: an unwritable settings directory must cost
    // a lane its env block, never its launch.
    const settingsPath = writeSessionSettings(o.sessionId, {
      tui: o.tuiMode,
      env: o.env,
      skillOverrides: o.skillOverrides,
      enabledPlugins: o.enabledPlugins,
      // `?? false` and not `|| undefined`: leaving the key out inherits Claude Code's org
      // default, which is currently auto-ON, and that is exactly the behaviour being fixed.
      remoteControlAtStartup: o.remoteControl ?? false,
    })
    const prefix = ['claude', '--settings', settingsPath ?? JSON.stringify({ tui: o.tuiMode })]
    const notes: string[] = []
    if (devPort) {
      // THE CONTRACT, and it is only worth stating to the extent `allocPort` makes it true —
      // which is different for a fresh port and a shared one, so the two say different things.
      //
      // A FRESH port was bind-checked against both loopbacks a moment ago and no lease claims it,
      // so "verified free" is a fact. A SHARED port is a sibling lane's reservation in the same
      // directory: it is either unbound or provably served by that sibling (see `provesOwnServer`,
      // which fails closed), and "provably" is still not "verified free at this instant" — the
      // sibling may start its server a second from now. Claiming otherwise is what the review
      // caught: the old hint asserted a verification the shared path had not done, and the agent
      // was told to trust it.
      //
      // Neither version asks the agent to identify a port's holder. `lsof -i :PORT` is how you
      // would, and it fires a macOS TCC prompt per inspected process.
      notes.push(
        sharedPort
          ? `Operator reserved localhost port ${devPort} for this session; start any dev server `
            + `on exactly that port (pass --port ${devPort}, or read it from the PORT env var). `
            + `Another session in this same directory shares this reservation and may already be `
            + `serving the same code on it — if something answers on ${devPort}, use it rather `
            + `than starting a second. Do not try to identify the process holding a port.`
          : `Operator reserved localhost port ${devPort} for this session; start any dev server `
            + `on exactly that port (pass --port ${devPort}, or read it from the PORT env var). `
            + `Operator verified the port was free when this session started, so nothing should `
            + `be answering on it yet. Do not try to identify the process holding a port.`,
      )
    }
    if (o.orchestrationNote?.trim()) notes.push(o.orchestrationNote.trim())
    if (notes.length) prefix.push('--append-system-prompt', notes.join('\n\n'))

    // THE ARTIFACT PLANE, wired for real this time.
    //
    // The comment that used to sit here said the `--mcp-config` flag "is wired now — see
    // mcp-serve.ts and the --mcp-serve branch in index.ts". That was true about the SERVER and
    // false about the client: nothing ever built the flag, so `operator__report` was in no lane's
    // tool list from the day the Electron shell shipped. `dev/results/agent-comms-audit.md`
    // measured it — 0 of 13 live lanes had the flag, 0 calls in any transcript, and the store's
    // last write was the day the launch path changed hands.
    //
    // PACKAGED VS DEV is the whole subtlety. `process.execPath` in the packaged app is the
    // Operator binary and `--mcp-serve` alone is enough. In dev it is the `electron` binary,
    // which needs the app directory as argv[1] or it opens an empty shell and answers nothing.
    // `app.isPackaged` is the only thing that can tell those apart, so the branch lives here
    // rather than inside the pure arg builder.
    prefix.push('--mcp-config', mcpConfigArg(process.execPath, app.isPackaged ? undefined : app.getAppPath()))

    const inner = [...prefix, ...o.args].map(shellQuote).join(' ')
    const shell = loginShell()
    const env: NodeJS.ProcessEnv = { ...stripNestedSessionEnv(process.env) }
    env.OPERATOR_TERMINAL_ID = id
    // WHICH Operator spawned this lane. Inherited by every descendant, so a next-launch sweep
    // can tell a survivor of a DEAD Operator (reap it) from a lane belonging to an instance
    // running right now (leave it strictly alone) — the distinction that makes the boot reap
    // safe at all. A live sweep of this machine found the running `Operator.app` ITSELF carrying
    // `OPERATOR_TERMINAL_ID` (it had been launched from a tagged shell), so "tagged" alone is
    // not evidence of an orphan. Nothing reads this at runtime; it exists to be found in `ps -E`.
    env.OPERATOR_APP_PID = String(process.pid)
    // WHOSE LANE THIS IS. Read by `mcp-serve.ts` to stamp `report` / `task_status` rows. The
    // terminal id alone could not answer it: ids restart at `t0` each run while `sessions.json`
    // is durable, so one id matches several rows and the first was taken — which is how a review
    // of `operator` was filed under `uwazi-app`. Stated at spawn, where it is known for certain.
    if (o.projectId) env.OPERATOR_PROJECT_ID = o.projectId
    if (o.roleId) env.OPERATOR_ROLE_ID = o.roleId
    if (devPort) {
      env.OPERATOR_DEV_PORT = String(devPort)
      env.PORT = String(devPort)
    }
    // The project's own variables, onto the pty as well as into the settings file. The file is
    // what Claude Code reads for its own subprocesses; the pty env is what the lane's SHELL
    // sees, which is where a user checks with `env | grep`. Set BEFORE the terminal-capability
    // block below so the names Operator manages still win — the denylist should already have
    // refused those at the UI, and this is the backstop for a hand-edited store.
    for (const [k, v] of Object.entries(o.env ?? {})) env[k] = v
    // Tombstones, honoured the only way they can be.
    for (const k of o.unsetEnv ?? []) delete env[k]
    env.FORCE_COLOR = '1'
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    // bg 0 = dark terminal, 15 = light — Claude's fallback when it can't OSC-query us.
    env.COLORFGBG = o.colorScheme === 'light' ? '0;15' : '15;0'
    // Claude gates its inline prompt suggestions on recognising the host terminal.
    env.TERM_PROGRAM = 'iTerm.app'
    return { shell, argv: ['-ilc', inner], env, devPort, id }
  }

  async spawn(o: SpawnOptions): Promise<{ terminalId: string; cwd: string; grid: boolean; claudeVersion: string | null }> {
    const { shell, argv, env, devPort, id } = await this.buildCommand(o)
    const cols = clamp(o.cols, 20, 500) ?? DEFAULT_COLS
    const rows = clamp(o.rows, 5, 200) ?? DEFAULT_ROWS

    const managed: Managed = { id, cwd: o.cwd, sessionId: o.sessionId, pty: null, pending: null, history: [], historyBytes: 0, devPort, sniffedPorts: new Set(), claudeVersion: o.claudeVersion ?? null, exited: false }
    this.terminals.set(id, managed)

    const launch = (c: number, r: number) => {
      if (managed.pty || managed.exited) return
      if (managed.pending) { clearTimeout(managed.pending.timer); managed.pending = null }
      const p = ptySpawn(shell, argv, { name: 'xterm-256color', cols: c, rows: r, cwd: o.cwd, env: env as Record<string, string> })
      managed.pty = p
      // The lease goes to disk HERE, not at `spawn()`: until the pty is exec'd there is no tree
      // to orphan. Not awaited — a lane must not wait on a file write to start, and the only
      // reader is the next boot.
      if (devPort && o.sessionId) {
        void claimLease({
          sessionId: o.sessionId, terminalId: id, devPort, cwd: o.cwd,
          shellPid: p.pid, appPid: process.pid, startedAt: new Date().toISOString(),
        })
      }
      // The transport is base64 all the way, matching `TerminalDataPayload`: the renderer's
      // `onTerminalData` does atob → bytes → STREAMING TextDecoder, which is what stitches a
      // multibyte character split across two pty reads. Handing it a JS string here would
      // have node-pty do that decode with its own boundary rules and quietly change the
      // bytes the terminal sees.
      p.onData((chunk) => {
        const buf = Buffer.from(chunk, 'utf8')
        managed.lastActivityAt = Date.now()
        this.pushHistory(managed, buf)
        this.onData(id, buf.toString('base64'))
      })
      p.onExit(({ exitCode, signal }) => {
        managed.exited = true
        managed.pty = null
        this.onExit(id, exitCode, signal ?? 0)
      })
    }

    managed.pending = { spawn: launch, timer: setTimeout(() => launch(cols, rows), DEFERRED_LAUNCH_FALLBACK_MS) }
    // `grid` is echoed back because the caller mounts the matching pane off it. This shell has
    // no alacritty core, so it is always false — see the ledger: `gridterm.rs` is the one
    // module with no Node equivalent.
    return { terminalId: id, cwd: o.cwd, grid: false, claudeVersion: managed.claudeVersion }
  }

  /** Deferred launch, explicit half: the pane fitted, so exec at the real grid size. */
  start(id: string, cols: number, rows: number): void {
    const t = this.terminals.get(id)
    t?.pending?.spawn(clamp(cols, 20, 500) ?? DEFAULT_COLS, clamp(rows, 5, 200) ?? DEFAULT_ROWS)
  }

  /** A plain interactive shell in `cwd` — the toolbar's scratch terminal. No deferral: there
   *  is no startup banner wrapped to the wrong width to protect. */
  spawnShell(cwd: string): string {
    const id = this.nextId()
    const managed: Managed = { id, cwd, pty: null, pending: null, history: [], historyBytes: 0, sniffedPorts: new Set(), claudeVersion: null, exited: false }
    this.terminals.set(id, managed)
    const shell = loginShell()
    const p = ptySpawn(shell, ['-il'], {
      name: 'xterm-256color', cols: DEFAULT_COLS, rows: DEFAULT_ROWS, cwd,
      env: { ...stripNestedSessionEnv(process.env), TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>,
    })
    managed.pty = p
    p.onData((chunk) => {
      const buf = Buffer.from(chunk, 'utf8')
      managed.lastActivityAt = Date.now()
      this.pushHistory(managed, buf)
      this.onData(id, buf.toString('base64'))
    })
    p.onExit(({ exitCode, signal }) => {
      managed.exited = true
      managed.pty = null
      this.onExit(id, exitCode, signal ?? 0)
    })
    return id
  }

  write(id: string, data: string): void {
    this.terminals.get(id)?.pty?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.terminals.get(id)
    if (!t?.pty) return
    // node-pty throws on a zero/NaN dimension; a pane mid-teardown can produce one.
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return
    try { t.pty.resize(Math.floor(cols), Math.floor(rows)) } catch { /* pty can race teardown */ }
  }

  /** End a lane AND everything it started.
   *
   *  `pty.kill()` alone signals ONE pid — the login shell — which is why every `npm run dev` a
   *  lane ever launched outlived it. The sequence here is: one `ps` snapshot taken BEFORE
   *  anything is signalled (at that instant every descendant is still attached to the shell by
   *  `ppid`, whatever its own process group), walk the tree, SIGTERM the shell plus each
   *  distinct group, wait out the grace period, SIGKILL whatever survived, and only then do the
   *  map/port bookkeeping. See `reap.ts` for why groups rather than sessions, and why never
   *  `lsof`.
   *
   *  THE TREE IS NOT THE WHOLE LANE. A dev server the agent backgrounded reparented to launchd
   *  the moment its intermediate shell exited, so it is not under the pty any more and the walk
   *  cannot reach it — that hole is what left 24 orphans live on this machine, the oldest 11
   *  days. The second half of the reap is therefore a `ps -E` sweep matched on the lane's own
   *  env tag, which survives reparenting; see `laneStrays` for why the tag alone is not enough
   *  and what is refused.
   *
   *  `snapshot` lets `killAll` reap the whole fleet from ONE `ps` pair rather than a pair per
   *  lane — the tagged sweep dumps every process's environment, so taking it per lane on quit
   *  would be the most expensive thing quitting does.
   *
   *  AWAITING THIS IS THE POINT at the call sites that remove a worktree afterwards: the tree
   *  holding files open in that directory is gone before `git worktree remove` runs, which the
   *  old fire-and-forget kill could not promise. */
  async kill(id: string, snapshot?: ReapSnapshot): Promise<void> {
    const t = this.terminals.get(id)
    if (!t) return
    if (t.killing) return t.killing
    const done = this.reapAndForget(t, snapshot)
    t.killing = done
    return done
  }

  private async reapAndForget(t: Managed, shared?: ReapSnapshot): Promise<void> {
    if (t.pending) { clearTimeout(t.pending.timer); t.pending = null }
    const pid = t.pty?.pid
    // NO `pid` GUARD around this any more, and that is a fix in itself: a pty that already
    // exited on its own (the agent quit `claude`) leaves `t.pty` null, and the old shape then
    // skipped the reap entirely — while the dev server that lane started was still up. The
    // strays are attributable with or without a live pty, so the sweep runs either way.
    try {
      const { ps, tagged } = shared ?? await freshReapSnapshot()
      const selfPgid = selfPgidFrom(ps, process.pid)
      // What the walk will reach on its own, so a process already in the tree is not counted
      // twice or reported as a stray.
      const treePids = pid ? descendantsOf(ps, pid) : new Set<number>()
      const { reap: strayRows, refused } = laneStrays(
        tagged,
        { terminalId: t.id, devPort: t.devPort, appPid: process.pid },
        { treePids, selfPid: process.pid, selfPgid },
      )
      // The refusals are the interesting half when something is left behind: a stray carrying
      // this lane's id but another run's app pid is the cross-project collision the tag guards
      // against, and it should be visible rather than silent.
      for (const r of refused) console.error(`[reap] ${t.id}: left pid ${r.pid} alone — ${r.why}`)
      const strays = expandStrays(ps, strayRows)
      if (strays.size) {
        console.error(`[reap] ${t.id}: ${strays.size} reparented stray(s) the tree could not reach: ${[...strays].join(', ')}`)
      }
      if (pid || strays.size) {
        // `rootPid` 0 when the pty is already gone: `reapTree` walks nothing and signals only
        // the strays, which is exactly the intent.
        const { found, pgids, escalated } = await reapTree(pid ?? 0, ps, { alsoReap: strays })
        if (escalated.length) {
          console.error(`[reap] ${t.id}: SIGKILLed ${escalated.length} of ${found.length} (groups ${pgids.join(', ')})`)
        }
      }
    } catch (e) {
      console.error(`[reap] ${t.id}: tree reap failed, falling back to the pty:`, e)
    }
    // Belt and braces, and the ONLY path when there is no pty yet (a deferred launch cancelled
    // before it exec'd) or when the snapshot came back empty: node-pty's own single-pid SIGHUP,
    // which is what this method used to be in its entirety.
    try { t.pty?.kill() } catch { /* already gone */ }

    // Same as the Rust path: removing the entry is what makes a second `terminal:exit`
    // impossible, and the frontend's exit path must not run twice.
    this.terminals.delete(t.id)
    // The lane is already out of `this.terminals` (line above), so what remains is every OTHER
    // live lane — see `shouldReleaseCwdPort` for the double-allocation this guards.
    if (this.portsByCwd.get(t.cwd) === t.devPort
        && shouldReleaseCwdPort([...this.terminals.values()], t.cwd, t.devPort)) {
      this.portsByCwd.delete(t.cwd)
    }
    // A CLEAN kill — so there is nothing left here for the next boot to hunt for.
    if (t.sessionId) await releaseLease(t.sessionId)
    // DID THE REAP ACTUALLY FREE THE PORT? Everything above signals a process tree; nothing
    // above confirms the socket went with it. A dev server that reparented past the walk (see
    // reap.ts:319) leaves the port held, the lease released, and no trace anywhere — which is
    // how 24 orphans accumulated unnoticed, one of them squatting 1420 since August. Now the
    // leak announces itself at the moment it is created, next to the lane that caused it.
    if (t.devPort) void this.reportStillBound(t.id, t.devPort)
  }

  /** Name whatever still holds a port after its lane was reaped. Best-effort and never awaited
   *  by the kill path — a diagnostic must not slow down a close, or fail one.
   *
   *  INFERRED FROM `ps`, not from `lsof`: the call that would say for certain which process owns
   *  a socket is the one this codebase forbids, because per-pid inspection fires a macOS TCC
   *  prompt. So the report says what it actually knows — a tagged process still carrying this
   *  port, or a command line mentioning it — and says plainly when it cannot attribute the
   *  holder at all, rather than naming a plausible pid. */
  private async reportStillBound(id: string, port: number): Promise<void> {
    try {
      if (await isPortFree(port)) return
      const [ps, tagged] = await Promise.all([snapshotPs(), sweepTagged()])
      const suspects = new Map<number, string>()
      for (const r of tagged) if (r.devPort === port) suspects.set(r.pid, r.command)
      // A server started with `--port 1425` need not carry our env tag at all — the agent may
      // have launched it from a shell that never inherited it.
      for (const r of ps) if (new RegExp(`\\b${port}\\b`).test(r.command)) suspects.set(r.pid, r.command)
      if (!suspects.size) {
        console.error(`[ports] ${id}: port ${port} is still bound after reap; holder not attributable from ps`)
        return
      }
      for (const [pid, command] of suspects) {
        console.error(`[ports] ${id}: port ${port} still bound after reap — pid ${pid}: ${command.slice(0, 200)}`)
      }
    } catch { /* a diagnostic that throws is worse than one that is missing */ }
  }

  list(): Array<{ id: string; pid: number; cwd: string; command: string; alive: boolean; devPort?: number; claudeVersion: string | null }> {
    return [...this.terminals.values()].map((t) => ({
      // Reported so a tab re-attached after a renderer reload still knows its lane's version.
      claudeVersion: t.claudeVersion,
      id: t.id,
      pid: t.pty?.pid ?? 0,
      cwd: t.cwd,
      command: 'claude',
      // A pty that has not been exec'd yet is NOT dead — it is deferred. Reporting it as
      // dead would have the frontend reconcile a launching lane away.
      alive: !t.exited,
      devPort: t.devPort,
    }))
  }

  history(id: string): string {
    const t = this.terminals.get(id)
    return t ? Buffer.concat(t.history).toString('base64') : ''
  }

  /** Record a dev-server port sniffed from this session's own terminal output.
   *
   *  This is what REPLACED the per-pid `lsof` walk, which fired a macOS TCC prompt ("would
   *  like to access data from other apps") once per inspected process. Attribution comes from
   *  the session's own bytes, so a sibling lane's server can never be mistaken for this one's
   *  and nothing inspects another process. */
  noteSessionPort(id: string, port: number): void {
    const t = this.terminals.get(id)
    if (!t || !Number.isInteger(port) || port < 1 || port > 65535) return
    t.sniffedPorts.add(port)
  }

  /** Ports this session is serving on, EACH WITH HOW WELL WE CAN ATTRIBUTE IT.
   *
   *  This used to return a bare `number[]` under a comment claiming "every port here belongs to
   *  THIS session". It did not: the reserved port was included whenever anything at all was
   *  listening on it, so a stale orphan or a sibling lane squatting 1422 was reported as this
   *  lane's app and the preview showed someone else's server. That is the bug.
   *
   *  Attribution is decided in `port-attribution.ts` — sniffed from our own bytes is proof;
   *  reserved-and-claimed-by-our-own-subtree is strong evidence; everything else answering is
   *  `foreign` and the caller must not show it as ours. No `lsof` anywhere: the `ps -E` snapshot
   *  the reaper already takes is the evidence, and the limits of that inference are written down
   *  where the decision is made.
   *
   *  Sorted by port so the caller's pick cannot flip with the order the OS reports things. */
  async sessionPorts(id: string): Promise<SessionPort[]> {
    const t = this.terminals.get(id)
    if (!t) return []
    const candidates = new Set<number>(t.sniffedPorts)
    if (t.devPort) candidates.add(t.devPort)
    if (!candidates.size) return []

    const live = (await Promise.all([...candidates].map(async (p) => (await isPortLive(p)) ? p : null)))
      .filter((p): p is number => p != null)
    if (!live.length) return []

    // The `ps` evidence is only needed when a LIVE port is not one of ours by sniffing — which is
    // the only case attribution has to work for. A lane whose server announced itself pays
    // nothing here, and the rest share a 3s-cached snapshot rather than each dumping the whole
    // process table (this call is polled, twice per session).
    const needsEvidence = live.some((p) => !t.sniffedPorts.has(p))
    const { psRows, claimants } = needsEvidence
      ? await evidenceSnapshot()
      : { psRows: [], claimants: new Map<number, Array<{ pid: number; terminalId?: string }>>() }
    const deep = ownDeepPids(psRows, t.pty?.pid)

    // HOW MANY LANES HOLD THIS RESERVATION. `allocPort` hands one port to every lane in a cwd
    // deliberately ("a sibling lane serving the same code is not a collision"), so for N lanes in
    // one root the reserved value is identical and cannot tell them apart. Counting the holders
    // is what lets the frontend say `shared with 2 lanes` instead of showing one of them.
    const holders = (port: number) =>
      [...this.terminals.values()].filter((o) => o.devPort === port && !o.exited).length

    return live
      .map((port) => {
        const others = (claimants.get(port) ?? []).filter((c) => c.terminalId && c.terminalId !== id)
        const attributed = attributePort({
          port,
          sniffed: t.sniffedPorts.has(port),
          reservedPort: t.devPort,
          reservationHolders: holders(port),
          terminalId: id,
          claimants: claimants.get(port) ?? [],
          ownDeepPids: deep,
        })
        return {
          port,
          attributed,
          sharedWith: attributed === 'shared' ? holders(port) : undefined,
          claimedBy: attributed === 'claimed' ? others[0]?.terminalId : undefined,
        }
      })
      .sort((a, b) => a.port - b.port)
  }

  devPorts(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const t of this.terminals.values()) if (t.devPort) out[t.id] = t.devPort
    return out
  }

  /** Is this pty's child actually running? The frontend once hardcoded `true` for this, which
   *  made the list a register of ptys that EXIST rather than ptys that WORK. */
  isAlive(id: string): boolean {
    const t = this.terminals.get(id)
    return !!t && !t.exited
  }

  /** Did this terminal emit output within `ms`? i.e. is it actively working right now.
   *
   *  The tailer uses this to outrank the transcript: bytes are moving NOW, while the transcript
   *  is written after the fact, so deriving "waiting" from the file while output streams would
   *  flicker every lane between running and waiting once a second. */
  activeWithin(id: string, ms: number): boolean {
    const at = this.terminals.get(id)?.lastActivityAt
    return at != null && Date.now() - at < ms
  }

  /** Kill every pty AND every tree under them. Called from the quit path — the shell owns these
   *  children, and leaving them behind is the accident `CloseRequested` exists to prevent on the
   *  Tauri side. Quit had the IDENTICAL leak as lane close, because it was only ever a loop over
   *  `kill()`; it still is, which is what makes one fix cover both.
   *
   *  ONE snapshot for the whole fleet, and the lanes reap CONCURRENTLY: serialising ten lanes
   *  through their own grace periods would put a visible multi-second stall on every quit.
   *  `teardown()` awaits this before the app is allowed to exit. */
  async killAll(): Promise<void> {
    const ids = [...this.terminals.keys()]
    if (!ids.length) return
    const snapshot = await freshReapSnapshot()
    await Promise.all(ids.map((id) => this.kill(id, snapshot)))
  }

  /** THE LIVE-APP SWEEP — narrow on purpose, and much narrower than it was.
   *
   *  It used to reap ANY tagged row carrying this app's pid whose terminal id is not open here.
   *  That is far too broad for an automatic path: the tag is inherited, so the set includes every
   *  process a closed lane ever started and anything that merely ran in a tagged shell — a
   *  Homebrew `postgres` and an Xcode `Python3` were both carrying lane tags on this machine.
   *  Killing on that evidence, on a timer, with no user in the loop, is how a reaper takes down a
   *  database.
   *
   *  So it now applies the BOOT SWEEP'S GATES, all three, and reaps only their intersection:
   *
   *    1. a LEASE names that terminal id and port — written at spawn, released on a clean kill,
   *       so it says Operator issued this and never took it back;
   *    2. the port is STILL BOUND, so there is something to reclaim rather than a stale record;
   *    3. the command LOOKS LIKE A DEV SERVER, which is the only thing this sweep exists to
   *       reclaim a port from.
   *
   *  Everything else that is tagged-but-abandoned is left alone and surfaces in the Dev servers
   *  list as `abandoned-lane`, for a person to confirm. An Operator or Electron binary is refused
   *  outright regardless of tags — our own helpers carry the full set.
   *
   *  NOT A FORCE-QUIT BACKSTOP, which the previous comment claimed: a force-quit kills this timer
   *  with the process, so nothing here runs. The case it actually covers is a close that raced or
   *  threw while this app kept running. A previous run's leftovers are the BOOT sweep's job.
   *
   *  The open set is read at FIRE time, not captured when the timer was armed, so a lane opened
   *  during the interval is never treated as abandoned. */
  async sweepAbandoned(): Promise<number> {
    try {
      const { ps, tagged } = await freshReapSnapshot()
      const open = this.openTerminalIds()
      const candidates = abandonedLaneRows(tagged, {
        appPid: process.pid,
        openTerminalIds: open,
        selfPid: process.pid,
        selfPgid: selfPgidFrom(ps, process.pid),
      })
      if (!candidates.length) return 0

      // GATE 1 — a lease, by terminal id AND port. Both, because a lease for another port on the
      // same id says nothing about this row.
      const leases = await loadLeases()
      const leased = new Set(leases.map((l) => `${l.terminalId} ${l.devPort}`))
      const gated = candidates.filter((r) => {
        if (OPERATOR_BINARY_RE.test(r.command)) return false
        if (r.devPort == null || !r.terminalId) return false
        if (!leased.has(`${r.terminalId} ${r.devPort}`)) return false
        // GATE 3 — the shape. Cheap, so it runs before the socket probe.
        return DEV_SERVER_RE.test(r.command)
      })
      if (!gated.length) {
        if (candidates.length) {
          console.error(`[reap] sweep: ${candidates.length} tagged row(s) left for the Dev servers list — no lease, not a dev server, or ours`)
        }
        return 0
      }

      // GATE 2 — the port is still held. Last because it is the only check that costs a socket.
      const doomed: typeof gated = []
      for (const r of gated) {
        if (!(await isPortLive(r.devPort!))) continue
        doomed.push(r)
      }
      if (!doomed.length) return 0

      const pids = expandStrays(ps, doomed)
      for (const r of doomed) {
        console.error(`[reap] sweep: ${r.terminalId} is not open here and still serves ${r.devPort} — pid ${r.pid}`)
      }
      const { escalated, found } = await reapTree(0, ps, { alsoReap: pids })
      if (escalated.length) console.error(`[reap] sweep: SIGKILLed ${escalated.length} of ${found.length}`)
      return pids.size
    } catch (e) {
      console.error('[reap] sweep failed:', e)
      return 0
    }
  }

  /** Terminal ids open right now — the fact the inventory needs and only this object has. */
  openTerminalIds(): Set<string> {
    return new Set([...this.terminals.values()].filter((t) => !t.exited).map((t) => t.id))
  }

  private pushHistory(t: Managed, buf: Buffer): void {
    t.history.push(buf)
    t.historyBytes += buf.length
    if (t.historyBytes <= HISTORY_CAP * 2) return
    // Drain whole chunks off the front until we are back under the cap. Clipping a partial
    // escape sequence on the oldest chunk is harmless — it has scrolled away.
    while (t.historyBytes > HISTORY_CAP && t.history.length > 1) {
      t.historyBytes -= t.history.shift()!.length
    }
  }
}

/** The two process tables a reap reads: the `ppid` tree, and the env tags that survive a
 *  process leaving that tree. Taken together so `killAll` can share ONE pair across the fleet. */
export interface ReapSnapshot {
  ps: PsRow[]
  tagged: TaggedRow[]
}

/** Both tables, taken FRESH at kill time.
 *
 *  Deliberately not `evidenceSnapshot()` from `port-attribution.ts`, which caches the identical
 *  pair for 3s to serve the preview's polling. Cheap there, wrong here: a pid that died inside
 *  that window can have been recycled by an unrelated process, and this code sends SIGTERM to
 *  what it reads. The polling can afford to be 3s stale; a kill list cannot.
 *
 *  Both halves fail soft to an empty table — `snapshotPs` and `sweepTagged` swallow their own
 *  errors — so this cannot be what makes a quit hang. */
async function freshReapSnapshot(): Promise<ReapSnapshot> {
  const [ps, tagged] = await Promise.all([snapshotPs(), sweepTagged()])
  return { ps, tagged }
}

/** Single-quote for a POSIX shell, mirroring `shell_quote` in lib.rs. */
function shellQuote(a: string): string {
  return `'${a.replace(/'/g, `'\\''`)}'`
}

/** Drop the env a NESTED Claude Code session would inherit from its parent — otherwise a lane
 *  spawned from inside a Claude session believes it IS that session. Mirrors
 *  `strip_nested_session_env`. */
function stripNestedSessionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env }
  // EXACTLY the five keys lib.rs removes, and no more. A tempting `CLAUDE_*` wildcard would
  // also take ANTHROPIC_API_KEY / CLAUDE_CONFIG_DIR with it and break the lane's auth — the
  // nested-session markers are a closed set, so it stays a closed set here.
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_EXECPATH']) {
    delete out[k]
  }
  // Ours, not Claude's: this shell sets them per lane below, and inheriting the parent's
  // would hand every lane the port reserved for whoever launched the app.
  delete out.OPERATOR_TERMINAL_ID
  delete out.OPERATOR_PROJECT_ID
  delete out.OPERATOR_ROLE_ID
  delete out.OPERATOR_APP_PID
  delete out.OPERATOR_DEV_PORT
  delete out.PORT
  return out
}

function clamp(v: number | undefined, lo: number, hi: number): number | undefined {
  return v != null && Number.isFinite(v) && v >= lo && v <= hi ? Math.floor(v) : undefined
}

/** Re-exported so the IPC layer builds the arg vector with the RENDERER's own function
 *  rather than a second copy of the launch rules. */
export { buildArgs, randomUUID, homedir }
