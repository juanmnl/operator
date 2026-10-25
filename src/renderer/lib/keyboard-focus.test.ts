import { describe, it, expect } from 'vitest'
import { isKeyboardFocus } from './keyboard-focus'

describe('isKeyboardFocus (review R7: a mouse click does not leave ■ on the row)', () => {
  const el = (matches: (sel: string) => boolean) => ({ matches }) as unknown as Element

  it('follows :focus-visible', () => {
    expect(isKeyboardFocus(el((sel) => sel === ':focus-visible'))).toBe(true)
    expect(isKeyboardFocus(el(() => false))).toBe(false)
  })

  it('keeps the keyboard reveal when the engine cannot parse the selector', () => {
    expect(isKeyboardFocus(el(() => { throw new SyntaxError('unknown pseudo-class') }))).toBe(true)
  })

  it('is false for no target', () => {
    expect(isKeyboardFocus(null)).toBe(false)
  })
})
