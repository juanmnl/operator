import { describe, it, expect } from 'vitest'
import { noteKeystroke, typedWithin, lastKeystrokeAt, draftEffect, noteDraftKey, notePaste, hasUnsentInput, clearUnsentInput, restoreDrafts, draftUnknown, onDraftChange, DOUBLE_ESC_MS } from './lane-keystrokes'

describe('lane keystrokes', () => {
  it('reports typing within the window, per terminal', () => {
    noteKeystroke('k1', 1_000)
    expect(typedWithin('k1', 10_000, 5_000)).toBe(true)
    expect(typedWithin('k1', 10_000, 11_000)).toBe(false)
    expect(typedWithin('k2', 10_000, 5_000)).toBe(false)
  })
})

describe('unsent input', () => {
  it('reads a printable key or a paste as a draft, and Enter or Ctrl+C as the end of one', () => {
    expect(draftEffect({ key: 'a' })).toBe('draft')
    expect(draftEffect({ key: 'A', shiftKey: true })).toBe('draft')
    expect(draftEffect({ key: 'v', metaKey: true })).toBe('draft')
    expect(draftEffect({ key: 'Enter' })).toBe('clear')
    expect(draftEffect({ key: 'Enter', shiftKey: true })).toBe('draft') // a newline inside the draft
    expect(draftEffect({ key: 'c', ctrlKey: true })).toBe('clear')
    expect(draftEffect({ key: 'ArrowUp' })).toBeNull()
    expect(draftEffect({ key: 'Backspace' })).toBeNull()
    expect(draftEffect({ key: 'k', metaKey: true })).toBeNull()
  })

  it('tracks the draft per lane', () => {
    noteDraftKey('d1', { key: 'h' })
    expect(hasUnsentInput('d1')).toBe(true)
    expect(hasUnsentInput('d2')).toBe(false)
    noteDraftKey('d1', { key: 'Enter' })
    expect(hasUnsentInput('d1')).toBe(false)
    notePaste('d2')
    expect(hasUnsentInput('d2')).toBe(true)
  })

  it('forgets a draft when the lane ends or restarts', () => {
    noteDraftKey('d5', { key: 'x' })
    clearUnsentInput('d5')
    expect(hasUnsentInput('d5')).toBe(false)
  })

  it('reports the last keystroke time', () => {
    noteKeystroke('d3', 7_000)
    expect(lastKeystrokeAt('d3')).toBe(7_000)
    expect(lastKeystrokeAt('d4')).toBeUndefined()
  })
})

describe('unsent input: the keys Claude Code reads differently (review F4/F5, 2026-10-24)', () => {
  it('reads \\ then Enter as a newline in the draft, not a send', () => {
    expect(draftEffect({ key: 'Enter' }, { key: '\\', at: 0 }, 10)).toBe('draft')
    noteDraftKey('k1', { key: 'x' }, 0)
    noteDraftKey('k1', { key: '\\' }, 10)
    // Shift on its own between them changes nothing in the composer.
    noteDraftKey('k1', { key: 'Shift', shiftKey: true }, 15)
    noteDraftKey('k1', { key: 'Enter' }, 20)
    expect(hasUnsentInput('k1')).toBe(true)
    // The next Enter sends the multi-line message.
    noteDraftKey('k1', { key: 'Enter' }, 30)
    expect(hasUnsentInput('k1')).toBe(false)
  })

  it('reads a \\ deleted before the Enter as gone', () => {
    noteDraftKey('k2', { key: '\\' }, 0)
    noteDraftKey('k2', { key: 'Backspace' }, 10)
    noteDraftKey('k2', { key: 'Enter' }, 20)
    expect(hasUnsentInput('k2')).toBe(false)
  })

  it('clears on a double Esc inside the window, as the TUI does', () => {
    noteDraftKey('k3', { key: 'x' }, 0)
    noteDraftKey('k3', { key: 'Escape' }, 1000)
    expect(hasUnsentInput('k3')).toBe(true)
    noteDraftKey('k3', { key: 'Escape' }, 1000 + DOUBLE_ESC_MS)
    expect(hasUnsentInput('k3')).toBe(false)
  })

  it('does not clear on two Escs too far apart, or with a key between them', () => {
    noteDraftKey('k4', { key: 'x' }, 0)
    noteDraftKey('k4', { key: 'Escape' }, 100)
    noteDraftKey('k4', { key: 'Escape' }, 101 + DOUBLE_ESC_MS)
    expect(hasUnsentInput('k4')).toBe(true)
    noteDraftKey('k5', { key: 'x' }, 0)
    noteDraftKey('k5', { key: 'Escape' }, 100)
    noteDraftKey('k5', { key: 'ArrowLeft' }, 150)
    noteDraftKey('k5', { key: 'Escape' }, 200)
    expect(hasUnsentInput('k5')).toBe(true)
  })

  it('restores the drafts main kept after a reload, marked unknown until a key settles them', () => {
    restoreDrafts(['k6', 'k7'])
    expect(hasUnsentInput('k6')).toBe(true)
    expect(draftUnknown('k6')).toBe(true)
    noteDraftKey('k6', { key: 'y' })
    expect(draftUnknown('k6')).toBe(false)
    expect(hasUnsentInput('k6')).toBe(true)
    noteDraftKey('k7', { key: 'Enter' })
    expect(hasUnsentInput('k7')).toBe(false)
    expect(draftUnknown('k7')).toBe(false)
    clearUnsentInput('k6')
  })

  it('tells its listeners each change once, for main\'s mirror', () => {
    const seen: [string, boolean][] = []
    const off = onDraftChange((id, on) => seen.push([id, on]))
    noteDraftKey('k8', { key: 'a' })
    noteDraftKey('k8', { key: 'b' })
    notePaste('k8')
    noteDraftKey('k8', { key: 'c', ctrlKey: true })
    clearUnsentInput('k8')
    off()
    noteDraftKey('k8', { key: 'z' })
    expect(seen).toEqual([['k8', true], ['k8', false]])
    clearUnsentInput('k8')
  })
})
