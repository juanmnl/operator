// Implements the `window.operator` API (defined in src/renderer/env.d.ts) over
// Tauri invoke()/events, so the Operator React UI runs unchanged.
// (touch to force a clean full reload)

import { invoke } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalSize } from '@tauri-apps/api/dpi'
import { homeDir, join } from '@tauri-apps/api/path'
import { open } from '@tauri-apps/plugin-dialog'
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch, exit } from '@tauri-apps/plugin-process'
import { buildArgs } from './renderer/lib/launch-args'
import { base64ToBytes } from './renderer/lib/base64'
import { isLightBackground } from './renderer/lib/terminal'
import { spawnTerminalMode } from './renderer/lib/terminal-options'
import { createWriteQueue, type WriteQueue } from './renderer/lib/write-queue'
import type { QuitLane } from './renderer/lib/quit-guard'
import type { GridUpdate, NarrationEntry, ProjectReply } from './shared/types'

type Unsub = () => void

// The pending update found by checkUpdate(), installed by installUpdate().
let pendingUpdate: Update | null = null

const decoders = new Map<string, TextDecoder>()

// One ordered write queue per terminal id. terminalWrite chains its invokes
// through here so the backend pty mutex sees bytes in enqueue order (a plain
// fire-and-forget `void invoke` could reorder under fast input). Created lazily
// on first write, torn down on terminal:exit.
const writeQueues = new Map<string, WriteQueue>()

export function installBridge(): void {
  // Route external links to the system browser. The ghostty terminal activates a
  // clicked URL / OSC-8 link via `window.open(url, '_blank')` (on Cmd/Ctrl+click),
  // but in a Tauri webview a raw window.open to an http(s) URL never reaches the
  // browser — so terminal links looked dead. Intercept http(s) targets and hand them
  // to the opener plugin; anything else falls through to the original.
  const origWindowOpen = window.open.bind(window)
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    const href = url == null ? '' : typeof url === 'string' ? url : url.toString()
    if (/^https?:\/\//i.test(href)) { void openUrl(href); return null }
    return origWindowOpen(url as string, target, features)
  }) as typeof window.open

  const bridge = {
    // --- terminals (real) ---
    terminalSpawn: async (cwd?: string, launchOptions?: Record<string, unknown>) => {
      let target = cwd
      if (!target) {
        const picked = await open({ directory: true })
        if (!picked || Array.isArray(picked)) return null
        target = picked
      }
      const resumeId = launchOptions?.resumeSessionId
      const sessionId = resumeId ? String(resumeId) : crypto.randomUUID()
      // The grid renderer (our own terminal) parses alt-screen correctly, so it can
      // host Claude Code's FULLSCREEN TUI — a fixed full-height viewport with the
      // input pinned to the bottom — which the DOM xterm corrupts. So force fullscreen
      // when grid is on; otherwise honour the user's tui pref (classic by default).
      // Tell Claude the terminal's light/dark scheme via COLORFGBG (a fallback for terminals
      // that don't answer Claude's OSC background query).
      const readVar = (name: string) => {
        try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() } catch { return '' }
      }
      const termBg = readVar('--bg-terminal') || '#0b0d10'
      const termFg = readVar('--fg') || '#e6e6e6'
      const colorScheme = isLightBackground(termBg) ? 'light' : 'dark'
      // THE FLAG THE COMMENT ABOVE HAS BEEN DESCRIBING SINCE 2026-06-30, now actually sent.
      // `terminal_spawn` takes `grid: Option<bool>` and only stands the alacritty core up when it
      // is true; nothing ever passed it, so it was always `None` and the grid was never created.
      // The intent was written and the wire was not.
      //
      // `term_bg`/`term_fg` ride along for the same reason: the core is created at spawn
      // specifically so it can answer Claude's OSC background query — which arrives in
      // milliseconds, long before the pane mounts — and it needs the theme's colours to answer
      // with. They were never passed either, so the core would have replied with its built-in
      // near-black whatever palette was on screen.
      const { grid, tuiMode } = spawnTerminalMode()
      // Classic (tui:default) is the DEFAULT because xterm has native scrollback and our
      // custom wheel handler scrolls it — in fullscreen/alt-screen there's no scrollback to
      // scroll and the wheel is forwarded as arrow keys, so wheel-scroll effectively stops
      // working. That cost is why classic stays the default.
      //
      // But classic is also what produces the overprint garble: Claude draws each word at an
      // absolute column (ESC[<n>G) on rows reached by RELATIVE moves and almost never clears a
      // line, so ONE row of cursor drift leaves the previous row's glyphs showing through the
      // gaps between words. Alt-screen repaints whole frames and structurally can't drift. So
      // the pref is now honoured rather than hardcoded: it's an opt-in escape hatch for anyone
      // hitting the garble, trading wheel-scroll for a stable picture.
      const id = await invoke<string>('terminal_spawn', {
        cwd: target,
        args: buildArgs(launchOptions, sessionId),
        sessionId,
        permissionMode: (launchOptions?.permissionMode as string) ?? null,
        // FULLSCREEN IS FORCED IN GRID MODE, not merely defaulted: the grid parses alt-screen
        // correctly and that is the entire reason to run it, whereas classic is the mode whose
        // absolute-column redraws produce the overprint this path exists to escape. Outside grid
        // mode the user's pref is honoured exactly as before.
        tuiMode,
        colorScheme,
        grid,
        termBg,
        termFg,
        orchestrationNote: (launchOptions?.orchestrationNote as string) ?? null,
        // Stamped onto any reply this session posts, so it lands in the right project's
        // channel. The tailer can't derive it — project ids are our canonical-repo-root
        // scheme (lib/resolve-project) — so it rides along at spawn.
        projectId: (launchOptions?.projectId as string) ?? null,
      })
      // `grid` goes back with the id: the caller has to mount the matching pane, and reading the
      // pref again over there would be a second read that a mid-flight change could answer
      // differently from the one that actually spawned this pty.
      return { terminalId: id, cwd: target, grid }
    },
    // Launch a deferred session's Claude process once its pane has fitted and resized the
    // pty to the real grid width (see terminal_spawn's DEFERRED LAUNCH note). Idempotent.
    terminalStart: (id: string, cols: number, rows: number) => { void invoke('terminal_start', { id, cols, rows }) },
    // Spawn a plain interactive shell in `cwd` — the toolbar's scratch terminal.
    // Returns a terminal id usable with the normal terminal* methods + onTerminalData.
    shellSpawn: (cwd: string) => invoke<string>('shell_spawn', { cwd }),
    terminalWrite: (id: string, data: string) => {
      let q = writeQueues.get(id)
      if (!q) {
        q = createWriteQueue((d) => invoke('terminal_write', { id, data: d }).then(() => {}))
        writeQueues.set(id, q)
      }
      q.write(data)
    },
    terminalResize: (id: string, cols: number, rows: number) => { void invoke('terminal_resize', { id, cols, rows }) },
    terminalKill: (id: string) => invoke('terminal_kill', { id }),
    terminalList: async () => {
      const list = await invoke<{ id: string; cwd: string; dev_port?: number; alive?: boolean }[]>('terminal_list')
      // `alive` is the backend's `try_wait` on the real child. It used to be hardcoded `true`
      // here, which made every consumer read "a pty entry exists" as "the agent is running".
      // Defaulted to true only for a backend too old to send the field — absence of evidence
      // must not read as death.
      return list.map((t) => ({ id: t.id, pid: 0, cwd: t.cwd, command: 'claude', alive: t.alive ?? true, devPort: t.dev_port }))
    },
    // The dev-server port registry: terminal id → port Operator reserved for it.
    getDevPorts: () => invoke<Record<string, number>>('get_dev_ports'),
    // Ports this session is actually serving on: the port we reserved for it plus the
    // ones sniffed from its own output, filtered to those answering a loopback connect.
    // Attribution comes from that candidate set, so a sibling lane's server can never be
    // mistaken for this one's — and nothing inspects another process (see note below).
    // The Rust command still answers with a bare `number[]` and has no attribution to give — it
    // is the backend this bug was found in. Everything it reports is marked `reserved`, the
    // middle confidence: calling it `sniffed` would claim proof this build cannot produce, and
    // `foreign` would blank the preview on the shell that still ships it.
    sessionPorts: async (id: string) => {
      const ports = await invoke<number[]>('session_ports', { id })
      return (ports ?? []).map((port) => ({ port, attributed: 'reserved' as const }))
    },
    // Hand the backend a dev-server port sniffed from this session's terminal output.
    // This is what replaced the per-pid `lsof` walk, which fired a macOS TCC prompt
    // ("would like to access data from other apps") once per inspected process.
    noteSessionPort: (id: string, port: number) => { void invoke('note_session_port', { id, port }) },
    // Base64 of a terminal's retained output tail — replayed when a pane re-attaches
    // to a pty that survived a renderer reload, so it shows scrollback, not a blank.
    // snake_case → camelCase at the boundary, like every other command here.
    projectIdentity: async (path: string) => {
      const r = await invoke<Record<string, unknown>>('project_identity', { path })
      return {
        branch: r.branch as string | undefined,
        dirty: (r.dirty as number) ?? 0,
        lastCommit: r.last_commit as string | undefined,
        lastCommitAt: r.last_commit_at as string | undefined,
        hubNote: r.hub_note as string | undefined,
        readme: r.readme as string | undefined,
        claudeMd: r.claude_md as string | undefined,
        packageJson: r.package_json as string | undefined,
        missing: (r.missing as boolean) ?? false,
      }
    },
    terminalHistory: (id: string) => invoke<string>('terminal_history', { id }),
    onTerminalData: (cb: (id: string, data: string) => void): Unsub => {
      const p = listen<{ id: string; data: string }>('terminal:data', (e) => {
        let d = decoders.get(e.payload.id)
        if (!d) { d = new TextDecoder(); decoders.set(e.payload.id, d) }
        // Backend ships base64 (see TerminalDataPayload). atob → bytes → streaming
        // UTF-8 decode (stream:true stitches multibyte chars split across reads).
        cb(e.payload.id, d.decode(base64ToBytes(e.payload.data), { stream: true }))
      })
      return () => { void p.then((f) => f()) }
    },
    onTerminalExit: (cb: (id: string, code: number, signal: number) => void): Unsub => {
      const p = listen<string>('terminal:exit', (e) => { decoders.delete(e.payload); writeQueues.delete(e.payload); cb(e.payload, 0, 0) })
      return () => { void p.then((f) => f()) }
    },

    // --- the artifact plane (see src-tauri/src/artifacts.rs) ---
    // Lanes write here through Operator's own MCP server, from their own processes; these are the
    // READ side. Nothing pushes into a lane — phase 1 is lane→Operator only.
    artifactReports: (limit?: number) => invoke('artifacts_reports', { limit: limit ?? null }),
    artifactPendingStatus: () => invoke('artifacts_pending_status'),
    artifactAckStatus: (ids: number[]) => invoke('artifacts_ack_status', { ids }),

    // --- grid terminal (our own, non-native — see src-tauri/src/gridterm.rs) ---
    // Pty bytes are parsed into a grid by alacritty in Rust; gridterm:update carries
    // a themed cell snapshot the GridTerminalPane paints as DOM. attach starts the
    // stream for a terminal (and pushes a full frame); resize keeps pty + grid sized.
    gridtermAttach: (id: string, cols: number, rows: number) => { void invoke('gridterm_attach', { id, cols, rows }) },
    gridtermResize: (id: string, cols: number, rows: number) => { void invoke('gridterm_resize', { id, cols, rows }) },
    gridtermScroll: (id: string, delta: number) => { void invoke('gridterm_scroll', { id, delta }) },
    gridtermSetTheme: (id: string, bg: string, fg: string) => { void invoke('gridterm_set_theme', { id, bg, fg }) },
    gridtermDetach: (id: string) => { void invoke('gridterm_detach', { id }) },
    onGridUpdate: (cb: (u: GridUpdate) => void): Unsub => {
      const p = listen<GridUpdate>('gridterm:update', (e) => cb(e.payload))
      return () => { void p.then((f) => f()) }
    },

    // --- sessions (real) ---
    onSessionUpdate: (cb: (sessions: unknown) => void): Unsub => {
      const p = listen('session:update', (e) => cb(e.payload))
      return () => { void p.then((f) => f()) }
    },
    // Orchestrator dispatch: an agent emitted `OPERATOR-DISPATCH [role] task`; the tailer
    // parsed it and fires this so the frontend can route it to the target lane.
    onOrchestratorDispatch: (cb: (d: { id: string; sessionId: string; terminalId: string; role: string; task: string }) => void): Unsub => {
      const p = listen('operator:dispatch', (e) => cb(e.payload as { id: string; sessionId: string; terminalId: string; role: string; task: string }))
      return () => { void p.then((f) => f()) }
    },
    // The return path: a lane emitted `OPERATOR-REPLY [to] text`. Unlike a dispatch this
    // routes into no pty — the tailer has already persisted it (project-scoped) by the time
    // this fires, so the event is a live notification, not the delivery mechanism.
    onOrchestratorReply: (cb: (r: { id: string; sessionId: string; terminalId: string; projectId: string; to: string; text: string }) => void): Unsub => {
      const p = listen('operator:reply', (e) => cb(e.payload as { id: string; sessionId: string; terminalId: string; projectId: string; to: string; text: string }))
      return () => { void p.then((f) => f()) }
    },
    getSessions: () => invoke('get_sessions'),
    // Full durable chat history for a session (reading-panel answers) from the SQLite
    // store — the whole conversation, not just the bounded tail in session:update.
    chatHistory: (sessionId: string) => invoke<NarrationEntry[]>('chat_history', { id: sessionId }),
    // Every OPERATOR-REPLY posted to a project, oldest first. Read-only by design: replies are
    // written by the tailer alone (a lane posts one by emitting the sentinel into its own
    // transcript), so there is no write counterpart here.
    projectReplies: (projectId: string) => invoke<ProjectReply[]>('project_replies', { projectId }),
    // Load a cached dropped-image (from NarrationEntry.images) as a data: URL for <img>.
    imageDataUrl: (path: string) => invoke<string>('image_data_url', { path }),
    // Liveness ping for the backend stall watchdog: while the main thread runs, this
    // fires ~1/s; when it hangs, the pings stop and the backend recovers the webview.
    rendererHeartbeat: () => { void invoke('renderer_heartbeat') },

    // --- misc ---
    pickFolder: async () => {
      const picked = await open({ directory: true })
      return !picked || Array.isArray(picked) ? null : picked
    },
    // NOT IMPLEMENTED on the Tauri backend. The skills catalog is a directory walk that only
    // the Electron shell grew (`electron/src/main/skills.ts`), and the Tauri build has no
    // command behind it — so this answers with an EMPTY catalog carrying an explicit error
    // rather than throwing an unhandled invoke. The Skills page then says it could not read the
    // roots, which is true here, instead of rendering an empty list that claims there are none.
    skillsCatalog: async () => ({
      entries: [],
      errors: [{ label: 'skills', path: '', message: 'The Tauri build has no skills catalog.' }],
      installedPlugins: [],
    }),
    // NOT IMPLEMENTED on the Tauri backend — the reaper is an Electron-main module
    // (`electron/src/main/worktree-reap.ts`) and there is no Rust command behind it. An EMPTY
    // plan, so the Settings section says "nothing to show" rather than claiming zero worktrees
    // exist; the reap itself refuses outright rather than reporting a silent success.
    worktreeReapPlan: async () => ({ entries: [], auto: [], asks: [], totalBytes: 0, autoBytes: 0, sizesOmitted: true }),
    worktreeReap: async () => { throw new Error('The Tauri build has no worktree reaper.') },
    // NOT IMPLEMENTED on the Tauri backend. The code navigator's filesystem seam is an
    // Electron-main module (`electron/src/main/files.ts`) and there is no Rust command behind it.
    // These REJECT rather than answering emptily: an empty tree and an empty file are both
    // plausible-looking lies, and a viewer that shows "no files here" is worse than one that says
    // it cannot read them.
    fileTree: async () => { throw new Error('The Tauri build has no file browser.') },
    fileRead: async () => { throw new Error('The Tauri build has no file browser.') },
    fileWatch: async () => {},
    fileUnwatch: async () => {},
    setActiveSession: () => {},
    // Closes the splash and reveals the main window at its restored geometry. Was a no-op here
    // while `App.tsx` called `invoke('app_ready')` itself — the operation existed under two
    // names, one of which only worked under Tauri.
    showMainWindow: () => { void invoke('app_ready') },
    // Start an OS window drag for the current gesture. Called from a mousedown on
    // a titlebar/drag strip. We invoke startDragging() explicitly rather than rely
    // on the data-tauri-drag-region attribute, whose handler goes dead on macOS
    // after the first drag (the OS drag loop eats the mouseup) or after the strip
    // remounts on a view switch — the exact "drag once, then nothing" symptom.
    startWindowDrag: () => { void getCurrentWindow().startDragging() },
    // Double-click on the titlebar zooms the window — fill the screen, or restore
    // to the previous size — matching native macOS title-bar behavior. Needs the
    // `core:window:allow-toggle-maximize` capability (core:default is getters only).
    toggleWindowMaximize: () => { void getCurrentWindow().toggleMaximize() },
    // Fires on every OS window size change — manual edge-drag, titlebar-zoom/maximize,
    // display change. Used to suspend the terminal's per-fit during the churn and refit
    // once it settles: each fit reallocates the ghostty Canvas backing store, and doing
    // that repeatedly mid-zoom thrashes the WKWebView compositor into a hang.
    onWindowResize: (cb: () => void): Unsub => {
      const p = getCurrentWindow().onResized(() => cb())
      return () => { void p.then((f) => f()) }
    },
    // Quit the whole app. This lands on `RunEvent::ExitRequested`, so the backend's quit
    // guard sees it like any other path and may hold it open to ask (see src-tauri/quit.rs).
    quitApp: () => { void exit(0) },

    // --- quit guard ---
    // Rust owns the veto AND the lane count: the accident this guards left the webview
    // navigated away, which is exactly when a frontend-owned count is absent. The dialog is a
    // pure function of this payload, so it renders with no store read and no loading state.
    onQuitRequested: (cb: (req: { lanes: QuitLane[]; idle: number }) => void): Unsub => {
      const p = listen('quit:requested', (e) => cb(e.payload as { lanes: QuitLane[]; idle: number }))
      return () => { void p.then((f) => f()) }
    },
    // Ack on mount. Rust falls back to a native ask if this doesn't arrive in 400ms.
    quitDialogShown: () => { void invoke('quit_dialog_shown') },
    quitDecision: (quit: boolean) => { void invoke('quit_decision', { quit }) },
    // Mirror of the "Ask before quitting…" switch, which lives in localStorage with the app's
    // other prefs. Rust cannot read that, and must still be right when the renderer is gone.
    quitSetAsk: (ask: boolean) => { void invoke('quit_set_ask', { ask }) },
    // Grow/shrink the OS window width by `delta` CSS px (negative shrinks), so a
    // side panel can be APPENDED to the right of the window instead of stealing
    // width from the terminal. Clamped to a sane minimum. No-op if maximized.
    growWindowWidth: async (delta: number) => {
      const win = getCurrentWindow()
      try {
        if (await win.isMaximized()) return
        const sf = await win.scaleFactor()
        const inner = (await win.innerSize()).toLogical(sf)
        const width = Math.max(720, Math.round(inner.width + delta))
        await win.setSize(new LogicalSize(width, Math.round(inner.height)))
      } catch { /* window ops can race teardown */ }
    },

    // Open a URL in the system browser (clickable terminal links).
    openExternal: (url: string) => { void openUrl(url) },
    // Reveal a path in Finder (the gallery's per-project action). Rejects quietly if the
    // path is gone — the caller treats it as a no-op rather than surfacing an OS error.
    revealPath: (path: string) => revealItemInDir(path).catch(() => {}),
    // Swap the live macOS dock icon between the 'light' (cream) and 'dark'
    // variants. Only affects the running app — the renderer re-applies the saved
    // choice on launch (see App.tsx). No-op off macOS.
    setDockIcon: (variant: 'light' | 'dark') => { void invoke('set_dock_icon', { variant }) },
    // Persist a pasted image (base64) to a temp file; returns the path so the
    // prompt bar can pass the agent a path reference instead of raw bytes.
    savePastedImage: (dataB64: string, ext: string) => invoke<string>('save_pasted_image', { data: dataB64, ext }),
    // Files dropped anywhere on the window — Tauri gives real paths (the webview
    // suppresses HTML5 file drops). The renderer writes them to the active terminal.
    onFileDrop: (cb: (paths: string[]) => void): Unsub => {
      const p = getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === 'drop' && event.payload.paths.length) cb(event.payload.paths)
      })
      return () => { void p.then((f) => f()) }
    },

    // --- git worktrees (real) ---
    inspectRepo: (cwd: string) => invoke('inspect_repo', { cwd }),
    // `branch` reattaches a SUSPENDED lane to the branch it left behind, instead of forking a
    // new one — the resume half of task-scoped lanes. Omitted for every ordinary launch.
    // `laneId` only labels the creation-provenance record the backend writes (see
    // worktree::Provenance) — the reaper may only remove what we can prove we made.
    worktreeCreate: async (cwd: string, branch?: string, laneId?: string) => {
      try { return await invoke('worktree_create', { cwd, branch: branch ?? null, laneId: laneId ?? null }) } catch (e) { return { error: String(e) } }
    },
    worktreeStatus: (path: string) => invoke('worktree_status', { path }),
    pathExists: (path: string) => invoke<boolean>('path_exists', { path }),
    worktreeRemove: async (path: string, sourceRoot: string) => {
      try { await invoke('worktree_remove', { path, sourceRoot }); return { ok: true } } catch (e) { return { ok: false, error: String(e) } }
    },
    worktreeDiff: (path: string, base?: string) => invoke('worktree_diff', { path, base }),
    // Diff a surviving branch vs its base from the source repo — the durable diff for a
    // done task after its worktree dir is gone (close removes the dir, keeps the branch).
    branchDiff: (sourceRoot: string, branch: string, baseBranch: string) =>
      invoke('branch_diff', { sourceRoot, branch, baseBranch }),
    // Verification gate: run the project's check command in a lane's dir (10-min cap).
    runCheck: (cwd: string, command: string) => invoke('run_check', { cwd, command }),
    worktreeCommit: async (path: string, message: string) => {
      try { const sha = await invoke<string>('worktree_commit', { path, message }); return { ok: true, sha } } catch (e) { return { ok: false, error: String(e) } }
    },
    worktreeMerge: (worktreePath: string, sourceRoot: string, branch: string, baseBranch: string) =>
      invoke('worktree_merge', { worktreePath, sourceRoot, branch, baseBranch }),
    worktreeDiscard: async (worktreePath: string, sourceRoot: string, branch: string) => {
      try { await invoke('worktree_discard', { worktreePath, sourceRoot, branch }); return { ok: true } } catch (e) { return { ok: false, error: String(e) } }
    },

    // --- agents, usage, folder-prefs (real) ---
    agentsList: (projectPath?: string) => invoke('agents_list', { projectPath: projectPath ?? null }),
    agentSave: (def: unknown, originalPath?: string) => invoke('agent_save', { def, originalPath: originalPath ?? null }),
    agentDelete: (path: string) => invoke('agent_delete', { path }),
    getUsageStats: (days?: number) => invoke('get_usage_stats', { days: days ?? null }),
    getUsageInsights: (days?: number) => invoke('get_usage_insights', { days: days ?? null }),
    saveSessions: (sessions: unknown[]) => { void invoke('save_sessions', { sessions }) },
    loadSessions: () => invoke('load_sessions') as Promise<unknown[]>,
    saveProjects: (projects: unknown[]) => { void invoke('save_projects', { projects }) },
    loadProjects: () => invoke('load_projects') as Promise<unknown[]>,
    saveRoleDefaults: (defaults: unknown) => { void invoke('save_role_defaults', { defaults }) },
    loadRoleDefaults: () => invoke('load_role_defaults') as Promise<Record<string, unknown>>,
    backupProjects: (stamp: string) => invoke('backup_projects', { stamp }) as Promise<string>,
    planLimits: (force?: boolean) => invoke('plan_limits', { force: force ?? false }) as Promise<unknown>,
    // Resolved in the bridge rather than through a new Rust command: `~/.operator` is a
    // derivation of $HOME, which the path plugin already answers, and adding a backend command
    // for it would be a second source of truth for the same directory.
    operatorHome: async () => join(await homeDir(), '.operator'),
    projectAssetDir: (id: string) => invoke('project_asset_dir', { id }) as Promise<string>,
    // Project-scoped moodboard (inspiration images).
    moodboardAdd: (id: string, dataB64: string, ext: string) => invoke('moodboard_add', { id, data: dataB64, ext }) as Promise<string>,
    moodboardList: (id: string) => invoke('moodboard_list', { id }) as Promise<string[]>,
    moodboardImage: (id: string, name: string) => invoke('moodboard_image', { id, name }) as Promise<string>,
    moodboardRemove: (id: string, name: string) => invoke('moodboard_remove', { id, name }) as Promise<void>,
    // Preview inspector (Stage 3 spike): a webview on the app's URL with an injected inspector.
    previewInspectOpen: (url: string, x: number, y: number, w: number, h: number) => invoke('preview_inspect_open', { url, x, y, w, h }) as Promise<void>,
    previewInspectMove: (x: number, y: number, w: number, h: number) => { void invoke('preview_inspect_move', { x, y, w, h }) },
    previewInspectClose: () => { void invoke('preview_inspect_close') },
    onPreviewPick: (cb: (data: string) => void): Unsub => {
      const p = listen('preview:pick', (e) => cb(e.payload as string))
      return () => { void p.then((f) => f()) }
    },

    // Auto-update: check the public releases feed; install + relaunch on demand.
    getVersion: () => getVersion(),
    checkUpdate: async () => {
      try {
        pendingUpdate = await check()
        return pendingUpdate ? { version: pendingUpdate.version } : null
      } catch { return null }
    },
    installUpdate: async () => {
      if (!pendingUpdate) return
      await pendingUpdate.downloadAndInstall()
      await relaunch()
    },
    folderPrefsLoad: (projectPath: string) => invoke('folder_prefs_load', { projectPath }),
    folderPrefsLoadGlobal: () => invoke('folder_prefs_load_global'),
    folderPrefsSaveSettings: (filePath: string, settings: unknown) => invoke('folder_prefs_save_settings', { path: filePath, settings }).then(() => undefined),
    folderPrefsSaveMd: (filePath: string, content: string) => invoke('folder_prefs_save_md', { path: filePath, content }).then(() => undefined),
    folderPrefsCreateFile: (filePath: string, type: string) => invoke('folder_prefs_create_file', { path: filePath, kind: type }).then(() => undefined),
    getMcpServers: (projectPath: string) => invoke('get_mcp_servers', { projectPath }),
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).operator = bridge
}
