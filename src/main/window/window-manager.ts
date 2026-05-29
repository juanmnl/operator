import { BrowserWindow, Notification, app } from 'electron'
import { createMainWindow } from './main-window'
import { createWidgetWindow } from './widget-window'
import { IPC, OperatorRequest, AgentSession, OperatorPrefs, DEFAULT_PREFS } from '../../shared/types'

export class WindowManager {
  mainWindow: BrowserWindow | null = null
  widgetWindow: BrowserWindow | null = null
  /** The session currently being viewed in the main window */
  activeSessionId: string | null = null
  prefs: OperatorPrefs = { ...DEFAULT_PREFS }

  updatePrefs(next: OperatorPrefs): void {
    this.prefs = { ...this.prefs, ...next }
  }

  init(): void {
    this.mainWindow = createMainWindow()
    this.widgetWindow = createWidgetWindow()

    this.mainWindow.on('closed', () => { this.mainWindow = null })
    this.widgetWindow.on('closed', () => { this.widgetWindow = null })

    // When the user comes back to Operator, dismiss the floating widget —
    // the queue is visible inside the app, no need for an overlay too.
    this.mainWindow.on('focus', () => { this.hideWidget() })
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

    const mainFocused = this.mainWindow?.isFocused() ?? false

    // Always send the payload to the widget so its queue stays current.
    // Only surface (show) it when the user is NOT in Operator.
    const widget = this.ensureWidget()
    if (widget) {
      const send = () => {
        widget.webContents.send(IPC.NEW_REQUEST, request)

        if (mainFocused) return
        if (widget.isVisible()) return // avoid re-show flicker on each event

        widget.show()
      }

      if (widget.webContents.isLoading()) {
        widget.webContents.once('did-finish-load', send)
      } else {
        send()
      }
    }

    // Native OS notification (only when user isn't already in Operator + prefs allow)
    if (!mainFocused && this.prefs.nativeNotifications && Notification.isSupported()) {
      const target = request.context.target
      const body = target ? `${request.action}: ${target}` : request.action
      const notification = new Notification({
        title: 'Operator — approval needed',
        body,
        silent: false,
      })
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
