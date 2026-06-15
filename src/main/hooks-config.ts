import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { app } from 'electron'

/**
 * Absolute path to the hook script. Claude Code executes this as an external
 * command, so it must be a real file on disk — in a packaged app it ships via
 * extraResources (Contents/Resources/scripts), not inside the asar archive.
 */
export function hookScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'scripts', 'operator-hook.sh')
    : join(app.getAppPath(), 'scripts', 'operator-hook.sh')
}

/**
 * Ensures Claude Code's ~/.claude/settings.json has hooks pointing to Operator.
 * Merges non-destructively — preserves existing settings and non-Operator hook entries.
 * Also cleans up malformed entries from previous versions.
 */
export function ensureHooksConfigured(): void {
  const hookPath = hookScriptPath()
  const claudeDir = join(homedir(), '.claude')
  const settingsPath = join(claudeDir, 'settings.json')

  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true })
  }

  let settings: Record<string, unknown> = {}
  try {
    const raw = readFileSync(settingsPath, 'utf-8')
    settings = JSON.parse(raw)
  } catch {
    // File doesn't exist or isn't valid JSON — start fresh
  }

  // Correct format: { matcher: "", hooks: [{ type: "command", command: "..." }] }
  const operatorEntry = { matcher: '', hooks: [{ type: 'command', command: hookPath }] }
  const hookEvents = [
    'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
    'Notification', 'Stop', 'SubagentStop', 'SubagentStart',
    'SessionStart', 'SessionEnd', 'UserPromptSubmit',
    'PreCompact', 'TaskCompleted',
  ]

  const hooks = (settings.hooks || {}) as Record<string, unknown[]>
  let changed = false

  for (const event of hookEvents) {
    const existing = hooks[event] || []

    // Remove malformed Operator entries (old format without matcher, or missing matcher)
    const cleaned = existing.filter((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) return false
      const e = entry as Record<string, unknown>
      // Remove bare { type, command } entries pointing to our hook
      if (e.type === 'command' && e.command === hookPath) return false
      // Remove { hooks: [...] } entries missing matcher
      if (Array.isArray(e.hooks) && !('matcher' in e)) {
        const hasOurs = (e.hooks as unknown[]).some(
          (h: unknown) => typeof h === 'object' && h !== null && (h as Record<string, unknown>).command === hookPath
        )
        if (hasOurs) return false
      }
      return true
    })

    // Check if a correct Operator entry already exists
    const alreadyConfigured = cleaned.some((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) return false
      const e = entry as Record<string, unknown>
      if (!('matcher' in e) || !Array.isArray(e.hooks)) return false
      return (e.hooks as unknown[]).some(
        (h: unknown) => typeof h === 'object' && h !== null && (h as Record<string, unknown>).command === hookPath
      )
    })

    if (!alreadyConfigured) {
      hooks[event] = [...cleaned, operatorEntry]
      changed = true
    } else if (cleaned.length !== existing.length) {
      // Malformed entries were removed
      hooks[event] = cleaned
      changed = true
    }
  }

  if (changed) {
    settings.hooks = hooks
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
    console.log('Operator: configured hooks in', settingsPath)
  }
}
