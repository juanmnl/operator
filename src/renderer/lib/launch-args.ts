// Build the Claude Code CLI argument vector from launch options. Extracted from
// operator-bridge so it can be unit-tested without pulling in the Tauri runtime.

export function buildArgs(o: Record<string, unknown> = {}, sessionId?: string): string[] {
  const args: string[] = []
  // Resume keeps the prior session id; a new session is pinned to a known uuid
  // so the backend can read exactly that transcript file.
  if (o.resumeSessionId) args.push('--resume', String(o.resumeSessionId))
  else if (sessionId) args.push('--session-id', sessionId)
  if (o.permissionMode && o.permissionMode !== 'default') {
    if (o.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions')
    else args.push('--permission-mode', String(o.permissionMode))
  }
  if (o.model) args.push('--model', String(o.model))
  if (o.allowedTools) args.push('--allowedTools', ...String(o.allowedTools).split(/\s+/).filter(Boolean))
  if (o.initialPrompt && String(o.initialPrompt).trim()) args.push(String(o.initialPrompt).trim())
  return args
}
