export type Severity = 'low' | 'medium' | 'high'

export type SessionPhase = 'idle' | 'running' | 'compacting'
export type SessionStatus = 'active' | 'ended'

export interface RequestOption {
  label: string
  value: string
  color?: string
}

export interface HookEvent {
  hook_event_name: string
  session_id?: string
  cwd?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_response?: Record<string, unknown>
  tool_use_id?: string
  message?: string
  title?: string
  notification_type?: string
  reason?: string
  agent_id?: string
  agent_type?: string
  transcript_path?: string
  permission_mode?: string
  last_assistant_message?: string
  terminal_id?: string
}

export interface OperatorRequest {
  id: string
  agentId: string
  action: string
  message: string
  context: {
    workingDirectory?: string
    target?: string
    preview?: string
  }
  severity: Severity
  options?: RequestOption[]
  expiresIn: number
  timestamp: string
  sessionId?: string
  terminalId?: string
}

export interface OperatorResponse {
  approved: boolean
  value: string
  modifiedContext: Record<string, unknown> | null
  respondedAt: string
  respondedBy: 'user' | 'auto-rule' | 'timeout'
}

export interface AuditEntry {
  id: string
  request: OperatorRequest
  response: OperatorResponse
}

export interface SessionEntry {
  request: OperatorRequest
  response: OperatorResponse | null
}

export interface ActivityEntry {
  toolName: string
  target?: string
  timestamp: string
  status: 'approved' | 'denied' | 'pending' | 'auto'
}

export interface AgentSession {
  id: string
  agentId: string
  workingDirectory: string
  projectName: string
  status: SessionStatus
  phase: SessionPhase
  entries: SessionEntry[]
  activity: ActivityEntry[]
  activeSubagents: number
  lastToolName: string | null
  startedAt: string
  lastActivityAt: string
  terminalId?: string
}

export interface ManagedTerminal {
  id: string
  pid: number
  cwd: string
  command: string
  sessionId?: string
  alive: boolean
}

// Folder Preferences types

export interface ClaudePermissionRules {
  allow?: string[]
  deny?: string[]
  ask?: string[]
}

export interface ClaudeHookEntry {
  matcher: string
  hooks: { type: string; command: string; timeout?: number }[]
}

export interface ClaudeSandboxConfig {
  enabled?: boolean
  network?: Record<string, unknown>
  excludedCommands?: string[]
  [key: string]: unknown
}

export interface ClaudeSettings {
  permissions?: ClaudePermissionRules
  hooks?: Record<string, ClaudeHookEntry[]>
  effortLevel?: 'high' | 'normal' | 'low'
  sandbox?: ClaudeSandboxConfig
  enabledPlugins?: Record<string, boolean>
  deniedMcpServers?: string[]
  [key: string]: unknown
}

export type MdFileScope = 'global' | 'project' | 'project-nested'
export type SettingsFileScope = 'global' | 'global-local' | 'project' | 'project-local' | 'managed'

export interface ClaudeMdFile {
  path: string
  label: string
  scope: MdFileScope
  exists: boolean
  content: string
}

export interface SettingsFile {
  path: string
  label: string
  scope: SettingsFileScope
  readOnly: boolean
  exists: boolean
  settings: ClaudeSettings
}

export interface FolderPreferences {
  projectPath: string
  projectName: string
  settingsFiles: SettingsFile[]
  mdFiles: ClaudeMdFile[]
}

export interface McpServerInfo {
  name: string
  type: 'stdio' | 'http' | 'cloud'
  source: string // e.g. "~/.claude.json", "cloud"
}

export interface McpServersResult {
  servers: McpServerInfo[]
}

export const IPC = {
  NEW_REQUEST: 'operator:new-request',
  RESPOND: 'operator:respond',
  GET_QUEUE: 'operator:get-queue',
  GET_SESSIONS: 'operator:get-sessions',
  SESSION_UPDATE: 'operator:session-update',
  HIDE_WIDGET: 'operator:hide-widget',
  QUEUE_UPDATE: 'operator:queue-update',
  TERMINAL_SPAWN: 'terminal:spawn',
  TERMINAL_WRITE: 'terminal:write',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_KILL: 'terminal:kill',
  TERMINAL_DATA: 'terminal:data',
  TERMINAL_EXIT: 'terminal:exit',
  TERMINAL_LIST: 'terminal:list',
  SHOW_MAIN_WINDOW: 'operator:show-main-window',
  GET_HOOK_PATH: 'operator:get-hook-path',
  SET_ACTIVE_SESSION: 'operator:set-active-session',
  FOLDER_PREFS_LOAD: 'folder-prefs:load',
  FOLDER_PREFS_SAVE_SETTINGS: 'folder-prefs:save-settings',
  FOLDER_PREFS_SAVE_MD: 'folder-prefs:save-md',
  FOLDER_PREFS_CREATE_FILE: 'folder-prefs:create-file',
  GET_MCP_SERVERS: 'operator:get-mcp-servers',
  PICK_FOLDER: 'operator:pick-folder',
} as const
