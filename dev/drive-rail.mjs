// Verify SidebarRail's NEW project clustering (seam + shortNameOf tag), which only
// renders when 2+ projects have live sessions — the mock fixture has one.
//
// Rather than edit dev/mock-bridge.ts (another lane may be in it), this intercepts the
// `window.operator` assignment and wraps the reads to add a second project's lanes.
import { webkit } from 'playwright'

const theme = process.argv[2] || 'mission-control-dark'
const tag = process.argv[3] || 'dark'
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 2, colorScheme: theme.endsWith('light') ? 'light' : 'dark' })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))

await p.addInitScript((t) => {
  localStorage.setItem('operator.theme', t)
  localStorage.setItem('operator.sidebarCollapsed', '1') // boot straight into the rail

  const P2 = { path: '/Users/dev/uwazi_app', id: 'proj-uwazi', name: 'uwazi_app' }
  const P3 = { path: '/Users/dev/el-encanto-landing', id: 'proj-encanto', name: 'el-encanto-landing' }
  const extraSessions = [
    { id: 's-u1', terminalId: 'u1', projectId: P2.id, projectName: P2.name, roleId: 'code', model: 'opus', phase: 'running', summary: 'Port the intake form' },
    { id: 's-u2', terminalId: 'u2', projectId: P2.id, projectName: P2.name, roleId: 'qa', model: 'sonnet', phase: 'waiting', summary: 'Regression sweep' },
    { id: 's-e1', terminalId: 'e1', projectId: P3.id, projectName: P3.name, roleId: 'design', model: 'opus', phase: 'idle', summary: 'Hero polish' },
  ]

  let installed = null
  Object.defineProperty(window, 'operator', {
    configurable: true,
    get: () => installed,
    set: (bridge) => {
      // Seed the extra projects/sessions into the stores the mock just wrote.
      const merge = () => {
        try {
          const projects = JSON.parse(localStorage.getItem('operator.projects') || '[]')
          const base = projects[0] || {}
          for (const P of [P2, P3]) {
            if (!projects.some((x) => x.id === P.id)) {
              projects.push({ ...base, ...P, tasks: [], dispatches: [] })
            }
          }
          localStorage.setItem('operator.projects', JSON.stringify(projects))

          const saved = JSON.parse(localStorage.getItem('operator.savedSessions') || '[]')
          for (const s of extraSessions) {
            if (!saved.some((x) => x.terminalId === s.terminalId)) {
              saved.push({
                key: `key-${s.terminalId}`, cwd: s.projectId === P2.id ? P2.path : P3.path,
                projectName: s.projectName, projectId: s.projectId, roleId: s.roleId,
                model: s.model, claudeSessionId: s.id, terminalId: s.terminalId,
                lastActiveAt: new Date(0).toISOString(),
              })
            }
          }
          localStorage.setItem('operator.savedSessions', JSON.stringify(saved))
        } catch (e) { console.log('merge failed', e) }
      }
      merge()

      const base = (s) => ({
        agentId: 'claude-code', workingDirectory: s.projectId === P2.id ? P2.path : P3.path,
        status: 'active', activity: [], activeSubagents: 0, lastToolName: null,
        startedAt: new Date(0).toISOString(), lastActivityAt: new Date(0).toISOString(), ...s,
      })
      const wrapped = { ...bridge }
      const origList = bridge.terminalList
      wrapped.terminalList = async () => {
        const list = await origList()
        return [...list, ...extraSessions.map((s) => ({
          id: s.terminalId, pid: 0, cwd: s.projectId === P2.id ? P2.path : P3.path,
          command: 'claude', alive: true,
        }))]
      }
      const origGet = bridge.getSessions
      wrapped.getSessions = async () => [...(await origGet()), ...extraSessions.map(base)]
      const origSub = bridge.onSessionUpdate
      wrapped.onSessionUpdate = (cb) => origSub((list) => cb([...list, ...extraSessions.map(base)]))
      installed = wrapped
    },
  })
}, theme)

await p.goto('http://localhost:1429/dev/mock.html', { waitUntil: 'load' })
await p.waitForTimeout(3000)
await p.screenshot({ path: `/tmp/operator-shots/audit/rail-${tag}.png`, clip: { x: 0, y: 0, width: 300, height: 980 } })

const info = await p.evaluate(() => {
  const texts = Array.from(document.querySelectorAll('div'))
    .filter((el) => el.children.length === 0 && /^[A-Z]{2,4}$/.test((el.textContent || '').trim()))
    .map((el) => ({ text: el.textContent.trim(), w: el.getBoundingClientRect().width, x: Math.round(el.getBoundingClientRect().x) }))
  return { tags: texts, railWidth: document.querySelector('div')?.getBoundingClientRect().width }
})
console.log(`[${tag}]`, JSON.stringify(info, null, 2))
// The tag is an abbreviation — its title tooltip must be hit-testable to decode it.
const tagHit = await p.evaluate(() => {
  const tag = Array.from(document.querySelectorAll('div'))
    .find((el) => el.children.length === 0 && /^[A-Z]{2,4}$/.test((el.textContent || '').trim()) && el.title)
  if (!tag) return { found: false }
  const r = tag.getBoundingClientRect()
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
  return { found: true, title: tag.title, text: tag.textContent, hitTestable: hit === tag, pe: getComputedStyle(tag).pointerEvents }
})
console.log('tag tooltip:', JSON.stringify(tagHit))
await b.close()
