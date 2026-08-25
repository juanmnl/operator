import { describe, it, expect } from 'vitest'
import {
  parseFileHref, buildFileHref, resolveFileTarget, panelForm, pushRecent, navigateTo,
  ancestorsOf, EMPTY_NAV, MAIN_PREFERRED_W, MAIN_MIN_W, PANEL_MIN_W,
} from './code-nav'
import { shortenPath } from '../components/files/FilesPanel'

describe('parseFileHref', () => {
  it('reads a bare path', () => {
    expect(parseFileHref('operator://file/src/a.ts'))
      .toEqual({ path: 'src/a.ts', line: undefined, endLine: undefined, root: 'lane' })
  })

  it('reads a line and a range', () => {
    expect(parseFileHref('operator://file/src/a.ts:60')).toMatchObject({ path: 'src/a.ts', line: 60 })
    expect(parseFileHref('operator://file/src/a.ts:60:74'))
      .toMatchObject({ path: 'src/a.ts', line: 60, endLine: 74 })
  })

  it('reads the root override, defaulting to the lane worktree', () => {
    expect(parseFileHref('operator://file/a.ts?root=project')?.root).toBe('project')
    expect(parseFileHref('operator://file/a.ts?root=lane')?.root).toBe('lane')
    expect(parseFileHref('operator://file/a.ts')?.root).toBe('lane')
  })

  // The regression the design names as the one to watch: both link kinds go through the same
  // canvas hit-test, so an over-eager parse would swallow ordinary web links.
  it('returns null for anything that is not one of our links', () => {
    expect(parseFileHref('https://example.com/a.ts:60')).toBeNull()
    expect(parseFileHref('operator://task/abc')).toBeNull()
    expect(parseFileHref('')).toBeNull()
    expect(parseFileHref('operator://file/')).toBeNull()
  })

  // A colon in a path is not a line suffix. Anchoring on trailing digits is what keeps them apart.
  it('does not mistake a colon INSIDE a filename for a line number', () => {
    expect(parseFileHref('operator://file/' + encodeURIComponent('weird:name.ts')))
      .toMatchObject({ path: 'weird:name.ts', line: undefined })
  })

  it('handles a percent-encoded path with a space or a hash', () => {
    expect(parseFileHref(`operator://file/${encodeURIComponent('src/a b#c.ts')}:12`))
      .toMatchObject({ path: 'src/a b#c.ts', line: 12 })
  })

  it('normalises a backwards range rather than refusing it', () => {
    expect(parseFileHref('operator://file/a.ts:74:60')).toMatchObject({ line: 60, endLine: 74 })
  })

  it('round-trips through buildFileHref', () => {
    for (const t of [
      { path: 'src/a.ts', root: 'lane' as const },
      { path: 'src/a.ts', line: 60, root: 'lane' as const },
      { path: 'src/a.ts', line: 60, endLine: 74, root: 'project' as const },
      { path: 'a b#c.ts', line: 3, root: 'lane' as const },
    ]) {
      expect(parseFileHref(buildFileHref(t))).toMatchObject(t)
    }
  })
})

// THE RULE THE WHOLE THING LIVES OR DIES ON, per the design. Tested before anything calls it.
describe('resolveFileTarget', () => {
  const closed = { filesInMain: false, filesInPanel: false }
  const roomy = { mainContent: 1200, panel: 460 }

  it('B — a link clicked in the PANEL opens in the main view', () => {
    expect(resolveFileTarget('panel', closed, roomy)).toBe('main')
  })

  it('C — a link clicked in the MAIN view opens in the panel', () => {
    expect(resolveFileTarget('main', closed, roomy)).toBe('panel')
  })

  // The principle, stated as its own test so it cannot be refactored away by accident.
  it('never replaces the surface the link was clicked in', () => {
    expect(resolveFileTarget('main', closed, roomy)).not.toBe('main')
    expect(resolveFileTarget('panel', closed, roomy)).not.toBe('panel')
  })

  it('A — an already-open Files wins, which is what makes the link idempotent', () => {
    expect(resolveFileTarget('main', { filesInMain: true, filesInPanel: false }, roomy)).toBe('main')
    expect(resolveFileTarget('panel', { filesInMain: false, filesInPanel: true }, roomy)).toBe('panel')
    expect(resolveFileTarget('elsewhere', { filesInMain: true, filesInPanel: false }, roomy)).toBe('main')
  })

  it('A — two links in a row cannot ping-pong the reader between surfaces', () => {
    const first = resolveFileTarget('main', closed, roomy)              // → panel
    const state = { filesInMain: false, filesInPanel: first === 'panel' }
    expect(resolveFileTarget('main', state, roomy)).toBe(first)
  })

  it('main wins over panel when both are open, since it is the better reader', () => {
    expect(resolveFileTarget('elsewhere', { filesInMain: true, filesInPanel: true }, roomy)).toBe('main')
  })

  it('D — from elsewhere, the main view wins only when it is wide enough', () => {
    expect(resolveFileTarget('elsewhere', closed, { mainContent: MAIN_PREFERRED_W, panel: 460 })).toBe('main')
    expect(resolveFileTarget('elsewhere', closed, { mainContent: MAIN_PREFERRED_W - 1, panel: 460 })).toBe('panel')
  })

  it('E — a too-narrow panel sends the link to the main view instead', () => {
    expect(resolveFileTarget('main', closed, { mainContent: 1200, panel: PANEL_MIN_W - 1 })).toBe('main')
  })

  it('E — a too-narrow main view sends the link to the panel instead', () => {
    expect(resolveFileTarget('panel', closed, { mainContent: MAIN_MIN_W - 1, panel: 460 })).toBe('panel')
  })

  // Both surfaces too small is a real window shape, and a veto that could fire twice would be an
  // infinite argument between them. It applies once; the first choice is the better guess.
  it('E — the veto applies at most once when BOTH surfaces are too narrow', () => {
    expect(resolveFileTarget('main', closed, { mainContent: 300, panel: 200 })).toBe('main')
    expect(resolveFileTarget('panel', closed, { mainContent: 300, panel: 200 })).toBe('panel')
  })

  it('the veto still applies when rule A chose the surface', () => {
    expect(resolveFileTarget('elsewhere', { filesInMain: false, filesInPanel: true }, { mainContent: 1200, panel: 100 }))
      .toBe('main')
  })
})

describe('panelForm — the three measured forms', () => {
  it('splits at 560 and 340', () => {
    expect(panelForm(560)).toBe('wide')
    expect(panelForm(559)).toBe('medium')
    expect(panelForm(340)).toBe('medium')
    expect(panelForm(339)).toBe('narrow')
  })
  it('460 — the shipped default — is the MEDIUM form, which is the one that matters most', () => {
    expect(panelForm(460)).toBe('medium')
  })
})

describe('pushRecent', () => {
  it('moves an existing entry to the front rather than duplicating it', () => {
    expect(pushRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
  })
  it('caps at ten', () => {
    const many = Array.from({ length: 12 }, (_, i) => `f${i}`)
    expect(pushRecent(many, 'new')).toHaveLength(10)
    expect(pushRecent(many, 'new')[0]).toBe('new')
  })
  it('ignores an empty path', () => {
    expect(pushRecent(['a'], '')).toEqual(['a'])
  })
})

describe('ancestorsOf', () => {
  it('lists every directory above a file, outermost first', () => {
    expect(ancestorsOf('src/renderer/lib/a.ts')).toEqual(['src', 'src/renderer', 'src/renderer/lib'])
  })
  it('is empty for a file at the root', () => {
    expect(ancestorsOf('README.md')).toEqual([])
  })
})

describe('navigateTo', () => {
  it('records the file, the line, and expands the path to it', () => {
    const nav = navigateTo(EMPTY_NAV, { path: 'src/lib/a.ts', line: 60, root: 'lane' })
    expect(nav).toMatchObject({ path: 'src/lib/a.ts', line: 60, root: 'lane' })
    expect(nav.expanded).toEqual(['src', 'src/lib'])
    expect(nav.recent).toEqual(['src/lib/a.ts'])
  })

  it('keeps a range only when there IS one', () => {
    expect(navigateTo(EMPTY_NAV, { path: 'a.ts', line: 60, endLine: 74, root: 'lane' }).range).toEqual([60, 74])
    expect(navigateTo(EMPTY_NAV, { path: 'a.ts', line: 60, root: 'lane' }).range).toBeUndefined()
  })

  it('does not lose directories the reader had already expanded', () => {
    const nav = navigateTo({ ...EMPTY_NAV, expanded: ['docs'] }, { path: 'src/a.ts', root: 'lane' })
    expect(nav.expanded).toEqual(['docs', 'src'])
  })

  it('follows the link\'s root override', () => {
    expect(navigateTo(EMPTY_NAV, { path: 'a.ts', root: 'project' }).root).toBe('project')
  })
})

describe('shortenPath — the breadcrumb in the medium and narrow forms', () => {
  it('leaves a path that already fits', () => {
    expect(shortenPath('src/a.ts', 40)).toBe('src/a.ts')
  })

  // The TAIL identifies the file, so the head is what gets dropped. Truncating the other way
  // would leave every row reading `src/renderer/comp…`, which distinguishes nothing.
  it('drops leading segments, never the filename', () => {
    const out = shortenPath('src/renderer/components/session/SessionToolbar.tsx', 30)
    expect(out.endsWith('SessionToolbar.tsx')).toBe(true)
    expect(out.startsWith('…/')).toBe(true)
  })

  it('keeps as many leading segments as FIT, and the result never exceeds the budget', () => {
    // `…/c/d.ts` is exactly 8 — one more segment would not have been.
    expect(shortenPath('a/b/c/d.ts', 8)).toBe('…/c/d.ts')
    expect(shortenPath('a/b/c/d.ts', 8).length).toBeLessThanOrEqual(8)
    expect(shortenPath('a/b/c/d.ts', 100)).toBe('a/b/c/d.ts')
  })

  it('does not mangle a bare filename that is itself too long', () => {
    expect(shortenPath('a-very-long-filename-indeed.ts', 10)).toBe('a-very-long-filename-indeed.ts')
  })
})
