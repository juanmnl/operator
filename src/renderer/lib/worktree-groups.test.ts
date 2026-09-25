import { describe, it, expect } from 'vitest'
import type { ReapEntry } from '../../shared/types'
import { canRescue, groupWorktrees, isSelectable, pruneSelection, toggleGroup, unsavedConsequence, unsavedLabel } from './worktree-groups'

const entry = (over: Partial<ReapEntry> = {}): ReapEntry => ({
  path: '/w/repo-1', cls: 'merged-clean', sizeBytes: 100, auto: true, reason: '',
  repo: '/dev/repo', live: false, uncommitted: 0, unsavedCommits: 0, unsavedKnown: true, needsUnsavedConfirm: false,
  removedWithoutGit: false, branch: 'operator/abc',
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
  it('says when every uncommitted file is a copy of one that exists elsewhere, and drops it from the loss sentence', () => {
    const copies = entry({ uncommitted: 4, uncommittedIsNonWork: true })
    expect(unsavedLabel(copies)).toBe('4 untracked, all copies of files that exist elsewhere')
    expect(unsavedConsequence([copies])).not.toMatch(/Uncommitted files will be lost/)
  })
})

describe('unsavedConsequence — the sentence above the second confirmation', () => {
  it('says commits stay on their branches only for named branches', () => {
    expect(unsavedConsequence([entry({ uncommitted: 2, unsavedCommits: 1 })]))
      .toBe('Uncommitted files will be lost. Commits on a named branch stay on that branch.')
  })

  it('says detached-HEAD commits will be lost, and does not claim they stay on a branch', () => {
    const text = unsavedConsequence([entry({ branch: 'HEAD', unsavedCommits: 3 })])
    expect(text).toMatch(/detached HEAD, on no branch\. Those commits will be lost\./)
    expect(text).not.toMatch(/stay on/)
    expect(unsavedLabel(entry({ branch: 'HEAD', unsavedCommits: 3 }))).toBe('3 commits on a detached HEAD, on no branch')
  })

  it('says a folder git cannot read is deleted outright', () => {
    const text = unsavedConsequence([entry({ unsavedKnown: false, uncommitted: undefined, unsavedCommits: undefined, removedWithoutGit: true })])
    expect(text).toMatch(/deleted outright/)
    expect(text).not.toMatch(/stay on/)
  })
})

describe('canRescue — where the Rescue action is offered', () => {
  it('offers it for readable folders with real unsaved work', () => {
    expect(canRescue(entry({ uncommitted: 2 }))).toBe(true)
    expect(canRescue(entry({ unsavedCommits: 1 }))).toBe(true)
  })
  it('not for a live lane, an unreadable folder, a plain-directory removal, or one already rescued', () => {
    expect(canRescue(entry({ uncommitted: 2, live: true }))).toBe(false)
    expect(canRescue(entry({ uncommitted: 2, unsavedKnown: false }))).toBe(false)
    expect(canRescue(entry({ uncommitted: 2, removedWithoutGit: true }))).toBe(false)
    expect(canRescue(entry({ uncommitted: 2, rescuedTo: '/Users/x/.operator/rescued/w-2026-09-25' }))).toBe(false)
  })
  it('not when there is nothing to rescue, or only copies of files that exist elsewhere', () => {
    expect(canRescue(entry())).toBe(false)
    expect(canRescue(entry({ uncommitted: 3, uncommittedIsNonWork: true }))).toBe(false)
  })
  it('the row says where it was rescued to', () => {
    expect(unsavedLabel(entry({ uncommitted: 2, rescuedTo: '/Users/x/.operator/rescued/w-2026-09-25' })))
      .toBe('2 uncommitted files · rescued to ~/.operator/rescued/w-2026-09-25')
  })
})
