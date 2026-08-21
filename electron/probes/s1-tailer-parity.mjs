// S1 acceptance: does the Electron tailer read a real transcript the same way Tauri did?
//
// The jsonl is the ground truth and both shells read it — but the Tauri app cannot be driven
// from here, so the comparison uses the closest thing to its own output that exists: the rows
// the TAURI BUILD ALREADY WROTE to chat.db for that same session. Those rows are the Rust
// tailer's answer for this exact file. Running the Node tailer over the same file and diffing
// the two is the parity check the brief asks for, without needing both apps open at once.
//
//   node probes/s1-tailer-parity.mjs [sessionId]
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const LIVE_DB = join(homedir(), '.operator', 'chat.db')
const PROJECTS = join(homedir(), '.claude', 'projects')

// A sandboxed HOME whose .claude/projects SYMLINKS the real one: the tailer reads, never
// writes, so linking is safe and avoids copying gigabytes of transcripts.
const SANDBOX = join(tmpdir(), `tailer-parity-${Date.now()}`)
mkdirSync(join(SANDBOX, '.claude'), { recursive: true })
symlinkSync(PROJECTS, join(SANDBOX, '.claude', 'projects'))
process.env.HOME = SANDBOX
process.env.OPERATOR_DIR = join(SANDBOX, 'operator-home')

const db = new Database(LIVE_DB, { readonly: true })
const pick = process.argv[2] ?? db.prepare(
  'SELECT session_id FROM messages GROUP BY session_id ORDER BY COUNT(*) DESC LIMIT 1',
).get().session_id

let jsonl = null
for (const d of readdirSync(PROJECTS)) {
  const p = join(PROJECTS, d, `${pick}.jsonl`)
  if (existsSync(p)) { jsonl = p; break }
}
if (!jsonl) { console.error(`no transcript on disk for ${pick}`); process.exit(1) }

const tauri = db.prepare('SELECT seq, kind, text, ts, tool FROM messages WHERE session_id = ? ORDER BY seq').all(pick)
db.close()

console.log(`session ${pick}`)
console.log(`  jsonl     ${(statSync(jsonl).size / 1048576).toFixed(1)} MB`)
console.log(`  tauri rows ${tauri.length}\n`)

const { Transcript } = await import('../out/main/transcript.cjs')
const t = new Transcript()
t.register('t0', { claudeSessionId: pick, cwd: '/x/y', projectId: 'p' })
const node = []
t.on('chat', (_id, entries) => node.push(...entries))
// Poll until the file is fully consumed — one tick reads whatever is there, and a big file is
// read in one pass, but loop until nothing new arrives so this is not timing-dependent.
for (let i = 0; i < 10; i++) {
  const before = node.length
  await t.tick({ isAlive: () => true, isActive: () => false })
  if (node.length === before) break
}

const fail = []
const check = (name, ok, detail) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) fail.push(name) }

// FOLD BY SEQ, the way the store does. A tool row is pushed twice — once for the call, once
// when its result lands — and both carry the same seq, so the DB holds one row per seq with the
// last write winning. Comparing raw pushes to rows would count that as a difference.
const folded = new Map()
for (const [seq, e] of node) folded.set(seq, e)
const nodeRows = [...folded.entries()].sort((a, b) => a[0] - b[0])
console.log(`  node pushes ${node.length} → ${nodeRows.length} rows after folding by seq\n`)

check('row count matches', nodeRows.length === tauri.length, `node ${nodeRows.length} vs tauri ${tauri.length}`)

// Compare on the fields that are the CONTRACT: seq, kind, and text. `ts` comes straight from
// the file, and the tool payload is compared by name rather than byte-for-byte because the
// output cap attaches asynchronously and the stored row is whichever write landed last.
const n = Math.min(nodeRows.length, tauri.length)
let seqMismatch = 0, kindMismatch = 0, textMismatch = 0, toolMismatch = 0
const examples = []
for (let i = 0; i < n; i++) {
  const [seq, e] = nodeRows[i]
  const r = tauri[i]
  if (seq !== r.seq) seqMismatch++
  if (e.kind !== r.kind) { kindMismatch++; if (examples.length < 3) examples.push(`#${i} kind ${e.kind} vs ${r.kind}`) }
  if ((e.text ?? '') !== (r.text ?? '')) { textMismatch++; if (examples.length < 3) examples.push(`#${i} text "${String(e.text).slice(0, 40)}" vs "${String(r.text).slice(0, 40)}"`) }
  const rt = r.tool ? JSON.parse(r.tool) : null
  if ((e.tool?.name ?? null) !== (rt?.name ?? null)) { toolMismatch++; if (examples.length < 3) examples.push(`#${i} tool ${e.tool?.name} vs ${rt?.name}`) }
}
check('seq assignment matches', seqMismatch === 0, `${seqMismatch} differ`)
check('kinds match', kindMismatch === 0, `${kindMismatch} differ`)
check('text matches', textMismatch === 0, `${textMismatch} differ`)
check('tool block names match', toolMismatch === 0, `${toolMismatch} differ`)
if (examples.length) console.log('\n  first differences:\n' + examples.map((e) => `    ${e}`).join('\n'))

const session = t.sessions()[0]
console.log(`\n  derived: summary="${String(session.summary).slice(0, 60)}" model=${session.model} phase=${session.phase}`)
console.log(`  live tail ${session.messages.length} (cap 80), activity ${session.activity.length}, usage ${JSON.stringify(session.usage)}`)
check('live tail is capped at 80', session.messages.length <= 80)
check('a summary was derived', !!session.summary)

rmSync(SANDBOX, { recursive: true, force: true })
console.log(fail.length ? `\nFAILED: ${fail.join(', ')}` : '\nparity confirmed')
process.exit(fail.length ? 1 : 0)
