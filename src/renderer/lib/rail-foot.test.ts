import { describe, it, expect, beforeEach } from 'vitest'
import {
  RESTING_FOOT_ITEMS,
  FOLDED_FOOT_ITEMS,
  FOOT_EXPANDED_KEY,
  readFootExpanded,
  writeFootExpanded,
  footDisclosureLabel,
  type FootItemId,
} from './rail-foot'

describe('the two tiers', () => {
  it('accounts for all eight controls exactly once', () => {
    const all = [...RESTING_FOOT_ITEMS, ...FOLDED_FOOT_ITEMS]
    expect(all).toHaveLength(8)
    expect(new Set(all).size).toBe(8)
  })

  it('splits four and four — half the rows come back', () => {
    expect(RESTING_FOOT_ITEMS).toHaveLength(4)
    expect(FOLDED_FOOT_ITEMS).toHaveLength(4)
  })

  it('keeps the ambient meter at rest — its value is being seen, not clicked', () => {
    expect(RESTING_FOOT_ITEMS).toContain<FootItemId>('usage')
    expect(FOLDED_FOOT_ITEMS).not.toContain<FootItemId>('usage')
  })

  it('keeps the constant navigation at rest', () => {
    for (const id of ['agents', 'gallery', 'open-folder'] as FootItemId[]) {
      expect(RESTING_FOOT_ITEMS).toContain(id)
    }
  })

  it('folds the occasional and the rare', () => {
    for (const id of ['folder-prefs', 'global-prefs', 'prefs', 'theme'] as FootItemId[]) {
      expect(FOLDED_FOOT_ITEMS).toContain(id)
    }
  })

  it('cuts on an existing group seam, so the four pairs survive intact', () => {
    // Render order is row-major, two cells per row. The cut must fall BETWEEN rows — if either
    // tier held an odd number, a hairline-fenced pair would have been split across the fold.
    expect(RESTING_FOOT_ITEMS.length % 2).toBe(0)
    expect(FOLDED_FOOT_ITEMS.length % 2).toBe(0)
    // The resting tier is rows 1-2 in order; the folded tier is rows 3-4 in order.
    expect([...RESTING_FOOT_ITEMS]).toEqual(['agents', 'usage', 'gallery', 'open-folder'])
    expect([...FOLDED_FOOT_ITEMS]).toEqual(['folder-prefs', 'global-prefs', 'prefs', 'theme'])
  })
})

describe('persistence', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to folded — the space is only saved if nobody has to ask for it', () => {
    expect(readFootExpanded()).toBe(false)
  })

  it('survives a restart in both directions', () => {
    writeFootExpanded(true)
    expect(localStorage.getItem(FOOT_EXPANDED_KEY)).toBe('1')
    expect(readFootExpanded()).toBe(true)

    writeFootExpanded(false)
    expect(localStorage.getItem(FOOT_EXPANDED_KEY)).toBe('0')
    expect(readFootExpanded()).toBe(false)
  })

  it('uses its own key — the rail\'s WIDTH is a different axis and must not be entangled', () => {
    writeFootExpanded(true)
    expect(FOOT_EXPANDED_KEY).not.toBe('operator.sidebarCollapsed')
    expect(localStorage.getItem('operator.sidebarCollapsed')).toBeNull()
  })

  it('treats any junk value as folded rather than throwing', () => {
    localStorage.setItem(FOOT_EXPANDED_KEY, 'yes')
    expect(readFootExpanded()).toBe(false)
    localStorage.setItem(FOOT_EXPANDED_KEY, '')
    expect(readFootExpanded()).toBe(false)
  })

  it('falls back to folded when storage throws', () => {
    const real = Storage.prototype.getItem
    Storage.prototype.getItem = () => { throw new Error('SecurityError') }
    try {
      expect(readFootExpanded()).toBe(false)
    } finally {
      Storage.prototype.getItem = real
    }
  })

  it('does not throw when a write is refused', () => {
    const real = Storage.prototype.setItem
    Storage.prototype.setItem = () => { throw new Error('QuotaExceededError') }
    try {
      expect(() => writeFootExpanded(true)).not.toThrow()
    } finally {
      Storage.prototype.setItem = real
    }
  })
})

describe('the disclosure label', () => {
  it('names the count in both directions, never a bare "More"', () => {
    expect(footDisclosureLabel(false)).toBe('Show 4 more controls')
    expect(footDisclosureLabel(true)).toBe('Hide 4 more controls')
  })

  it('tracks the folded tier rather than hardcoding the number', () => {
    expect(footDisclosureLabel(false)).toContain(String(FOLDED_FOOT_ITEMS.length))
  })

  it('never says "collapse" or "expand" — those verbs belong to the sidebar toggle', () => {
    for (const l of [footDisclosureLabel(true), footDisclosureLabel(false)]) {
      expect(l.toLowerCase()).not.toContain('collapse')
      expect(l.toLowerCase()).not.toContain('expand')
      expect(l.toLowerCase()).not.toContain('sidebar')
    }
  })
})
