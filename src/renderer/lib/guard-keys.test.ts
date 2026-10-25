import { describe, it, expect } from 'vitest'
import { guardKeyAction, keepFocus } from './guard-keys'

const key = (k: string, mods: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, ...mods })

describe('guard dialog keys', () => {
  it('answers the safe verb on Esc and ⌘.', () => {
    expect(guardKeyAction(key('Escape'))).toBe('safe')
    expect(guardKeyAction(key('.', { metaKey: true }))).toBe('safe')
  })

  it('cycles the buttons on Tab', () => {
    expect(guardKeyAction(key('Tab'))).toBe('cycle')
    expect(guardKeyAction(key('Tab', { shiftKey: true }))).toBe('cycle')
  })

  it('keeps the app chords from the app while it is up (review R4)', () => {
    for (const k of ['w', 'n', 'k', 'b', 'j', '1', '9', 'e']) expect(guardKeyAction(key(k, { metaKey: true }))).toBe('block')
    expect(guardKeyAction(key('O', { metaKey: true, shiftKey: true }))).toBe('block')
  })

  it('lets other keys through: ⌘Q is the menu\'s, ⌘C copies, a letter is nothing', () => {
    expect(guardKeyAction(key('q', { metaKey: true }))).toBeNull()
    expect(guardKeyAction(key('c', { metaKey: true }))).toBeNull()
    expect(guardKeyAction(key('a'))).toBeNull()
  })
})

describe('keepFocus (review R5)', () => {
  it('puts focus back on the element that had it', () => {
    const lane = document.createElement('textarea')
    document.body.appendChild(lane)
    lane.focus()
    const restore = keepFocus()
    const button = document.createElement('button')
    document.body.appendChild(button)
    button.focus()
    button.remove()
    restore()
    expect(document.activeElement).toBe(lane)
    lane.remove()
  })

  it('does nothing when that element has left the document', () => {
    const gone = document.createElement('input')
    document.body.appendChild(gone)
    gone.focus()
    const restore = keepFocus()
    gone.remove()
    expect(() => restore()).not.toThrow()
    expect(document.activeElement).not.toBe(gone)
  })
})
