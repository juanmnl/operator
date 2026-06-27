import { describe, it, expect } from 'vitest'
import { isAppChord } from './key-routing'

const chord = (key: string, mods: { metaKey?: boolean; ctrlKey?: boolean } = {}) => ({
  metaKey: !!mods.metaKey,
  ctrlKey: !!mods.ctrlKey,
  key,
})

describe('isAppChord', () => {
  it('matches Cmd + K/N/B/W', () => {
    for (const k of ['k', 'n', 'b', 'w']) {
      expect(isAppChord(chord(k, { metaKey: true }))).toBe(true)
      expect(isAppChord(chord(k.toUpperCase(), { metaKey: true }))).toBe(true)
    }
  })

  it('matches Cmd + 1..9 but not 0', () => {
    for (let n = 1; n <= 9; n++) expect(isAppChord(chord(String(n), { metaKey: true }))).toBe(true)
    expect(isAppChord(chord('0', { metaKey: true }))).toBe(false)
  })

  it('matches the Ctrl variants too (so the window handler still sees them)', () => {
    expect(isAppChord(chord('k', { ctrlKey: true }))).toBe(true)
    expect(isAppChord(chord('1', { ctrlKey: true }))).toBe(true)
  })

  it('requires a modifier — bare keys are terminal input', () => {
    expect(isAppChord(chord('k'))).toBe(false)
    expect(isAppChord(chord('1'))).toBe(false)
    expect(isAppChord(chord('a', { metaKey: true }))).toBe(false)
  })

  it('does not match unrelated modified keys', () => {
    expect(isAppChord(chord('c', { metaKey: true }))).toBe(false) // copy
    expect(isAppChord(chord('v', { metaKey: true }))).toBe(false) // paste
    expect(isAppChord(chord('Enter', { metaKey: true }))).toBe(false)
  })
})
