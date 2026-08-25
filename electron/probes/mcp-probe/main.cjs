// The riskiest line in the whole migration, isolated.
//
// Operator's artifact plane works because ONE signed binary is both the app and the MCP server:
// `main.rs` checks `--mcp-serve` before Tauri starts, and `terminal_spawn` hands each lane
// `{"command": <current_exe>, "args": ["--mcp-serve"]}`. If a packaged, signed Electron `.app`
// cannot do the same — stable re-executable path, clean stdio, tolerable startup — the control
// plane breaks silently and only at release time.
//
// This file mirrors `src-tauri/src/mcp.rs` exactly where it matters: JSON-RPC 2.0, ONE OBJECT PER
// LINE, the same three methods (`initialize`, `tools/list`, `tools/call`) plus `ping`, the same
// notification rule (no `id` → no answer), the same `-32601` / `-32700` codes, and the same
// caller-attribution refusal. It deliberately does NOT persist anything: this probe answers "can
// the transport survive the shell change", and writing into the user's real `~/.operator` store
// to answer that would be a side effect nobody asked for.

const readline = require('node:readline')

const PROTOCOL_VERSION = '2024-11-05'
const RUN_AS_NODE = !!process.env.ELECTRON_RUN_AS_NODE
const MCP_SERVE = process.argv.includes('--mcp-serve')

// STDOUT IS THE PROTOCOL. Anything else printed there corrupts a JSON-RPC frame, and the classic
// poisoner is a library or Chromium writing a friendly line. So the very first thing this file
// does is take stdout away from everything except the writer below: `console.log` is rebound to
// stderr before any other code can reach it. Chromium's own logging goes to stderr already, but
// this makes that a guarantee of ours rather than an assumption about theirs.
const stdoutWrite = process.stdout.write.bind(process.stdout)
console.log = (...a) => { console.error(...a) }
console.info = console.log
console.debug = console.log

/** WHO IS CALLING — and a call that cannot answer this is refused.
 *  Mirrors `resolve_caller` in mcp.rs: OPERATOR_TERMINAL_ID is exported into every lane's
 *  environment at spawn, and an unattributable report is worse than no report — it lands looking
 *  like data that Operator cannot trace. The failure has to be loud at the call site. */
function resolveCaller() {
  const terminalId = (process.env.OPERATOR_TERMINAL_ID ?? '').trim()
  if (!terminalId) {
    throw new Error(
      'unattributable call: OPERATOR_TERMINAL_ID is not set in this environment. This tool is ' +
      'only available to a lane Operator launched.',
    )
  }
  return { terminalId }
}

const toolDefs = () => ([
  {
    name: 'report',
    description:
      'Hand your result to Operator directly. Use this INSTEAD OF (or as well as) writing a ' +
      '*-RESULT.md file: a file written inside your worktree is invisible to Operator and to ' +
      'every other lane. Pass the content itself in `artifacts` — never a path into your own ' +
      'checkout, which is exactly what gets lost.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What you did and what came of it, in prose.' },
        taskId: { type: 'string', description: 'The task this answers, if it came from one.' },
        artifacts: {
          type: 'array',
          description: 'Named blobs of CONTENT (not paths).',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, content: { type: 'string' } },
            required: ['name', 'content'],
          },
        },
      },
      required: ['summary'],
    },
  },
])

function callTool(name, args) {
  if (name !== 'report') {
    return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
  }
  let caller
  try { caller = resolveCaller() } catch (e) {
    return { content: [{ type: 'text', text: String(e.message) }], isError: true }
  }
  const summary = typeof args?.summary === 'string' ? args.summary : ''
  if (!summary.trim()) {
    return { content: [{ type: 'text', text: 'summary is required' }], isError: true }
  }
  // PROBE ONLY — nothing is written. The real server inserts a row via artifacts.rs; what is
  // under test here is the transport and the binary's ability to BE the server, not the store.
  return {
    content: [{
      type: 'text',
      text: `probe ok — would record for terminal ${caller.terminalId} ` +
            `(${summary.length} chars, ${(args?.artifacts ?? []).length} artifacts). Nothing persisted.`,
    }],
  }
}

/** One request in, one response out — or `null` for a notification, which must not be answered. */
function handle(req) {
  const id = req?.id
  const method = typeof req?.method === 'string' ? req.method : ''
  const params = req?.params ?? {}
  if (id === undefined || id === null) return null

  switch (method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'operator', version: require('./package.json').version },
      } }
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: toolDefs() } }
    case 'tools/call':
      return { jsonrpc: '2.0', id, result: callTool(params?.name ?? '', params?.arguments ?? {}) }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    // PROBE-ONLY, not part of mcp.rs. `terminal_spawn` writes `{"command": <current_exe>}` into
    // each lane's --mcp-config, so whether `process.execPath` resolves to a stable, re-executable
    // path from inside an asar-packed bundle is the single fact the artifact plane rests on.
    // Asking the server itself is the only honest way to read it.
    case 'probe/env':
      return { jsonrpc: '2.0', id, result: {
        execPath: process.execPath,
        argv0: process.argv[0],
        argv1: process.argv[1],
        resourcesPath: process.resourcesPath ?? null,
        dirname: __dirname,
        insideAsar: __dirname.includes('.asar'),
        runAsNode: RUN_AS_NODE,
        versions: { electron: process.versions.electron ?? null, node: process.versions.node, chrome: process.versions.chrome ?? null },
      } }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
  }
}

function serve() {
  const send = (obj) => stdoutWrite(JSON.stringify(obj) + '\n')
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (raw) => {
    const line = raw.trim()
    if (!line) return
    let req
    try { req = JSON.parse(line) } catch {
      // Malformed input is not worth killing the server for — the client may recover.
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
      return
    }
    const resp = handle(req)
    if (resp) send(resp)
  })
  // Exit with the client, exactly as the Rust loop does when stdin closes.
  rl.on('close', () => process.exit(0))
}

if (MCP_SERVE) {
  // NEVER open a window, take a single-instance lock, or touch the dock/tray on this path.
  // Under ELECTRON_RUN_AS_NODE the `electron` module is not the API (Chromium never boots), so
  // this is guarded rather than assumed.
  if (!RUN_AS_NODE) {
    try {
      const { app } = require('electron')
      app.dock?.hide()
      // Chromium is already up by the time this file runs; keeping the process alive is stdin's
      // job, and `app.quit()` on stdin close would race the exit below.
    } catch (e) { console.error('[mcp-probe] electron app module unavailable:', e.message) }
  }
  serve()
} else {
  // The ordinary app path — the thinnest possible window, only so that the SAME binary is
  // demonstrably a real app and not an MCP server wearing a bundle.
  const { app, BrowserWindow } = require('electron')
  app.whenReady().then(() => {
    const win = new BrowserWindow({ width: 480, height: 240, show: true,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })
    void win.loadURL('data:text/html,<title>mcp-probe</title><body style="font:14px system-ui;padding:2rem">Probe app. Run with <code>--mcp-serve</code> for the stdio server.</body>')
  })
  app.on('window-all-closed', () => app.quit())
}
