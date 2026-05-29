import { ipcMain, dialog, app } from 'electron'
import { join } from 'path'
import { queue } from './queue'
import { sessions } from './sessions'
import { IPC, OperatorResponse, ClaudeSettings } from '../shared/types'
import { PtyManager } from './terminal/pty-manager'
import { launchClaudeCode, LaunchOptions } from './terminal/agent-launcher'
import { WindowManager } from './window/window-manager'
import { loadFolderPreferences, loadGlobalPreferences, saveSettingsFile, saveMdFile, createFile, getMcpServers } from './folder-prefs'
import { inspectRepo, createWorktree, worktreeStatus, removeWorktree, worktreeDiff, commitAll, mergeBranch, discardBranch } from './worktree'
import { rules } from './rules'

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

  ipcMain.handle(IPC.FOLDER_PREFS_LOAD_GLOBAL, () => {
    return loadGlobalPreferences()
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

  // Git / worktrees
  ipcMain.handle(IPC.REPO_INSPECT, (_event, cwd: string) => {
    return inspectRepo(cwd)
  })

  ipcMain.handle(IPC.WORKTREE_CREATE, async (_event, cwd: string) => {
    try {
      return await createWorktree(cwd)
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC.WORKTREE_STATUS, (_event, path: string) => {
    return worktreeStatus(path)
  })

  ipcMain.handle(IPC.WORKTREE_REMOVE, async (_event, path: string, sourceRoot: string) => {
    try {
      await removeWorktree(path, sourceRoot)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC.WORKTREE_DIFF, (_event, path: string) => {
    return worktreeDiff(path)
  })

  ipcMain.handle(IPC.WORKTREE_COMMIT, async (_event, path: string, message: string) => {
    try {
      const sha = await commitAll(path, message)
      return { ok: true, sha }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC.WORKTREE_MERGE, (_event, worktreePath: string, sourceRoot: string, branch: string, baseBranch: string) => {
    return mergeBranch(worktreePath, sourceRoot, branch, baseBranch)
  })

  ipcMain.handle(IPC.WORKTREE_DISCARD, async (_event, worktreePath: string, sourceRoot: string, branch: string) => {
    try {
      await discardBranch(worktreePath, sourceRoot, branch)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // Rules engine
  ipcMain.handle(IPC.RULES_LIST, () => rules.list())
  ipcMain.handle(IPC.RULES_ADD, (_event, rule: { tool: string; pattern?: string; action: 'approve' | 'deny' }) => rules.add(rule))
  ipcMain.handle(IPC.RULES_REMOVE, (_event, id: string) => rules.remove(id))

  // Renderer-driven preferences: renderer owns persistence (localStorage), main
  // process just receives updates so it can act on flags like notification gating.
  ipcMain.on(IPC.PREFS_UPDATE, (_event, prefs: import('../shared/types').OperatorPrefs) => {
    windowManager.updatePrefs(prefs)
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
