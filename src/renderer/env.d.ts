declare module '*.png' {
  const src: string
  export default src
}

import { AgentSession, ManagedTerminal, FolderPreferences, ClaudeSettings, McpServersResult, RepoInfo, WorktreeCreateResult, WorktreeStatus, WorktreeDiff, AgentDefinition, UsageStats, UsageInsights } from '../shared/types'

declare global {
  interface Window {
    operator: {
      onSessionUpdate: (callback: (sessions: AgentSession[]) => void) => () => void
      getSessions: () => Promise<AgentSession[]>
      terminalSpawn: (cwd?: string, launchOptions?: Record<string, unknown>) => Promise<{ terminalId: string; cwd: string } | null>
      terminalWrite: (id: string, data: string) => void
      terminalResize: (id: string, cols: number, rows: number) => void
      terminalKill: (id: string) => Promise<void>
      terminalList: () => Promise<ManagedTerminal[]>
      /** Dev-port registry: terminal id → reserved port (OPERATOR_DEV_PORT). */
      getDevPorts: () => Promise<Record<string, number>>
      onTerminalData: (callback: (id: string, data: string) => void) => () => void
      onTerminalExit: (callback: (id: string, exitCode: number, signal: number) => void) => () => void
      showMainWindow: () => void
      /** Begin dragging the OS window for the current mousedown gesture. */
      startWindowDrag: () => void
      /** Toggle window zoom (fill screen ⇆ restore) — titlebar double-click. */
      toggleWindowMaximize: () => void
      openExternal: (url: string) => void
      /** Swap the live macOS dock icon between the 'light' and 'dark' variants. */
      setDockIcon: (variant: 'light' | 'dark') => void
      /** Native terminal: attach the wgpu NSView for terminal `id` behind the webview. */
      pocAttachTermview?: (id: string, x: number, y: number, w: number, h: number, scale: number) => void
      /** Native terminal: reposition/resize the wgpu NSView for terminal `id`. */
      pocSetRect?: (id: string, x: number, y: number, w: number, h: number, scale: number) => void
      /** Native terminal: set the color palette from a theme's xterm ITheme. */
      pocSetTheme?: (theme: unknown) => void
      /** Native terminal: scroll the active grid by `lines` (positive = into history). */
      pocScroll?: (id: string, lines: number) => void
      /** Native terminal: forward a mouse event (selection / tracking / opt+click). */
      pocMouse?: (id: string, kind: 'down' | 'move' | 'up', x: number, y: number, scale: number, button: number, alt: boolean) => void
      /** Native terminal: drop a terminal's grid when it closes. */
      pocDetach?: (id: string) => void
      /** Subscribe to native dev-server port detections (id, port). */
      onDevServerPort?: (cb: (id: string, port: number) => void) => () => void
      /** Write a pasted image (base64) to a temp file; resolves to its path. */
      savePastedImage: (dataB64: string, ext: string) => Promise<string>
      onFileDrop: (callback: (paths: string[]) => void) => () => void
      setActiveSession: (sessionId: string | null) => void
      folderPrefsLoad: (projectPath: string) => Promise<FolderPreferences>
      folderPrefsLoadGlobal: () => Promise<FolderPreferences>
      folderPrefsSaveSettings: (filePath: string, settings: ClaudeSettings) => Promise<void>
      folderPrefsSaveMd: (filePath: string, content: string) => Promise<void>
      folderPrefsCreateFile: (filePath: string, type: 'settings' | 'md') => Promise<void>
      getMcpServers: (projectPath: string) => Promise<McpServersResult>
      pickFolder: () => Promise<string | null>
      inspectRepo: (cwd: string) => Promise<RepoInfo>
      worktreeCreate: (cwd: string) => Promise<WorktreeCreateResult | { error: string }>
      worktreeStatus: (path: string) => Promise<WorktreeStatus>
      worktreeRemove: (path: string, sourceRoot: string) => Promise<{ ok: boolean; error?: string }>
      worktreeDiff: (path: string) => Promise<WorktreeDiff>
      worktreeCommit: (path: string, message: string) => Promise<{ ok: boolean; sha?: string; error?: string }>
      worktreeMerge: (worktreePath: string, sourceRoot: string, branch: string, baseBranch: string) => Promise<{ ok: boolean; message?: string }>
      worktreeDiscard: (worktreePath: string, sourceRoot: string, branch: string) => Promise<{ ok: boolean; error?: string }>
      agentsList: (projectPath?: string) => Promise<AgentDefinition[]>
      agentSave: (def: AgentDefinition, originalPath?: string) => Promise<{ ok: boolean; path?: string; error?: string }>
      agentDelete: (path: string) => Promise<{ ok: boolean; error?: string }>
      getUsageStats: (days?: number) => Promise<UsageStats>
      getUsageInsights: (days?: number) => Promise<UsageInsights>
      /** Durable, crash-safe session snapshot (~/.operator/sessions.json). */
      saveSessions: (sessions: unknown[]) => void
      loadSessions: () => Promise<unknown[]>
      /** Auto-update against the public releases feed. */
      getVersion: () => Promise<string>
      checkUpdate: () => Promise<{ version: string } | null>
      installUpdate: () => Promise<void>
    }
  }
}
