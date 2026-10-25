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

/** The text of `const <name> = …` (or `const <name>: T = …`) up to the next top-level `const` of the component. */
function bodyOf(name: string): string {
  const at = src.search(new RegExp(`const ${name}(: [^=]+)? = `))
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
    expect(end).toContain('stuckAfterClose(withIds, aliveAfter)')
  })

  it('judges a woken suspended lane by every id it had, its close\'s new one included (review R3)', () => {
    const end = bodyOf('endProjectLanes')
    expect(end).toContain('laneClosesRef.current.closedAs(tid)')
    expect(end).toMatch(/terminalsRef\.current\.find\(\(t\) => t\.key === key\)/)
  })

  it('leaves the dedupe to handleCloseSession, for every caller (review R2)', () => {
    const end = bodyOf('endProjectLanes')
    expect(end).toContain('lanes.map((s) => handleCloseSessionRef.current(s))')
    const close = bodyOf('handleCloseSession')
    expect(close).toContain('closes.run(tid, start)')
    expect(close).toMatch(/if \(back\) alias\(back\.id\)/)
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
    expect(req).toContain('closeGuardCopy(project.name, plan.sessions.length, plan.running, lanes)')
    // The body is true per lane kind (review R6): each lane says which folder fate is its own.
    expect(req).toMatch(/isReleased\(tab, pendingReleasesRef\.current\) \? 'released'/)
  })

  it('every entry point asks; only the guard and the idle path close directly', () => {
    // requestCloseProject's idle path, the guard's End, and nothing else.
    expect(src.match(/void closeProject\(/g)).toHaveLength(2)
    expect(src).toContain('onCloseProject={requestCloseProject}')
  })

  it('the rail menu item does not arm: the dialog is the confirm', () => {
    const items = bodyOf('railMenuItems')
    expect(items).toContain('requestCloseProject(project.id)')
    expect(items).not.toMatch(/confirm: live/)
  })
})

describe('more ways in to Close project (task 4)', () => {
  it('the project home header asks for the close', () => {
    expect(src).toContain('onCloseProject={() => requestCloseProject(proj.id)}')
  })

  it('the palette lists Close for every project on the rail, through the same request', () => {
    const palette = bodyOf('paletteActions')
    expect(palette).toMatch(/if \(isOnRail\(p, projectActivities\[p\.id\], activeProjectId\)\)/)
    expect(palette).toMatch(/id: `close-project-\$\{p\.id\}`[\s\S]*?run: \(\) => requestCloseProject\(p\.id\)/)
  })
})

describe('the rail row close control (task 6)', () => {
  const ITEM = Object.values(import.meta.glob('../components/sidebar/SessionItem.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)[0]

  it('draws ■ and arms as stop?, like the Team card: one verb, one glyph, one look', () => {
    expect(ITEM).toContain("{confirmingClose ? 'stop?' : '■'}")
    expect(ITEM).not.toMatch(/'×\??'/)
    expect(ITEM).toMatch(/background: confirmingClose \? 'var\(--overlay-medium\)'/)
    expect(ITEM).not.toMatch(/confirmingClose \? 'var\(--color-error\)'/)
    expect(ITEM).toContain("'Close session (⌘W)'")
  })

  it('is revealed by keyboard focus as well as hover', () => {
    expect(ITEM).toContain('const revealClose = closable && (hovered || focusWithin)')
    // Keyboard focus only (review R7): a mouse click focuses the row too.
    expect(ITEM).toMatch(/onFocus=\{\(e\) => setFocusWithin\(isKeyboardFocus\(e\.target\)\)\}/)
    expect(ITEM).toContain('(revealClose || confirmingClose)')
  })
})

describe('⌘W arms on a mid-turn lane (task 7)', () => {
  it('asks closeKeyAction before closing, and arms with a toast for CONFIRM_MS', () => {
    const at = src.indexOf("e.key === 'w' || e.key === 'W'")
    expect(at).toBeGreaterThan(-1)
    const branch = src.slice(at, src.indexOf('} else if', at))
    expect(branch).toMatch(/const action = closeKeyAction\([^;]*e\.repeat\)/)
    // An auto-repeat does nothing (review R1), before anything arms or closes.
    expect(branch).toMatch(/if \(action === 'ignore'\) return[\s\S]*if \(action === 'arm'\)/)
    expect(branch).toContain('Press ⌘W again to close ${name} — it is mid-turn')
    expect(branch).toContain('until: Date.now() + CONFIRM_MS')
    expect(branch.indexOf('return')).toBeLessThan(branch.indexOf('handleCloseSession(active)'))
  })
})

describe('Forget is blocked while lanes are open (task 8)', () => {
  const GALLERY = Object.values(import.meta.glob('../components/dashboard/ProjectGallery.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)[0]

  it('both Forget items come from forgetProjectItem with the lane count', () => {
    expect(GALLERY.match(/\{ \.\.\.forgetProjectItem\(liveCount\), id: 'forget-project', onClick: onForget, confirm: true/g)).toHaveLength(2)
    expect(GALLERY).not.toMatch(/label: 'Forget project'/)
    expect(GALLERY).toContain('liveCount={lanesToEnd(activities[project.id])}')
  })

  it('forgetProject refuses a project with open lanes', () => {
    expect(bodyOf('forgetProject')).toMatch(/if \(lanesToEnd\(activitiesRef\.current\[id\]\) > 0\) return/)
  })
})

describe('the guard dialog keeps the app\'s keys and gives focus back (review R4/R5)', () => {
  const DIALOG = Object.values(import.meta.glob('../components/GuardDialog.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)[0]

  it('blocks app chords in its capture listener, with preventDefault', () => {
    expect(DIALOG).toContain('const action = guardKeyAction(e)')
    expect(DIALOG).toMatch(/if \(action === 'block'\) \{\s*e\.preventDefault\(\)\s*e\.stopPropagation\(\)/)
    expect(DIALOG).toContain("window.addEventListener('keydown', onKey, true)")
  })

  it('restores focus on unmount', () => {
    expect(DIALOG).toMatch(/const restore = keepFocus\(\)[\s\S]*?return restore/)
  })
})
