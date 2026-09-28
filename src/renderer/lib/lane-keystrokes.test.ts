import { describe, it, expect } from 'vitest'
import { noteKeystroke, typedWithin } from './lane-keystrokes'

describe('lane keystrokes', () => {
  it('reports typing within the window, per terminal', () => {
    noteKeystroke('k1', 1_000)
    expect(typedWithin('k1', 10_000, 5_000)).toBe(true)
    expect(typedWithin('k1', 10_000, 11_000)).toBe(false)
    expect(typedWithin('k2', 10_000, 5_000)).toBe(false)
  })
})
