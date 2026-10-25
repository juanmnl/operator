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
    expect(draftEffect({ key: 'Enter' }, { before: '\\' }, 10)).toBe('draft')
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

describe('unsent input: suggestion lists and the character before the cursor (review S1/S2, 2026-10-25)', () => {
  it('S1: an Esc while a suggestion list may be open starts no pair, as with disableEscapeDoublePress', () => {
    expect(draftEffect({ key: 'Escape' }, { prev: { key: 'Escape', at: 0 }, picker: true }, 10)).toBeNull()
    // `@src/ren`, then a double Esc: the first closes the picker, the second only says "Esc again".
    for (const [i, key] of [...'look @src/ren'].entries()) noteDraftKey('s1', { key }, i)
    noteDraftKey('s1', { key: 'Escape' }, 100)
    noteDraftKey('s1', { key: 'Escape' }, 200)
    expect(hasUnsentInput('s1')).toBe(true)
    // A third Esc inside the window is the second of a new pair, and the TUI clears then.
    noteDraftKey('s1', { key: 'Escape' }, 300)
    expect(hasUnsentInput('s1')).toBe(false)
  })

  it('S1: the / command menu counts too, and a pasted @ path', () => {
    noteDraftKey('s2', { key: '/' }, 0)
    noteDraftKey('s2', { key: 'e' }, 10)
    noteDraftKey('s2', { key: 'Escape' }, 100)
    noteDraftKey('s2', { key: 'Escape' }, 200)
    expect(hasUnsentInput('s2')).toBe(true)
    notePaste('s3', 'see @docs/plan.md')
    noteDraftKey('s3', { key: 'Escape' }, 100)
    noteDraftKey('s3', { key: 'Escape' }, 200)
    expect(hasUnsentInput('s3')).toBe(true)
    clearUnsentInput('s2')
    clearUnsentInput('s3')
  })

  it('S1: with no key that opens a list, a double Esc still clears; after Enter or Ctrl+C the list is gone', () => {
    noteDraftKey('s4', { key: 'a' }, 0)
    noteDraftKey('s4', { key: 'Escape' }, 100)
    noteDraftKey('s4', { key: 'Escape' }, 200)
    expect(hasUnsentInput('s4')).toBe(false)
    noteDraftKey('s5', { key: '@' }, 0)
    noteDraftKey('s5', { key: 'c', ctrlKey: true }, 10)
    noteDraftKey('s5', { key: 'x' }, 20)
    noteDraftKey('s5', { key: 'Escape' }, 100)
    noteDraftKey('s5', { key: 'Escape' }, 200)
    expect(hasUnsentInput('s5')).toBe(false)
  })

  it('S1: a draft restored after a reload takes a list to be open', () => {
    restoreDrafts(['s6'])
    noteDraftKey('s6', { key: 'Escape' }, 100)
    noteDraftKey('s6', { key: 'Escape' }, 200)
    expect(hasUnsentInput('s6')).toBe(true)
    clearUnsentInput('s6')
  })

  it('S2: a paste that ends in \\, then Enter, is a newline', () => {
    notePaste('b1', 'C:\\Users\\')
    noteDraftKey('b1', { key: 'Enter' }, 10)
    expect(hasUnsentInput('b1')).toBe(true)
    // The TUI replaced the \\ with the newline, so the next Enter sends.
    noteDraftKey('b1', { key: 'Enter' }, 20)
    expect(hasUnsentInput('b1')).toBe(false)
  })

  it('S2: \\, another character, Backspace, Enter is a newline', () => {
    noteDraftKey('b2', { key: '\\' }, 0)
    noteDraftKey('b2', { key: 'x' }, 10)
    noteDraftKey('b2', { key: 'Backspace' }, 20)
    noteDraftKey('b2', { key: 'Enter' }, 30)
    expect(hasUnsentInput('b2')).toBe(true)
    clearUnsentInput('b2')
  })

  it('S2: a \\ typed before the cursor moved is not read as the one before it', () => {
    noteDraftKey('b3', { key: '\\' }, 0)
    noteDraftKey('b3', { key: 'ArrowLeft' }, 10)
    noteDraftKey('b3', { key: 'Backspace' }, 20)
    noteDraftKey('b3', { key: 'Enter' }, 30)
    expect(hasUnsentInput('b3')).toBe(false)
    // A paste whose text is not known leaves the character unseen, and Enter sends.
    noteDraftKey('b4', { key: '\\' }, 0)
    notePaste('b4')
    noteDraftKey('b4', { key: 'Enter' }, 10)
    expect(hasUnsentInput('b4')).toBe(false)
  })
})
