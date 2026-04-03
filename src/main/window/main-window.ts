import { BrowserWindow } from 'electron'
import { join } from 'path'

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 600,
    minHeight: 400,
    backgroundColor: '#1E1E25',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const url = process.env['ELECTRON_RENDERER_URL']
  if (url) {
    win.loadURL(`${url}#/dashboard`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/dashboard' })
  }

  win.once('ready-to-show', () => win.show())

  return win
}
