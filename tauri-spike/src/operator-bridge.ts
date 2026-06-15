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

    // --- not yet ported: safe empties so the UI renders ---
    inspectRepo: async () => ({ isRepo: false }),
    worktreeCreate: async () => ({ error: 'worktrees not ported yet' }),
    worktreeStatus: async () => ({ changes: 0, valid: false }),
    worktreeRemove: async () => ({ ok: false, error: 'not ported' }),
    worktreeDiff: async () => ({ files: [], diff: '' }),
    worktreeCommit: async () => ({ ok: false, error: 'not ported' }),
    worktreeMerge: async () => ({ ok: false }),
    worktreeDiscard: async () => ({ ok: false, error: 'not ported' }),
    rulesList: () => invoke('rules_list_cmd'),
    rulesAdd: (rule: { tool: string; pattern?: string; scope?: string; action: string }) =>
      invoke('rules_add_cmd', { tool: rule.tool, pattern: rule.pattern ?? null, scope: rule.scope ?? null, action: rule.action }),
    rulesRemove: (id: string) => invoke('rules_remove_cmd', { id }).then(() => undefined),
    agentsList: async () => [],
    agentSave: async () => ({ ok: false, error: 'not ported' }),
    agentDelete: async () => ({ ok: false, error: 'not ported' }),
    getUsageStats: async () => ({ totalCost: 0, totalTokens: 0, byModel: [], byProject: [], byDay: [], generatedAt: new Date().toISOString() }),
    folderPrefsLoad: async (projectPath: string) => ({ projectPath, projectName: projectPath.split('/').pop() || projectPath, settingsFiles: [{ path: '', label: 'Global', scope: 'global', readOnly: false, exists: false, settings: {} }], mdFiles: [] }),
    folderPrefsLoadGlobal: async () => ({ projectPath: '', projectName: 'Global', settingsFiles: [], mdFiles: [] }),
    folderPrefsSaveSettings: async () => {},
    folderPrefsSaveMd: async () => {},
    folderPrefsCreateFile: async () => {},
    getMcpServers: async () => ({ servers: [] }),
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).operator = bridge
}
