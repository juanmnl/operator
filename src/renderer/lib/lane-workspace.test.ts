import { describe, it, expect } from 'vitest'
import type { Role } from '../../shared/types'
import { launchWorkspace } from './lane-workspace'
import { resolveAgentConfig } from './model-config'
import { orchestrationNote, rolePresets, SHARED_CHECKOUT_NOTE, WORKTREE_DONE_NOTE } from './roster'

const role = (over: Partial<Role> & { id: string }): Role => ({ name: over.id, ...over })

describe('own-worktree default by role (no field stored)', () => {
  const on = (id: string) => resolveAgentConfig(role({ id })).useWorktree

  it('is on for code and design, off for research, review, qa, custom lanes and the coordinator', () => {
    expect([on('code'), on('design')]).toEqual([true, true])
    expect([on('research'), on('review'), on('qa'), on('my-custom-lane'), on('operator')]).toEqual([false, false, false, false, false])
  })

  it('a stored pin wins over the default, either way', () => {
    expect(resolveAgentConfig(role({ id: 'research', useWorktree: true })).useWorktree).toBe(true)
    expect(resolveAgentConfig(role({ id: 'code', useWorktree: false })).useWorktree).toBe(false)
    expect(resolveAgentConfig(role({ id: 'my-custom-lane', useWorktree: true })).useWorktree).toBe(true)
  })

  it('resolving a roster without the field never adds it to the stored role', () => {
    const stored = role({ id: 'research' })
    resolveAgentConfig(stored)
    expect('useWorktree' in stored).toBe(false)
  })
})

describe('launchWorkspace — where the launch goes', () => {
  it('a fresh launch follows the setting', () => {
    expect(launchWorkspace('code', true)).toEqual({ useWorktree: true, sharesMainCheckout: false, ownWorktree: true })
    expect(launchWorkspace('research', false)).toEqual({ useWorktree: false, sharesMainCheckout: true, ownWorktree: false })
  })

  it('the coordinator is in the main checkout but does not get the no-commit line', () => {
    expect(launchWorkspace('operator', false)).toEqual({ useWorktree: false, sharesMainCheckout: false, ownWorktree: false })
  })

  it('a suspended lane resumes where it was, whatever the setting says now', () => {
    expect(launchWorkspace('research', false, { worktreeBranch: 'operator/abc' })).toEqual({ useWorktree: true, sharesMainCheckout: false, ownWorktree: true })
    expect(launchWorkspace('code', true, { worktreeBranch: undefined })).toEqual({ useWorktree: false, sharesMainCheckout: true, ownWorktree: false })
  })
})

describe('the shared-checkout line in the launch brief', () => {
  const roster = rolePresets()
  const research = roster.find((r) => r.id === 'research')!

  it('is added only when the lane shares the main checkout', () => {
    expect(orchestrationNote('proj', research, roster, { sharesMainCheckout: true })).toContain(SHARED_CHECKOUT_NOTE)
    expect(orchestrationNote('proj', research, roster)).not.toContain(SHARED_CHECKOUT_NOTE)
  })

  it('names every rule: no commit, branch switch, stash or tracked edits; results under dev/results/', () => {
    for (const s of ['do not commit', 'switch', 'stash', 'edit tracked files', 'dev/results/']) expect(SHARED_CHECKOUT_NOTE).toContain(s)
  })

  it('keeps the lane note under the size guard', () => {
    expect(orchestrationNote('proj', research, roster, { sharesMainCheckout: true }).length).toBeLessThan(3300)
  })
})

describe('the worktree_done line in the launch brief', () => {
  const roster = rolePresets()
  const byId = (id: string) => roster.find((r) => r.id === id)!

  it('is added for a lane in its own worktree — Code and Design by default — and not otherwise', () => {
    for (const id of ['code', 'design']) {
      const ws = launchWorkspace(id, resolveAgentConfig(byId(id)).useWorktree)
      expect(orchestrationNote('proj', byId(id), roster, ws)).toContain(WORKTREE_DONE_NOTE)
    }
    for (const id of ['research', 'review', 'qa', 'operator']) {
      const ws = launchWorkspace(id, resolveAgentConfig(byId(id)).useWorktree)
      expect(orchestrationNote('proj', byId(id), roster, ws)).not.toContain(WORKTREE_DONE_NOTE)
    }
  })

  it('names the order: committed, then worktree_done, then report', () => {
    expect(WORKTREE_DONE_NOTE).toMatch(/committed on your branch, call `mcp__operator__worktree_done`, then `mcp__operator__report`/)
  })

  it('keeps a Code lane note under the size guard', () => {
    expect(orchestrationNote('proj', byId('code'), roster, { ownWorktree: true }).length).toBeLessThan(3300)
  })
})
