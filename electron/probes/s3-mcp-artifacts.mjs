// S3 acceptance: does `--mcp-serve` write the same rows into a real artifacts.db that mcp.rs
// would, and does the two-writer discipline hold?
//
// Runs the PACKAGED-SHAPE server (the built main bundle, via Electron) against a COPY of the
// real `~/.operator/artifacts.db` — never the live one, because every tools/call really inserts.
import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const LIVE = join(homedir(), '.operator', 'artifacts.db')
if (!existsSync(LIVE)) { console.error(`no artifacts.db at ${LIVE}`); process.exit(1) }

const SANDBOX = mkdtempSync(join(tmpdir(), 'mcp-artifacts-'))
copyFileSync(LIVE, join(SANDBOX, 'artifacts.db'))

const fail = []
const check = (name, ok, detail) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) fail.push(name) }

// Baseline, straight from SQL.
const truth = new Database(join(SANDBOX, 'artifacts.db'), { readonly: true })
const before = {
  reports: truth.prepare('SELECT COUNT(*) c FROM reports').get().c,
  status: truth.prepare('SELECT COUNT(*) c FROM task_status').get().c,
  pending: truth.prepare('SELECT COUNT(*) c FROM task_status WHERE applied = 0').get().c,
}
truth.close()
console.log(`copy of the real store: ${before.reports} reports, ${before.status} status rows (${before.pending} unapplied)\n`)

/** Drive the server over stdio, one JSON object per line, exactly as a lane's Claude does. */
function drive(requests, env) {
  return new Promise((resolve) => {
    const c = spawn('npx', ['electron', join(process.cwd(), 'out', 'main', 'index.cjs'), '--mcp-serve'], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, OPERATOR_DIR: SANDBOX, ...env },
    })
    let out = ''
    c.stdout.on('data', (d) => { out += d })
    for (const r of requests) c.stdin.write(JSON.stringify(r) + '\n')
    setTimeout(() => {
      c.stdin.end()
      try { c.kill() } catch { /* already gone */ }
      resolve(out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return { raw: l } } }))
    }, 9000)
  })
}

console.log('a lane reports and updates a task status')
const lane = { OPERATOR_TERMINAL_ID: 't-s3-probe' }
const res = await drive([
  { jsonrpc: '2.0', id: 1, method: 'initialize' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'report', arguments: { summary: 's3 probe report', taskId: 'task-s3', artifacts: [{ name: 'a.md', content: 'body' }] } } },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'task_status', arguments: { id: 'task-s3', status: 'done' } } },
  { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'task_status', arguments: { id: 'task-s3', status: 'nonsense' } } },
  { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'report', arguments: {} } },
], lane)

const byId = Object.fromEntries(res.filter((r) => r.id != null).map((r) => [r.id, r]))
// mcp.rs declares exactly two tools. The S2/S3 brief mentions a third (`brief`); it does not
// exist in the Rust, so the port matching at two is correct.
check('tools/list has exactly the two tools mcp.rs declares',
      JSON.stringify(byId[2]?.result?.tools?.map((t) => t.name)) === JSON.stringify(['report', 'task_status']),
      JSON.stringify(byId[2]?.result?.tools?.map((t) => t.name)))
check('report accepted', byId[3]?.result?.isError !== true, byId[3]?.result?.content?.[0]?.text?.slice(0, 60))
check('task_status accepted', byId[4]?.result?.isError !== true, byId[4]?.result?.content?.[0]?.text)
check('an invalid status is REFUSED', byId[5]?.result?.isError === true, byId[5]?.result?.content?.[0]?.text)
check('a report with no summary is REFUSED', byId[6]?.result?.isError === true, byId[6]?.result?.content?.[0]?.text?.slice(0, 60))

// An UNATTRIBUTABLE call must be refused: a report Operator cannot trace is worse than none.
console.log('\nan unattributable call (no OPERATOR_TERMINAL_ID)')
const anon = await drive([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'report', arguments: { summary: 'from nowhere' } } }],
                         { OPERATOR_TERMINAL_ID: '' })
check('refused, and says why', anon[0]?.result?.isError === true && /unattributable/.test(anon[0]?.result?.content?.[0]?.text ?? ''),
      anon[0]?.result?.content?.[0]?.text?.slice(0, 70))

console.log('\nwhat landed in the store')
const db = new Database(join(SANDBOX, 'artifacts.db'), { readonly: true })
const after = {
  reports: db.prepare('SELECT COUNT(*) c FROM reports').get().c,
  status: db.prepare('SELECT COUNT(*) c FROM task_status').get().c,
}
check('exactly ONE report row was added', after.reports === before.reports + 1, `${before.reports} → ${after.reports}`)
check('exactly ONE status row was added (the invalid one wrote nothing)', after.status === before.status + 1, `${before.status} → ${after.status}`)

const row = db.prepare('SELECT * FROM reports ORDER BY id DESC LIMIT 1').get()
check('attributed to the calling lane', row.terminal_id === 't-s3-probe', row.terminal_id)
check('taskId carried through', row.task_id === 'task-s3')
check('artifacts stored as a JSON STRING, as the renderer expects', typeof row.artifacts === 'string' && JSON.parse(row.artifacts)[0].name === 'a.md')
check('seen defaults to 0 — unread until the app says otherwise', row.seen === 0)

const st = db.prepare('SELECT * FROM task_status ORDER BY id DESC LIMIT 1').get()
check('status row unapplied, so a crash REPLAYS it', st.applied === 0 && st.status === 'done')
check('no pre-existing row was disturbed', db.prepare('SELECT COUNT(*) c FROM task_status WHERE applied = 0').get().c === before.pending + 1)
db.close()

// TWO-WRITER DISCIPLINE: the app reads/acks while lanes write. Both hold the db at once.
console.log('\ntwo writers at once (a lane inserting while the app acks)')
const { ArtifactStore } = await import('../out/main/chat-store.cjs')
const app = new ArtifactStore(join(SANDBOX, 'artifacts.db'))
const pending = app.pendingStatus()
const concurrent = await drive([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'report', arguments: { summary: 'while the app holds the db' } } }], lane)
check('a lane can write while the app has the store open', concurrent[0]?.result?.isError !== true,
      concurrent[0]?.result?.content?.[0]?.text?.slice(0, 50))
app.markApplied(pending.map((p) => p.id))
check('the app can ack while lanes are writing', app.pendingStatus().length === 0, `${pending.length} acked`)
app.close()

rmSync(SANDBOX, { recursive: true, force: true })
console.log(fail.length ? `\nFAILED: ${fail.join(', ')}` : '\nmcp/artifacts parity confirmed')
process.exit(fail.length ? 1 : 0)
