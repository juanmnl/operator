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
