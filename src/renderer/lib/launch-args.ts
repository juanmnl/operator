// Build the Claude Code CLI argument vector from launch options. Extracted from
// operator-bridge so it can be unit-tested without pulling in the Tauri runtime.

/** THE CLIENT HALF of the artifact plane.
 *
 *  The server half has existed and worked the whole time — `mcp-serve.ts` is a complete MCP
 *  server and `index.ts` has a `--mcp-serve` branch that lets the packaged binary answer it
 *  headlessly. What never existed in the Electron port is the flag that points a lane AT it, so
 *  `operator__report` has not been in any lane's tool list since the shell changed on 2026-08-21.
 *  The audit measured the consequence exactly: 0 of 13 live lanes carried `--mcp-config`, 0
 *  `operator__report` calls appear in any of the day's transcripts, and `artifacts.db` has not
 *  been written to since the Tauri build stopped launching lanes.
 *
 *  `command` is the OPERATOR BINARY ITSELF — `process.execPath`. In the packaged app that is
 *  `Operator.app/Contents/MacOS/Operator`; in dev it is the `electron` binary, which needs the
 *  app path as its first argument or it opens an empty shell instead of running our main script.
 *  That asymmetry is why the caller passes both rather than this function guessing.
 *
 *  Passed as INLINE JSON rather than a file: it is one small object, it changes per lane only in
 *  ways this function already knows, and a temp file would be one more thing to write, clean up,
 *  and fail to find. */
export function mcpConfigArg(execPath: string, appPath?: string): string {
  const args = appPath ? [appPath, '--mcp-serve'] : ['--mcp-serve']
  return JSON.stringify({ mcpServers: { operator: { command: execPath, args } } })
}

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
  // A LANE'S EFFORT TRAVELS HERE, not in `~/.claude/settings.json`. The launch path used to write
  // the level into the GLOBAL settings file before spawning, which made six lanes at six efforts
  // last-write-wins across all of them — the global file is an app-wide default, not a per-lane
  // channel. The flag takes the full ladder, `max` included (see lib/effort).
  if (o.effort) args.push('--effort', String(o.effort))
  if (o.allowedTools) args.push('--allowedTools', ...String(o.allowedTools).split(/\s+/).filter(Boolean))
  // REMOTE CONTROL'S NAME — what the Claude phone app lists this session as. Only for a lane
  // whose role has it on; the settings file is what actually turns the bridge on or off (see
  // `buildSessionSettings`), and this only decides what it is called.
  //
  // ORDER MATTERS, and this is the one place it does. `--remote-control [name]` takes an
  // OPTIONAL argument, so it must never be the last flag before the positional prompt below: with
  // no name of its own it would swallow the prompt as its name and the lane would start with no
  // instruction and an absurd phone label. Pushing it here, and only ever with a non-empty name,
  // means the prompt is always a separate token. Verified against the installed binary (2.1.261):
  // the name binds and the following argument is left alone.
  const rcName = typeof o.remoteControlName === 'string' ? o.remoteControlName.trim() : ''
  if (rcName) args.push('--remote-control', rcName)
  if (o.initialPrompt && String(o.initialPrompt).trim()) args.push(String(o.initialPrompt).trim())
  return args
}
