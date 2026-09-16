import { describe, it, expect } from 'vitest'
import type { ReapEntry } from '../../shared/types'
import { groupWorktrees, isSelectable, pruneSelection, toggleGroup, unsavedLabel } from './worktree-groups'

const entry = (over: Partial<ReapEntry> = {}): ReapEntry => ({
  path: '/w/repo-1', cls: 'merged-clean', sizeBytes: 100, auto: true, reason: '', needsCommit: false,
  repo: '/dev/repo', live: false, uncommitted: 0, unsavedCommits: 0, unsavedKnown: true, needsUnsavedConfirm: false,
  ...over,
})

describe('groupWorktrees', () => {
  it('groups by source repo with count and size, largest group first, unknown repo last', () => {
    const groups = groupWorktrees([
      entry({ path: '/w/a-1', repo: '/dev/a', sizeBytes: 10 }),
      entry({ path: '/w/b-1', repo: '/dev/b', sizeBytes: 50 }),
      entry({ path: '/w/a-2', repo: '/dev/a', sizeBytes: 30 }),
      entry({ path: '/w/x', repo: undefined, sizeBytes: 999 }),
    ])
    expect(groups.map((g) => [g.label, g.rows.length, g.bytes])).toEqual([
      ['b', 1, 50], ['a', 2, 40], ['Unknown source repository', 1, 999],
    ])
    expect(groups[1].rows.map((r) => r.path)).toEqual(['/w/a-2', '/w/a-1'])
  })

  it('is empty for no entries', () => {
    expect(groupWorktrees([])).toEqual([])
  })
})

describe('selection', () => {
  const group = groupWorktrees([
    entry({ path: '/w/1' }), entry({ path: '/w/2' }), entry({ path: '/w/live', live: true }),
  ])[0]

  it('never selects a live-claimed row', () => {
    expect(isSelectable(entry({ live: true }))).toBe(false)
    expect([...toggleGroup(new Set(), group)].sort()).toEqual(['/w/1', '/w/2'])
  })

  it('select-all clears when every selectable row is already selected, and leaves other groups alone', () => {
    const selected = new Set(['/w/1', '/w/2', '/other'])
    expect([...toggleGroup(selected, group)]).toEqual(['/other'])
    expect([...toggleGroup(new Set(['/w/1']), group)].sort()).toEqual(['/w/1', '/w/2'])
  })

  it('prunes selections that vanished or became live', () => {
    const entries = [entry({ path: '/w/1', live: true }), entry({ path: '/w/2' })]
    expect([...pruneSelection(new Set(['/w/1', '/w/2', '/gone']), entries)]).toEqual(['/w/2'])
  })
})

describe('unsavedLabel', () => {
  it('names uncommitted files and unsaved commits', () => {
    expect(unsavedLabel(entry({ uncommitted: 3, unsavedCommits: 1 }))).toBe('3 uncommitted files · 1 commit on no other branch or remote')
  })
  it('says so when there is nothing unsaved, and when git could not tell', () => {
    expect(unsavedLabel(entry())).toBe('No unsaved work')
    expect(unsavedLabel(entry({ unsavedKnown: false, uncommitted: undefined, unsavedCommits: undefined }))).toMatch(/unknown/)
  })
})
