import { PtyManager } from './pty-manager'

export interface LaunchOptions {
  permissionMode?: string
  model?: string
  allowedTools?: string
  /** Resume a specific prior Claude Code session by id (`claude --resume <id>`). */
  resumeSessionId?: string
  /** Initial prompt submitted on launch (`claude "<prompt>"`) — used for fan-out. */
  initialPrompt?: string
}

export function launchClaudeCode(ptyManager: PtyManager, cwd: string, options?: LaunchOptions): string {
  const args: string[] = []

  if (options?.resumeSessionId) {
    args.push('--resume', options.resumeSessionId)
  }

  if (options?.permissionMode && options.permissionMode !== 'default') {
    if (options.permissionMode === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions')
    } else {
      args.push('--permission-mode', options.permissionMode)
    }
  }

  if (options?.model) {
    args.push('--model', options.model)
  }

  if (options?.allowedTools) {
    args.push('--allowedTools', ...options.allowedTools.split(/\s+/).filter(Boolean))
  }

  // Positional initial prompt — submitted automatically on launch.
  if (options?.initialPrompt && options.initialPrompt.trim()) {
    args.push(options.initialPrompt.trim())
  }

  // Launch through an interactive login shell so the user's real PATH (and
  // node/nvm setup) is loaded. When the app is launched from Finder it inherits
  // only a minimal PATH, so spawning `claude` directly fails with ENOENT and the
  // pty exits instantly. `zsh -ilc '<cmd>'` sources the user's profile first.
  const shell = process.env.SHELL || '/bin/zsh'
  const cmdline = ['claude', ...args].map(shellQuote).join(' ')

  return ptyManager.spawn(cwd, shell, ['-ilc', cmdline], {
    FORCE_COLOR: '1',
  })
}

/** Single-quote a shell argument, escaping embedded single quotes. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
