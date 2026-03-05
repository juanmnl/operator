import { Tray, Menu, nativeImage, app, BrowserWindow } from 'electron'
import { join } from 'path'
import { queue } from './queue'

let tray: Tray | null = null
let getWindow: (() => BrowserWindow | null) | null = null

export function createTray(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter
  const iconPath = join(__dirname, '../../assets/trayTemplate.png')
  const icon = nativeImage.createFromPath(iconPath)
  icon.setTemplateImage(true)

  tray = new Tray(icon)
  tray.setToolTip('Operator')

  tray.on('click', () => {
    const win = getWindow?.()
    if (win && queue.size > 0) {
      win.show()
    }
  })

  tray.setContextMenu(buildMenu())
}

export function updateTrayBadge(): void {
  if (!tray) return
  const count = queue.size
  tray.setTitle(count > 0 ? ` ${count}` : '')
  tray.setContextMenu(buildMenu())
}

function buildMenu(): Menu {
  const count = queue.size
  return Menu.buildFromTemplate([
    {
      label: count > 0 ? `${count} pending request${count > 1 ? 's' : ''}` : 'No pending requests',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Server: localhost:47821',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Quit Operator',
      click: () => app.quit(),
    },
  ])
}
