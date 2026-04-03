import { PtyManager } from './pty-manager'

export function launchClaudeCode(ptyManager: PtyManager, cwd: string): string {
  return ptyManager.spawn(cwd, 'claude', [], {
    FORCE_COLOR: '1',
  })
}
