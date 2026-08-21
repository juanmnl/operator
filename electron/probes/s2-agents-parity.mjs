// S2 acceptance: does the Node agent library read the REAL agent files, and does its writer
// produce something its own reader agrees with?
//
// The reference is `src-tauri/src/agents.rs`. The ground truth is the user's actual
// `~/.claude/agents/*.md` — files Claude Code and the Tauri build both read. Read-only against
// them; the serialize round-trip writes into a temp dir.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'agents-parity-'))
const agents = await import('../out/main/agents.cjs')

const fail = []
const check = (name, ok, detail) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) fail.push(name) }

const dir = join(homedir(), '.claude', 'agents')
if (!existsSync(dir)) { console.log('no ~/.claude/agents — nothing to compare against'); process.exit(0) }
const files = readdirSync(dir).filter((f) => f.endsWith('.md'))
console.log(`${files.length} real agent files in ~/.claude/agents\n`)

const list = await agents.listAgents()
check('every file with a `name` parsed', list.length > 0, `${list.length} parsed`)
check('sorted case-insensitively by name', JSON.stringify(list.map((a) => a.name)) ===
      JSON.stringify([...list.map((a) => a.name)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))))
check('all are user scope with no projectPath', list.every((a) => a.scope === 'user' && a.projectPath === undefined))
check('every one has a path that exists', list.every((a) => existsSync(a.path)))

// Frontmatter fields, against a hand-parse of the raw file.
let fieldMismatch = 0
for (const a of list) {
  const raw = readFileSync(a.path, 'utf8')
  const fm = raw.startsWith('---\n') ? raw.slice(4, raw.indexOf('\n---', 4)) : ''
  const field = (k) => { const m = fm.match(new RegExp(`^${k}:\\s*(.+)$`, 'm')); return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined }
  if (field('name') !== a.name) { fieldMismatch++; console.log(`      name: ${field('name')} vs ${a.name}`) }
  if (field('model') !== undefined && field('model') !== a.model) { fieldMismatch++; console.log(`      model: ${field('model')} vs ${a.model}`) }
  // The body must not carry the frontmatter, and must be trimmed.
  if (a.prompt.startsWith('---')) { fieldMismatch++; console.log(`      ${a.name}: prompt still carries frontmatter`) }
  if (a.prompt !== a.prompt.trim()) { fieldMismatch++; console.log(`      ${a.name}: prompt not trimmed`) }
}
check('frontmatter fields match a hand-parse', fieldMismatch === 0, `${fieldMismatch} mismatches across ${list.length} files`)

// A `tools:` value is a list in some files and a comma-separated string in others; Claude Code
// accepts both, so both must read as a list.
const withTools = list.filter((a) => a.tools?.length)
check('tools read as a list wherever present', withTools.every((a) => Array.isArray(a.tools) && a.tools.every((t) => typeof t === 'string')),
      `${withTools.length} agents declare tools`)

// Serialize → parse round-trip through a temp scope.
console.log('\nwrite/read round-trip')
const proj = join(SANDBOX, 'proj')
mkdirSync(join(proj, '.claude', 'agents'), { recursive: true })
const sample = list[0]
const saved = await agents.saveAgent({ ...sample, scope: 'project', projectPath: proj, path: '' })
check('save reports ok', saved.ok, saved.path ?? saved.error)
const back = (await agents.listAgents(proj)).find((a) => a.scope === 'project')
check('name survives', back?.name === sample.name)
check('description survives', back?.description === sample.description)
check('model survives', (back?.model ?? null) === (sample.model ?? null), `${back?.model} vs ${sample.model}`)
check('tools survive', JSON.stringify(back?.tools ?? null) === JSON.stringify(sample.tools ?? null))
check('prompt survives byte-for-byte', back?.prompt === sample.prompt.trim())
check('filename derives from the name', saved.path?.endsWith(`${sample.name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')}.md`), saved.path)

// A rename must not leave the old file behind — the library would list both.
const renamed = await agents.saveAgent({ ...sample, name: `${sample.name}-renamed`, scope: 'project', projectPath: proj }, saved.path)
const after = await agents.listAgents(proj)
check('a rename removes the old file', after.filter((a) => a.scope === 'project').length === 1, `${after.filter((a) => a.scope === 'project').length} project agents`)
check('delete is idempotent — a missing file is success', (await agents.deleteAgent(renamed.path)).ok && (await agents.deleteAgent(renamed.path)).ok)

// A file with no `name` is not an agent — this is what keeps a stray README out of the library.
writeFileSync(join(proj, '.claude', 'agents', 'README.md'), '# just some notes\n')
check('a file without a `name` is skipped', (await agents.listAgents(proj)).filter((a) => a.scope === 'project').length === 0)

rmSync(SANDBOX, { recursive: true, force: true })
console.log(fail.length ? `\nFAILED: ${fail.join(', ')}` : '\nagent parity confirmed')
process.exit(fail.length ? 1 : 0)
