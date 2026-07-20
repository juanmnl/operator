export type Severity = 'low' | 'medium' | 'high'

// --- grid terminal (our own, non-native) wire format (see src-tauri/src/gridterm.rs) ---
/** A cell colour: ANSI palette index 0–15 (mapped to the live theme), a "#rrggbb"
 *  truecolor/256 value, or null/undefined for the position's theme default. */
export type GridColor = number | string | null
/** A run of consecutive cells sharing fg(`f`)/bg(`b`)/attrs(`a`). `a` is a bitmask:
 *  1 bold, 2 dim, 4 italic, 8 underline, 16 inverse, 32 strikeout. */
export interface GridRun { t: string; f?: GridColor; b?: GridColor; a?: number }
export interface GridLine { y: number; runs: GridRun[] }
export interface GridUpdate {
  id: string
  cols: number
  rows: number
  cursor: { x: number; y: number; vis: boolean }
  lines: GridLine[]
  /** Lines scrolled back into history (0 = at the live bottom). */
  offset: number
}

export type SessionPhase = 'idle' | 'running' | 'compacting' | 'waiting'
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
  /** Canonical project id (repo root) — groups sessions by project in the sidebar. */
  projectId?: string
  /** Orchestration role (lane) this session was launched against, if any. */
  roleId?: string
  /** Model alias this session was launched with (Operator-side; the transcript omits it). */
  model?: string
  /** Reasoning effort this session was launched with (Operator-side). */
  effortLevel?: 'high' | 'normal' | 'low'
  /** Short summary derived from the first user prompt, shown as the default label. */
  summary?: string
  status: SessionStatus
  phase: SessionPhase
  activity: ActivityEntry[]
  /** Assistant prose (answers + thinking) for the reading panel; recent tail. */
  messages?: NarrationEntry[]
  /** Latest TodoWrite plan snapshot (Plan tab). */
  todos?: TodoItem[]
  activeSubagents: number
  lastToolName: string | null
  startedAt: string
  lastActivityAt: string
  terminalId?: string
  permissionMode?: string
  /** Cumulative token usage parsed from the transcript (absent until the first turn). */
  usage?: TokenUsage
}

/** Cumulative session token usage — the per-lane effort/cost signal. */
export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
}

/** An orchestration role within a project's roster — a reusable "lane" that pins a model and
 *  its settings (e.g. Orchestrator=Fable, Research=Sonnet, Code=Opus). Launching a session
 *  against a role prefills its config; the session then carries the role's id. */
export interface Role {
  id: string
  name: string
  /** Model alias: 'fable' | 'opus' | 'sonnet' | 'haiku' (or a full model id). */
  model: string
  effort?: 'high' | 'normal' | 'low'
  permissionMode?: string
  /** Optional `.claude/agents` definition name to launch this lane as. */
  agentName?: string
  /** Optional lane accent (CSS colour) for sidebar/board badges. */
  accent?: string
  /** Launch this lane in an isolated git worktree — gives its tasks an attributable
   *  diff and a merge-back story (vs sharing the project root with other lanes). */
  useWorktree?: boolean
  /** The lane's standing charter, appended to its system prompt at launch (how this
   *  role works — scope, method, output shape). Defaults per role; editable. */
  prompt?: string
}

/** Compact summary of a task's code change, captured when the task completes. */
export interface TaskDiffStat {
  files: number
  added: number
  removed: number
}

/** A queued unit of work in a project's backlog. Optionally assigned to an agent lane (roleId);
 *  unassigned tasks sit in the backlog until assigned. Dispatched tasks leave the queue. */
export interface ProjectTask {
  id: string
  text: string
  /** Assigned agent lane, or undefined = unassigned backlog. */
  roleId?: string
  /** Lifecycle: queued (backlog) → running (handed to a lane) → done. Absent = queued. */
  status?: 'queued' | 'running' | 'done'
  /** The lane's terminal this task was dispatched to (for auto-complete + diff link). */
  terminalId?: string
  /** Where the lane ran (worktree path or project root) — the live-diff source. */
  cwd?: string
  /** Worktree lanes: source repo root + branch/base, so the diff (and merge) survive
   *  worktree removal — close deletes the dir but keeps the branch. */
  sourceCwd?: string
  worktreeBranch?: string
  worktreeBase?: string
  /** Change summary captured at completion (files/+/−), shown on the done row. */
  diffStat?: TaskDiffStat
  /** Verification gate result — the project's check command run in the lane's dir
   *  at completion ("done" vs "done and green"). */
  check?: { status: 'running' | 'pass' | 'fail'; output?: string; at: string }
  createdAt: string
  startedAt?: string
  doneAt?: string
}

/** Launch-time config for a single Claude Code session (model/effort/permissions/etc.) —
 *  built from a Role when launching a roster lane, or from a project's saved defaults. */
export interface SessionConfig {
  effortLevel: 'high' | 'normal' | 'low'
  permissionMode: 'default' | 'auto' | 'bypassPermissions'
  model: string
  allowedTools: string
  useWorktree: boolean
  /** Ask the agent to start the project's dev server on launch (so Preview works right away). */
  launchDevServer: boolean
  /** Number of parallel agents to fan the task out to (1 = a single session). */
  count: number
  /** Initial task submitted to every agent on launch (required when count > 1). */
  prompt: string
}

/** A project = a folder/repo (its canonical git root) that owns many sessions over time.
 *  The durable home for a repo's sessions, defaults, roster, and — later — moodboard/context. */
export interface Project {
  id: string
  /** Canonical repo root, or the folder path itself for a non-git folder. */
  path: string
  /** Folder basename; renamable (id/path stay fixed). */
  name: string
  createdAt: string
  lastActiveAt: string
  defaults?: { model?: string; effortLevel?: 'high' | 'normal' | 'low'; permissionMode?: string }
  /** Verification gate: shell command (e.g. "npm test") run in a lane's dir when its
   *  task completes. Empty/absent = gates off. */
  checkCommand?: string
  /** Orchestration roster — the project's agent lanes (see Role). */
  roster?: Role[]
  /** Backlog of tasks to dispatch to agents (see ProjectTask). */
  tasks?: ProjectTask[]
  /** Recent orchestrator dispatches (who asked whom to do what) — capped tail, newest last. */
  dispatches?: DispatchRecord[]
  // Deferred seams (not populated this phase): moodboard, contextNotes, chatThreadId.
}

/** One routed `OPERATOR-DISPATCH` directive, kept as a project activity log. */
export interface DispatchRecord {
  /** The backend's dedupe id (stable across transcript re-reads). */
  id: string
  at: string
  /** The lane that emitted the directive (unknown for non-role sessions). */
  fromRoleId?: string
  /** The resolved target lane; absent when the role didn't match (→ unassigned). */
  toRoleId?: string
  task: string
  /** sent = typed into a live lane · queued = lane idle, task queued · unassigned = unknown role. */
  outcome: 'sent' | 'queued' | 'unassigned'
}

/** What resolveProject() returns for a source cwd. */
export interface ProjectResolution {
  id: string
  path: string
  name: string
}

/** A session's restorable config, persisted across restarts (~/.operator/sessions.json +
 *  localStorage mirror). Lives here (not in a view) so the sidebar can import it too. */
export interface SavedSession {
  key: string
  cwd: string
  projectName: string
  /** Canonical project id (repo root). Optional — older saved files predate it. */
  projectId?: string
  /** Orchestration role (lane) this session was launched against, if any. */
  roleId?: string
  customName?: string
  model?: string
  effortLevel?: 'high' | 'normal' | 'low'
  permissionMode?: string
  worktreeBranch?: string
  worktreeBase?: string
  sourceCwd?: string
  /** Latest Claude Code session id seen — enables "resume conversation". */
  claudeSessionId?: string
  /** Live pty id from the CURRENT backend run; stale (ignored) after a full restart. */
  terminalId?: string
  lastActiveAt: string
}

export interface NarrationEntry {
  kind: 'text' | 'thinking' | 'user'
  text: string
  timestamp: string
  /** Cache-file paths for images the user dropped into this turn (load via imageDataUrl). */
  images?: string[]
}

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface ManagedTerminal {
  id: string
  pid: number
  cwd: string
  command: string
  sessionId?: string
  alive: boolean
  /** Dev-server port Operator reserved for this session (OPERATOR_DEV_PORT). */
  devPort?: number
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
  AGENTS_LIST: 'agents:list',
  AGENT_SAVE: 'agents:save',
  AGENT_DELETE: 'agents:delete',
  PREFS_UPDATE: 'operator:prefs-update',
} as const
