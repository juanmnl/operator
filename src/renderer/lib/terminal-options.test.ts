import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { getTuiMode, setTuiMode, getRendererMode, setRendererMode, spawnTerminalMode } from './terminal-options'

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

// The renderer pref is on the same spawn path, and it is an OPT-IN escape hatch for a soak test
// of the grid terminal — so the case that matters most is the one nobody will look at: that a
// default install, and any install with a corrupt value, still gets xterm.
describe('getRendererMode', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('defaults to xterm when unset — the grid is opt-in, never inherited', () => {
    expect(getRendererMode()).toBe('xterm')
  })

  it('round-trips through setRendererMode', () => {
    setRendererMode('grid')
    expect(getRendererMode()).toBe('grid')
    setRendererMode('xterm')
    expect(getRendererMode()).toBe('xterm')
  })

  it('treats any unrecognised stored value as xterm', () => {
    localStorage.setItem('operator.terminal.renderer', 'ghostty')
    expect(getRendererMode()).toBe('xterm')
  })

  it('falls back to xterm when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    expect(getRendererMode()).toBe('xterm')
  })
})

// The COUPLING is the part worth pinning: grid mode forces Claude's fullscreen TUI whatever the
// tui pref says, because alt-screen is the only mode the grid was built to parse — and classic is
// the mode whose absolute-column redraws produce the overprint the grid exists to escape.
describe('spawnTerminalMode', () => {
  beforeEach(() => localStorage.clear())

  it('default install: xterm, and the tui pref is honoured', () => {
    expect(spawnTerminalMode()).toEqual({ grid: false, tuiMode: 'default' })
    setTuiMode('fullscreen')
    expect(spawnTerminalMode()).toEqual({ grid: false, tuiMode: 'fullscreen' })
  })

  it('grid FORCES fullscreen even when the tui pref says classic', () => {
    setRendererMode('grid')
    setTuiMode('default')
    expect(spawnTerminalMode()).toEqual({ grid: true, tuiMode: 'fullscreen' })
  })

  it('grid + fullscreen pref agree, and turning grid back off restores the pref', () => {
    setRendererMode('grid')
    setTuiMode('fullscreen')
    expect(spawnTerminalMode()).toEqual({ grid: true, tuiMode: 'fullscreen' })
    setRendererMode('xterm')
    setTuiMode('default')
    // The tui pref was never written to by grid mode — it is overridden at spawn, not persisted.
    expect(spawnTerminalMode()).toEqual({ grid: false, tuiMode: 'default' })
  })
})
