declare module '*.png' {
  const src: string
  export default src
}

import { OperatorRequest, AgentSession, ManagedTerminal, FolderPreferences, ClaudeSettings, McpServersResult } from '../shared/types'

declare global {
  interface Window {
    operator: {
      onNewRequest: (callback: (request: OperatorRequest) => void) => () => void
      onSessionUpdate: (callback: (sessions: AgentSession[]) => void) => () => void
      respond: (id: string, value: string) => Promise<boolean>
      getQueue: () => Promise<OperatorRequest[]>
      getSessions: () => Promise<AgentSession[]>
      terminalSpawn: (cwd?: string) => Promise<{ terminalId: string; cwd: string } | null>
      terminalWrite: (id: string, data: string) => void
      terminalResize: (id: string, cols: number, rows: number) => void
      terminalKill: (id: string) => Promise<void>
      terminalList: () => Promise<ManagedTerminal[]>
      onTerminalData: (callback: (id: string, data: string) => void) => () => void
      onTerminalExit: (callback: (id: string, exitCode: number, signal: number) => void) => () => void
      showMainWindow: () => void
      getHookPath: () => Promise<string>
      setActiveSession: (sessionId: string | null) => void
      folderPrefsLoad: (projectPath: string) => Promise<FolderPreferences>
      folderPrefsSaveSettings: (filePath: string, settings: ClaudeSettings) => Promise<void>
      folderPrefsSaveMd: (filePath: string, content: string) => Promise<void>
      folderPrefsCreateFile: (filePath: string, type: 'settings' | 'md') => Promise<void>
      getMcpServers: (projectPath: string) => Promise<McpServersResult>
      pickFolder: () => Promise<string | null>
    }
  }
}
