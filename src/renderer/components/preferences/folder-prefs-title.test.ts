import { describe, it, expect } from 'vitest'
import { folderPrefsTitle, folderPrefsSubtitle, FOLDER_PREFS_TABS } from './FolderPreferencesView'

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
})
