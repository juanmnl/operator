import { describe, it, expect } from 'vitest'
import { cdpButton, cdpModifiers, fitFrame, keyInput, toPage } from './preview-electron'

const key = (over: Partial<Parameters<typeof keyInput>[0]> = {}) =>
  ({ key: 'a', code: 'KeyA', keyCode: 65, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...over })

describe('fitFrame', () => {
  it('fits the app viewport inside the box, keeping its aspect, never above 1:1', () => {
    expect(fitFrame({ w: 400, h: 600 }, { w: 800, h: 600 })).toEqual({ w: 400, h: 300, scale: 0.5 })
    expect(fitFrame({ w: 1000, h: 300 }, { w: 800, h: 600 })).toEqual({ w: 400, h: 300, scale: 0.5 })
    expect(fitFrame({ w: 2000, h: 2000 }, { w: 800, h: 600 })).toEqual({ w: 800, h: 600, scale: 1 })
  })
  it('is empty until there is a frame', () => {
    expect(fitFrame({ w: 400, h: 300 }, { w: 0, h: 0 })).toEqual({ w: 0, h: 0, scale: 1 })
  })
})

describe('input mapping', () => {
  it('maps canvas px to page CSS px through the scale', () => {
    expect(toPage(100, 50, 0.5)).toEqual({ x: 200, y: 100 })
    expect(toPage(10, 10, 0)).toEqual({ x: 10, y: 10 })
  })
  it('encodes modifiers as CDP bits and buttons as names', () => {
    expect(cdpModifiers({ altKey: true, ctrlKey: false, metaKey: true, shiftKey: true })).toBe(13)
    expect([cdpButton(0), cdpButton(1), cdpButton(2), cdpButton(4)]).toEqual(['left', 'middle', 'right', 'none'])
  })
  it('sends text for a printable key down, none for a shortcut or a key up', () => {
    expect(keyInput(key(), 'keyDown')).toMatchObject({ type: 'keyDown', text: 'a', keyCode: 65, modifiers: 0 })
    expect(keyInput(key({ metaKey: true, key: 's', code: 'KeyS', keyCode: 83 }), 'keyDown')).toMatchObject({ text: undefined, modifiers: 4 })
    expect(keyInput(key({ key: 'Enter', code: 'Enter', keyCode: 13 }), 'keyDown').text).toBe('\r')
    expect(keyInput(key(), 'keyUp').text).toBeUndefined()
  })
})
