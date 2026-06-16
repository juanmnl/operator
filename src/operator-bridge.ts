// Implements the `window.operator` API (defined in src/renderer/env.d.ts) over
// Tauri invoke()/events, so the Operator React UI runs unchanged.

import { invoke } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

type Unsub = () => void

// The pending update found by checkUpdate(), installed by installUpdate().
let pendingUpdate: Update | null = null

function buildArgs(o: Record<string, unknown> = {}, sessionId?: string): string[] {
  const args: string[] = []
  // Resume keeps the prior session id; a new session is pinned to a known uuid
  // so the backend can read exactly that transcript file.
  if (o.resumeSessionId) args.push('--resume', String(o.resumeSessionId))
  else if (sessionId) args.push('--session-id', sessionId)
  if (o.permissionMode && o.permissionMode !== 'default') {
    if (o.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions')
    else args.push('--permission-mode', String(o.permissionMode))
  }
  if (o.model) args.push('--model', String(o.model))
  if (o.allowedTools) args.push('--allowedTools', ...String(o.allowedTools).split(/\s+/).filter(Boolean))
  if (o.initialPrompt && String(o.initialPrompt).trim()) args.push(String(o.initialPrompt).trim())
  return args
}

const decoders = new Map<string, TextDecoder>()

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
      const id = await invoke<string>('terminal_spawn', {
        cwd: target,
        args: buildArgs(launchOptions, sessionId),
        sessionId,
        permissionMode: (launchOptions?.permissionMode as string) ?? null,
      })
      return { terminalId: id, cwd: target }
    },
    terminalWrite: (id: string, data: string) => { void invoke('terminal_write', { id, data }) },
    terminalResize: (id: string, cols: number, rows: number) => { void invoke('terminal_resize', { id, cols, rows }) },
    terminalKill: (id: string) => invoke('terminal_kill', { id }),
    terminalList: async () => {
      const list = await invoke<{ id: string; cwd: string; dev_port?: number }[]>('terminal_list')
      return list.map((t) => ({ id: t.id, pid: 0, cwd: t.cwd, command: 'claude', alive: true, devPort: t.dev_port }))
    },
    // The dev-server port registry: terminal id → port Operator reserved for it.
    getDevPorts: () => invoke<Record<string, number>>('get_dev_ports'),
    onTerminalData: (cb: (id: string, data: string) => void): Unsub => {
      const p = listen<{ id: string; data: string }>('terminal:data', (e) => {
        let d = decoders.get(e.payload.id)
        if (!d) { d = new TextDecoder(); decoders.set(e.payload.id, d) }
        // Backend ships base64 (see TerminalDataPayload). Native atob → bytes →
        // streaming UTF-8 decode (stream:true stitches multibyte chars split
        // across reads, same as before).
        const bin = atob(e.payload.data)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        cb(e.payload.id, d.decode(bytes, { stream: true }))
      })
      return () => { void p.then((f) => f()) }
    },
    onTerminalExit: (cb: (id: string, code: number, signal: number) => void): Unsub => {
      const p = listen<string>('terminal:exit', (e) => { decoders.delete(e.payload); cb(e.payload, 0, 0) })
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

    // Open a URL in the system browser (clickable terminal links).
    openExternal: (url: string) => { void openUrl(url) },
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
