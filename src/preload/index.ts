import { contextBridge, ipcRenderer } from 'electron'
import { IPC, OperatorRequest, AgentSession, ManagedTerminal, FolderPreferences, ClaudeSettings, McpServersResult } from '../shared/types'

contextBridge.exposeInMainWorld('operator', {
  // Permission flow
  onNewRequest: (callback: (request: OperatorRequest) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, request: OperatorRequest) => callback(request)
    ipcRenderer.on(IPC.NEW_REQUEST, handler)
    return () => ipcRenderer.removeListener(IPC.NEW_REQUEST, handler)
  },
  onSessionUpdate: (callback: (sessions: AgentSession[]) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessions: AgentSession[]) => callback(sessions)
    ipcRenderer.on(IPC.SESSION_UPDATE, handler)
    return () => ipcRenderer.removeListener(IPC.SESSION_UPDATE, handler)
  },
  respond: (id: string, value: string) => {
    return ipcRenderer.invoke(IPC.RESPOND, id, value)
  },
  getQueue: () => {
    return ipcRenderer.invoke(IPC.GET_QUEUE)
  },
  getSessions: () => {
    return ipcRenderer.invoke(IPC.GET_SESSIONS)
  },

  // Terminal management
  terminalSpawn: (cwd?: string, launchOptions?: Record<string, unknown>): Promise<{ terminalId: string; cwd: string } | null> => {
    return ipcRenderer.invoke(IPC.TERMINAL_SPAWN, cwd, launchOptions)
  },
  terminalWrite: (id: string, data: string) => {
    ipcRenderer.send(IPC.TERMINAL_WRITE, id, data)
  },
  terminalResize: (id: string, cols: number, rows: number) => {
    ipcRenderer.send(IPC.TERMINAL_RESIZE, id, cols, rows)
  },
  terminalKill: (id: string) => {
    return ipcRenderer.invoke(IPC.TERMINAL_KILL, id)
  },
  terminalList: (): Promise<ManagedTerminal[]> => {
    return ipcRenderer.invoke(IPC.TERMINAL_LIST)
  },
  onTerminalData: (callback: (id: string, data: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, id: string, data: string) => callback(id, data)
    ipcRenderer.on(IPC.TERMINAL_DATA, handler)
    return () => ipcRenderer.removeListener(IPC.TERMINAL_DATA, handler)
  },
  onTerminalExit: (callback: (id: string, exitCode: number, signal: number) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, id: string, exitCode: number, signal: number) => callback(id, exitCode, signal)
    ipcRenderer.on(IPC.TERMINAL_EXIT, handler)
    return () => ipcRenderer.removeListener(IPC.TERMINAL_EXIT, handler)
  },

  // Window
  showMainWindow: () => {
    ipcRenderer.send(IPC.SHOW_MAIN_WINDOW)
  },

  // Hook setup
  getHookPath: (): Promise<string> => {
    return ipcRenderer.invoke(IPC.GET_HOOK_PATH)
  },

  // Session tracking
  setActiveSession: (sessionId: string | null) => {
    ipcRenderer.send(IPC.SET_ACTIVE_SESSION, sessionId)
  },

  // Folder preferences
  folderPrefsLoad: (projectPath: string): Promise<FolderPreferences> => {
    return ipcRenderer.invoke(IPC.FOLDER_PREFS_LOAD, projectPath)
  },
  folderPrefsSaveSettings: (filePath: string, settings: ClaudeSettings): Promise<void> => {
    return ipcRenderer.invoke(IPC.FOLDER_PREFS_SAVE_SETTINGS, filePath, settings)
  },
  folderPrefsSaveMd: (filePath: string, content: string): Promise<void> => {
    return ipcRenderer.invoke(IPC.FOLDER_PREFS_SAVE_MD, filePath, content)
  },
  folderPrefsCreateFile: (filePath: string, type: 'settings' | 'md'): Promise<void> => {
    return ipcRenderer.invoke(IPC.FOLDER_PREFS_CREATE_FILE, filePath, type)
  },
  getMcpServers: (projectPath: string): Promise<McpServersResult> => {
    return ipcRenderer.invoke(IPC.GET_MCP_SERVERS, projectPath)
  },
  pickFolder: (): Promise<string | null> => {
    return ipcRenderer.invoke(IPC.PICK_FOLDER)
  },
})
