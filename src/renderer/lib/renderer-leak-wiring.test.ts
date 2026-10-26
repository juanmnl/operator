import { describe, it, expect } from 'vitest'

// THE RENDERER LEAK (dev/results/renderer-leak-live-lanes-2026-10-26.md). A memoised callback keeps
// the DashboardView render that created it, and that render keeps the other callbacks as they were
// then. `focusTerminal` was recreated on every session event and `setPanelOpen` on lane switches
// and layout changes, so each held an older version of the other: a chain of retained renders,
// rooted at `onTogglePanel`, that grew for the life of the window, each link with that moment's
// sessions and their messages. The fix keeps callbacks off session state (they read it through
// refs), so session events no longer recreate them. DashboardView has no render tests; this pins
// the wiring against the source, the way idle-suspend-wiring.test.ts does.

const SOURCES = import.meta.glob('../views/DashboardView.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const raw = Object.values(SOURCES)[0]

/** Comments stripped, so the checks read code and not the prose about it. */
const src = raw
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)))

/** Every `const <name> = useCallback(…)` with its body and its dependency list. */
function callbacks(): { name: string; body: string; deps: string[] }[] {
  const out: { name: string; body: string; deps: string[] }[] = []
  for (const m of src.matchAll(/const (\w+) = useCallback\(/g)) {
    let i = m.index! + m[0].length
    let depth = 1
    while (depth > 0) {
      const c = src[i++]
      if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') depth--
    }
    const text = src.slice(m.index! + m[0].length, i - 1)
    const open = text.lastIndexOf('[')
    out.push({
      name: m[1],
      body: text.slice(0, open),
      deps: text.slice(open + 1, text.lastIndexOf(']')).split(',').map((d) => d.trim()).filter(Boolean),
    })
  }
  return out
}

/** State that changes with session and lane events. */
const SESSION_STATE = ['sessions', 'terminals', 'localSessions', 'allSidebarSessions', 'sessionLayouts', 'savedSessions', 'resumeOffer', 'activeSession']
/** Read directly, not through a ref (`terminalsRef.current`) or as a property (`x.sessions`). */
const readsDirectly = (body: string, name: string) => new RegExp(`(?<![\\w.])${name}\\b(?!Ref)`).test(body)

describe('callbacks do not change identity with session state', () => {
  const all = callbacks()
  const byName = new Map(all.map((c) => [c.name, c]))

  it('finds the callbacks it checks', () => {
    expect(all.length).toBeGreaterThan(80)
  })

  // The ones on the retained chain, and the others that were recreated by session events.
  for (const name of ['setPanelOpen', 'togglePanel', 'focusTerminal', 'openLaneTerminal', 'dispatchToRole', 'sendProjectTask', 'startProjectTasks', 'handleSelectSession', 'handleResumeProject', 'resumePreviousRun', 'handleDumpBuffer']) {
    it(`${name} depends on no session state and reads it through refs`, () => {
      const cb = byName.get(name)
      expect(cb, `${name} is a useCallback`).toBeDefined()
      expect(cb!.deps.filter((d) => SESSION_STATE.includes(d))).toEqual([])
      expect(SESSION_STATE.filter((s) => readsDirectly(cb!.body, s))).toEqual([])
    })
  }

  it('lane focus and selection never change identity', () => {
    expect(byName.get('focusTerminal')!.deps).toEqual([])
    expect(byName.get('handleSelectSession')!.deps).toEqual([])
  })

  it('no callback lists session state in its dependencies, except the quit guard\'s', () => {
    // `identifyQuitLane` is passed straight to <QuitGuard>, outside any closure, so it links no
    // renders; QuitGuard's useMemo relies on its identity changing to refresh a lane's state word
    // while the dialog is open.
    const offenders = all
      .filter((c) => c.name !== 'identifyQuitLane')
      .filter((c) => c.deps.some((d) => SESSION_STATE.includes(d)))
      .map((c) => `${c.name} [${c.deps.join(', ')}]`)
    expect(offenders).toEqual([])
  })
})

// The same chain forms between any two sets of callbacks recreated at different moments, session
// state or not. `projects` changes with dispatch and task traffic, between lane switches.
const PROJECT_STATE = ['projects', 'roleOf', 'accentOf', 'customNames', 'panelOpen']

describe('callbacks do not change identity with project traffic', () => {
  const all = callbacks()
  const byName = new Map(all.map((c) => [c.name, c]))

  for (const name of ['openProjectOrFolder', 'setAccentForSession', 'requestCloseProject', 'toggleSidebar']) {
    it(`${name} depends on no project state and reads it through refs`, () => {
      const cb = byName.get(name)
      expect(cb, `${name} is a useCallback`).toBeDefined()
      expect(cb!.deps.filter((d) => PROJECT_STATE.includes(d))).toEqual([])
      expect(PROJECT_STATE.filter((s) => readsDirectly(cb!.body, s))).toEqual([])
    })
  }

  it('no callback lists project state in its dependencies, except the quit guard\'s', () => {
    const offenders = all
      .filter((c) => c.name !== 'identifyQuitLane')
      .filter((c) => c.deps.some((d) => PROJECT_STATE.includes(d)))
      .map((c) => `${c.name} [${c.deps.join(', ')}]`)
    expect(offenders).toEqual([])
  })

  it('builds roleOf and accentOf outside the component, so they hold only their inputs', () => {
    const component = src.indexOf('export function DashboardView(')
    expect(src.indexOf('function roleLookup(')).toBeGreaterThan(-1)
    expect(src.indexOf('function roleLookup(')).toBeLessThan(component)
    expect(src.indexOf('function accentLookup(')).toBeLessThan(component)
    expect(src).toMatch(/const roleOf = useMemo\(\(\) => roleLookup\(projects\), \[projects\]\)/)
    expect(src).toMatch(/const accentOf = useMemo\(\(\) => accentLookup\(roleOf, sessionAccents\), \[roleOf, sessionAccents\]\)/)
  })
})

describe('what a retained render holds', () => {
  it('builds the sidebar entries through the per-lane cache', () => {
    expect(src).toMatch(/sidebarSessions\(terminals, sessions, sidebarEntriesRef\.current\)/)
    expect(src).toMatch(/sidebarEntriesRef\.current = sidebarBuilt\.cache/)
    expect(src).not.toMatch(/startedAt: new Date\(\)\.toISOString\(\)/)
  })

  it('remembers the last persisted text as a fingerprint, not as the text', () => {
    expect(src).toMatch(/savedSerRef\.current = fp\b/)
    expect(src).toMatch(/const fp = fingerprint\(ser\)/)
    expect(src).toMatch(/const ser = fingerprint\(JSON\.stringify\(projects\.map/)
    expect(src).not.toMatch(/SerRef\.current = JSON\.stringify/)
  })
})
