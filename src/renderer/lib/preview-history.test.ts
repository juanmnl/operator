import { describe, it, expect } from 'vitest'
import {
  emptyHistory, pushEntry, goBack, goForward, canGoBack, canGoForward, currentEntry,
  HISTORY_CAP, type PreviewHistory, type PreviewEntry,
} from './preview-history'

const at = (port: number | null, path = ''): PreviewEntry => ({ port, path })
const load = (...entries: PreviewEntry[]): PreviewHistory =>
  entries.reduce(pushEntry, emptyHistory())

describe('pushEntry', () => {
  it('records addresses in order', () => {
    const h = load(at(5173, ''), at(5173, '/admin'))
    expect(h.entries).toHaveLength(2)
    expect(currentEntry(h)).toEqual(at(5173, '/admin'))
  })

  // A reload, or the 3s re-ping resolving to the same URL, must not fill the stack with
  // duplicates — that is how `back` ends up doing nothing visible several times in a row.
  it('does NOT record the same address twice in a row', () => {
    const h = load(at(5173, '/x'), at(5173, '/x'), at(5173, '/x'))
    expect(h.entries).toHaveLength(1)
  })

  it('records the same address again once something else came between', () => {
    expect(load(at(5173, '/a'), at(5173, '/b'), at(5173, '/a')).entries).toHaveLength(3)
  })

  // Exactly like a browser: having gone back and then navigated elsewhere, the skipped entries
  // are gone — keeping them would make `forward` jump somewhere never chosen from here.
  it('a new address TRUNCATES the forward entries', () => {
    let h = load(at(1, '/a'), at(2, '/b'), at(3, '/c'))
    h = goBack(goBack(h))
    expect(currentEntry(h)).toEqual(at(1, '/a'))
    h = pushEntry(h, at(9, '/z'))
    expect(h.entries.map((e) => e.port)).toEqual([1, 9])
    expect(canGoForward(h)).toBe(false)
  })

  it('caps the stack, keeping the most recent', () => {
    let h = emptyHistory()
    for (let i = 0; i < HISTORY_CAP + 10; i++) h = pushEntry(h, at(i, `/p${i}`))
    expect(h.entries).toHaveLength(HISTORY_CAP)
    expect(currentEntry(h)!.port).toBe(HISTORY_CAP + 9)
    expect(h.index).toBe(HISTORY_CAP - 1)
  })

  it('distinguishes an external url from a port', () => {
    const h = load(at(5173, ''), { port: null, path: '', url: 'https://x.co' })
    expect(h.entries).toHaveLength(2)
  })
})

describe('back / forward', () => {
  it('walks the stack', () => {
    let h = load(at(1, '/a'), at(2, '/b'), at(3, '/c'))
    h = goBack(h); expect(currentEntry(h)).toEqual(at(2, '/b'))
    h = goBack(h); expect(currentEntry(h)).toEqual(at(1, '/a'))
    h = goForward(h); expect(currentEntry(h)).toEqual(at(2, '/b'))
  })

  // The buttons disable by absence of INK, not by grey chrome — so they stay clickable and this
  // has to be safe to call at the ends.
  it('is a no-op at either end rather than throwing or wrapping', () => {
    const one = load(at(1, '/a'))
    expect(goBack(one)).toBe(one)
    expect(goForward(one)).toBe(one)
    expect(goBack(emptyHistory())).toEqual(emptyHistory())
  })

  it('reports what the ink should say', () => {
    const h = load(at(1, '/a'), at(2, '/b'))
    expect(canGoBack(h)).toBe(true)
    expect(canGoForward(h)).toBe(false)
    expect(canGoBack(goBack(h))).toBe(false)
    expect(canGoForward(goBack(h))).toBe(true)
  })

  it('an empty history can go neither way and has no current entry', () => {
    const h = emptyHistory()
    expect(canGoBack(h)).toBe(false)
    expect(canGoForward(h)).toBe(false)
    expect(currentEntry(h)).toBeNull()
  })
})
