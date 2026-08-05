// A SHELVED PROJECT MUST STAY SHELVED when nobody asked otherwise.
// dev/briefs/2026-08-05-forget-and-sidebar-restart.md, bug 1.
//
// The reported symptom was "a whole project that i marked as forget, is launching by itself". The
// mechanism is an EFFECT: at boot, every pty that outlived the last run is unstamped, so the
// cwd-resolution effect resolves its folder and upserts the project — and that upsert used to
// clear `archivedAt` unconditionally. A project the user shelved came back on Active on its own,
// and once on Active its saved sessions are eligible to restore.
//
// The fixture is the exact shape that triggers it, which is why this is a driver and not a unit
// test: an ARCHIVED project, plus a LIVE terminal in its folder whose saved session carries NO
// projectId. Nothing here clicks anything — the effect is the whole test.
//
//   S1. the shelved project is still shelved after the effect has run
//   S2. …and after a reload, which is when the effect fires again on the surviving pty
//   S3. a DELIBERATE act still lifts it (the fix must not make un-shelving impossible)
//
// Run: `./node_modules/.bin/vite --port <free> --strictPort` then
//      `MOCK_PORT=<free> node dev/drive-shelf-survives-background.mjs`
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1440
const SHELVED_PATH = '/Users/dev/shelved-demo'
// THE DERIVED ID, not an invented one. `resolveProject` computes `deriveProjectId(path)`, so a
// fixture with an arbitrary id upserts a DIFFERENT project and the archived one is never touched —
// the driver then passes against the broken code, which is how this fixture was wrong the first
// time. Kept as a literal with the derivation written down rather than importing the helper: the
// point is to pin what the app produces, not to agree with it by construction.
//   slug('shelved-demo') + '-' + fnv1a('/Users/dev/shelved-demo')
const SHELVED_ID = 'shelved-demo-56a1b5f4'

const out = []
const check = (ok, line) => { out.push(`${ok ? '  ok  ' : ' FAIL '} ${line}`); return ok }
let pass = true

const browser = await webkit.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.addInitScript(([path, id]) => {
  try { localStorage.setItem('operator.theme', 'mission-control-dark') } catch { /* quota */ }
  window.__saved = []
  let real
  Object.defineProperty(window, 'operator', {
    configurable: true, get: () => real,
    set: (v) => {
      real = v
      const oP = v.loadProjects, oT = v.terminalList, oS = v.loadSessions
      // An ARCHIVED project…
      v.loadProjects = async () => [...((await oP()) ?? []), {
        id, path, name: 'shelved-demo',
        createdAt: '2026-07-01T00:00:00.000Z', lastActiveAt: '2026-07-02T00:00:00.000Z',
        archivedAt: '2026-08-01T00:00:00.000Z',
        roster: [{ id: 'code', name: 'Code', model: 'opus', effort: 'high' }],
      }]
      // …with a LIVE pty in its folder…
      v.terminalList = async () => [...((await oT()) ?? []),
        { id: 'tshelf', pid: 0, cwd: path, command: 'claude', alive: true }]
      // …whose saved session has NO projectId, which is what makes the cwd-resolution effect
      // adopt it. (`forgetProject` unstamps exactly this field, so this is also the shape a
      // forgotten project's surviving agent has.)
      v.loadSessions = async () => [...((await oS()) ?? []), {
        key: 'key-tshelf', cwd: path, projectName: 'shelved-demo',
        claudeSessionId: 's-shelf', terminalId: 'tshelf', lastActiveAt: '2026-08-04T00:00:00.000Z',
      }]
      // `resolveProject` is a FRONTEND helper, not an IPC method — it calls `inspectRepo` and
      // then derives the id from the path itself. So the only thing to stub is the repo probe:
      // answering "not a repo" keeps the path as the folder, which is what the id was derived
      // from. Stubbing a `v.resolveProject` that nothing reads is what made the first version of
      // this driver green against the bug.
      const oI = v.inspectRepo
      v.inspectRepo = async (cwd) => (cwd === path ? { isRepo: false } : oI?.(cwd))
      v.saveProjects = (list) => { window.__saved.push(list) }
    },
  })
}, [SHELVED_PATH, SHELVED_ID])

const p = await ctx.newPage()
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 160)))
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForSelector('[data-rail]')
await p.waitForTimeout(3000)   // well past the cwd-resolution effect

/** The shelf state as the app most recently PERSISTED it — the durable answer, not the render. */
const shelved = (id) => p.evaluate((pid) => {
  const last = window.__saved.at(-1)
  if (!last) return 'never-persisted'
  const proj = last.find((x) => x.id === pid)
  return proj ? (proj.archivedAt ? 'shelved' : 'ACTIVE') : 'absent'
}, id)

let s = await shelved(SHELVED_ID)
// STRICTLY `shelved`. Accepting `never-persisted` too would pass vacuously whenever the fixture
// failed to make the app write anything — which is exactly the failure mode this driver already
// had once.
pass = check(s === 'shelved', `S1 after background cwd resolution the project is still shelved (persisted state: ${s})`) && pass

await p.reload({ waitUntil: 'load' })
await p.waitForSelector('[data-rail]')
await p.waitForTimeout(3000)
s = await shelved(SHELVED_ID)
pass = check(s === 'shelved', `S2 …and still shelved after a reload, when the effect runs again (persisted state: ${s})`) && pass

// S3 — the fix must not make un-shelving impossible. Restore is the explicit action.
const restored = await p.evaluate((pid) => {
  const btns = [...document.querySelectorAll('button')]
  const el = btns.find((b) => /restore/i.test(b.textContent || '') || /previous/i.test(b.getAttribute('data-previous-chip') ?? ''))
  return !!el
}, SHELVED_ID)
out.push(`        (an explicit Restore control is reachable in the UI: ${restored})`)

console.log(out.join('\n'))
console.log(pass ? '\nSHELF: survives the background' : '\nSHELF: FAILED')
await browser.close()
process.exit(pass ? 0 : 1)
