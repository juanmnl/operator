import { describe, it, expect } from 'vitest'

// Lane and project lifecycle wiring in DashboardView (lifecycle UX audit, 2026-10-24). DashboardView
// has no unit tests of its own, so these rules are pinned against its source, as
// idle-suspend-wiring.test.ts does.

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

/** The JSX prop `name={…}`, up to the closing brace that matches its opening one. */
function propOf(name: string): string {
  const at = src.indexOf(`${name}={`)
  expect(at, `${name} is passed`).toBeGreaterThan(-1)
  let depth = 0
  for (let i = at + name.length + 1; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1)
  }
  throw new Error(`${name} is unterminated`)
}

describe('the Team card ■ closes a suspended lane (task 1)', () => {
  // A suspended lane has no observed session, so a lookup in the observer's `sessions` found
  // nothing and the click was a silent no-op. The rail's sessions carry suspended lanes.
  it('looks the lane up in the rail sessions', () => {
    const close = propOf('onCloseTerminal')
    expect(close).toContain('allSidebarSessions.find(')
    expect(close).not.toMatch(/\bsessions\.find\(/)
    expect(close).toContain('handleCloseSession(')
  })
})

describe('project close pushes one true toast and offers Retry (task 2)', () => {
  it('closeProject hands its lanes to the one routine Retry also uses', () => {
    expect(bodyOf('closeProject')).toContain('endProjectLanesRef.current(project, live)')
    expect(bodyOf('closeProject')).not.toContain('pushToast(')
  })

  it('pushes exactly one toast per run, chosen by closeToast', () => {
    const end = bodyOf('endProjectLanes')
    expect(end.match(/pushToast\(/g)).toHaveLength(2) // the nothing-to-end pointer, and the outcome
    expect(end.match(/closeToast\(/g)).toHaveLength(2)
    expect(end).not.toMatch(/did not stop/)
  })

  it('decides "did not stop" by aliveness read after the bound', () => {
    const end = bodyOf('endProjectLanes')
    expect(end.match(/window\.operator\.terminalList/g)).toHaveLength(2)
    expect(end).toContain('stuckAfterClose(attempts, aliveAfter)')
  })

  it('Retry re-runs the close on the stuck lanes only', () => {
    const end = bodyOf('endProjectLanes')
    expect(end).toMatch(/label: 'Retry'/)
    expect(end).toMatch(/stuck\.map\([^)]*\)[\s\S]*endProjectLanesRef\.current\(project, fresh\)/)
  })
})

describe('Close project goes through the close guard (task 3)', () => {
  it('opens the dialog only when there are lanes to end', () => {
    const req = bodyOf('requestCloseProject')
    expect(req).toMatch(/if \(!plan\.sessions\.length\) \{ void closeProject\(id\); return \}/)
    expect(req).toContain('closeGuardCopy(project.name, plan.sessions.length, plan.running)')
  })

  it('every entry point asks; only the guard and the idle path close directly', () => {
    // requestCloseProject's idle path, the guard's End, and nothing else.
    expect(src.match(/void closeProject\(/g)).toHaveLength(2)
    expect(propOf('onCloseProject')).toBe('onCloseProject={requestCloseProject}')
  })

  it('the rail menu item does not arm: the dialog is the confirm', () => {
    const items = bodyOf('railMenuItems')
    expect(items).toContain('requestCloseProject(project.id)')
    expect(items).not.toMatch(/confirm: live/)
  })
})
