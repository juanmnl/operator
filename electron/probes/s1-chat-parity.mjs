// S1 acceptance: does the Electron build read a chat.db the TAURI build wrote?
//
// Works on a COPY, never the live file — this opens the store for real, and the store has one
// destructive statement in it. The copy is also what lets the last check exist: hash the file
// before and after, and prove that opening it changed nothing.
//
//   node probes/s1-chat-parity.mjs
import Database from 'better-sqlite3'
import { copyFileSync, createReadStream, existsSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const LIVE = join(homedir(), '.operator', 'chat.db')
const COPY = join(tmpdir(), `chat-parity-${Date.now()}.db`)

const hash = (p) => new Promise((res, rej) => {
  const h = createHash('sha256')
  createReadStream(p).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej)
})

if (!existsSync(LIVE)) { console.error(`no chat.db at ${LIVE}`); process.exit(1) }
console.log(`live store: ${(statSync(LIVE).size / 1048576).toFixed(1)} MB`)
copyFileSync(LIVE, COPY)

const fail = []
const check = (name, ok, detail) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) fail.push(name) }

// Ground truth straight from SQL, before our code touches it.
const truth = new Database(COPY, { readonly: true })
const userVersion = truth.pragma('user_version', { simple: true })
const totalMessages = truth.prepare('SELECT COUNT(*) c FROM messages').get().c
const biggest = truth.prepare('SELECT session_id, COUNT(*) c FROM messages GROUP BY session_id ORDER BY c DESC LIMIT 1').get()
const expected = truth.prepare('SELECT kind, text, ts, images, tool FROM messages WHERE session_id = ? ORDER BY seq').all(biggest.session_id)
const projectWithReplies = truth.prepare(
  `SELECT project_id, COUNT(*) c FROM replies WHERE project_id IS NOT NULL AND project_id <> '' GROUP BY project_id ORDER BY c DESC LIMIT 1`,
).get()
const expectedReplies = projectWithReplies
  ? truth.prepare('SELECT id, session_id, to_target, text, ts FROM replies WHERE project_id = ? ORDER BY ts').all(projectWithReplies.project_id)
  : []
truth.close()

const before = await hash(COPY)

// Now the real thing, through the shipped code path.
const { ChatStore } = await import('../out/main/chat-store.cjs').catch(() => import('./_tsx-shim.mjs'))
const store = new ChatStore(COPY)

console.log(`\nsession ${biggest.session_id} (${biggest.c} rows)`)
const got = store.load(biggest.session_id)

check('row count matches SQL', got.length === expected.length, `${got.length} vs ${expected.length}`)
check('order preserved (by seq)', got.every((g, i) => g.text === expected[i].text && g.kind === expected[i].kind))
check('timestamps preserved', got.every((g, i) => g.timestamp === expected[i].ts))

const withTool = expected.findIndex((e) => e.tool)
if (withTool >= 0) {
  const parsed = JSON.parse(expected[withTool].tool)
  check('tool blocks parse back to objects', typeof got[withTool].tool === 'object' && got[withTool].tool?.name === parsed.name,
        `${got[withTool].tool?.name}`)
} else {
  check('tool blocks (none in this session — not exercised)', true)
}
const withImages = expected.findIndex((e) => e.images)
check('images parse back to a list', withImages < 0 || Array.isArray(got[withImages].images))

if (projectWithReplies) {
  const gotReplies = store.replies(projectWithReplies.project_id)
  check('replies match SQL for a real project', gotReplies.length === expectedReplies.length,
        `${gotReplies.length} vs ${expectedReplies.length} in ${projectWithReplies.project_id}`)
  check('reply fields map correctly', gotReplies.every((r, i) => r.text === expectedReplies[i].text && r.to === expectedReplies[i].to_target && r.sessionId === expectedReplies[i].session_id))
} else {
  check('replies (no project-scoped replies to compare)', true)
}

// The contract from the brief: "the Electron build must open an existing chat.db unmodified".
store.close()
const after = await hash(COPY)
check('opening the store did NOT modify the file', before === after, before === after ? `sha256 ${before.slice(0, 12)}…` : 'FILE CHANGED')
check('no purge backup was written (user_version was already current)', !existsSync(`${COPY}.pre-v1.bak`), `user_version=${userVersion}`)

const post = new Database(COPY, { readonly: true })
check('no rows were deleted', post.prepare('SELECT COUNT(*) c FROM messages').get().c === totalMessages, `${totalMessages} messages`)
post.close()

rmSync(COPY, { force: true })
rmSync(`${COPY}-wal`, { force: true })
rmSync(`${COPY}-shm`, { force: true })

console.log(fail.length ? `\nFAILED: ${fail.join(', ')}` : '\nall checks passed')
process.exit(fail.length ? 1 : 0)
