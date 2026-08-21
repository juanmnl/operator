import { describe, it, expect } from 'vitest'
import { isBusy } from './quit'

// Ported from `busy_means_mid_turn_or_blocked_on_you_but_never_idle` in quit.rs — the one pure
// decision in the module, and the one the design turns on.
describe('isBusy', () => {
  it('running and compacting are busy', () => {
    expect(isBusy('running')).toBe(true)
    expect(isBusy('compacting')).toBe(true)
  })

  it('WAITING is busy — an agent blocked on you is the lane you forgot about', () => {
    expect(isBusy('waiting')).toBe(true)
  })

  it('idle is NOT busy — a guard that fires on every quit trains its own dismissal', () => {
    expect(isBusy('idle')).toBe(false)
    expect(isBusy('')).toBe(false)
    expect(isBusy('ended')).toBe(false)
  })
})
