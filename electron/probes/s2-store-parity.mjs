// S2 acceptance: does the Node store write BYTE-FOR-BYTE what the Rust store writes?
//
// The ground truth is the real `~/.operator/*.json` — those files were written by the Rust
// (`save_projects` / `save_sessions` / `save_role_defaults`, `serde_json::to_string_pretty`).
// Parse one, re-serialize it through the Node writer, and diff the bytes. Anything that differs
// is a divergence the Electron build would introduce the first time it saved.
//
// Read-only against the live files; every write goes to a temp dir.
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'store-parity-'))
process.env.OPERATOR_DIR = SANDBOX

const store = await import('../out/main/store.cjs')

const fail = []
const check = (name, ok, detail) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) fail.push(name) }

const LIVE = join(homedir(), '.operator')

for (const [file, save, load] of [
  ['projects.json', store.saveProjects, store.loadProjects],
  ['sessions.json', store.saveSessions, store.loadSessions],
  ['role-defaults.json', store.saveRoleDefaults, store.loadRoleDefaults],
]) {
  const src = join(LIVE, file)
  if (!existsSync(src)) { console.log(`\n${file}: not present, skipped`); continue }
  const rustBytes = readFileSync(src)
  const parsed = JSON.parse(rustBytes.toString('utf8'))

  console.log(`\n${file} (${(rustBytes.length / 1024).toFixed(0)} KB, written by the Rust)`)
  await save(parsed)
  const nodeBytes = readFileSync(join(SANDBOX, file))

  const same = rustBytes.equals(nodeBytes)
  check('byte-for-byte identical', same, same ? `${nodeBytes.length} bytes` : `rust ${rustBytes.length} vs node ${nodeBytes.length}`)

  if (!same) {
    // Where do they first differ, and is the CONTENT the same?
    const a = rustBytes.toString('utf8'), b = nodeBytes.toString('utf8')
    let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++
    console.log(`      first difference at byte ${i}:`)
    console.log(`        rust: ${JSON.stringify(a.slice(i - 20, i + 40))}`)
    console.log(`        node: ${JSON.stringify(b.slice(i - 20, i + 40))}`)
    check('  …but the parsed content is equal', JSON.stringify(parsed) === JSON.stringify(JSON.parse(b)) || deepEq(parsed, JSON.parse(b)))
  }

  // Round-trip through load(), which is what the app actually does.
  const back = await load()
  check('load() round-trips the value', deepEq(parsed, back))
}

// THE CASE A ROUND-TRIP CANNOT SEE. Re-serializing a Rust-written file preserves its key order
// because that order is already what serde produced. A FRESH save from the frontend arrives in
// the frontend's own order, and there the two writers can disagree.
//
// serde_json without `preserve_order` backs a JSON object with a BTreeMap, so it writes keys
// SORTED. Evidence it is not enabled here: every object in the real projects.json is in exact
// alphabetical order (`createdAt, id, lastActiveAt, name, path, railOrder, tasks`), which a
// frontend type does not produce by chance.
console.log('\nfresh save, frontend key order (not alphabetical)')
{
  const fresh = [{ path: '/x/y', name: 'zeta', id: 'p1', createdAt: 't', lastActiveAt: 't' }]
  await store.saveProjects(fresh)
  const written = readFileSync(join(SANDBOX, 'projects.json'), 'utf8')
  const keysAsWritten = [...written.matchAll(/^    "(\w+)":/gm)].map((m) => m[1])
  console.log(`      keys as written: ${keysAsWritten.join(', ')}`)
  check('keys are written SORTED, as serde_json does', JSON.stringify(keysAsWritten) === JSON.stringify([...keysAsWritten].sort()),
        JSON.stringify(keysAsWritten) === JSON.stringify([...keysAsWritten].sort()) ? 'matches the Rust' : 'insertion order — the Rust would sort these')
}

function deepEq(a, b) { return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b)) }
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  return v
}

rmSync(SANDBOX, { recursive: true, force: true })
console.log(fail.length ? `\nFAILED: ${fail.join(', ')}` : '\nstore parity confirmed')
process.exit(fail.length ? 1 : 0)
