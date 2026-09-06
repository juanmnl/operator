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
  try {
    const v = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')).version
    if (typeof v === 'string') return v
  } catch { /* fall through */ }
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
  // THE ENVIRONMENT IS THE AUTHORITY, and sessions.json is only the fallback.
  //
  // `OPERATOR_TERMINAL_ID` IS NOT UNIQUE. Terminal ids are minted per app run and start again at
  // `t0` every launch, so `sessions.json` — which is durable across runs and across projects —
  // holds the same id many times over. A live snapshot had `t2` four times: uwazi-app/operator,
  // el-encanto/operator, operator/review, operator/research. `list.find` takes the FIRST, so
  // every report from `t2` was stamped with whichever project happened to sit earliest in the
  // file, and reports #313/#316/#318 landed in the store as `uwazi-app-d9bb8dcc` while their text
  // was a review of `operator`. No amount of filtering downstream can recover from a row that
  // names the wrong project; the fix has to be at the stamp.
  //
  // `terminals.ts` knows both facts at spawn and exports them, so a lane launched by this build
  // states who it is instead of being looked up. The snapshot lookup stays for a lane spawned by
  // an OLDER build (it has no such variables and is still running), and is now narrowed by
  // whichever of the two the environment did supply.
  let projectId: string | null = (process.env.OPERATOR_PROJECT_ID ?? '').trim() || null
  let roleId: string | null = (process.env.OPERATOR_ROLE_ID ?? '').trim() || null
  if (projectId && roleId) return { terminalId, projectId, roleId }
  try {
    const raw = JSON.parse(readFileSync(join(process.env.OPERATOR_DIR || join(homedir(), '.operator'), 'sessions.json'), 'utf8'))
    const list: unknown = Array.isArray(raw) ? raw : (raw as Record<string, unknown>)?.sessions
    if (Array.isArray(list)) {
      const hit = list.find((s) => {
        const row = s as Record<string, unknown>
        if (row?.terminalId !== terminalId) return false
        // Narrowed by what the environment already told us. With neither variable set this is
        // the old first-match-wins lookup, which is all an older lane can be given.
        if (projectId && row.projectId !== projectId) return false
        if (roleId && row.roleId !== roleId) return false
        return true
      }) as Record<string, unknown> | undefined
      if (hit) {
        projectId = projectId ?? (typeof hit.projectId === 'string' ? hit.projectId : null)
        roleId = roleId ?? (typeof hit.roleId === 'string' ? hit.roleId : null)
      }
    }
  } catch { /* no snapshot yet — terminal id alone is enough */ }
  return { terminalId, projectId, roleId }
}

const textResult = (text: string) => ({ content: [{ type: 'text', text }] })
const errorResult = (text: string) => ({ content: [{ type: 'text', text }], isError: true })

const TOOLS = [
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
          items: { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' } }, required: ['name', 'content'] },
        },
      },
      required: ['summary'],
    },
  },
  {
    name: 'dispatch',
    description:
      'Hand a task to another lane in THIS project. Operator resolves the lane, applies the '
      + 'delivery brakes, creates the task and its board entry, and answers with where to send. '
      + 'TWO STEPS: if the answer says `send`, you must then call SendMessage with the `to` and '
      + '`text` it gives you — this tool does not deliver, it routes. If the answer says '
      + '`launching`, Operator is starting that lane with your task as its opening brief and you '
      + 'send nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        lane: { type: 'string', description: "The lane's role id or name, e.g. `code`." },
        task: { type: 'string', description: 'The task, in one line.' },
      },
      required: ['lane', 'task'],
    },
  },
  {
    name: 'reply',
    description:
      'Send one line to another lane in THIS project. Same two-step as `dispatch`: Operator '
      + 'answers with where to send, and you then call SendMessage with what it returns. Use it '
      + 'when a lane needs to know something that changes what it does next — not to narrate.',
    inputSchema: {
      type: 'object',
      properties: {
        lane: { type: 'string', description: "The lane's role id or name." },
        line: { type: 'string', description: 'The message, one line.' },
      },
      required: ['lane', 'line'],
    },
  },
  {
    name: 'task_status',
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

// THE TOOL NAMES ARE BARE ON PURPOSE — `report`, not `operator__report`.
//
// Claude Code namespaces every MCP tool as `mcp__<server>__<tool>`. With the server named
// `operator` and the tools named `operator__report`, the name a lane actually sees was
// `mcp__operator__operator__report` — doubled, and matching nothing any prompt tells a lane to
// call. Verified by running a real lane against the packaged binary:
//
//   $ echo "list every tool starting with operator__" | claude -p --mcp-config '{"mcpServers":…}'
//   mcp__operator__operator__report
//   mcp__operator__operator__task_status
//
// So even with the `--mcp-config` flag finally wired, a lane told "call `operator__report`" would
// have searched its tool list, found nothing under that name, and gone quiet — which is precisely
// the symptom the audit was written about, reproduced one layer further in. Bare names make the
// exposed pair `mcp__operator__report` / `mcp__operator__task_status`, and `roster.ts`'s prompts
// name them that way.

const VALID_STATUS = new Set(['queued', 'running', 'done', 'blocked'])

/** How long a lane waits for Operator's routing decision before giving up. */
const VERDICT_TIMEOUT_MS = 15_000
const VERDICT_POLL_MS = 100

/** Wait for the app's verdict, SYNCHRONOUSLY.
 *
 *  `callTool` is synchronous and so is `handle` above it, because this process serves one stdio
 *  request at a time and nothing here has ever needed to interleave. Threading async through both
 *  for one tool would change the shape of every other. `Atomics.wait` on a throwaway buffer is the
 *  standard way to sleep a Node thread without a busy loop; better-sqlite3 is synchronous too, so
 *  the poll below is a plain read.
 *
 *  Returns null on timeout, and the caller says plainly that nothing was sent — a dispatch that
 *  silently did nothing is the failure this whole path exists to end. */
type StoredVerdict = NonNullable<ReturnType<ArtifactStore['dispatchVerdict']>>

function awaitVerdict(store: ArtifactStore, id: number): StoredVerdict | null {
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  const deadline = Date.now() + VERDICT_TIMEOUT_MS
  for (;;) {
    const v = store.dispatchVerdict(id)
    if (v) return v
    if (Date.now() >= deadline) return null
    Atomics.wait(sleeper, 0, 0, VERDICT_POLL_MS)
  }
}

function callTool(name: string, args: Record<string, unknown>): unknown {
  let caller: Caller
  try { caller = resolveCaller() } catch (e) { return errorResult(String((e as Error).message)) }

  let store: ArtifactStore
  try { store = new ArtifactStore() } catch (e) { return errorResult(`artifact store unavailable: ${e}`) }

  const at = new Date().toISOString()
  try {
    if (name === 'report') {
      const summary = typeof args.summary === 'string' ? args.summary.trim() : ''
      if (!summary) {
        return errorResult('`summary` is required — a report with nothing in it is the silence this tool exists to remove.')
      }
      const taskId = typeof args.taskId === 'string' ? args.taskId : null
      const artifactsJson = Array.isArray(args.artifacts) ? JSON.stringify(args.artifacts) : '[]'
      const id = store.insertReport(at, caller.terminalId, caller.projectId, caller.roleId, taskId, summary, artifactsJson)
      // CLAIMS ONLY THE INSERT. The old wording — "you do not need to relay it" — asserted that
      // someone would read this, and for the whole life of the Electron shell nobody could: there
      // was no UI consumer at all, so a landed report was exactly as invisible as a lost one. A
      // tool that overstates its own delivery teaches the model to stop saying things twice, and
      // that is only safe once delivery is real. Say what happened; do not promise an audience.
      return textResult(
        `Saved as report #${id} in Operator's store. That is the write, not a read receipt — it is `
        + `queued for the coordinator's Inbox and will be marked delivered when it is shown there.`,
      )
    }

    if (name === 'task_status') {
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      const status = typeof args.status === 'string' ? args.status.trim() : ''
      if (!id || !status) return errorResult('`id` and `status` are both required.')
      if (!VALID_STATUS.has(status)) return errorResult('`status` must be one of: queued, running, done, blocked.')
      store.insertStatus(at, caller.terminalId, caller.projectId, id, status)
      return textResult(`Task ${id} marked ${status}.`)
    }

    if (name === 'dispatch' || name === 'reply') {
      const lane = typeof args.lane === 'string' ? args.lane.trim() : ''
      const body = typeof (name === 'dispatch' ? args.task : args.line) === 'string'
        ? String(name === 'dispatch' ? args.task : args.line).trim()
        : ''
      if (!lane || !body) {
        return errorResult(`\`lane\` and \`${name === 'dispatch' ? 'task' : 'line'}\` are both required.`)
      }
      if (!caller.projectId) {
        // Scope is the whole point of routing through Operator: a lane may only address lanes in
        // its own project, and a caller whose project cannot be established has no scope to be in.
        return errorResult('this lane has no project on record, so Operator cannot scope the dispatch.')
      }
      const id = store.openDispatch({
        terminalId: caller.terminalId, projectId: caller.projectId, roleId: caller.roleId,
        kind: name, lane, body,
      })
      const verdict = awaitVerdict(store, id)
      if (!verdict) {
        return errorResult(
          'Operator did not answer in time. Nothing was sent and no task was created — retry, or '
          + 'use the OPERATOR-DISPATCH sentinel, which still works.',
        )
      }
      // THE ANSWER IS JSON ON PURPOSE. The caller has to act on it — `send` means "now call
      // SendMessage with exactly these two fields" — and a sentence would have the model
      // reconstructing an address by eye.
      //
      // BUILT EXPLICITLY, not stringified from the row. The store column is `address`; the wire
      // contract this tool's own description promises is `to`, and so does the coordinator's
      // prompt. Stringifying the internal shape shipped `address` and left every real `send`
      // outcome with no field the lane was told to read — caught by QA (#653) through a real
      // round trip, because both ends were unit-tested in isolation and neither could see the
      // seam. Naming the wire fields here is what stops a column rename becoming a protocol
      // change.
      return textResult(JSON.stringify({
        outcome: verdict.outcome,
        to: verdict.address,
        text: verdict.text,
        taskId: verdict.taskId,
        reason: verdict.reason,
      }))
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
