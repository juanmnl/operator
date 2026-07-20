import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { getTuiMode, setTuiMode } from './terminal-options'

// getTuiMode is on the session-spawn path (operator-bridge terminalSpawn), so a throw
// or a bogus value here would break launching, not just the preference. These pin the
// contract: always one of the two valid modes, never an exception.
describe('getTuiMode', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('defaults to classic when unset', () => {
    expect(getTuiMode()).toBe('default')
  })

  it('round-trips through setTuiMode', () => {
    setTuiMode('fullscreen')
    expect(getTuiMode()).toBe('fullscreen')
    setTuiMode('default')
    expect(getTuiMode()).toBe('default')
  })

  it('treats any unrecognised stored value as classic', () => {
    localStorage.setItem('operator.terminal.tuiMode', 'nonsense')
    expect(getTuiMode()).toBe('default')
  })

  it('falls back to classic when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    expect(getTuiMode()).toBe('default')
  })
})
