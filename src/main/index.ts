import { app, nativeImage } from 'electron'
import { join } from 'path'
import { startServer } from './server'
import { setupIpc } from './ipc'
import { initDb } from './db'
import { createTray, updateTrayBadge } from './tray'
import { sessions } from './sessions'
import { WindowManager } from './window/window-manager'
import { PtyManager } from './terminal/pty-manager'
import { TerminalRegistry } from './terminal/terminal-registry'
import { ensureHooksConfigured } from './hooks-config'

const windowManager = new WindowManager()
let ptyManager: PtyManager

app.setName('Operator')

app.whenReady().then(() => {
  initDb()
  ensureHooksConfigured()
  windowManager.init()
  ptyManager = new PtyManager(windowManager)
  const terminalRegistry = new TerminalRegistry()
  setupIpc(ptyManager, windowManager)
  createTray(windowManager)
  startServer(windowManager, terminalRegistry)

  // When a terminal exits, mark its session as ended
  ptyManager.onTerminalExitHook((terminalId) => {
    const sessionId = terminalRegistry.getSessionId(terminalId)
    if (sessionId) {
      const session = sessions.getSession(sessionId)
      if (session && session.status === 'active') {
        session.status = 'ended'
        session.phase = 'idle'
      }
      terminalRegistry.unlink(terminalId)
    }
    windowManager.sendSessionUpdate(sessions.getActive())
    updateTrayBadge()
  })

  // Show in dock and Cmd+Tab switcher with rounded icon
  const icon = nativeImage.createFromPath(join(__dirname, '../../assets/logo-64.png'))
  app.dock?.setIcon(icon)
  app.dock?.show()
})

app.on('before-quit', () => {
  ptyManager?.killAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
