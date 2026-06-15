// Implements the `window.operator` API (defined in src/renderer/env.d.ts) over
// Tauri invoke()/events, so the existing Operator React UI runs unchanged.
//
// Phase 1 status: terminal sessions are fully wired. The hook server is live but
// auto-approves for now (the permission/session/rules pipeline — server.ts,
// tool-summary.ts, rules.ts, sessions.ts — is the next port). Everything else
// returns safe empties so the UI renders without crashing.

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'

type Unsub = () => void

function buildArgs(o: Record<string, unknown> = {}): string[] {
  const args: string[] = []
  if (o.resumeSessionId) args.push('--resume', String(o.resumeSessionId))
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
      const id = await invoke<string>('terminal_spawn', { cwd: target, args: buildArgs(launchOptions) })
      return { terminalId: id, cwd: target }
    },
    terminalWrite: (id: string, data: string) => { void invoke('terminal_write', { id, data }) },
    terminalResize: (id: string, cols: number, rows: number) => { void invoke('terminal_resize', { id, cols, rows }) },
    terminalKill: (id: string) => invoke('terminal_kill', { id }),
    terminalList: async () => {
      const list = await invoke<{ id: string; cwd: string }[]>('terminal_list')
      return list.map((t) => ({ id: t.id, pid: 0, cwd: t.cwd, command: 'claude', alive: true }))
    },
    onTerminalData: (cb: (id: string, data: string) => void): Unsub => {
      const p = listen<{ id: string; data: number[] }>('terminal:data', (e) => {
        let d = decoders.get(e.payload.id)
        if (!d) { d = new TextDecoder(); decoders.set(e.payload.id, d) }
        cb(e.payload.id, d.decode(new Uint8Array(e.payload.data), { stream: true }))
      })
      return () => { void p.then((f) => f()) }
    },
    onTerminalExit: (cb: (id: string, code: number, signal: number) => void): Unsub => {
      const p = listen<string>('terminal:exit', (e) => { decoders.delete(e.payload); cb(e.payload, 0, 0) })
      return () => { void p.then((f) => f()) }
    },

    // --- permission flow + sessions (real) ---
    onNewRequest: (cb: (req: unknown) => void): Unsub => {
      const p = listen('hook:new-request', (e) => cb(e.payload))
      return () => { void p.then((f) => f()) }
    },
    onSessionUpdate: (cb: (sessions: unknown) => void): Unsub => {
      const p = listen('session:update', (e) => cb(e.payload))
      return () => { void p.then((f) => f()) }
    },
    onFocusSession: (): Unsub => () => {},
    respond: (id: string, value: string) => invoke('respond', { id, approve: value !== 'deny' && value !== 'n' }).then(() => true),
    getQueue: () => invoke('get_queue'),
    getSessions: () => invoke('get_sessions'),

    // --- misc ---
    pickFolder: async () => {
      const picked = await open({ directory: true })
      return !picked || Array.isArray(picked) ? null : picked
    },
    getHookPath: async () => '', // hooks-config not ported yet
    setActiveSession: () => {},
    showMainWindow: () => {},
    prefsUpdate: () => {},

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

    // --- rules engine (real) ---
    rulesList: () => invoke('rules_list_cmd'),
    rulesAdd: (rule: { tool: string; pattern?: string; scope?: string; action: string }) =>
      invoke('rules_add_cmd', { tool: rule.tool, pattern: rule.pattern ?? null, scope: rule.scope ?? null, action: rule.action }),
    rulesRemove: (id: string) => invoke('rules_remove_cmd', { id }).then(() => undefined),

    // --- agents, usage, folder-prefs (real) ---
    agentsList: (projectPath?: string) => invoke('agents_list', { projectPath: projectPath ?? null }),
    agentSave: (def: unknown, originalPath?: string) => invoke('agent_save', { def, originalPath: originalPath ?? null }),
    agentDelete: (path: string) => invoke('agent_delete', { path }),
    getUsageStats: (days?: number) => invoke('get_usage_stats', { days: days ?? null }),
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
