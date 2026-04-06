import { PtyManager } from './pty-manager'

export interface LaunchOptions {
  permissionMode?: string
  model?: string
  allowedTools?: string
}

export function launchClaudeCode(ptyManager: PtyManager, cwd: string, options?: LaunchOptions): string {
  const args: string[] = []

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

  return ptyManager.spawn(cwd, 'claude', args, {
    FORCE_COLOR: '1',
  })
}
