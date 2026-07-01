// Implements the `window.operator` API (defined in src/renderer/env.d.ts) over
// Tauri invoke()/events, so the Operator React UI runs unchanged.
// (touch to force a clean full reload)

import { invoke } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalSize } from '@tauri-apps/api/dpi'
import { open } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch, exit } from '@tauri-apps/plugin-process'
import { buildArgs } from './renderer/lib/launch-args'
import { base64ToBytes } from './renderer/lib/base64'
import { isLightBackground } from './renderer/lib/terminal'
import { createWriteQueue, type WriteQueue } from './renderer/lib/write-queue'
import type { GridUpdate } from './shared/types'

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
      // Tell Claude the terminal's light/dark scheme (COLORFGBG fallback). The terminal
      // is ghostty (a full VT engine) so it answers Claude's OSC colour query too.
      const readVar = (name: string) => {
        try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() } catch { return '' }
      }
      const termBg = readVar('--bg-terminal') || '#0b0d10'
      const colorScheme = isLightBackground(termBg) ? 'light' : 'dark'
      // FORCE classic (tui:default). Ghostty is a complete terminal with native
      // scrollback, and the wheel only scrolls in classic — in fullscreen/alt-screen
      // ghostty's handleWheel forwards the wheel as ARROW KEYS (Claude reads those as
      // input-history nav, not scroll), and there's no scrollback to scroll anyway.
      // So classic is required for wheel-scroll; the Fullscreen pref is incompatible here.
      const id = await invoke<string>('terminal_spawn', {
        cwd: target,
        args: buildArgs(launchOptions, sessionId),
        sessionId,
        permissionMode: (launchOptions?.permissionMode as string) ?? null,
        tuiMode: 'default',
        colorScheme,
      })
      return { terminalId: id, cwd: target }
    },
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
      const list = await invoke<{ id: string; cwd: string; dev_port?: number }[]>('terminal_list')
      return list.map((t) => ({ id: t.id, pid: 0, cwd: t.cwd, command: 'claude', alive: true, devPort: t.dev_port }))
    },
    // The dev-server port registry: terminal id → port Operator reserved for it.
    getDevPorts: () => invoke<Record<string, number>>('get_dev_ports'),
    // Base64 of a terminal's retained output tail — replayed when a pane re-attaches
    // to a pty that survived a renderer reload, so it shows scrollback, not a blank.
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
    getSessions: () => invoke('get_sessions'),

    // --- misc ---
    pickFolder: async () => {
      const picked = await open({ directory: true })
      return !picked || Array.isArray(picked) ? null : picked
    },
    setActiveSession: () => {},
    showMainWindow: () => {},
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
    // Quit the whole app (⌘Q). There's no native macOS app menu, so the OS doesn't
    // intercept ⌘Q — the renderer drives the quit explicitly via plugin-process.
    quitApp: () => { void exit(0) },
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
    worktreeCreate: async (cwd: string) => {
      try { return await invoke('worktree_create', { cwd }) } catch (e) { return { error: String(e) } }
    },
    worktreeStatus: (path: string) => invoke('worktree_status', { path }),
    worktreeRemove: async (path: string, sourceRoot: string) => {
      try { await invoke('worktree_remove', { path, sourceRoot }); return { ok: true } } catch (e) { return { ok: false, error: String(e) } }
    },
    worktreeDiff: (path: string) => invoke('worktree_diff', { path }),
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
