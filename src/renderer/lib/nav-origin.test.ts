import { describe, it, expect } from 'vitest'
import {
  describeOrigin, isPageMode, originKey, originLabel, pushOrigin, ORIGIN_STACK_MAX,
  PAGE_MODES, type LaneRef, type NavOrigin, type ViewState,
} from './nav-origin'

// THE RULES BEHIND THE BACK CONTROL on a PageShell page. Held here rather than in the view
// because every one of them is a decision — which views can be returned to, what each is called,
// and when there is deliberately no control at all — and a decision that only exists inside a
// 5,500-line component is one nobody can check.

const PROJECTS = [
  { id: 'p1', name: 'operator' },
  { id: 'p2', name: 'mantel landing' },
]

const view = (over: Partial<ViewState>): ViewState => ({
  contentMode: 'gallery',
  projectId: null,
  projectTab: 'board',
  galleryTab: 'projects',
  folderPrefs: null,
  ...over,
})

const OVERVIEW: NavOrigin = { projectId: null, mode: 'gallery', projectTab: 'board', galleryTab: 'overview' }

describe('isPageMode', () => {
  it('names exactly the five modes that wear PageShell', () => {
    expect([...PAGE_MODES]).toEqual(['folderPrefs', 'globalPrefs', 'prefs', 'agents', 'tuning'])
    for (const m of PAGE_MODES) expect(isPageMode(m)).toBe(true)
    for (const m of ['gallery', 'project', 'localTerminal']) expect(isPageMode(m)).toBe(false)
  })
})

describe('describeOrigin', () => {
  it("records the gallery's TAB, not just the gallery", () => {
    expect(describeOrigin(view({ contentMode: 'gallery', galleryTab: 'overview' })))
      .toEqual({ projectId: null, mode: 'gallery', projectTab: 'board', galleryTab: 'overview' })
    expect(describeOrigin(view({ contentMode: 'gallery', galleryTab: 'projects' })))
      .toMatchObject({ galleryTab: 'projects' })
    expect(describeOrigin(view({ contentMode: 'gallery', galleryTab: 'activity' })))
      .toMatchObject({ galleryTab: 'activity' })
  })

  it('drops project scope at the gallery — the gallery is outside every project', () => {
    // `activeProjectId` survives a visit to Preferences by design, so it can still be set while
    // the gallery is on screen. Returning THERE must not re-enter the project.
    expect(describeOrigin(view({ contentMode: 'gallery', projectId: 'p1' }))?.projectId).toBeNull()
  })

  it('records a project home with the tab you were reading', () => {
    expect(describeOrigin(view({ contentMode: 'project', projectId: 'p1', projectTab: 'team' })))
      .toEqual({ projectId: 'p1', mode: 'project', projectTab: 'team' })
  })

  it('tells the two settings pages apart by the folder record, not the mode', () => {
    const folder = describeOrigin(view({
      contentMode: 'folderPrefs', projectId: 'p1',
      folderPrefs: { projectPath: '/a', projectName: 'operator', tab: 'Worktrees' },
    }))
    expect(folder).toMatchObject({ mode: 'prefs', folderPrefs: { projectPath: '/a', tab: 'Worktrees' } })
    expect(describeOrigin(view({ contentMode: 'prefs' }))).toMatchObject({ mode: 'prefs' })
    expect(describeOrigin(view({ contentMode: 'prefs' }))?.folderPrefs).toBeUndefined()
  })

  it('keeps which tab Global settings was on', () => {
    expect(describeOrigin(view({ contentMode: 'globalPrefs', globalPrefsTab: 'Skills' })))
      .toMatchObject({ mode: 'globalPrefs', globalPrefsTab: 'Skills' })
  })

  it('covers the Agents hub and Tuning', () => {
    expect(describeOrigin(view({ contentMode: 'agents' }))).toMatchObject({ mode: 'agents' })
    expect(describeOrigin(view({ contentMode: 'tuning' }))).toMatchObject({ mode: 'tuning' })
  })

  it('records a focused lane — the commonest origin there is', () => {
    // You are in a lane and you hit Preferences from the rail's foot. The scope around the lane
    // is still its project, and `contentMode` ranks a live lane above the project home.
    expect(describeOrigin(view({ contentMode: 'localTerminal', projectId: 'p1', terminalId: 't3' })))
      .toEqual({ projectId: 'p1', mode: 'project', projectTab: 'board', lane: { terminalId: 't3' } })
  })

  it('records a lane that belongs to no project', () => {
    // A terminal opened on a bare folder. Restoring it sets no scope, which is correct.
    expect(describeOrigin(view({ contentMode: 'localTerminal', projectId: null, terminalId: 't0' })))
      .toMatchObject({ projectId: null, lane: { terminalId: 't0' } })
  })

  it('refuses to name a view it could not restore', () => {
    // A project mode with no project, a folder page with no folder record, a lane with no pty:
    // all unreachable in practice, all null rather than half a destination.
    expect(describeOrigin(view({ contentMode: 'project', projectId: null }))).toBeNull()
    expect(describeOrigin(view({ contentMode: 'folderPrefs', folderPrefs: null }))).toBeNull()
    expect(describeOrigin(view({ contentMode: 'localTerminal', projectId: 'p1', terminalId: null }))).toBeNull()
    expect(describeOrigin(view({ contentMode: 'something-new' }))).toBeNull()
  })
})

describe('originLabel', () => {
  it('names the gallery by the tab you left', () => {
    expect(originLabel(OVERVIEW, PROJECTS)).toBe('Worktree overview')
    expect(originLabel({ ...OVERVIEW, galleryTab: 'projects' }, PROJECTS)).toBe('All projects')
    expect(originLabel({ ...OVERVIEW, galleryTab: 'activity' }, PROJECTS)).toBe('Activity')
  })

  it('names a project by its name', () => {
    expect(originLabel({ projectId: 'p1', mode: 'project', projectTab: 'board' }, PROJECTS)).toBe('operator')
  })

  it('names each settings page as the page names itself', () => {
    expect(originLabel({ projectId: null, mode: 'prefs', projectTab: 'board' }, PROJECTS)).toBe('Preferences')
    expect(originLabel({ projectId: null, mode: 'globalPrefs', projectTab: 'board' }, PROJECTS)).toBe('Global settings')
    expect(originLabel({ projectId: null, mode: 'agents', projectTab: 'board' }, PROJECTS)).toBe('Agents')
    expect(originLabel({ projectId: null, mode: 'tuning', projectTab: 'board' }, PROJECTS)).toBe('Tuning')
  })

  it('binds the project name to its separator, so neither is ever left alone on a line', () => {
    const label = originLabel({
      projectId: 'p1', mode: 'prefs', projectTab: 'board',
      folderPrefs: { projectPath: '/a', projectName: 'mantel landing' },
    }, PROJECTS)
    expect(label).toBe('Project settings · mantel landing')
    expect(label).not.toMatch(/ ·| · /)
  })

  it("names a lane with the lane's own display name, never its id", () => {
    const lane: NavOrigin = { projectId: 'p1', mode: 'project', projectTab: 'board', lane: { terminalId: 't3' } }
    const live: LaneRef[] = [{ terminalId: 't3', name: 'Code' }]
    expect(originLabel(lane, PROJECTS, live)).toBe('Code')
  })

  it('renders NO control when the lane is gone — never its project instead', () => {
    // A lane can end, be closed, or have its worktree reaped while the user sits in settings.
    // Falling back to "operator" would label the control with one destination and land on another.
    const lane: NavOrigin = { projectId: 'p1', mode: 'project', projectTab: 'board', lane: { terminalId: 't3' } }
    expect(originLabel(lane, PROJECTS, [])).toBeNull()
    expect(originLabel(lane, PROJECTS, [{ terminalId: 't9', name: 'Review' }])).toBeNull()
    // A live lane with no usable name is the same answer.
    expect(originLabel(lane, PROJECTS, [{ terminalId: 't3', name: '  ' }])).toBeNull()
  })

  it('still names a project home by its project — the lane field is what changes the rule', () => {
    const home: NavOrigin = { projectId: 'p1', mode: 'project', projectTab: 'board' }
    expect(originLabel(home, PROJECTS, [{ terminalId: 't3', name: 'Code' }])).toBe('operator')
  })

  it('returns null rather than a label it cannot keep', () => {
    // The project was forgotten while the settings page was open. No label, so no control.
    expect(originLabel({ projectId: 'gone', mode: 'project', projectTab: 'board' }, PROJECTS)).toBeNull()
    expect(originLabel({ projectId: 'p1', mode: 'project', projectTab: 'board' }, [])).toBeNull()
  })
})

describe('pushOrigin', () => {
  const prefs: NavOrigin = { projectId: null, mode: 'prefs', projectTab: 'board' }
  const globals: NavOrigin = { projectId: null, mode: 'globalPrefs', projectTab: 'board' }

  it('records the origin when a page is entered', () => {
    expect(pushOrigin([], OVERVIEW, 'folderPrefs:/a')).toEqual([OVERVIEW])
  })

  it('grows a chain across settings pages', () => {
    const one = pushOrigin([], OVERVIEW, 'prefs')
    const two = pushOrigin(one, prefs, 'globalPrefs')
    expect(two).toEqual([OVERVIEW, prefs])
  })

  it('unwinds instead of looping when you navigate back to a page already in the chain', () => {
    // gallery → prefs → globals → prefs. Without this, prefs and globals would each claim to be
    // the other's origin and the back control would bounce between them for ever.
    const chain = pushOrigin(pushOrigin([], OVERVIEW, 'prefs'), prefs, 'globalPrefs')
    expect(pushOrigin(chain, globals, 'prefs')).toEqual([OVERVIEW])
  })

  it('does not record anything when you re-enter the page you are already on', () => {
    const chain = pushOrigin([], OVERVIEW, 'prefs')
    expect(pushOrigin(chain, prefs, 'prefs')).toEqual(chain)
  })

  it('drops the chain when there is no origin — the new page gets NO control', () => {
    expect(pushOrigin([OVERVIEW], null, 'prefs')).toEqual([])
  })

  it('treats two lanes of one project as two places', () => {
    const a: NavOrigin = { projectId: 'p1', mode: 'project', projectTab: 'board', lane: { terminalId: 't1' } }
    const b: NavOrigin = { projectId: 'p1', mode: 'project', projectTab: 'board', lane: { terminalId: 't2' } }
    expect(originKey(a)).toBe('lane:t1')
    expect(originKey(b)).toBe('lane:t2')
    expect(originKey(a)).not.toBe(originKey(b))
    // …and neither is the project's home.
    expect(originKey({ projectId: 'p1', mode: 'project', projectTab: 'board' })).toBe('project:p1')
    // A chain from lane A to a settings page and on to lane B is three places, not a loop.
    expect(pushOrigin([a], { projectId: null, mode: 'prefs', projectTab: 'board' }, 'lane:t2')).toEqual([a, { projectId: null, mode: 'prefs', projectTab: 'board' }])
  })

  it('treats two projects settings pages as two places', () => {
    const a: NavOrigin = { projectId: 'p1', mode: 'prefs', projectTab: 'board', folderPrefs: { projectPath: '/a', projectName: 'a' } }
    expect(originKey(a)).toBe('folderPrefs:/a')
    expect(pushOrigin([OVERVIEW], a, 'folderPrefs:/b')).toEqual([OVERVIEW, a])
  })

  it('keeps the chain short', () => {
    let stack: NavOrigin[] = []
    for (let i = 0; i < ORIGIN_STACK_MAX + 5; i++) {
      stack = pushOrigin(stack, { projectId: `p${i}`, mode: 'project', projectTab: 'board' }, `folderPrefs:/${i}`)
    }
    expect(stack).toHaveLength(ORIGIN_STACK_MAX)
    expect(stack[stack.length - 1].projectId).toBe(`p${ORIGIN_STACK_MAX + 4}`)
  })
})

describe('originKey', () => {
  it('is the same string for the same place', () => {
    expect(originKey(OVERVIEW)).toBe('gallery:overview')
    expect(originKey({ ...OVERVIEW, galleryTab: undefined })).toBe('gallery:projects')
    expect(originKey({ projectId: 'p1', mode: 'project', projectTab: 'team' }))
      .toBe(originKey({ projectId: 'p1', mode: 'project', projectTab: 'board' }))
    expect(originKey({ projectId: null, mode: 'agents', projectTab: 'board' })).toBe('agents')
  })
})

// ── THE WIRING, held at the source ─────────────────────────────────────────────────────────────
// The rules above are pure and provable; the wiring that delivers them is not, and this repo has
// no renderer harness. Same shape as `muted-opacity.guard.test.ts`: the parts a review would have
// to catch by eye are read out of the source on every `npm test`.

const SOURCES = import.meta.glob('../**/*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

/** Strip comments, so the guard reads DECLARATIONS and not the prose about them — DashboardView's
 *  own notes mention the chevron by name. (`muted-opacity.guard.test.ts` learned this first.) */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)))
}

function sourceOf(suffix: string): string {
  const key = Object.keys(SOURCES).find((k) => k.endsWith(suffix))
  if (!key) throw new Error(`no source globbed for ${suffix} — has it moved?`)
  return SOURCES[key]
}

describe('the back control reaches every page', () => {
  it('lives in PageShell, so all five pages inherit one', () => {
    const shell = sourceOf('components/settings/PageShell.tsx')
    expect(shell).toContain('data-page-back')
    expect(shell).toContain('PageBackProvider')
    // Rendered from the shell's own header block, above the title — not by any one page.
    expect(shell).toMatch(/backControl && <BackToOrigin/)
  })

  it('is provided once, around the whole tree', () => {
    const dash = sourceOf('views/DashboardView.tsx')
    expect(dash.match(/<PageBackProvider/g)).toHaveLength(1)
  })

  it('is what every PageShell page gets — none of them rolls its own', () => {
    const pages = ['prefs/PrefsView.tsx', 'preferences/FolderPreferencesView.tsx',
      'agents/AgentsHubView.tsx', 'tuning/TuningView.tsx']
    for (const p of pages) {
      expect(sourceOf(p), `${p} renders PageShell`).toContain('<PageShell')
      expect(sourceOf(p), `${p} must not carry its own back control`).not.toContain('data-page-back')
    }
  })

  // The existence guard is the whole job for a lane origin, and it cannot be unit-tested from
  // here: it is a filter against the live terminal list inside the view. Held at the source so a
  // refactor that names a lane from anything else has to argue with this test.
  it('names a lane only from the live terminal list, by the one label ladder', () => {
    const dash = stripComments(sourceOf('views/DashboardView.tsx'))
    const memo = dash.slice(dash.indexOf('const backLanes'), dash.indexOf('const pageBack'))
    expect(memo, 'backLanes must exist').not.toBe('')
    // `contentMode` calls a lane on screen by this same test, so the two agree about what exists.
    expect(memo).toContain('terminals.find')
    // …and the words come from lib/session-label, not a second naming rule.
    expect(memo).toContain('sessionLabel(')
    expect(dash).toContain("from '../lib/session-label'")
  })

  // TWO VERBS NEVER SHARE A GLYPH. `‹` means "go back" in this app and nothing else, so the list
  // of files allowed to type it is short and explicit — a new one is a decision, not a detail.
  it('keeps the chevron to one verb', () => {
    const carriers = Object.entries(SOURCES)
      .filter(([, src]) => stripComments(src).includes('‹'))
      .map(([f]) => f.replace('../', ''))
      .sort()
    expect(carriers).toEqual([
      'components/dashboard/ProjectGallery.tsx',
      'components/session/ProjectView.tsx',
      'components/session/SessionToolbar.tsx',
      'components/settings/PageShell.tsx',
    ])
  })
})
