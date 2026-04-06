import { ipcMain, dialog, app } from 'electron'
import { join } from 'path'
import { queue } from './queue'
import { sessions } from './sessions'
import { IPC, OperatorResponse, ClaudeSettings } from '../shared/types'
import { PtyManager } from './terminal/pty-manager'
import { launchClaudeCode, LaunchOptions } from './terminal/agent-launcher'
import { WindowManager } from './window/window-manager'
import { loadFolderPreferences, saveSettingsFile, saveMdFile, createFile, getMcpServers } from './folder-prefs'

export function setupIpc(ptyManager: PtyManager, windowManager: WindowManager): void {
  // Permission flow
  ipcMain.handle(IPC.RESPOND, (_event, id: string, value: string) => {
    const response: OperatorResponse = {
      approved: value !== 'deny' && value !== 'n',
      value,
      modifiedContext: null,
      respondedAt: new Date().toISOString(),
      respondedBy: 'user'
    }
    return queue.respond(id, response)
  })

  ipcMain.handle(IPC.GET_QUEUE, () => {
    return queue.getAll()
  })

  ipcMain.handle(IPC.GET_SESSIONS, () => {
    return sessions.getActive()
  })

  // Terminal management
  ipcMain.handle(IPC.TERMINAL_SPAWN, async (_event, cwd?: string, launchOptions?: LaunchOptions) => {
    let targetCwd = cwd
    if (!targetCwd) {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select project folder',
      })
      if (result.canceled || result.filePaths.length === 0) return null
      targetCwd = result.filePaths[0]
    }
    const terminalId = launchClaudeCode(ptyManager, targetCwd, launchOptions)
    return { terminalId, cwd: targetCwd }
  })

  ipcMain.on(IPC.TERMINAL_WRITE, (_event, id: string, data: string) => {
    ptyManager.write(id, data)
  })

  ipcMain.on(IPC.TERMINAL_RESIZE, (_event, id: string, cols: number, rows: number) => {
    ptyManager.resize(id, cols, rows)
  })

  ipcMain.handle(IPC.TERMINAL_KILL, (_event, id: string) => {
    ptyManager.kill(id)
  })

  ipcMain.handle(IPC.TERMINAL_LIST, () => {
    return ptyManager.list()
  })

  ipcMain.on(IPC.SHOW_MAIN_WINDOW, () => {
    windowManager.showMainWindow()
  })

  ipcMain.handle(IPC.GET_HOOK_PATH, () => {
    return join(app.getAppPath(), 'scripts/operator-hook.sh')
  })

  ipcMain.on(IPC.SET_ACTIVE_SESSION, (_event, sessionId: string | null) => {
    windowManager.activeSessionId = sessionId
  })

  // Folder preferences
  ipcMain.handle(IPC.FOLDER_PREFS_LOAD, (_event, projectPath: string) => {
    return loadFolderPreferences(projectPath)
  })

  ipcMain.handle(IPC.FOLDER_PREFS_SAVE_SETTINGS, (_event, filePath: string, settings: ClaudeSettings) => {
    saveSettingsFile(filePath, settings)
  })

  ipcMain.handle(IPC.FOLDER_PREFS_SAVE_MD, (_event, filePath: string, content: string) => {
    saveMdFile(filePath, content)
  })

  ipcMain.handle(IPC.FOLDER_PREFS_CREATE_FILE, (_event, filePath: string, type: 'settings' | 'md') => {
    createFile(filePath, type)
  })

  ipcMain.handle(IPC.GET_MCP_SERVERS, (_event, projectPath: string) => {
    return getMcpServers(projectPath)
  })

  ipcMain.handle(IPC.PICK_FOLDER, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select project folder',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
