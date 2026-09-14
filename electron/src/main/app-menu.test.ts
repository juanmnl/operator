import { describe, it, expect, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { appMenuTemplate } from './app-menu'

const top = (t: MenuItemConstructorOptions[]) => t.map((m) => m.role ?? m.label)
const viewItems = (t: MenuItemConstructorOptions[]) => t.find((m) => m.label === 'View')!.submenu as MenuItemConstructorOptions[]

describe('appMenuTemplate', () => {
  it('keeps Electron\'s default menus on macOS, so ⌘C/⌘V/⌘A, ⌘W and ⌘Q behave as they did', () => {
    expect(top(appMenuTemplate(() => {}, true))).toEqual(['appMenu', 'fileMenu', 'editMenu', 'View', 'windowMenu'])
  })

  it('has no app menu off macOS', () => {
    expect(top(appMenuTemplate(() => {}, false))).toEqual(['fileMenu', 'editMenu', 'View', 'windowMenu'])
  })

  it('binds ⌘\' to the layout grid and sends it to the renderer', () => {
    const send = vi.fn()
    const grid = viewItems(appMenuTemplate(send, true)).find((i) => i.accelerator === "CmdOrCtrl+'")!
    expect(grid).toBeDefined()
    ;(grid.click as () => void)()
    expect(send).toHaveBeenCalledWith('toggle-grid')
  })

  it('keeps the default View menu\'s reload, devtools, zoom and full screen', () => {
    expect(viewItems(appMenuTemplate(() => {}, true)).map((i) => i.role).filter(Boolean))
      .toEqual(['reload', 'forceReload', 'toggleDevTools', 'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen'])
  })
})
