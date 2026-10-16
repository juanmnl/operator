import { describe, it, expect } from 'vitest'
import { noteKeystroke, typedWithin, lastKeystrokeAt, draftEffect, noteDraftKey, notePaste, hasUnsentInput } from './lane-keystrokes'

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

  it('reports the last keystroke time', () => {
    noteKeystroke('d3', 7_000)
    expect(lastKeystrokeAt('d3')).toBe(7_000)
    expect(lastKeystrokeAt('d4')).toBeUndefined()
  })
})
