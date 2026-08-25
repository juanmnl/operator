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
import { reapTree, snapshotPs, type PsRow } from './reap'
import { claimLease, releaseLease } from './leases'
import { isPortLive } from './port-probe'
import { attributePort, evidenceSnapshot, ownDeepPids, type SessionPort } from './port-attribution'
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

/** Dev-port reservations, mirroring `alloc_port`: one port per session, and lanes sharing a
 *  cwd share a port (a sibling lane serving the same code is not a collision). */
const PORT_BASE = 1420
const PORT_MAX = 1520

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
   *  the second lane joins the first's server rather than starting a redundant one. Same rule
   *  as `alloc_port` in lib.rs, and its `shares one port across lanes in the same cwd` test. */
  private allocPort(cwd: string): number | undefined {
    const shared = this.portsByCwd.get(cwd)
    if (shared) return shared
    const taken = new Set(this.portsByCwd.values())
    for (let p = PORT_BASE; p <= PORT_MAX; p++) {
      if (!taken.has(p)) {
        this.portsByCwd.set(cwd, p)
        return p
      }
    }
    return undefined
  }

  /** Build the login-shell command line exactly as `terminal_spawn` does. The `-ilc` form is
   *  not incidental: Claude Code is usually on a PATH that only an interactive login shell
   *  sets up, and dropping to a bare exec is how a build "can't find claude" while the real
   *  app can. */
  private buildCommand(o: SpawnOptions): { shell: string; argv: string[]; env: NodeJS.ProcessEnv; devPort?: number; id: string } {
    const id = this.nextId()
    const devPort = this.allocPort(o.cwd)
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
    })
    const prefix = ['claude', '--settings', settingsPath ?? JSON.stringify({ tui: o.tuiMode })]
    const notes: string[] = []
    if (devPort) {
      notes.push(
        `Operator reserved localhost port ${devPort} for this session; start any dev server on ` +
          `exactly that port (pass --port ${devPort}, or read it from the PORT env var).`,
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

  spawn(o: SpawnOptions): { terminalId: string; cwd: string; grid: boolean } {
    const { shell, argv, env, devPort, id } = this.buildCommand(o)
    const cols = clamp(o.cols, 20, 500) ?? DEFAULT_COLS
    const rows = clamp(o.rows, 5, 200) ?? DEFAULT_ROWS

    const managed: Managed = { id, cwd: o.cwd, sessionId: o.sessionId, pty: null, pending: null, history: [], historyBytes: 0, devPort, sniffedPorts: new Set(), exited: false }
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
    return { terminalId: id, cwd: o.cwd, grid: false }
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
    const managed: Managed = { id, cwd, pty: null, pending: null, history: [], historyBytes: 0, sniffedPorts: new Set(), exited: false }
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
   *  `rows` lets `killAll` reap the whole fleet from a single snapshot rather than one per lane.
   *
   *  AWAITING THIS IS THE POINT at the call sites that remove a worktree afterwards: the tree
   *  holding files open in that directory is gone before `git worktree remove` runs, which the
   *  old fire-and-forget kill could not promise. */
  async kill(id: string, rows?: PsRow[]): Promise<void> {
    const t = this.terminals.get(id)
    if (!t) return
    if (t.killing) return t.killing
    const done = this.reapAndForget(t, rows)
    t.killing = done
    return done
  }

  private async reapAndForget(t: Managed, rows?: PsRow[]): Promise<void> {
    if (t.pending) { clearTimeout(t.pending.timer); t.pending = null }
    const pid = t.pty?.pid
    if (pid) {
      try {
        const snapshot = rows ?? await snapshotPs()
        const { found, pgids, escalated } = await reapTree(pid, snapshot)
        if (escalated.length) {
          console.error(`[reap] ${t.id}: SIGKILLed ${escalated.length} of ${found.length} (groups ${pgids.join(', ')})`)
        }
      } catch (e) {
        console.error(`[reap] ${t.id}: tree reap failed, falling back to the pty:`, e)
      }
    }
    // Belt and braces, and the ONLY path when there is no pty yet (a deferred launch cancelled
    // before it exec'd) or when the snapshot came back empty: node-pty's own single-pid SIGHUP,
    // which is what this method used to be in its entirety.
    try { t.pty?.kill() } catch { /* already gone */ }

    // Same as the Rust path: removing the entry is what makes a second `terminal:exit`
    // impossible, and the frontend's exit path must not run twice.
    this.terminals.delete(t.id)
    if (t.devPort && this.portsByCwd.get(t.cwd) === t.devPort) this.portsByCwd.delete(t.cwd)
    // A CLEAN kill — so there is nothing left here for the next boot to hunt for.
    if (t.sessionId) await releaseLease(t.sessionId)
  }

  list(): Array<{ id: string; pid: number; cwd: string; command: string; alive: boolean; devPort?: number }> {
    return [...this.terminals.values()].map((t) => ({
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

    return live
      .map((port) => ({
        port,
        attributed: attributePort({
          port,
          sniffed: t.sniffedPorts.has(port),
          reservedPort: t.devPort,
          terminalId: id,
          claimants: claimants.get(port) ?? [],
          ownDeepPids: deep,
        }),
      }))
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
    const rows = await snapshotPs()
    await Promise.all(ids.map((id) => this.kill(id, rows)))
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
