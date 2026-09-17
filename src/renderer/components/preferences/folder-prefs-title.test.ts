import { describe, it, expect } from 'vitest'
import { folderPrefsTitle, folderPrefsSubtitle, FOLDER_PREFS_TABS } from './FolderPreferencesView'
import { originLabel } from '../../lib/nav-origin'

describe('the settings page header', () => {
  it('names a project as `Project settings · <name>`, with the name bound to its separator', () => {
    expect(folderPrefsTitle('operator', false)).toBe('Project settings · operator')
    // No ordinary space around the dot, so a wrap can only fall inside `Project settings`.
    expect(folderPrefsTitle('mantel landing', false)).not.toMatch(/ ·|· /)
  })

  it('falls back to the plain words for a nameless project, and says Global for ~/.claude', () => {
    expect(folderPrefsTitle('  ', false)).toBe('Project settings')
    expect(folderPrefsTitle('ignored', true)).toBe('Global settings')
  })

  it('shows the project path, or where global settings live and what they reach', () => {
    expect(folderPrefsSubtitle('/Users/dev/thing', false)).toBe('/Users/dev/thing')
    expect(folderPrefsSubtitle('', true)).toBe('~/.claude · applies to every\u00a0project')
  })

  it('has an Environment tab to deep-link to', () => {
    expect(FOLDER_PREFS_TABS).toContain('Environment')
  })

  // A back control labelled with a destination the destination does not call itself is a control
  // that describes a screen the user cannot find. `originLabel` restates this wording (lib/ may
  // not import a view), so the two are held together here.
  it('is what a back control pointing AT this page calls it', () => {
    for (const name of ['operator', 'mantel landing', '  ']) {
      expect(originLabel(
        { projectId: 'p1', mode: 'prefs', projectTab: 'board', folderPrefs: { projectPath: '/a', projectName: name } },
        [{ id: 'p1', name }],
      )).toBe(folderPrefsTitle(name, false))
    }
    expect(originLabel({ projectId: null, mode: 'globalPrefs', projectTab: 'board' }, []))
      .toBe(folderPrefsTitle('', true))
  })
})
