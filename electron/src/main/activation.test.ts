import { describe, it, expect } from 'vitest'
import { onAppActivated, onWindowFocused, type ActivatableWindow } from './activation'

function fakeWindow(over: { visible?: boolean; destroyed?: boolean; wcDestroyed?: boolean } = {}) {
  const log: string[] = []
  const win: ActivatableWindow = {
    isDestroyed: () => !!over.destroyed,
    isVisible: () => over.visible ?? true,
    focus: () => { log.push('win.focus') },
    webContents: { isDestroyed: () => !!over.wcDestroyed, focus: () => { log.push('webContents.focus') } },
  }
  return { win, log }
}

describe('window focus → page focus → renderer told', () => {
  it('focuses the web contents, then notifies, in that order', () => {
    const { win, log } = fakeWindow()
    onWindowFocused(win, () => log.push('notify'))
    expect(log).toEqual(['webContents.focus', 'notify'])
  })
  it('does nothing for a destroyed window or web contents', () => {
    for (const f of [fakeWindow({ destroyed: true }), fakeWindow({ wcDestroyed: true })]) {
      onWindowFocused(f.win, () => f.log.push('notify'))
      expect(f.log).toEqual([])
    }
  })
})

describe('app activate (Dock click) with a window open', () => {
  it('focuses a visible window', () => {
    const { win, log } = fakeWindow()
    onAppActivated(win)
    expect(log).toEqual(['win.focus'])
  })
  it('leaves a window that is not shown yet alone (activate also fires at launch)', () => {
    const { win, log } = fakeWindow({ visible: false })
    onAppActivated(win)
    expect(log).toEqual([])
    onAppActivated(null)
  })
})
