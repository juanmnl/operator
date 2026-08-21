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
import { homedir } from 'node:os'
import { buildArgs } from '../../../../src/renderer/lib/launch-args'

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
}

interface Managed {
  id: string
  cwd: string
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
   *  sets up, and dropping to a bare exec is how a spike "can't find claude" while the real
   *  app can. */
  private buildCommand(o: SpawnOptions): { shell: string; argv: string[]; env: NodeJS.ProcessEnv; devPort?: number; id: string } {
    const id = this.nextId()
    const devPort = this.allocPort(o.cwd)
    const prefix = ['claude', '--settings', JSON.stringify({ tui: o.tuiMode })]
    const notes: string[] = []
    if (devPort) {
      notes.push(
        `Operator reserved localhost port ${devPort} for this session; start any dev server on ` +
          `exactly that port (pass --port ${devPort}, or read it from the PORT env var).`,
      )
    }
    if (o.orchestrationNote?.trim()) notes.push(o.orchestrationNote.trim())
    if (notes.length) prefix.push('--append-system-prompt', notes.join('\n\n'))

    // NOTE — the artifact plane (`--mcp-config` pointing at Operator's own `--mcp-serve`) is
    // deliberately NOT wired here. It resolves `std::env::current_exe`, which in this shell is
    // the Electron binary, and a lane talking to an MCP server that doesn't exist is worse than
    // a lane without one. Porting it is an L in the ledger, not a line in this spike.

    const inner = [...prefix, ...o.args].map(shellQuote).join(' ')
    const shell = process.env.SHELL || '/bin/zsh'
    const env: NodeJS.ProcessEnv = { ...stripNestedSessionEnv(process.env) }
    env.OPERATOR_TERMINAL_ID = id
    if (devPort) {
      env.OPERATOR_DEV_PORT = String(devPort)
      env.PORT = String(devPort)
    }
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

    const managed: Managed = { id, cwd: o.cwd, pty: null, pending: null, history: [], historyBytes: 0, devPort, sniffedPorts: new Set(), exited: false }
    this.terminals.set(id, managed)

    const launch = (c: number, r: number) => {
      if (managed.pty || managed.exited) return
      if (managed.pending) { clearTimeout(managed.pending.timer); managed.pending = null }
      const p = ptySpawn(shell, argv, { name: 'xterm-256color', cols: c, rows: r, cwd: o.cwd, env: env as Record<string, string> })
      managed.pty = p
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
    const shell = process.env.SHELL || '/bin/zsh'
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

  kill(id: string): void {
    const t = this.terminals.get(id)
    if (!t) return
    if (t.pending) { clearTimeout(t.pending.timer); t.pending = null }
    try { t.pty?.kill() } catch { /* already gone */ }
    // Same as the Rust path: removing the entry is what makes a second `terminal:exit`
    // impossible, and the frontend's exit path must not run twice.
    this.terminals.delete(id)
    if (t.devPort && this.portsByCwd.get(t.cwd) === t.devPort) this.portsByCwd.delete(t.cwd)
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

  /** Ports this session is actually serving on: the one Operator reserved for it plus the ones
   *  sniffed from its output, filtered to those answering a loopback connect. */
  async sessionPorts(id: string): Promise<number[]> {
    const t = this.terminals.get(id)
    if (!t) return []
    const candidates = new Set<number>(t.sniffedPorts)
    if (t.devPort) candidates.add(t.devPort)
    const live = await Promise.all([...candidates].map(async (p) => (await isLive(p)) ? p : null))
    return live.filter((p): p is number => p != null).sort((a, b) => a - b)
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

  /** Kill every pty. Called from the quit path — the shell owns these children, and leaving
   *  them behind is the accident `CloseRequested` exists to prevent on the Tauri side. */
  killAll(): void {
    for (const id of [...this.terminals.keys()]) this.kill(id)
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

/** Is something listening on this loopback port?
 *
 *  BOTH loopbacks are probed. Vite (via Node's localhost resolution) binds [::1] ONLY on some
 *  machines, so a v4-only probe reads a live server as down — and the caller then starts a
 *  second one on the v4 side of the same port. */
async function isLive(port: number): Promise<boolean> {
  const { createConnection } = await import('node:net')
  const probe = (host: string) => new Promise<boolean>((resolve) => {
    const sock = createConnection({ port, host })
    const done = (v: boolean) => { sock.destroy(); resolve(v) }
    sock.setTimeout(250)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
  return (await probe('127.0.0.1')) || (await probe('::1'))
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
