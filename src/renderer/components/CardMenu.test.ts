import { describe, it, expect } from 'vitest'
import { confirmKeyOf } from './CardMenu'

// The regression: `Close project · end N agents` carries a LIVE count, so keying the armed
// confirm on the label meant one agent exiting between the two clicks changed the key and the
// second click re-armed instead of firing. Two clicks on a confirm, nothing happens.
describe('confirmKeyOf', () => {
  it('is STABLE while a live label changes underneath it', () => {
    const three = { id: 'close-project', label: 'Close project · end 3 agents' }
    const two = { id: 'close-project', label: 'Close project · end 2 agents' }
    expect(confirmKeyOf(three)).toBe(confirmKeyOf(two))
  })

  it('falls back to the label, so static-label callers are unchanged', () => {
    expect(confirmKeyOf({ label: 'Forget project' })).toBe('Forget project')
  })

  it('keeps two different actions apart even when one has no id', () => {
    expect(confirmKeyOf({ id: 'close-project', label: 'Close project' }))
      .not.toBe(confirmKeyOf({ label: 'Forget project' }))
  })

  it('would NOT have been stable on the label alone — the bug, pinned', () => {
    const three = 'Close project · end 3 agents'
    const two = 'Close project · end 2 agents'
    expect(three).not.toBe(two)
  })
})
