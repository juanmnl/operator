import { describe, it, expect } from 'vitest'
import { ACCENT_SWATCHES, DEFAULT_LANE_ACCENTS, normalizeHex, sameAccent } from './lane-accents'
import { parseSessionAccents, withSessionAccent, suggestedAccent, saveSessionAccent, loadSessionAccents, SESSION_ACCENTS_KEY } from './session-accents'

describe('lane-accents', () => {
  it('offers the six default lane accents first, then the extension', () => {
    expect(DEFAULT_LANE_ACCENTS).toHaveLength(6)
    expect(ACCENT_SWATCHES.slice(0, 6)).toEqual(DEFAULT_LANE_ACCENTS)
    // No duplicates — a repeated swatch would read as two different choices.
    expect(new Set(ACCENT_SWATCHES).size).toBe(ACCENT_SWATCHES.length)
  })

  it('normalises hex input and rejects anything else', () => {
    expect(normalizeHex('#AABBCC')).toBe('#aabbcc')
    expect(normalizeHex('  #abc ')).toBe('#aabbcc')
    expect(normalizeHex('#7ee787')).toBe('#7ee787')
    for (const bad of ['', '#', 'abc', '#ab', '#abcd', 'red', '#gggggg', 'rgb(1,2,3)']) {
      expect(normalizeHex(bad)).toBeNull()
    }
  })

  it('compares accents case- and shorthand-insensitively', () => {
    expect(sameAccent('#FFFFFF', '#ffffff')).toBe(true)
    expect(sameAccent('#FFF', '#ffffff')).toBe(true)
    expect(sameAccent('#7ee787', '#5ac8fa')).toBe(false)
    expect(sameAccent(undefined, '#fff')).toBe(false)
    expect(sameAccent('#fff', undefined)).toBe(false)
  })
})

describe('session-accents', () => {
  it('parses a stored map and ignores junk', () => {
    expect(parseSessionAccents(null)).toEqual({})
    expect(parseSessionAccents('not json')).toEqual({})
    expect(parseSessionAccents('[]')).toEqual({})
    expect(parseSessionAccents('"str"')).toEqual({})
    expect(parseSessionAccents('{"k":"#fff"}')).toEqual({ k: '#fff' })
    // Non-string / empty values are dropped rather than stored as bad accents.
    expect(parseSessionAccents('{"a":1,"b":null,"c":"  ","d":"#abc"}')).toEqual({ d: '#abc' })
  })

  it('sets and clears one entry without touching the rest', () => {
    const base = { a: '#111111', b: '#222222' }
    expect(withSessionAccent(base, 'c', '#333333')).toEqual({ a: '#111111', b: '#222222', c: '#333333' })
    // Clearing REMOVES the key, so the session falls back to its default colour.
    expect(withSessionAccent(base, 'a')).toEqual({ b: '#222222' })
    expect(withSessionAccent(base, 'a', '   ')).toEqual({ b: '#222222' })
    // Input is not mutated.
    expect(base).toEqual({ a: '#111111', b: '#222222' })
    // A blank key is a no-op rather than an entry under "".
    expect(withSessionAccent(base, '', '#333333')).toEqual(base)
  })

  it('suggests a stable accent per key', () => {
    expect(suggestedAccent('abc')).toBe(suggestedAccent('abc'))
    expect(DEFAULT_LANE_ACCENTS).toContain(suggestedAccent('abc'))
    expect(DEFAULT_LANE_ACCENTS).toContain(suggestedAccent(''))
  })

  /// Two app instances share one localStorage, so a save must merge with what's there
  /// rather than overwrite the whole map with this instance's snapshot.
  it('saveSessionAccent merges with what another instance already wrote', () => {
    localStorage.setItem(SESSION_ACCENTS_KEY, JSON.stringify({ a: '#111111' }))
    // This instance loaded before the other one wrote 'b'…
    const stale = loadSessionAccents()
    localStorage.setItem(SESSION_ACCENTS_KEY, JSON.stringify({ a: '#111111', b: '#222222' }))
    // …and now picks a colour for 'c'. The other instance's 'b' must survive.
    const merged = saveSessionAccent('c', '#333333')
    expect(merged).toEqual({ a: '#111111', b: '#222222', c: '#333333' })
    expect(loadSessionAccents()).toEqual(merged)
    expect(stale).toEqual({ a: '#111111' }) // the snapshot that would have clobbered it
  })

  it('saveSessionAccent clears one key without disturbing the others', () => {
    localStorage.setItem(SESSION_ACCENTS_KEY, JSON.stringify({ a: '#111111', b: '#222222' }))
    expect(saveSessionAccent('a')).toEqual({ b: '#222222' })
    expect(loadSessionAccents()).toEqual({ b: '#222222' })
  })
})
