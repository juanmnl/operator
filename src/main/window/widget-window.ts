import { BrowserWindow, screen } from 'electron'
import { join } from 'path'

export function createWidgetWindow(): BrowserWindow {
  const { width: screenWidth } = screen.getPrimaryDisplay().workAreaSize

  const winWidth = 572
  const winHeight = 64

  const win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: Math.round((screenWidth - winWidth) / 2),
    y: 54,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  const url = process.env['ELECTRON_RENDERER_URL']
  if (url) {
    win.loadURL(`${url}#/widget`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/widget' })
  }

  return win
}
