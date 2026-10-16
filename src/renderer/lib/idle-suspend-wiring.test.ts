import { describe, it, expect } from 'vitest'
import { suspendDecision } from './idle-suspend'

// The DashboardView wiring has no unit tests of its own, so the two QA defects that lived only in
// it (final pass 2026-10-16) are pinned here against the source, the way chrome.test.ts pins layout
// rules: a rule enforced only by review is not enforced.

const SOURCES = import.meta.glob('../views/DashboardView.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const raw = Object.values(SOURCES)[0]

/** Comments stripped, so the checks read code and not the prose about it. */
const src = raw
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)))

/** The text of `const <name> = …` up to the next top-level `const` of the component. */
function bodyOf(name: string): string {
  const at = src.indexOf(`const ${name} = `)
  expect(at, `${name} is declared`).toBeGreaterThan(-1)
  const next = src.indexOf('\n  const ', at + 1)
  return src.slice(at, next === -1 ? undefined : next)
}

describe('every lane spawn is stamped (QA final pass, O2)', () => {
  // Lanes the project-resume card brought back were suspended 26 s later with a 60 s limit: the
  // restore path spawned without stamping `spawnedAtRef`, so the suspend tick read them as quiet
  // since their last transcript record, minutes earlier.
  it('spawns ptys in one place, which stamps the spawn time', () => {
    expect(src.match(/window\.operator\.terminalSpawn\(/g)).toHaveLength(1)
    const helper = bodyOf('spawnLanePty')
    expect(helper).toContain('window.operator.terminalSpawn(')
    expect(helper).toMatch(/spawnedAtRef\.current\.set\(result\.terminalId, Date\.now\(\)\)/)
  })

  it('the launch, the restore and the resume in place all go through it', () => {
    expect(bodyOf('handleRestoreSession')).toContain('await spawnLanePty(')
    expect(bodyOf('spawnInPlace')).toContain('await spawnLanePty(')
    expect(bodyOf('handleLaunchSession')).toContain('await spawnLanePty(')
  })

  it('with the stamp, a lane restored 26 s ago is not idle, whatever its transcript says', () => {
    const now = Date.parse('2026-10-16T19:26:03.180Z')
    const lane = { terminalId: 't9', roleId: 'research', phase: 'waiting', lastActivityAt: '2026-10-16T19:12:16.000Z', resumable: true, conversation: true, devServer: false }
    expect(suspendDecision(lane, now, 60_000).suspend).toBe(true)
    expect(suspendDecision({ ...lane, spawnedAt: now - 26_000 }, now, 60_000)).toEqual({ suspend: false, why: 'not idle long enough' })
  })
})

describe('closing a project ends its suspended lanes', () => {
  // `closePlan` took suspended sessions since round 2, but it was handed the observer's sessions,
  // where a suspended lane has none. The rail's sessions carry them.
  it('plans the close from the rail sessions', () => {
    const close = bodyOf('closeProject')
    expect(close).toContain('sidebarSessionsRef.current')
    expect(close).not.toMatch(/closePlan\(id, sessionsRef\.current\)/)
  })
})
