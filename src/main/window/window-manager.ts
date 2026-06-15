import { BrowserWindow, Notification, app } from 'electron'
import { createMainWindow } from './main-window'
import { IPC, OperatorRequest, AgentSession, OperatorPrefs, DEFAULT_PREFS } from '../../shared/types'

export class WindowManager {
  mainWindow: BrowserWindow | null = null
  /** The session currently being viewed in the main window */
  activeSessionId: string | null = null
  prefs: OperatorPrefs = { ...DEFAULT_PREFS }

  updatePrefs(next: OperatorPrefs): void {
    this.prefs = { ...this.prefs, ...next }
  }

  init(): void {
    this.mainWindow = createMainWindow()
    this.mainWindow.on('closed', () => { this.mainWindow = null })
  }

  sendNewRequest(request: OperatorRequest): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IPC.NEW_REQUEST, request)
    }

    // A single native ping when an agent needs you and you're not already in
    // Operator. Clicking it focuses the requesting session.
    const mainFocused = this.mainWindow?.isFocused() ?? false
    if (!mainFocused && this.prefs.nativeNotifications && Notification.isSupported()) {
      const target = request.context.target
      const body = target ? `${request.action}: ${target}` : request.action
      const notification = new Notification({ title: 'Operator — approval needed', body, silent: false })
      notification.on('click', () => {
        this.showMainWindow()
        if (request.sessionId) {
          this.mainWindow?.webContents.send(IPC.FOCUS_SESSION, request.sessionId)
        }
        app.focus({ steal: true })
      })
      notification.show()
    }
  }

  sendSessionUpdate(sessions: AgentSession[]): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IPC.SESSION_UPDATE, sessions)
    }
  }

  showMainWindow(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      this.mainWindow = createMainWindow()
      this.mainWindow.on('closed', () => { this.mainWindow = null })
    } else {
      this.mainWindow.show()
      this.mainWindow.focus()
    }
  }

  sendToMain(channel: string, ...args: unknown[]): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, ...args)
    }
  }
}
