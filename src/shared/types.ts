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
  reason?: string
  agent_id?: string
  agent_type?: string
  transcript_path?: string
  permission_mode?: string
  last_assistant_message?: string
  /** UserPromptSubmit hook: the prompt the user typed. Field name per Claude Code hook spec. */
  prompt?: string
  user_prompt?: string
  terminal_id?: string
}

export interface OperatorRequest {
  id: string
  agentId: string
  /** Humanized verb shown in the UI, e.g. "Run command", "Edit file". */
  action: string
  /** Raw underlying tool name (e.g. "Bash", "Edit") for matching and rules. */
  toolName?: string
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
  /**
   * What kind of timeline event this is:
   * - 'tool': an ordinary tool call (default)
   * - 'delegate': the lead agent dispatched a subagent (Agent/Task tool)
   * - 'subagent': a SubagentStart/SubagentStop lifecycle marker
   */
  kind?: 'tool' | 'delegate' | 'subagent'
  /** Secondary line, e.g. a delegation's description/prompt or subagent type. */
  detail?: string
}

export interface AgentSession {
  id: string
  agentId: string
  workingDirectory: string
  projectName: string
  /** Short summary derived from the first user prompt, shown as the default label. */
  summary?: string
  status: SessionStatus
  phase: SessionPhase
  entries: SessionEntry[]
  activity: ActivityEntry[]
  activeSubagents: number
  lastToolName: string | null
  startedAt: string
  lastActivityAt: string
  terminalId?: string
  permissionMode?: string
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

export type AgentScope = 'user' | 'project'

/**
 * A Claude Code subagent definition, backed by a Markdown file with YAML
 * frontmatter in `~/.claude/agents/` (user) or `<project>/.claude/agents/`
 * (project). Operator is a visual editor over these files — the headline being
 * per-agent model selection.
 */
export interface AgentDefinition {
  /** Unique identifier; also the invocation name. Derives the filename. */
  name: string
  description: string
  /** Model alias (`opus`/`sonnet`/`haiku`/`fable`/`opusplan`/`inherit`/`default`) or full ID. Omitted = inherit. */
  model?: string
  /** Allowed tool names. Empty/omitted = inherit all tools from the parent. */
  tools?: string[]
  /** Effort level: low | medium | high | xhigh | max. */
  effort?: string
  /** Max agentic turns before the subagent stops. */
  maxTurns?: number
  /** Display color hint (CC `/agents` UI). */
  color?: string
  /** The system prompt — everything below the frontmatter. */
  prompt: string
  scope: AgentScope
  /** Project root when scope === 'project'. */
  projectPath?: string
  /** Absolute path of the backing file. Empty string for an unsaved draft. */
  path: string
}

export type RuleAction = 'approve' | 'deny'

export interface Rule {
  id: string
  /** Tool name (e.g. "Bash", "Edit") or "*" for any tool. */
  tool: string
  /** Optional glob (`*` wildcards) matched against the tool's primary input field. */
  pattern?: string
  /**
   * Optional absolute project path. When set, the rule only applies to requests
   * whose working directory is at or under this path. Undefined = global.
   */
  scope?: string
  action: RuleAction
  createdAt: string
}

export interface RepoInfo {
  isRepo: boolean
  root?: string
  branch?: string
}

export interface WorktreeCreateResult {
  path: string
  branch: string
  baseBranch?: string
}

export interface WorktreeStatus {
  branch?: string
  changes: number
  valid: boolean
}

export interface FileChange {
  path: string
  status: string
  added: number
  removed: number
}

export interface WorktreeDiff {
  branch?: string
  files: FileChange[]
  diff: string
}

// Usage & cost (parsed from ~/.claude transcripts)

export interface ModelUsage {
  model: string
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  cost: number
  messages: number
}

export interface ProjectUsage {
  slug: string
  name: string
  cost: number
  tokens: number
  messages: number
}

export interface DayUsage {
  date: string
  cost: number
  tokens: number
}

export interface UsageStats {
  totalCost: number
  totalTokens: number
  /** Summed API call duration (ms) and wall-clock span (ms) over the window. */
  apiMs: number
  wallMs: number
  byModel: ModelUsage[]
  byProject: ProjectUsage[]
  byDay: DayUsage[]
  /** ISO start of the window, if filtered. */
  since?: string
  generatedAt: string
}

export interface SkillUsage {
  name: string
  pct: number
}

/**
 * "What's contributing to your limits usage?" — approximate, derived from local
 * transcripts. (The session/week rate-limit % bars come from Anthropic's
 * servers and aren't reproducible locally.)
 */
export interface UsageInsights {
  totalTokens: number
  highContextPct: number
  subagentPct: number
  longSessionPct: number
  skills: SkillUsage[]
  since?: string
  generatedAt: string
}

export const IPC = {
  NEW_REQUEST: 'operator:new-request',
  RESPOND: 'operator:respond',
  GET_QUEUE: 'operator:get-queue',
  GET_SESSIONS: 'operator:get-sessions',
  SESSION_UPDATE: 'operator:session-update',
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
  FOCUS_SESSION: 'operator:focus-session',
  FOLDER_PREFS_LOAD: 'folder-prefs:load',
  FOLDER_PREFS_LOAD_GLOBAL: 'folder-prefs:load-global',
  FOLDER_PREFS_SAVE_SETTINGS: 'folder-prefs:save-settings',
  FOLDER_PREFS_SAVE_MD: 'folder-prefs:save-md',
  FOLDER_PREFS_CREATE_FILE: 'folder-prefs:create-file',
  GET_MCP_SERVERS: 'operator:get-mcp-servers',
  PICK_FOLDER: 'operator:pick-folder',
  GET_USAGE_STATS: 'operator:get-usage-stats',
  REPO_INSPECT: 'git:inspect-repo',
  WORKTREE_CREATE: 'worktree:create',
  WORKTREE_STATUS: 'worktree:status',
  WORKTREE_REMOVE: 'worktree:remove',
  WORKTREE_DIFF: 'worktree:diff',
  WORKTREE_COMMIT: 'worktree:commit',
  WORKTREE_MERGE: 'worktree:merge',
  WORKTREE_DISCARD: 'worktree:discard',
  RULES_LIST: 'rules:list',
  RULES_ADD: 'rules:add',
  RULES_REMOVE: 'rules:remove',
  AGENTS_LIST: 'agents:list',
  AGENT_SAVE: 'agents:save',
  AGENT_DELETE: 'agents:delete',
  PREFS_UPDATE: 'operator:prefs-update',
} as const
