import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { loadForgottenProjects, saveForgottenProjects, rememberProjectForgotten, rememberProjectOpened } from './forgotten-projects'

// This list is the ONLY record that a forget ever happened — the project row itself is gone, so
// there is nothing else to hang the decision on. It is read on the hydrate path, so every failure
// mode here has to degrade to "empty", never to a throw.
describe('forgotten projects — the durable record', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('round-trips, and SURVIVES the process — which is the whole point', () => {
    rememberProjectForgotten('operator-abc123', [])
    // A fresh read is what the next boot does: the in-memory Set is gone, this is not.
    expect(loadForgottenProjects()).toEqual(['operator-abc123'])
  })

  it('accumulates without duplicating', () => {
    let ids = rememberProjectForgotten('a', [])
    ids = rememberProjectForgotten('b', ids)
    ids = rememberProjectForgotten('a', ids)
    expect(loadForgottenProjects().sort()).toEqual(['a', 'b'])
  })

  it('a deliberate re-open CANCELS the forget, or the guard outlives its truth', () => {
    let ids = rememberProjectForgotten('a', [])
    ids = rememberProjectForgotten('b', ids)
    ids = rememberProjectOpened('a', ids)
    expect(loadForgottenProjects()).toEqual(['b'])
    // …and un-forgetting something that was never forgotten is a no-op, not an error.
    expect(rememberProjectOpened('zzz', ids)).toEqual(['b'])
  })

  it('degrades to EMPTY on junk rather than throwing — it runs during hydrate', () => {
    localStorage.setItem('operator.forgottenProjects', 'not json')
    expect(loadForgottenProjects()).toEqual([])
    localStorage.setItem('operator.forgottenProjects', '{"not":"an array"}')
    expect(loadForgottenProjects()).toEqual([])
    localStorage.setItem('operator.forgottenProjects', '[1, null, "ok", ""]')
    expect(loadForgottenProjects()).toEqual(['ok'])
  })

  it('survives a throwing localStorage on both sides', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('disabled') })
    expect(loadForgottenProjects()).toEqual([])
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(() => saveForgottenProjects(['a'])).not.toThrow()
  })
})
