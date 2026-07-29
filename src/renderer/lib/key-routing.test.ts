import { describe, it, expect } from 'vitest'
import { isAppChord } from './key-routing'

const chord = (key: string, mods: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {}) => ({
  metaKey: !!mods.metaKey,
  ctrlKey: !!mods.ctrlKey,
  shiftKey: !!mods.shiftKey,
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

  it('matches the SHIFTED navigation pair only when shifted', () => {
    // ⌘⇧O = all projects, ⌘⇧P = project switcher. The browser reports the shifted key as
    // uppercase, which is why the check is case-insensitive.
    expect(isAppChord(chord('O', { metaKey: true, shiftKey: true }))).toBe(true)
    expect(isAppChord(chord('P', { metaKey: true, shiftKey: true }))).toBe(true)
    // Unshifted ⌘O / ⌘P have no app meaning and must stay the terminal's.
    expect(isAppChord(chord('o', { metaKey: true }))).toBe(false)
    expect(isAppChord(chord('p', { metaKey: true }))).toBe(false)
  })

  it('does not match unrelated modified keys', () => {
    expect(isAppChord(chord('c', { metaKey: true }))).toBe(false) // copy
    expect(isAppChord(chord('v', { metaKey: true }))).toBe(false) // paste
    expect(isAppChord(chord('Enter', { metaKey: true }))).toBe(false)
  })
})
