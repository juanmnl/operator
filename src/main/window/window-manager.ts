import { BrowserWindow } from 'electron'
import { createMainWindow } from './main-window'
import { createWidgetWindow } from './widget-window'
import { IPC, OperatorRequest, AgentSession } from '../../shared/types'

export class WindowManager {
  mainWindow: BrowserWindow | null = null
  widgetWindow: BrowserWindow | null = null
  /** The session currently being viewed in the main window */
  activeSessionId: string | null = null

  init(): void {
    this.mainWindow = createMainWindow()
    this.widgetWindow = createWidgetWindow()

    this.mainWindow.on('closed', () => { this.mainWindow = null })
    this.widgetWindow.on('closed', () => { this.widgetWindow = null })
  }

  private ensureWidget(): BrowserWindow | null {
    if (!this.widgetWindow || this.widgetWindow.isDestroyed()) {
      this.widgetWindow = createWidgetWindow()
      this.widgetWindow.on('closed', () => { this.widgetWindow = null })
    }
    return this.widgetWindow
  }

  sendNewRequest(request: OperatorRequest): void {
    // Always send to main window
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IPC.NEW_REQUEST, request)
    }

    // Always send to widget and show it
    const widget = this.ensureWidget()
    if (widget) {
      const send = () => {
        widget.webContents.send(IPC.NEW_REQUEST, request)

        // Show widget unless the user is actively looking at this session in Operator
        const mainFocused = this.mainWindow?.isFocused() ?? false
        const isActiveSession = request.sessionId && request.sessionId === this.activeSessionId
        if (!mainFocused || !isActiveSession) {
          widget.show()
        }
      }

      // Ensure webContents is ready before sending
      if (widget.webContents.isLoading()) {
        widget.webContents.once('did-finish-load', send)
      } else {
        send()
      }
    }
  }

  sendSessionUpdate(sessions: AgentSession[]): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IPC.SESSION_UPDATE, sessions)
    }
  }

  hideWidget(): void {
    if (this.widgetWindow && !this.widgetWindow.isDestroyed()) {
      this.widgetWindow.hide()
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
