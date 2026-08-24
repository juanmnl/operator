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
  /** The saved-session key (Operator-side, stable across restarts — unlike `id`, which is
   *  a per-run `local-<terminalId>` for untracked sessions). Keys the per-session accent
   *  override, so a colour picked on a lane-less agent survives a relaunch. */
  savedKey?: string
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
  /** Prompts the lane's TUI took into its message QUEUE (mirrors `queue-operation: enqueue`
   *  in the transcript), recent tail. A prompt that arrives mid-turn is queued and then
   *  consumed inside that turn, so it NEVER shows up in `messages` — this is the only place
   *  delivery of such a message can be observed. Not a reading surface; see delivery-confirm. */
  queued?: NarrationEntry[]
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
 *  its settings (e.g. Operator=Fable, Research=Sonnet, Code=Opus). Launching a session
 *  against a role prefills its config; the session then carries the role's id. */
export interface Role {
  id: string
  name: string
  /** Model alias: 'fable' | 'opus' | 'sonnet' | 'haiku' (or a full model id).
   *
   *  OPTIONAL, and that is the point: absent means "inherit" — the global role default, then the
   *  built-in preset (see lib/model-config `resolveAgentConfig`). It was required, which made every
   *  seeded roster entry indistinguishable from a deliberate pin and left a global default with
   *  nothing to override. Never read it directly for a launch; go through the resolver. */
  model?: string
  /** Absent = inherit, exactly as with `model`. */
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
  /** Lifecycle: queued (backlog) → running (handed to a lane) → done.
   *  `abandoned` is the fourth: its lane is gone and it was never seen to finish, so we know
   *  its run ended but NOT that the work completed. It exists because the alternative was
   *  lying — reconciliation used to write `done`, which every count and chip reads as
   *  "finished". Absent = queued. */
  status?: 'queued' | 'running' | 'done' | 'abandoned'
  /** The lane's terminal this task was dispatched to (for auto-complete + diff link).
   *  NOT a liveness key: it's a per-run counter (`t0`, `t1`, …) that COLLIDES across runs —
   *  three different sessions in the real store hold `t5` — so "is this terminal alive?" is
   *  unanswerable from it. Use `claudeSessionId` for that. */
  terminalId?: string
  /** The lane's Claude session id — a UUID, globally unique and stable across restarts, which
   *  is what makes it the liveness key `terminalId` can't be. Absent on tasks stamped before
   *  this field existed; those are adopted or abandoned once on hydrate (lib/task-lifecycle). */
  claudeSessionId?: string
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
  /** Set when a task was closed by STARTUP RECONCILIATION rather than by its lane finishing:
   *  it was running on a pty from a previous run, so it can never complete normally (see
   *  lib/task-lifecycle). Distinct from doneAt because it means "its run ended", NOT
   *  "verified complete" — the done row says so. */
  reconciledAt?: string
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
/** Claude Code's four listing modes for a skill. Absent = on.
 *
 *  Its own words, from the CLI binary — kept verbatim because the UI copy must describe the
 *  EFFECT without misrepresenting the mechanism: `"name-only"` lists the skill without its
 *  description; `"user-invocable-only"` hides it from the model but keeps `/name`; `"off"`
 *  hides it from both. */
export type SkillMode = 'on' | 'name-only' | 'user-invocable-only' | 'off'

/** One environment row at one altitude.
 *
 *  Three shapes, and the third is the one a `Record<string, string>` cannot hold: `unset` is a
 *  TOMBSTONE that masks whatever the altitude below set. Deleting a row is the only way to
 *  unset a name — clearing its value gives you `""`, which is a different thing, and `[ -z ]`
 *  and `[ -v ]` disagree exactly there. */
export type EnvEntry =
  | { name: string; value: string }
  /** A secret NAME, resolved into the pty environment at spawn. Never a value: this record is
   *  written to `projects.json`, and a value here would be plaintext in a file we own. */
  | { name: string; secret: string }
  | { name: string; unset: true }

export interface SkillPolicy {
  /** Keyed by skill name. Absent = on.
   *
   *  GLOBAL AND PROJECT SKILLS ONLY. Verified against CLI 2.1.235: no key form —
   *  `tdd`, `mattpocock-skills:tdd`, nor `mattpocock-skills@claude-plugins-official:tdd` —
   *  has any effect on a plugin-contributed skill. `plugins` below is the only control for
   *  those. See `dev/results/session-settings-s0-s3.md`. */
  overrides?: Record<string, SkillMode>
  /** Mirrors Claude Code's own `enabledPlugins` key, so it can be written straight through.
   *  Keyed `<plugin>@<marketplace>`. This is the ONLY way to turn a plugin's skills off. */
  plugins?: Record<string, boolean>
}

/** One skill found on disk. Built by the backend's directory walk, not by asking the CLI. */
export interface SkillCatalogEntry {
  name: string
  description: string
  source: {
    kind: 'global' | 'project' | 'plugin'
    label: string
    path: string
    /** `<plugin>@<marketplace>` — present only for plugin skills. */
    plugin?: string
  }
}

export interface SkillsCatalog {
  entries: SkillCatalogEntry[]
  /** Roots that could not be READ — so the UI can say so rather than render an empty group
   *  that claims there are no skills. */
  errors: Array<{ label: string; path: string; message: string }>
  /** Plugin ids `installed_plugins.json` still lists. */
  installedPlugins: string[]
}

export interface Project {
  id: string
  /** Canonical repo root, or the folder path itself for a non-git folder. */
  path: string
  /** Folder basename; renamable (id/path stay fixed). */
  name: string
  createdAt: string
  /** Last time an agent RAN or was restored here — *not* last opened. Only the launch and
   *  restore sites bump it; browsing into a project leaves it alone. Read it as "when this
   *  project last did work", never as "when you last looked at it". */
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
  /** Free text about what this project IS — the thing the folder name can't tell you.
   *  Written by the user, edited from the gallery card's ⋯ menu, and shown there as a
   *  two-line snippet. Absent or empty = no description; the card just omits the row. */
  contextNotes?: string
  /** Environment variables set on every lane Operator launches in this project.
   *
   *  A LIST, never a Record: a map keyed by name cannot carry a tombstone, and `unset` is
   *  exactly the case a map has no way to express. Stored in `projects.json` on this Mac — not
   *  in the repo, and never in the repo's own `.claude/settings.json`, which has its own writer
   *  (`FolderPreferencesView`). One writer per file. */
  env?: EnvEntry[]
  /** Per-skill listing modes and plugin toggles for every lane in this project. */
  skills?: SkillPolicy
  /** The user's chosen position in the ProjectRail, and the ONLY thing that orders it.
   *
   *  A total order over every project, not just the ones currently on the rail: a drag restamps
   *  all of them, so a project that is off the rail today (nothing live in it) still holds a
   *  place for when it comes back.
   *
   *  `undefined` = never placed. Those sort AFTER everything placed, in store order — which is
   *  creation order, since every write path in DashboardView appends. That is the defined slot
   *  for a brand-new project and for one that appears because something just went live in it:
   *  the end of the rail, never the middle of an arrangement the user has learned.
   *
   *  No migration needed. An existing store has none of these, they all read as unplaced, and
   *  the rail renders in store order exactly as it did before the first drag. */
  railOrder?: number
  /** When the user shelved this project. Absent = ACTIVE; present = PREVIOUS.
   *  A decision, never a measurement. Cleared automatically the moment a session launches
   *  here (upsertProject) — a running agent must never hide in a collapsed section.
   *  Nothing writes it yet; see lib/project-shelf for how it's read. */
  archivedAt?: string
  // The moodboard is BUILT — it just isn't a field here: its images live on disk under the
  // project's asset dir, reached by id via moodboardAdd/moodboardList, so nothing about it
  // needs to ride in projects.json. Remaining deferred seam: chatThreadId.
}

/** An edit to a project: either a fixed patch, or one computed from the project as it is
 *  RIGHT NOW. Surfaces that derive their next state from a rendered snapshot (the roster
 *  board) must use the function form — otherwise two edits landing in the same tick both
 *  build on the same stale copy and the first is lost. */
export type ProjectPatch = Partial<Project> | ((current: Project) => Partial<Project>)

/** One routed `OPERATOR-DISPATCH` directive, kept as a project activity log. */
export interface DispatchRecord {
  /** The backend's dedupe id (stable across transcript re-reads). */
  id: string
  at: string
  /** The lane that emitted the directive (unknown for non-role sessions). */
  fromRoleId?: string
  /** Absent = a lane authored it (`fromRoleId` names which). Present = the HUMAN sent it from the
   *  project channel. Provenance has to be recorded here or it is lost: delivery types into a pty
   *  either way, so in the target's own transcript a channel message and the user typing directly
   *  are the same `user` turn. NOT modelled as `fromRoleId: 'user'` — a roster could legitimately
   *  hold a lane with that id, and every existing consumer reads `fromRoleId` as a roster id. */
  /** HISTORICAL ONLY as of the channel's deletion: its one writer was the channel composer's
   *  fan-out send, so no new record can carry it. Kept because `TaskBoard` still READS it, and
   *  a stored record that says a human sent this is the only provenance those rows have — the
   *  alternative is relabelling real history "unknown lane". */
  fromHuman?: true
  /** The resolved target lane; absent when the role didn't match (→ unassigned). */
  toRoleId?: string
  task: string
  /** Set when this record is the DELIVERY of a lane's `OPERATOR-REPLY` rather than a dispatch of
   *  its own: the reply's content-hash id. The reply itself already lives in chat.db; this record
   *  exists only to say what happened when we tried to hand it to the addressee, and the channel
   *  merges it into that reply's row instead of drawing a second one. It is also the delivery
   *  seen-set — a transcript re-read reproduces the same hash, so a reply is never delivered
   *  twice. */
  replyId?: string
  /** sent = typed into a live lane · launched = idle lane spawned with the task ·
   *  queued = task queued (lane idle, pre-auto-launch records or a failed launch) ·
   *  unassigned = unknown role ·
   *  pending-approval = a NON-coordinator lane asked for this and it has NOT been delivered;
   *    it waits for an explicit human approval and never expires into delivery ·
   *  rejected = a pending one was declined; terminal, and never delivered.
   *  The last three are agent→agent delivery brakes, and only ever appear with `replyId`:
   *  hop-limit = the chain hit its budget with no human in it · pair-brake = that ordered pair
   *  was sending too fast and is suspended · paused = the human's kill switch was on.
   *  All three mean NOTHING was typed anywhere, and none of them retries on its own.
   *  Historical records predate everything after `unassigned` and keep whatever they were.
   *  ONE reclassification exists, and only this one: `sent` → `undelivered`, written by the
   *  delivery loop when the bytes went out but no turn ever followed. `sent` used to mean "it
   *  already went" and was treated as final for that reason — which is exactly how a dispatch
   *  that never arrived kept reading as a success. */
  outcome:
    | 'sent' | 'launched' | 'queued' | 'unassigned' | 'pending-approval' | 'rejected'
    | 'hop-limit' | 'pair-brake' | 'paused'
    // Written LATE, by the delivery loop, over an earlier `sent`: the bytes went to the pty but
    // no turn ever appeared in the target's transcript, so the task is sitting in its composer.
    // The one outcome that is a MEASUREMENT rather than a decision — see lib/delivery-confirm.
    | 'undelivered'
}

/** A lane's `OPERATOR-REPLY`, as the tailer emits it live. The return path's event shape —
 *  the mirror of a dispatch, except nothing is typed anywhere: by the time this arrives the
 *  reply is already persisted, project-scoped, in chat.db. */
export interface OperatorReply {
  /** Content hash over `sessionId|to|text` — stable across transcript re-reads, so the
   *  frontend's seen-set can drop a repeat after a relaunch. */
  id: string
  sessionId: string
  terminalId: string
  /** The project whose channel it was posted to; '' for an ad-hoc session. */
  projectId: string
  /** Addressee token: a lane id, or `project` for a broadcast. Resolved against the live
   *  roster on arrival — the parser stays liberal, exactly as it is for a dispatch. */
  to: string
  text: string
}

/** One stored reply, as read back per project (chat.db). */
export interface ProjectReply {
  /** The row's key: the same content hash `OperatorReply.id` carries, so a delivery outcome
   *  recorded against a live reply still matches it after a reload. */
  id: string
  /** The SENDER's session — resolve to a lane via its terminal's roleId. */
  sessionId: string
  to: string
  text: string
  timestamp: string
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
  /** SUSPENDED, not gone. Set when a task-scoped lane was closed automatically: its pty is dead
   *  and its worktree directory has been removed, but this record — `claudeSessionId`,
   *  `worktreeBranch`, `sourceCwd` — is what brings it back with `--resume` on the same branch.
   *  Cleared the moment the lane is live again (the persist effect rewrites the row from the tab).
   *  A lane the USER closes is still forgotten; only the automatic path suspends. */
  suspendedAt?: string
  /** WHY it closed, and the two are not the same claim. `reported-done` = it called
   *  `operator__task_status(id,'done')` and then went quiet for the grace window. `went-quiet` =
   *  it never reported at all and the long backstop took it, which is a bug signal, not a
   *  completion. Kept on the record so the difference survives a restart. */
  suspendedReason?: 'reported-done' | 'went-quiet'
  lastActiveAt: string
}

/** A tool call as a first-class transcript block. Mirrors `ToolBlock` in src-tauri/core.rs. */
export interface ToolBlock {
  name: string
  /** What it acted on (path, command, pattern) — same summarizer as the activity timeline. */
  target?: string
  /** Which agent made the call. Present on 100% of real tool_use blocks (30,699 sampled);
   *  this is what makes a subagent's work attributable without inventing a mechanism. */
  caller?: string
  /** Result text, CAPPED at parse time (2000 chars — see TOOL_RESULT_CAP in transcript.rs;
   *  the real p99 is 172KB and the max seen is 3.5MB). Empty until the result arrives. */
  output?: string
  /** Length of the ORIGINAL result, so the UI can say "the first 2,000 of 71,194". */
  outputChars?: number
  truncated?: boolean
  /** The tool_use id, so a late result finds its call. */
  id?: string
}

export interface NarrationEntry {
  /** `queued` appears only in `AgentSession.queued` — a prompt the TUI accepted but has not
   *  turned into a turn yet. It is never mixed into `messages`, so the reading surface's
   *  `kind === 'user' ? user : agent` split is unaffected. */
  kind: 'text' | 'thinking' | 'user' | 'tool' | 'queued'
  text: string
  timestamp: string
  /** Cache-file paths for images the user dropped into this turn (load via imageDataUrl). */
  images?: string[]
  /** Set only on `kind: 'tool'`. Absent on every entry written before this existed. */
  tool?: ToolBlock
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
  /** THE DURABLE IDENTITY, reported by the backend because it outlives a renderer respawn. The
   *  re-attach joins saved sessions to live ptys on `claudeSessionId`; `terminalId` is a per-run
   *  counter and a tab that fails that join is created unstamped — alive, and unroutable. */
  claudeSessionId?: string
  /** The project this pty was launched into, straight from the backend's own record. */
  projectId?: string
  /** Spawned in GRID-renderer mode — this pty has an alacritty core in Rust (gridterm.rs), so
   *  its pane is `GridTerminalPane` rather than `TerminalSurface`. Reported by the backend
   *  because the core is created at spawn and never after: it is the one copy of this fact that
   *  a renderer reload cannot lose. Opt-in, default off — see `getRendererMode`. */
  grid?: boolean
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

/** What a project says about itself + what its folder says right now. Raw sources; the choosing
 *  happens in `lib/project-description` (pure, tested). See the Rust `project_identity`. */
export interface ProjectIdentity {
  branch?: string
  dirty: number
  lastCommit?: string
  lastCommitAt?: string
  hubNote?: string
  readme?: string
  claudeMd?: string
  packageJson?: string
  /** The folder is gone — two of the real projects point at directories that no longer exist. */
  missing: boolean
}

// --- the artifact plane (phase 1: lane → Operator) ---------------------------------------
//
// A lane reaches Operator through its own MCP server (`src-tauri/src/mcp.rs`) rather than by
// writing a file into a worktree nobody else can read. These are the shapes Operator reads back.

export interface ArtifactReport {
  id: number
  at: string
  /** The lane that called, from OPERATOR_TERMINAL_ID. Never absent — an unattributable call is
   *  refused at the server rather than stored. */
  terminalId: string
  projectId?: string | null
  roleId?: string | null
  taskId?: string | null
  summary: string
  /** JSON `[{name, content}]` — CONTENT, never a path into the caller's checkout. */
  artifacts: string
}

export interface ArtifactStatusEvent {
  id: number
  at: string
  terminalId: string
  projectId?: string | null
  taskId: string
  status: string
}
