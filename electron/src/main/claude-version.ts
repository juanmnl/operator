// WHICH CLAUDE CODE IS INSTALLED, and which one a lane was started on.
//
// Claude Code updates itself in the background: the native installer puts a new binary in
// `~/.local/share/claude/versions/<version>` and moves the `claude` symlink to it. A lane started
// before that keeps running the old binary until its process restarts, and says so only inside its
// own terminal ("Update installed · Restart to update"). This module gets the same fact without
// reading that banner: resolve the `claude` a lane's login shell would run, follow the link, and
// read the version off the target's name.
//
// `--version` is the fallback for an install whose target is not named by version (npm, Homebrew).
// It runs once per resolved path and is cached, so the minute poll never execs the binary twice.
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { loginShell } from './login-shell'

/** How often the installed version is re-read. Updates are rare; a minute late costs nothing. */
export const CLAUDE_VERSION_POLL_MS = 60_000

/** A spawn waits at most this long for a version before launching without one. */
export const SPAWN_VERSION_WAIT_MS = 2_000

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** `2.1.269` from `…/claude/versions/2.1.269`; null when the name is not a version. */
export function versionFromPath(p: string): string | null {
  const name = basename(p)
  return VERSION.test(name) ? name : null
}

/** `2.1.269` from `claude --version`, which prints `2.1.269 (Claude Code)`. */
export function versionFromOutput(out: string): string | null {
  const m = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(out)
  return m ? m[1] : null
}

export interface VersionDeps {
  /** Absolute path of the `claude` a login shell resolves, or null. */
  which: () => Promise<string | null>
  realpath: (p: string) => Promise<string>
  /** Output of `<binary> --version`. */
  runVersion: (binary: string) => Promise<string>
}

const run = (file: string, args: string[]) => new Promise<string>((resolve, reject) => {
  execFile(file, args, { timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))))
})

export const defaultVersionDeps: VersionDeps = {
  // `-ilc` because that is how a lane runs `claude` (see `buildCommand`), so it is the PATH that
  // decides which binary a lane gets. Last absolute line only: an interactive shell may print first.
  which: async () => {
    try {
      const out = await run(loginShell(), ['-ilc', 'command -v claude'])
      return out.split('\n').map((l) => l.trim()).reverse().find((l) => l.startsWith('/')) ?? null
    } catch {
      return null
    }
  },
  realpath: (p) => realpath(p),
  runVersion: (binary) => run(binary, ['--version']),
}

/** The native installer's link, for when the login shell cannot answer. */
const NATIVE_LINK = join(homedir(), '.local', 'bin', 'claude')

export class ClaudeVersionWatcher {
  private command: string | null = null
  private readonly byTarget = new Map<string, string | null>()
  private current: string | null = null
  private inflight: Promise<string | null> | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly onChange: (version: string | null) => void,
    private readonly deps: VersionDeps = defaultVersionDeps,
  ) {}

  /** The last reading, without touching the filesystem. */
  installed(): string | null {
    return this.current
  }

  /** Read the installed version now. Concurrent callers share one read. */
  resolve(): Promise<string | null> {
    if (!this.inflight) this.inflight = this.read().finally(() => { this.inflight = null })
    return this.inflight
  }

  start(intervalMs = CLAUDE_VERSION_POLL_MS): void {
    if (this.timer) return
    void this.resolve()
    this.timer = setInterval(() => { void this.resolve() }, intervalMs)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  private async target(): Promise<string | null> {
    if (!this.command) this.command = (await this.deps.which()) ?? NATIVE_LINK
    try {
      return await this.deps.realpath(this.command)
    } catch {
      // The link is gone or the install changed shape: ask the shell again, once per read.
      this.command = (await this.deps.which()) ?? NATIVE_LINK
      try { return await this.deps.realpath(this.command) } catch { return null }
    }
  }

  private async read(): Promise<string | null> {
    const target = await this.target()
    let version: string | null = null
    if (target) {
      version = versionFromPath(target)
      if (!version) {
        if (!this.byTarget.has(target)) {
          const out = await this.deps.runVersion(target).catch(() => '')
          this.byTarget.set(target, versionFromOutput(out))
        }
        version = this.byTarget.get(target) ?? null
      }
    }
    if (version !== this.current) {
      this.current = version
      this.onChange(version)
    }
    return version
  }
}
