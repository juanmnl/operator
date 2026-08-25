declare module '*.png' {
  const src: string
  export default src
}

import type { QuitRequest } from './lib/quit-guard'
import { AgentSession, ManagedTerminal, FolderPreferences, ClaudeSettings, McpServersResult, RepoInfo, WorktreeCreateResult, WorktreeStatus, WorktreeDiff, ProjectIdentity, AgentDefinition, UsageStats, UsageInsights, GridUpdate, NarrationEntry, OperatorReply, ProjectReply, ArtifactReport, ArtifactStatusEvent, SkillsCatalog, ReapPlan, ReapRunResult } from '../shared/types'

interface PlanLimits {
  sessionPct?: number | null
  sessionResets?: string | null
  weekPct?: number | null
  weekResets?: string | null
  modelLabel?: string | null
  modelPct?: number | null
  modelResets?: string | null
  plan?: string | null
  fetchedAt: string
  /** The CLI ran but said something unexpected. Shown, never swallowed. */
  note?: string | null
}

declare global {
  interface Window {
    operator: {
      onSessionUpdate: (callback: (sessions: AgentSession[]) => void) => () => void
      /** Orchestrator dispatch directives parsed from an agent's output. */
      onOrchestratorDispatch: (callback: (d: { id: string; sessionId: string; terminalId: string; role: string; task: string }) => void) => () => void
      /** A lane posted `OPERATOR-REPLY [to] text`. Already persisted by the tailer when this fires. */
      onOrchestratorReply?: (callback: (r: OperatorReply) => void) => () => void
      getSessions: () => Promise<AgentSession[]>
      /** Full durable chat history (reading-panel answers) for a session, from SQLite. */
      chatHistory: (sessionId: string) => Promise<NarrationEntry[]>
      /** Every reply posted to a project, oldest first. Read-only — see the bridge. */
      projectReplies?: (projectId: string) => Promise<ProjectReply[]>
      imageDataUrl: (path: string) => Promise<string>
      rendererHeartbeat: () => void
      /** `grid` echoes back which renderer this session was actually spawned with, so the
       *  caller records what was SENT rather than re-reading the pref a second time (which a
       *  mid-flight change could answer differently). See `getRendererMode`. */
      terminalSpawn: (cwd?: string, launchOptions?: Record<string, unknown>) => Promise<{ terminalId: string; cwd: string; grid: boolean } | null>
      /** Launch a deferred session's Claude process at the pane's fitted size (defer-launch). */
      terminalStart: (id: string, cols: number, rows: number) => void
      /** Spawn a plain interactive shell in `cwd` (toolbar scratch terminal); returns its id. */
      shellSpawn: (cwd: string) => Promise<string>
      terminalWrite: (id: string, data: string) => void
      terminalResize: (id: string, cols: number, rows: number) => void
      terminalKill: (id: string) => Promise<void>
      /** Reports lanes handed to Operator via `operator__report` — newest first. */
      artifactReports: (limit?: number) => Promise<ArtifactReport[]>
      /** `operator__task_status` signals not yet applied to projects.json. */
      artifactPendingStatus: () => Promise<ArtifactStatusEvent[]>
      /** Ack AFTER the task is written through, so a crash replays rather than drops. */
      artifactAckStatus: (ids: number[]) => Promise<void>
      terminalList: () => Promise<ManagedTerminal[]>
      /** Base64 of a terminal's retained output, replayed on re-attach after reload. */
      terminalHistory: (id: string) => Promise<string>
      /** Dev-port registry: terminal id → reserved port (OPERATOR_DEV_PORT). */
      getDevPorts: () => Promise<Record<string, number>>
      /** TCP ports this session is serving on: its reserved + sniffed ports, filtered to
       *  those answering loopback. Attributed by candidate set, never by process inspection. */
      sessionPorts: (id: string) => Promise<number[]>
      /** Record a dev-server port sniffed from this session's own terminal output. */
      noteSessionPort: (id: string, port: number) => void
      onTerminalData: (callback: (id: string, data: string) => void) => () => void
      onTerminalExit: (callback: (id: string, exitCode: number, signal: number) => void) => () => void
      /** Grid terminal (our own, non-native): start streaming a themed cell snapshot
       *  for `id` at the given size (pushes a full frame immediately). */
      gridtermAttach: (id: string, cols: number, rows: number) => void
      /** Resize the pty + alacritty grid together. */
      gridtermResize: (id: string, cols: number, rows: number) => void
      /** Scroll the grid viewport by `delta` lines into history (+) / toward bottom (−). */
      gridtermScroll: (id: string, delta: number) => void
      /** Update the colours the grid reports to Claude's colour queries (theme change). */
      gridtermSetTheme: (id: string, bg: string, fg: string) => void
      /** Stop streaming for `id` (keeps the Rust grid for a clean re-attach). */
      gridtermDetach: (id: string) => void
      onGridUpdate: (callback: (u: GridUpdate) => void) => () => void
      showMainWindow: () => void
      /** Begin dragging the OS window for the current mousedown gesture. */
      startWindowDrag: () => void
      /** Toggle window zoom (fill screen ⇆ restore) — titlebar double-click. */
      toggleWindowMaximize: () => void
      /** Subscribe to OS window resize/zoom events; returns an unsubscribe fn. */
      onWindowResize: (callback: () => void) => () => void
      /** Quit the whole app. Goes through the backend's quit guard like every other path. */
      quitApp: () => void
      /** Rust asked before quitting: busy lanes + how many idle ones go with them. */
      onQuitRequested?: (callback: (req: QuitRequest) => void) => () => void
      /** Ack the dialog mounted — cancels the 400ms native-dialog fallback. */
      quitDialogShown?: () => void
      /** `false` = Stay open. The veto then stands and nothing else happens. */
      quitDecision?: (quit: boolean) => void
      /** Mirror the "Ask before quitting with agents running" preference into Rust. */
      quitSetAsk?: (ask: boolean) => void
      /** Grow/shrink the OS window width by `delta` CSS px (negative shrinks). */
      growWindowWidth: (delta: number) => void
      openExternal: (url: string) => void
      /** Show a path in the OS file manager (Finder) — the gallery's "Reveal in Finder". */
      revealPath: (path: string) => Promise<void>
      /** Swap the live macOS dock icon between the 'light' and 'dark' variants. */
      setDockIcon: (variant: 'light' | 'dark') => void
      /** Write a pasted image (base64) to a temp file; resolves to its path. */
      savePastedImage: (dataB64: string, ext: string) => Promise<string>
      onFileDrop: (callback: (paths: string[]) => void) => () => void
      setActiveSession: (sessionId: string | null) => void
      /** Every skill Claude Code would load for this project, walked off disk (three roots).
       *  Read-only: nothing here writes a skill's state. Pass '' for the global view. */
      skillsCatalog: (projectPath: string) => Promise<SkillsCatalog>
      /** Classify every directory under `~/.operator/worktrees`. READ-ONLY — computing the plan
       *  never removes anything. */
      worktreeReapPlan: () => Promise<ReapPlan>
      /** Remove the plan's automatic tier. `dryRun` defaults to TRUE; pass `false` only from a
       *  deliberate user action. */
      worktreeReap: (dryRun?: boolean) => Promise<ReapRunResult>
      folderPrefsLoad: (projectPath: string) => Promise<FolderPreferences>
      folderPrefsLoadGlobal: () => Promise<FolderPreferences>
      folderPrefsSaveSettings: (filePath: string, settings: ClaudeSettings) => Promise<void>
      folderPrefsSaveMd: (filePath: string, content: string) => Promise<void>
      folderPrefsCreateFile: (filePath: string, type: 'settings' | 'md') => Promise<void>
      getMcpServers: (projectPath: string) => Promise<McpServersResult>
      pickFolder: () => Promise<string | null>
      inspectRepo: (cwd: string) => Promise<RepoInfo>
      worktreeCreate: (cwd: string, branch?: string, laneId?: string) => Promise<WorktreeCreateResult | { error: string }>
      worktreeStatus: (path: string) => Promise<WorktreeStatus>
      /** What a project IS (derived sources) + what its folder is doing. */
      projectIdentity: (path: string) => Promise<ProjectIdentity>
      /** Does this path still exist as a directory? See `path_exists` in lib.rs for why this
       *  is not `worktreeStatus` — that conflates "deleted" with "not a git repo". */
      pathExists?: (path: string) => Promise<boolean>
      worktreeRemove: (path: string, sourceRoot: string) => Promise<{ ok: boolean; error?: string }>
      worktreeDiff: (path: string, base?: string) => Promise<WorktreeDiff>
      branchDiff: (sourceRoot: string, branch: string, baseBranch: string) => Promise<WorktreeDiff>
      runCheck: (cwd: string, command: string) => Promise<{ ok: boolean; code?: number; output: string }>
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
      /** Durable project store (~/.operator/projects.json), same crash-safe pattern. */
      saveProjects: (projects: unknown[]) => void
      loadProjects: () => Promise<unknown[]>
      /** GLOBAL per-role launch defaults (~/.operator/role-defaults.json) — an object keyed by
       *  role id, opaque to Rust exactly like projects.json. */
      saveRoleDefaults?: (defaults: unknown) => void
      loadRoleDefaults?: () => Promise<Record<string, unknown>>
      /** Copy projects.json to ~/.operator/backups/ before a migration rewrites rosters.
       *  Rejects rather than silently continuing — no backup, no write. */
      backupProjects?: (stamp: string) => Promise<string>
      /** The plan's session/weekly limits, read from `claude -p "/usage"` by the backend and
       *  cached there (5-min TTL). `force` skips the cache for an explicit refresh. Never
       *  rejects: an unreadable answer comes back with empty fields and a `note`. */
      planLimits?: (force?: boolean) => Promise<PlanLimits>
      /** `~/.operator` — the durable store's root.
       *
       *  Exists because `DashboardView` needed it and reached for `@tauri-apps/api/path`
       *  directly, which is the ONE place a view bypassed this seam. That import throws under
       *  any shell that is not Tauri (there is no `invoke` to answer it), and it silently
       *  disabled the saved-session prune's backup — "no backup, no prune". A path the backend
       *  already knows belongs on the seam, not in a view. */
      operatorHome: () => Promise<string>
      /** Lazily create + return ~/.operator/projects/<id>/ (moodboard/context asset dir). */
      projectAssetDir: (id: string) => Promise<string>
      /** Project-scoped moodboard: copy an image in (→ filename), list, load one, remove. */
      moodboardAdd: (id: string, dataB64: string, ext: string) => Promise<string>
      moodboardList: (id: string) => Promise<string[]>
      moodboardImage: (id: string, name: string) => Promise<string>
      moodboardRemove: (id: string, name: string) => Promise<void>
      /** Preview inspector window (Stage 3): open on the app URL with an injected inspector. */
      previewInspectOpen: (url: string, x: number, y: number, w: number, h: number) => Promise<void>
      previewInspectMove: (x: number, y: number, w: number, h: number) => void
      previewInspectClose: () => void
      /** Inspector picked an element — payload is a JSON string (selector/component/source/…). */
      onPreviewPick: (callback: (data: string) => void) => () => void
      /** Auto-update against the public releases feed. */
      getVersion: () => Promise<string>
      checkUpdate: () => Promise<{ version: string } | null>
      installUpdate: () => Promise<void>
    }
  }
}
