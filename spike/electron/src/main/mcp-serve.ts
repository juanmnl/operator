// Operator's own MCP server — `operator --mcp-serve`, the artifact plane's write side.
//
// THE SAME BINARY IS THE APP AND THE SERVER. `terminalSpawn` hands each lane
// `{"command": process.execPath, "args": ["--mcp-serve"]}`, so a lane talks to the build it was
// launched from: nothing extra to sign, notarize or locate. Ported from `src-tauri/src/mcp.rs`,
// and proven to survive packaging + Developer ID signing in
// `dev/briefs/2026-08-20-electron-mcp-serve-probe-RESULT.md` (85ms, execPath correct under asar).
//
// THE CONDITION FROM THAT PROBE: a quarantined, UNNOTARIZED bundle spawned this way hangs
// silently — no output, no error, no exit code. Notarizing and stapling is therefore load-
// bearing for this file, not release polish.
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { ArtifactStore } from './chat-store'

const PROTOCOL_VERSION = '2024-11-05'

/** The APP's version, for `serverInfo`. `npm_package_version` is only set when npm launched the
 *  process, which a lane's spawn never does — packaged, it reported "0.0.0". Read from the
 *  package.json beside the bundle, and fall back rather than throw: a server that refuses to
 *  start because it could not name itself is worse than one that says "unknown". */
const VERSION = (() => {
  for (const p of [join(__dirname, '..', '..', 'package.json'), join(__dirname, '..', '..', '..', '..', 'package.json')]) {
    try {
      const v = JSON.parse(readFileSync(p, 'utf8')).version
      if (typeof v === 'string' && v !== '0.0.1') return v
    } catch { /* try the next */ }
  }
  return process.env.npm_package_version ?? 'unknown'
})()

interface Caller { terminalId: string; projectId: string | null; roleId: string | null }

/** WHO IS CALLING — and a call that cannot answer this is REFUSED.
 *
 *  `OPERATOR_TERMINAL_ID` is exported into every lane's environment at spawn, which is what
 *  makes it answerable. Refusing is the point: an unattributable report is worse than no
 *  report, because it lands in the store looking like data while Operator cannot tell whose it
 *  is or which task it closes. The failure has to be loud at the call site, where the lane can
 *  still say something about it, rather than silent in a table. */
function resolveCaller(): Caller {
  const terminalId = (process.env.OPERATOR_TERMINAL_ID ?? '').trim()
  if (!terminalId) {
    throw new Error(
      'unattributable call: OPERATOR_TERMINAL_ID is not set in this environment. This tool is ' +
      'only available to a lane Operator launched.',
    )
  }
  // sessions.json maps terminal id → project and role. A lane not yet in the snapshot is still
  // attributable BY TERMINAL — the row is written with what is known rather than rejected.
  let projectId: string | null = null
  let roleId: string | null = null
  try {
    const raw = JSON.parse(readFileSync(join(process.env.OPERATOR_DIR || join(homedir(), '.operator'), 'sessions.json'), 'utf8'))
    const list: unknown = Array.isArray(raw) ? raw : (raw as Record<string, unknown>)?.sessions
    if (Array.isArray(list)) {
      const hit = list.find((s) => (s as Record<string, unknown>)?.terminalId === terminalId) as Record<string, unknown> | undefined
      if (hit) {
        projectId = typeof hit.projectId === 'string' ? hit.projectId : null
        roleId = typeof hit.roleId === 'string' ? hit.roleId : null
      }
    }
  } catch { /* no snapshot yet — terminal id alone is enough */ }
  return { terminalId, projectId, roleId }
}

const textResult = (text: string) => ({ content: [{ type: 'text', text }] })
const errorResult = (text: string) => ({ content: [{ type: 'text', text }], isError: true })

const TOOLS = [
  {
    name: 'operator__report',
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
          items: { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' } }, required: ['name', 'content'] },
        },
      },
      required: ['summary'],
    },
  },
  {
    name: 'operator__task_status',
    description: "Tell Operator a task's status changed. Call it when you START and when you FINISH.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task id.' },
        status: { type: 'string', enum: ['queued', 'running', 'done', 'blocked'] },
      },
      required: ['id', 'status'],
    },
  },
]

const VALID_STATUS = new Set(['queued', 'running', 'done', 'blocked'])

function callTool(name: string, args: Record<string, unknown>): unknown {
  let caller: Caller
  try { caller = resolveCaller() } catch (e) { return errorResult(String((e as Error).message)) }

  let store: ArtifactStore
  try { store = new ArtifactStore() } catch (e) { return errorResult(`artifact store unavailable: ${e}`) }

  const at = new Date().toISOString()
  try {
    if (name === 'operator__report') {
      const summary = typeof args.summary === 'string' ? args.summary.trim() : ''
      if (!summary) {
        return errorResult('`summary` is required — a report with nothing in it is the silence this tool exists to remove.')
      }
      const taskId = typeof args.taskId === 'string' ? args.taskId : null
      const artifactsJson = Array.isArray(args.artifacts) ? JSON.stringify(args.artifacts) : '[]'
      const id = store.insertReport(at, caller.terminalId, caller.projectId, caller.roleId, taskId, summary, artifactsJson)
      return textResult(`Reported to Operator (#${id}). It is readable outside your worktree; you do not need to relay it.`)
    }

    if (name === 'operator__task_status') {
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      const status = typeof args.status === 'string' ? args.status.trim() : ''
      if (!id || !status) return errorResult('`id` and `status` are both required.')
      if (!VALID_STATUS.has(status)) return errorResult('`status` must be one of: queued, running, done, blocked.')
      store.insertStatus(at, caller.terminalId, caller.projectId, id, status)
      return textResult(`Task ${id} marked ${status}.`)
    }

    return errorResult(`unknown tool: ${name}`)
  } catch (e) {
    return errorResult(`could not store the call: ${e}`)
  } finally {
    store.close()
  }
}

/** One request in, one response out — or `null` for a notification, which must NOT be answered.
 *  Answering `notifications/initialized` with a result is a protocol error and pushes every
 *  later response one frame out of step. */
export function handle(req: Record<string, unknown>): Record<string, unknown> | null {
  const id = req?.id
  if (id === undefined || id === null) return null
  const method = typeof req.method === 'string' ? req.method : ''
  const params = (req.params ?? {}) as Record<string, unknown>

  switch (method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'operator', version: VERSION } } }
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
    case 'tools/call':
      return { jsonrpc: '2.0', id, result: callTool(String(params.name ?? ''), (params.arguments ?? {}) as Record<string, unknown>) }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
  }
}

/** The stdio loop. One JSON object per line in, one per line out.
 *
 *  STDOUT IS THE PROTOCOL, so it is taken away from everything else first: `console.log` is
 *  rebound to stderr and the writer keeps a private handle. Chromium's own logging already goes
 *  to stderr, but that is an assumption about someone else's code, and a stray line here is a
 *  silently mangled frame rather than a crash. */
export function serve(): void {
  const write = process.stdout.write.bind(process.stdout)
  console.log = (...a: unknown[]) => console.error(...a)
  console.info = console.log
  console.debug = console.log

  const send = (obj: unknown) => write(`${JSON.stringify(obj)}\n`)
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (raw) => {
    const line = raw.trim()
    if (!line) return
    let req: Record<string, unknown>
    // Malformed input is not worth killing the server for — the client may recover.
    try { req = JSON.parse(line) } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
      return
    }
    const resp = handle(req)
    if (resp) send(resp)
  })
  // Exit with the client.
  rl.on('close', () => process.exit(0))
}
