import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { AgentSession, OperatorRequest } from '../../shared/types'
import { Sidebar } from '../components/sidebar/Sidebar'
import { TerminalPane } from '../components/terminal/TerminalPane'
import { InlinePermission } from '../components/terminal/InlinePermission'
import { SessionActivityView } from '../components/session/SessionActivityView'
import { FolderPreferencesView } from '../components/preferences/FolderPreferencesView'
import { SessionToolbar } from '../components/session/SessionToolbar'
import { SessionInfoBar } from '../components/session/SessionInfoBar'
import { NewSessionPanel, SessionConfig } from '../components/session/NewSessionPanel'
import { DiffPanel } from '../components/session/DiffPanel'
import { PromptBar } from '../components/session/PromptBar'
import { RulesView } from '../components/rules/RulesView'
import { AgentLibraryView } from '../components/agents/AgentLibraryView'
import { UsageView } from '../components/usage/UsageView'
import { PrefsView } from '../components/prefs/PrefsView'
import { CommandPalette, PaletteAction } from '../components/CommandPalette'
import { ActivityDashboard } from '../components/dashboard/ActivityDashboard'
import { Toasts, ToastMessage } from '../components/Toast'
import { themes, defaultTheme, applyTheme } from '../themes'
import type { OperatorTheme } from '../themes'
import { LogoMark } from '../components/LogoMark'

interface TerminalTab {
  id: string
  /** Stable key that survives restart, used to persist & restore this session. */
  key: string
  cwd: string
  model?: string
  effortLevel?: 'high' | 'normal' | 'low'
  permissionMode?: string
  worktreeBranch?: string
  worktreeBase?: string
  sourceCwd?: string
  /** Shared id across the N agents of one fan-out launch (undefined = solo). */
  fanGroup?: string
  /** 1-based position within the fan-out group, and the group size. */
  fanIndex?: number
  fanTotal?: number
}

/** A session's restorable config, persisted to localStorage across restarts. */
interface SavedSession {
  key: string
  cwd: string
  projectName: string
  customName?: string
  model?: string
  effortLevel?: 'high' | 'normal' | 'low'
  permissionMode?: string
  worktreeBranch?: string
  worktreeBase?: string
  sourceCwd?: string
  /** Latest Claude Code session id seen — enables "resume conversation". */
  claudeSessionId?: string
  lastActiveAt: string
}

export function DashboardView() {
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [terminals, setTerminals] = useState<TerminalTab[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null)
  // Latest active terminal, for the (single, mount-time) file-drop listener.
  const activeTerminalIdRef = useRef<string | null>(null)
  useEffect(() => { activeTerminalIdRef.current = activeTerminalId }, [activeTerminalId])
  const [pendingRequests, setPendingRequests] = useState<OperatorRequest[]>([])
  const [customNames, setCustomNames] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem('operator.customNames')
      return raw ? JSON.parse(raw) : {}
    } catch { return {} }
  })
  const [activeFolderPrefs, setActiveFolderPrefs] = useState<{ projectPath: string; projectName: string } | null>(null)
  const [globalPrefsActive, setGlobalPrefsActive] = useState(false)
  const [rulesViewActive, setRulesViewActive] = useState(false)
  const [agentsViewActive, setAgentsViewActive] = useState(false)
  const [usageViewActive, setUsageViewActive] = useState(false)
  const [prefsViewActive, setPrefsViewActive] = useState(false)
  const [reviewingTerminalId, setReviewingTerminalId] = useState<string | null>(null)
  const [activityViewingTerminalId, setActivityViewingTerminalId] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [toasts, setToasts] = useState<ToastMessage[]>([])

  const pushToast = useCallback((message: Omit<ToastMessage, 'id'>) => {
    setToasts((prev) => [...prev, { ...message, id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }])
  }, [])

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])
  const [pendingSession, setPendingSession] = useState<string | null>(null) // cwd awaiting launch
  const [currentTheme, setCurrentTheme] = useState<OperatorTheme>(() => {
    const saved = localStorage.getItem('operator.theme')
    return (saved && themes[saved]) || defaultTheme
  })
  const [hookPath, setHookPath] = useState<string | null>(null)
  const [showSetup, setShowSetup] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleRename = useCallback((sessionId: string, name: string) => {
    setCustomNames((prev) => {
      const next = { ...prev, [sessionId]: name }
      try { localStorage.setItem('operator.customNames', JSON.stringify(next)) } catch { /* quota */ }
      return next
    })
  }, [])

  useEffect(() => {
    window.operator.getSessions().then(setSessions)
    window.operator.getQueue().then(setPendingRequests)
    window.operator.getHookPath().then(setHookPath)

    const unsubSession = window.operator.onSessionUpdate(setSessions)
    const unsubRequest = window.operator.onNewRequest((request) => {
      setPendingRequests((prev) => [...prev, request])
    })

    // Poll sessions every 1s for responsive status updates
    const pollInterval = setInterval(() => {
      window.operator.getSessions().then(setSessions)
      window.operator.getQueue().then(setPendingRequests)
    }, 1000)
    const unsubExit = window.operator.onTerminalExit((id) => {
      setTerminals((prev) => prev.filter((t) => t.id !== id))
      setActiveTerminalId((current) => (current === id ? null : current))
      // Clear active session if it was the local placeholder for the dead terminal.
      // For hook-backed sessions, the next poll will reconcile status to 'ended' and clear via the effect below.
      setActiveSessionId((current) => (current === `local-${id}` ? null : current))
    })

    // Files dropped on the window → paste their paths into the active terminal,
    // so you can drop an image straight into the conversation.
    const unsubDrop = window.operator.onFileDrop?.((paths) => {
      const tid = activeTerminalIdRef.current
      if (!tid || !paths.length) return
      const text = paths.map((p) => (/\s/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p)).join(' ') + ' '
      window.operator.terminalWrite(tid, text)
    }) ?? (() => {})

    return () => { unsubSession(); unsubRequest(); unsubExit(); clearInterval(pollInterval); unsubDrop() }
  }, [])

  const handleNewSession = useCallback(async () => {
    const folder = await window.operator.pickFolder()
    if (folder) {
      setPendingSession(folder)
      setActiveSessionId(null)
      setActiveTerminalId(null)
      setActiveFolderPrefs(null)
      setGlobalPrefsActive(false)
      setRulesViewActive(false)
      setAgentsViewActive(false)
      setUsageViewActive(false)
      setPrefsViewActive(false)
    }
  }, [])

  const handleNewSessionInFolder = useCallback((cwd: string) => {
    setPendingSession(cwd)
    setActiveSessionId(null)
    setActiveTerminalId(null)
    setActiveFolderPrefs(null)
    setGlobalPrefsActive(false)
    setRulesViewActive(false)
    setAgentsViewActive(false)
    setUsageViewActive(false)
    setPrefsViewActive(false)
  }, [])

  const handleOpenGlobalPrefs = useCallback(() => {
    setGlobalPrefsActive(true)
    setRulesViewActive(false)
    setAgentsViewActive(false)
    setUsageViewActive(false)
    setPrefsViewActive(false)
    setActiveFolderPrefs(null)
    setActiveSessionId(null)
    setActiveTerminalId(null)
    setPendingSession(null)
  }, [])

  const handleOpenRules = useCallback(() => {
    setRulesViewActive(true)
    setPrefsViewActive(false)
    setAgentsViewActive(false)
    setUsageViewActive(false)
    setGlobalPrefsActive(false)
    setActiveFolderPrefs(null)
    setActiveSessionId(null)
    setActiveTerminalId(null)
    setPendingSession(null)
  }, [])

  const handleOpenAgents = useCallback(() => {
    setAgentsViewActive(true)
    setRulesViewActive(false)
    setPrefsViewActive(false)
    setUsageViewActive(false)
    setGlobalPrefsActive(false)
    setActiveFolderPrefs(null)
    setActiveSessionId(null)
    setActiveTerminalId(null)
    setPendingSession(null)
  }, [])

  const handleOpenUsage = useCallback(() => {
    setUsageViewActive(true)
    setAgentsViewActive(false)
    setRulesViewActive(false)
    setPrefsViewActive(false)
    setGlobalPrefsActive(false)
    setActiveFolderPrefs(null)
    setActiveSessionId(null)
    setActiveTerminalId(null)
    setPendingSession(null)
  }, [])

  const handleOpenPrefs = useCallback(() => {
    setPrefsViewActive(true)
    setRulesViewActive(false)
    setAgentsViewActive(false)
    setUsageViewActive(false)
    setGlobalPrefsActive(false)
    setActiveFolderPrefs(null)
    setActiveSessionId(null)
    setActiveTerminalId(null)
    setPendingSession(null)
  }, [])

  const rememberRecent = useCallback((cwd: string) => {
    try {
      const raw = localStorage.getItem('operator.recentProjects')
      const list: Array<{ path: string; name: string; lastUsedAt: string }> = raw ? JSON.parse(raw) : []
      const name = cwd.split('/').pop() || cwd
      const filtered = list.filter((p) => p.path !== cwd)
      filtered.unshift({ path: cwd, name, lastUsedAt: new Date().toISOString() })
      localStorage.setItem('operator.recentProjects', JSON.stringify(filtered.slice(0, 10)))
    } catch { /* quota */ }
  }, [])

  const [recentProjects, setRecentProjects] = useState<Array<{ path: string; name: string; lastUsedAt: string }>>(() => {
    try {
      const raw = localStorage.getItem('operator.recentProjects')
      return raw ? JSON.parse(raw) : []
    } catch { return [] }
  })

  // Sessions that were open in a previous run, restorable on this launch.
  // Seeded from localStorage for instant render, then reconciled against the
  // durable file store (~/.operator/sessions.json) once hydrated below.
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>(() => {
    try {
      const raw = localStorage.getItem('operator.savedSessions')
      return raw ? JSON.parse(raw) : []
    } catch { return [] }
  })
  // Block file-writes until the durable store has been read, so we never clobber
  // it with the (possibly staler) localStorage seed on launch.
  const [savedHydrated, setSavedHydrated] = useState(false)
  useEffect(() => {
    const p = window.operator.loadSessions?.()
    if (p) {
      p.then((list) => {
        if (Array.isArray(list) && list.length) setSavedSessions(list as SavedSession[])
        setSavedHydrated(true)
      }).catch(() => setSavedHydrated(true))
    } else {
      setSavedHydrated(true) // no file store (e.g. Electron) — localStorage only
    }
  }, [])

  const handleLaunchSession = useCallback(async (cwd: string, config: SessionConfig) => {
    // Write effort level to global settings (Claude Code reads it from there)
    const prefs = await window.operator.folderPrefsLoad(cwd)
    const globalFile = prefs.settingsFiles.find((f) => f.scope === 'global')
    if (globalFile) {
      await window.operator.folderPrefsSaveSettings(globalFile.path, { effortLevel: config.effortLevel })
    }

    // Fan-out: launch the same task on N agents, each in its own worktree.
    const count = Math.max(1, config.count || 1)
    const fanGroup = count > 1 ? crypto.randomUUID() : undefined

    for (let i = 0; i < count; i++) {
      // Each agent gets an isolated git worktree (forced on for fan-out).
      let spawnCwd = cwd
      let worktreeBranch: string | undefined
      let worktreeBase: string | undefined
      if (config.useWorktree) {
        const result = await window.operator.worktreeCreate(cwd)
        if ('error' in result) {
          console.warn('Worktree creation failed:', result.error)
        } else {
          spawnCwd = result.path
          worktreeBranch = result.branch
          worktreeBase = result.baseBranch
        }
      }

      const launchOptions: Record<string, unknown> = {}
      if (config.permissionMode !== 'default') launchOptions.permissionMode = config.permissionMode
      if (config.model) launchOptions.model = config.model
      if (config.allowedTools) launchOptions.allowedTools = config.allowedTools
      if (config.prompt) launchOptions.initialPrompt = config.prompt

      const result = await window.operator.terminalSpawn(spawnCwd, launchOptions)
      if (!result) continue

      const tab: TerminalTab = {
        id: result.terminalId,
        key: crypto.randomUUID(),
        cwd: result.cwd,
        model: config.model || undefined,
        effortLevel: config.effortLevel,
        permissionMode: config.permissionMode,
        worktreeBranch,
        worktreeBase,
        sourceCwd: worktreeBranch ? cwd : undefined,
        fanGroup,
        fanIndex: fanGroup ? i + 1 : undefined,
        fanTotal: fanGroup ? count : undefined,
      }
      setTerminals((prev) => [...prev, tab])
      // Focus the first agent; the rest run in the background.
      if (i === 0) {
        setActiveTerminalId(result.terminalId)
        setActiveSessionId(`local-${result.terminalId}`)
      }
    }

    rememberRecent(cwd)
    setRecentProjects((prev) => {
      const name = cwd.split('/').pop() || cwd
      const filtered = prev.filter((p) => p.path !== cwd)
      return [{ path: cwd, name, lastUsedAt: new Date().toISOString() }, ...filtered].slice(0, 10)
    })
    setPendingSession(null)
  }, [rememberRecent])

  // Re-open a previously saved session. `resume` continues the prior Claude
  // conversation (--resume); otherwise it starts the agent clean in the same
  // folder/worktree with the same config.
  const handleRestoreSession = useCallback(async (saved: SavedSession, resume: boolean) => {
    if (saved.effortLevel) {
      const fp = await window.operator.folderPrefsLoad(saved.cwd)
      const globalFile = fp.settingsFiles.find((f) => f.scope === 'global')
      if (globalFile) await window.operator.folderPrefsSaveSettings(globalFile.path, { effortLevel: saved.effortLevel })
    }

    const launchOptions: Record<string, unknown> = {}
    if (saved.permissionMode && saved.permissionMode !== 'default') launchOptions.permissionMode = saved.permissionMode
    if (saved.model) launchOptions.model = saved.model
    if (resume && saved.claudeSessionId) launchOptions.resumeSessionId = saved.claudeSessionId

    // Restore spawns directly into the saved cwd (the worktree path persists
    // across quits), so no new worktree is created.
    const result = await window.operator.terminalSpawn(saved.cwd, launchOptions)
    if (!result) return

    const tab: TerminalTab = {
      id: result.terminalId,
      key: saved.key,
      cwd: result.cwd,
      model: saved.model,
      effortLevel: saved.effortLevel,
      permissionMode: saved.permissionMode,
      worktreeBranch: saved.worktreeBranch,
      worktreeBase: saved.worktreeBase,
      sourceCwd: saved.sourceCwd,
    }
    setTerminals((prev) => [...prev, tab])
    setActiveTerminalId(result.terminalId)
    setActiveSessionId(`local-${result.terminalId}`)
    if (saved.customName) {
      setCustomNames((prev) => {
        const next = { ...prev, [`local-${result.terminalId}`]: saved.customName! }
        try { localStorage.setItem('operator.customNames', JSON.stringify(next)) } catch { /* quota */ }
        return next
      })
    }
    rememberRecent(saved.cwd)
    setPendingSession(null)
    setActiveFolderPrefs(null)
    setGlobalPrefsActive(false)
    setRulesViewActive(false)
    setAgentsViewActive(false)
    setUsageViewActive(false)
    setPrefsViewActive(false)
  }, [rememberRecent])

  const forgetSavedSession = useCallback((key: string) => {
    setSavedSessions((prev) => {
      const next = prev.filter((s) => s.key !== key)
      try { localStorage.setItem('operator.savedSessions', JSON.stringify(next)) } catch { /* quota */ }
      window.operator.saveSessions?.(next) // keep the durable store in sync
      return next
    })
  }, [])

  const handleCloseSession = useCallback(async (session: AgentSession) => {
    const terminalId = session.terminalId
    if (!terminalId) return
    const tab = terminals.find((t) => t.id === terminalId)
    // Kill the pty first so any in-flight git operations on the worktree die.
    await window.operator.terminalKill(terminalId)
    // If this was a worktree session, clean up the worktree directory.
    // Branch is intentionally left intact — user may want to merge or review later.
    if (tab?.worktreeBranch && tab?.sourceCwd) {
      const result = await window.operator.worktreeRemove(tab.cwd, tab.sourceCwd)
      if (!result.ok) console.warn('Worktree removal failed:', result.error)
    }
    // Drop the tab; the onTerminalExit handler also runs and will reconcile state.
    // Closing is intentional — forget the saved session so it won't offer to restore.
    if (tab) forgetSavedSession(tab.key)
    setTerminals((prev) => prev.filter((t) => t.id !== terminalId))
    setActiveTerminalId((current) => (current === terminalId ? null : current))
    setActiveSessionId((current) => {
      if (current === session.id) return null
      if (current === `local-${terminalId}`) return null
      return current
    })
    // Leave the session's settings view when its session is closed, so the main
    // area returns to the workspace instead of staying stuck in settings.
    setActiveFolderPrefs(null)
  }, [terminals, forgetSavedSession])

  const handleSelectSession = useCallback((session: AgentSession) => {
    const localTerminalIds = new Set(terminals.map((t) => t.id))
    setActiveSessionId(session.id)
    setActiveFolderPrefs(null)
    setGlobalPrefsActive(false)
    setRulesViewActive(false)
    setAgentsViewActive(false)
    setUsageViewActive(false)
    setPrefsViewActive(false)
    setPendingSession(null)
    if (session.terminalId && localTerminalIds.has(session.terminalId)) {
      setActiveTerminalId(session.terminalId)
    } else {
      setActiveTerminalId(null)
    }
  }, [terminals])

  const handleToggleTheme = useCallback(() => {
    const nextKey = currentTheme.isDark ? 'light' : 'mr-pink'
    const next = themes[nextKey]
    setCurrentTheme(next)
    applyTheme(next)
    localStorage.setItem('operator.theme', nextKey)
  }, [currentTheme])

  // Build effort level map from terminal tabs (keyed by terminalId)
  const effortLevels: Record<string, string> = {}
  // Fan-out membership map (keyed by terminalId) for the per-agent badge.
  const fanInfo: Record<string, { index: number; total: number }> = {}
  for (const t of terminals) {
    if (t.effortLevel) effortLevels[t.id] = t.effortLevel
    if (t.fanGroup && t.fanIndex && t.fanTotal) fanInfo[t.id] = { index: t.fanIndex, total: t.fanTotal }
  }

  const handleOpenFolderPrefs = useCallback((projectPath: string, projectName: string) => {
    setActiveFolderPrefs({ projectPath, projectName })
    setActiveSessionId(null)
    setActiveTerminalId(null)
    setPendingSession(null)
    setGlobalPrefsActive(false)
    setRulesViewActive(false)
    setAgentsViewActive(false)
    setUsageViewActive(false)
    setPrefsViewActive(false)
  }, [])

  const handleRespond = useCallback(async (id: string, value: string) => {
    await window.operator.respond(id, value)
    setPendingRequests((prev) => prev.filter((r) => r.id !== id))
  }, [])

  const handleRespondAndRemember = useCallback(async (request: OperatorRequest, action: 'approve' | 'deny') => {
    const toolName = request.toolName || request.action
    let pattern: string | undefined
    if (toolName === 'Bash') {
      const command = request.context.target || ''
      const firstWord = command.split(/\s+/)[0]
      pattern = firstWord ? `${firstWord} *` : undefined
    } else if (request.context.target) {
      pattern = request.context.target
    }
    // Scope the rule to the requesting session's project by default — "always
    // allow X" almost always means "in this project", not machine-wide. Falls
    // back to global if we don't know the working directory.
    const scope = request.context.workingDirectory || undefined
    await window.operator.rulesAdd({ tool: toolName, pattern, scope, action })
    await window.operator.respond(request.id, action)
    setPendingRequests((prev) => prev.filter((r) => r.id !== request.id))
    const scopeLabel = scope ? scope.split('/').filter(Boolean).pop() || scope : 'all projects'
    pushToast({
      text: `Rule added — ${action === 'approve' ? 'always allow' : 'always deny'} ${toolName}`,
      detail: `${pattern ? `pattern: ${pattern}` : 'any input'} · ${scopeLabel}`,
      kind: action === 'approve' ? 'success' : 'error',
    })
  }, [pushToast])

  // Sidebar entries are only the sessions Operator launched in-app. External
  // Claude Code processes are intentionally not tracked — the hook no-ops for
  // them (no OPERATOR_TERMINAL_ID), so nothing arrives without a managed pty.
  const localTerminalIds = new Set(terminals.map((t) => t.id))

  const localSessions: AgentSession[] = terminals.map((t) => {
    const hookSession = sessions.find((s) => s.terminalId === t.id)
    if (hookSession) return hookSession
    return {
      id: `local-${t.id}`,
      agentId: 'claude-code',
      workingDirectory: t.cwd,
      projectName: t.cwd.split('/').pop() || t.cwd,
      status: 'active' as const,
      phase: 'idle' as const,
      entries: [],
      activity: [],
      activeSubagents: 0,
      lastToolName: null,
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      terminalId: t.id,
    }
  })

  const allSidebarSessions = localSessions

  // ⌘1..9 maps to terminals[0..8] — map each session id to its 1-based index.
  const shortcutIndices = useMemo(() => {
    const map: Record<string, number> = {}
    terminals.slice(0, 9).forEach((t, i) => {
      const session = localSessions.find((s) => s.terminalId === t.id)
      if (session) map[session.id] = i + 1
    })
    return map
  }, [terminals, localSessions])

  const sidebarStats = useMemo(() => ({
    activeSessions: allSidebarSessions.filter((s) => s.status === 'active').length,
    pendingRequests: pendingRequests.length,
  }), [allSidebarSessions, pendingRequests])

  // Notify main process of active session for widget visibility
  useEffect(() => {
    window.operator.setActiveSession(activeSessionId)
  }, [activeSessionId])

  // Keep activeSessionId in sync — if a local-* placeholder gets a real hook session, update
  useEffect(() => {
    if (activeSessionId?.startsWith('local-')) {
      const tid = activeSessionId.replace('local-', '')
      const hookSession = sessions.find((s) => s.terminalId === tid)
      if (hookSession) {
        setActiveSessionId(hookSession.id)
      }
    }
  }, [sessions, activeSessionId])

  // Migrate a custom name from the local-* placeholder to the real Claude
  // session id once it arrives, so renames survive the id handoff.
  useEffect(() => {
    setCustomNames((prev) => {
      let changed = false
      const next = { ...prev }
      for (const t of terminals) {
        const localKey = `local-${t.id}`
        if (next[localKey] === undefined) continue
        const hook = sessions.find((s) => s.terminalId === t.id)
        if (hook && next[hook.id] === undefined) {
          next[hook.id] = next[localKey]
          delete next[localKey]
          changed = true
        }
      }
      if (!changed) return prev
      try { localStorage.setItem('operator.customNames', JSON.stringify(next)) } catch { /* quota */ }
      return next
    })
  }, [sessions, terminals])

  // Persist open sessions (merged over previously-saved ones) so they survive a
  // restart. Enriched with the live Claude session id to enable resume.
  const savedSerRef = useRef<string>('')
  useEffect(() => {
    if (!savedHydrated) return // wait for the durable store so we don't overwrite it
    setSavedSessions((prev) => {
      const liveByKey = new Map<string, SavedSession>()
      for (const t of terminals) {
        const hook = sessions.find((s) => s.terminalId === t.id)
        const nameKey = hook?.id ?? `local-${t.id}`
        liveByKey.set(t.key, {
          key: t.key,
          cwd: t.cwd,
          projectName: t.cwd.split('/').pop() || t.cwd,
          customName: customNames[nameKey] || customNames[`local-${t.id}`],
          model: t.model,
          effortLevel: t.effortLevel,
          permissionMode: t.permissionMode,
          worktreeBranch: t.worktreeBranch,
          worktreeBase: t.worktreeBase,
          sourceCwd: t.sourceCwd,
          claudeSessionId: hook?.id,
          lastActiveAt: hook?.lastActivityAt || new Date().toISOString(),
        })
      }
      const merged = [...prev.filter((s) => !liveByKey.has(s.key)), ...liveByKey.values()]
      // Compare ignoring the volatile timestamp to avoid churning localStorage.
      const ser = JSON.stringify(merged.map(({ lastActiveAt: _omit, ...rest }) => rest))
      if (ser === savedSerRef.current) return prev
      savedSerRef.current = ser
      try { localStorage.setItem('operator.savedSessions', JSON.stringify(merged)) } catch { /* quota */ }
      window.operator.saveSessions?.(merged) // durable, crash-safe file write
      return merged
    })
  }, [terminals, sessions, customNames, savedHydrated])

  // Reset "Copied!" label 2s after a copy, with cleanup on unmount / re-copy
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(t)
  }, [copied])

  // "Ready for review" detection — watch worktree sessions transitioning to idle
  // with uncommitted changes. Show one in-app toast per (terminalId, idle-arrival).
  const lastPhaseRef = useRef<Record<string, string>>({})
  const notifiedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const tab of terminals) {
      if (!tab.worktreeBranch) continue
      const session = sessions.find((s) => s.terminalId === tab.id)
      if (!session) continue
      const prevPhase = lastPhaseRef.current[tab.id]
      lastPhaseRef.current[tab.id] = session.phase
      if (prevPhase === 'running' && session.phase === 'idle') {
        // Verify changes exist before notifying; key by terminal+timestamp so each idle arrival fires once.
        const key = `${tab.id}-${session.lastActivityAt}`
        if (notifiedRef.current.has(key)) continue
        window.operator.worktreeStatus(tab.cwd).then((status) => {
          if (!status.valid || status.changes === 0) return
          notifiedRef.current.add(key)
          pushToast({
            text: `Ready for review — ${session.projectName}`,
            detail: `${status.changes} change${status.changes === 1 ? '' : 's'} on ${tab.worktreeBranch}`,
            kind: 'info',
          })
        })
      }
    }
  }, [sessions, terminals, pushToast])

  // Global keyboard shortcuts: Cmd+N new session, Cmd+W close active session,
  // Cmd+1..9 switch to local terminal by index.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault()
        setPaletteOpen((open) => !open)
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        handleNewSession()
      } else if (e.key === 'w' || e.key === 'W') {
        const active = allSidebarSessions.find((s) => s.id === activeSessionId)
        if (active && active.terminalId && localTerminalIds.has(active.terminalId)) {
          e.preventDefault()
          handleCloseSession(active)
        }
      } else if (e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key, 10) - 1
        const t = terminals[idx]
        if (t) {
          e.preventDefault()
          // Synthesize a select via the same path used by sidebar click
          const hookSession = sessions.find((s) => s.terminalId === t.id)
          if (hookSession) {
            handleSelectSession(hookSession)
          } else {
            setActiveTerminalId(t.id)
            setActiveSessionId(`local-${t.id}`)
            setActiveFolderPrefs(null)
            setGlobalPrefsActive(false)
            setPendingSession(null)
          }
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleNewSession, handleCloseSession, handleSelectSession, allSidebarSessions, activeSessionId, localTerminalIds, terminals, sessions])

  // Saved sessions not currently open — offered for restore on the splash & palette.
  const restorableSessions = useMemo(() => {
    const liveKeys = new Set(terminals.map((t) => t.key))
    return savedSessions
      .filter((s) => !liveKeys.has(s.key))
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
  }, [savedSessions, terminals])

  // Find pending requests for the active session
  const activeSession = allSidebarSessions.find((s) => s.id === activeSessionId)
  const activeRequests = pendingRequests.filter(
    (r) => r.terminalId === activeTerminalId || r.sessionId === activeSession?.id
  )

  // Single source of truth for content area routing. Order = priority.
  const contentMode: 'pendingSession' | 'folderPrefs' | 'globalPrefs' | 'rules' | 'agents' | 'usage' | 'prefs' | 'localTerminal' | 'splash' = useMemo(() => {
    if (pendingSession) return 'pendingSession'
    if (prefsViewActive) return 'prefs'
    if (rulesViewActive) return 'rules'
    if (agentsViewActive) return 'agents'
    if (usageViewActive) return 'usage'
    if (globalPrefsActive) return 'globalPrefs'
    if (activeFolderPrefs) return 'folderPrefs'
    if (activeTerminalId) return 'localTerminal'
    return 'splash'
  }, [pendingSession, prefsViewActive, rulesViewActive, agentsViewActive, usageViewActive, globalPrefsActive, activeFolderPrefs, activeTerminalId])

  const paletteActions: PaletteAction[] = useMemo(() => {
    const actions: PaletteAction[] = []

    // Session switches
    allSidebarSessions.forEach((s, i) => {
      actions.push({
        id: `select-${s.id}`,
        group: 'Session',
        label: customNames[s.id] || s.summary || s.projectName || 'Session',
        detail: s.workingDirectory,
        hint: i < 9 ? `⌘${i + 1}` : undefined,
        run: () => handleSelectSession(s),
      })
    })

    // Folder prefs entries (one per unique project)
    const seenProjects = new Set<string>()
    for (const s of allSidebarSessions) {
      if (!s.workingDirectory || seenProjects.has(s.workingDirectory)) continue
      seenProjects.add(s.workingDirectory)
      actions.push({
        id: `prefs-${s.workingDirectory}`,
        group: 'Settings',
        label: `Edit settings for ${s.projectName}`,
        detail: s.workingDirectory,
        run: () => handleOpenFolderPrefs(s.workingDirectory, s.projectName),
      })
    }

    // Saved sessions — resume the prior conversation or start clean
    restorableSessions.slice(0, 8).forEach((s) => {
      const name = s.customName || s.projectName
      if (s.claudeSessionId) {
        actions.push({
          id: `resume-${s.key}`,
          group: 'Continue',
          label: `Resume ${name}`,
          detail: s.worktreeBranch || s.cwd,
          run: () => handleRestoreSession(s, true),
        })
      }
      actions.push({
        id: `reopen-${s.key}`,
        group: 'Continue',
        label: `${s.claudeSessionId ? 'Reopen' : 'Open'} ${name} (clean)`,
        detail: s.worktreeBranch || s.cwd,
        run: () => handleRestoreSession(s, false),
      })
    })

    // Recent projects — one-click relaunch
    recentProjects.slice(0, 8).forEach((p) => {
      actions.push({
        id: `recent-${p.path}`,
        group: 'Recent',
        label: `New session in ${p.name}`,
        detail: p.path,
        run: () => handleNewSessionInFolder(p.path),
      })
    })

    // Static entries
    actions.push(
      { id: 'new-session', group: 'New', label: 'New session (pick folder)', hint: '⌘N', run: handleNewSession },
      { id: 'agents', group: 'Settings', label: 'Agents — configure models per task', run: handleOpenAgents },
      { id: 'usage', group: 'Settings', label: 'Usage & cost', run: handleOpenUsage },
      { id: 'rules', group: 'Settings', label: 'Auto-approve rules', run: handleOpenRules },
      { id: 'prefs', group: 'Settings', label: 'Operator preferences', run: handleOpenPrefs },
      { id: 'globals', group: 'Settings', label: 'Global Claude files', run: handleOpenGlobalPrefs },
      { id: 'theme', group: 'View', label: currentTheme.isDark ? 'Switch to light mode' : 'Switch to dark mode', run: handleToggleTheme },
    )

    return actions
  }, [allSidebarSessions, customNames, recentProjects, restorableSessions, currentTheme, handleSelectSession, handleOpenFolderPrefs, handleNewSession, handleNewSessionInFolder, handleRestoreSession, handleOpenRules, handleOpenAgents, handleOpenUsage, handleOpenPrefs, handleOpenGlobalPrefs, handleToggleTheme])

  const hookConfigSnippet = hookPath
    ? `{
  "hooks": {
    "PreToolUse": [{ "matcher": "", "hooks": [{ "type": "command", "command": "${hookPath}" }] }],
    "PostToolUse": [{ "matcher": "", "hooks": [{ "type": "command", "command": "${hookPath}" }] }],
    "Notification": [{ "matcher": "", "hooks": [{ "type": "command", "command": "${hookPath}" }] }],
    "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "${hookPath}" }] }],
    "SubagentStop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "${hookPath}" }] }]
  }
}`
    : ''

  return (
    <div style={{ display: 'flex', width: '100%', height: '100vh', background: 'var(--bg-terminal)' }}>
      <Sidebar
        sessions={allSidebarSessions}
        activeSessionId={activeSessionId}
        customNames={customNames}
        pendingRequests={pendingRequests}
        activeFolderPrefs={activeFolderPrefs?.projectPath ?? null}
        globalPrefsActive={globalPrefsActive}
        rulesViewActive={rulesViewActive}
        agentsViewActive={agentsViewActive}
        usageViewActive={usageViewActive}
        prefsViewActive={prefsViewActive}
        effortLevels={effortLevels}
        fanInfo={fanInfo}
        shortcutIndices={shortcutIndices}
        stats={sidebarStats}
        isDark={currentTheme.isDark}
        onSelectSession={handleSelectSession}
        onRenameSession={handleRename}
        onCloseSession={handleCloseSession}
        onNewSession={handleNewSession}
        onOpenFolderPrefs={handleOpenFolderPrefs}
        onOpenGlobalPrefs={handleOpenGlobalPrefs}
        onOpenRules={handleOpenRules}
        onOpenAgents={handleOpenAgents}
        onOpenUsage={handleOpenUsage}
        onOpenPrefs={handleOpenPrefs}
        onToggleTheme={handleToggleTheme}
      />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Drag region — full height only when no session toolbar is acting as drag region */}
        {contentMode !== 'localTerminal' && (
          <div style={{ height: 40,
            // @ts-expect-error Electron-specific CSS property
            WebkitAppRegion: 'drag',
            flexShrink: 0,
          }} />
        )}

        {contentMode === 'pendingSession' && pendingSession && (
          <NewSessionPanel
            cwd={pendingSession}
            onLaunch={handleLaunchSession}
            onCancel={() => setPendingSession(null)}
          />
        )}

        {contentMode === 'folderPrefs' && activeFolderPrefs && (
          <FolderPreferencesView
            projectPath={activeFolderPrefs.projectPath}
            projectName={activeFolderPrefs.projectName}
          />
        )}

        {contentMode === 'globalPrefs' && (
          <FolderPreferencesView
            projectPath=""
            projectName="Global Claude Files"
            globalOnly
          />
        )}

        {contentMode === 'rules' && <RulesView />}

        {contentMode === 'agents' && <AgentLibraryView />}

        {contentMode === 'usage' && <UsageView />}

        {contentMode === 'prefs' && (
          <PrefsView />
        )}

        {contentMode === 'localTerminal' && activeSession && (() => {
          const tab = terminals.find((t) => t.id === activeTerminalId)
          return (
            <SessionToolbar
              key={activeSession.workingDirectory}
              projectPath={activeSession.workingDirectory}
              projectName={activeSession.projectName}
              effortLevel={tab?.effortLevel}
              permissionMode={tab?.permissionMode || activeSession.permissionMode}
              lastToolName={activeSession.lastToolName}
              branch={tab?.worktreeBranch}
            />
          )
        })()}

        {contentMode === 'localTerminal' && activeSession && (() => {
          const tab = terminals.find((t) => t.id === activeTerminalId)
          // If the session was launched into a worktree, tab.cwd is the worktree path.
          const worktreePath = tab?.worktreeBranch ? tab.cwd : null
          return (
            <SessionInfoBar
              session={activeSession}
              worktreePath={worktreePath}
              onReviewChanges={worktreePath ? () => {
                setReviewingTerminalId(activeTerminalId)
                setActivityViewingTerminalId(null)
              } : undefined}
              onViewActivity={() => {
                if (activityViewingTerminalId === activeTerminalId) {
                  setActivityViewingTerminalId(null)
                } else {
                  setActivityViewingTerminalId(activeTerminalId)
                  setReviewingTerminalId(null)
                }
              }}
              activityViewing={activityViewingTerminalId === activeTerminalId}
            />
          )
        })()}

        {contentMode === 'localTerminal' && activeTerminalId
          && reviewingTerminalId !== activeTerminalId
          && activityViewingTerminalId !== activeTerminalId && (
          <PromptBar terminalId={activeTerminalId} />
        )}

        {/* Activity timeline — overlays the terminal when viewing activity */}
        {contentMode === 'localTerminal' && activityViewingTerminalId === activeTerminalId && activeSession && (
          <SessionActivityView session={activeSession} pendingRequests={activeRequests} />
        )}

        {/* Diff review panel — overlays the terminal when reviewing */}
        {contentMode === 'localTerminal' && reviewingTerminalId === activeTerminalId && (() => {
          const tab = terminals.find((t) => t.id === activeTerminalId)
          if (!tab?.worktreeBranch) return null
          const handleSessionEnded = async () => {
            // Worktree is already gone (merge or discard handled it). Kill the pty and drop the tab.
            if (tab) {
              await window.operator.terminalKill(tab.id)
              setTerminals((prev) => prev.filter((t) => t.id !== tab.id))
              setActiveTerminalId((c) => c === tab.id ? null : c)
              setActiveSessionId((c) => c === `local-${tab.id}` ? null : c)
              setReviewingTerminalId(null)
            }
          }
          return (
            <DiffPanel
              worktreePath={tab.cwd}
              branch={tab.worktreeBranch}
              baseBranch={tab.worktreeBase}
              sourceRoot={tab.sourceCwd}
              onClose={() => setReviewingTerminalId(null)}
              onSessionEnded={handleSessionEnded}
            />
          )
        })()}

        {/* Terminal panes stay mounted across mode changes so xterm state persists.
            Hidden when reviewing diff, viewing activity, or in another content mode. */}
        {terminals.length > 0 && (
          <div style={{
            flex: 1,
            minHeight: 0,
            position: 'relative',
            display: contentMode === 'localTerminal'
              && reviewingTerminalId !== activeTerminalId
              && activityViewingTerminalId !== activeTerminalId
              ? 'block' : 'none',
          }}>
            {terminals.map((t) => (
              <div
                key={t.id}
                style={{
                  position: 'absolute',
                  inset: 0,
                  visibility: t.id === activeTerminalId ? 'visible' : 'hidden',
                }}
              >
                <TerminalPane
                  terminalId={t.id}
                  theme={currentTheme.xterm}
                  active={t.id === activeTerminalId}
                />
              </div>
            ))}
          </div>
        )}

        {contentMode === 'localTerminal' && activeRequests.length > 0 && (
          <InlinePermission
            request={activeRequests[0]}
            onRespond={(value) => handleRespond(activeRequests[0].id, value)}
            onRespondAndRemember={(action) => handleRespondAndRemember(activeRequests[0], action)}
          />
        )}

        {contentMode === 'splash' && allSidebarSessions.length > 0 && (
          <ActivityDashboard
            sessions={allSidebarSessions}
            customNames={customNames}
            pendingRequests={pendingRequests}
            onSelectSession={handleSelectSession}
            onNewSession={handleNewSession}
          />
        )}

        {contentMode === 'splash' && allSidebarSessions.length === 0 && (
          <div
            className="scroll-hidden"
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'flex-start',
              fontFamily: "'Inter', system-ui, sans-serif",
              padding: '40px 40px',
              overflow: 'auto',
              minHeight: 0,
              maxWidth: 480,
              margin: '0 auto',
            }}
          >
            {/* margin-top:auto on first + margin-bottom:auto on last child centers the
                block when it fits, but keeps the top reachable/scrollable when it overflows. */}
            <div style={{ marginTop: 'auto', marginBottom: 20 }}><LogoMark size={64} /></div>
            <div style={{ textAlign: 'center', marginBottom: 32 }}>
              <p style={{
                fontSize: 13,
                color: 'var(--fg)',
                fontWeight: 500,
                lineHeight: 1.7,
                margin: 0,
              }}>
                Mission control for working agents.
              </p>
              <p style={{
                fontSize: 12,
                color: 'var(--fg-muted)',
                lineHeight: 1.7,
                margin: '12px 0 0',
              }}>
                Define agents and the model each task runs on, then launch
                Claude Code sessions that delegate to them — each in its own
                git worktree. Watch the work unfold live, and approve or deny
                inline.
              </p>
              <p style={{
                fontSize: 11,
                color: 'var(--fg-muted)',
                lineHeight: 1.7,
                margin: '10px 0 0',
                opacity: 0.6,
              }}>
                Fan a task across parallel agents and see what each is doing —
                and what it costs.
              </p>
            </div>

            <button
              onClick={handleNewSession}
              style={{
                padding: '7px 20px',
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                color: 'var(--fg)',
                fontSize: 12,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              + New Session
            </button>
            <p style={{ fontSize: 11, color: 'var(--fg-muted)', opacity: 0.5, marginTop: 8 }}>
              Cmd+N · Cmd+K for command palette
            </p>

            {restorableSessions.length > 0 && (
              <div style={{ width: '100%', marginTop: 24 }}>
                <p style={{
                  fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
                  letterSpacing: 0.5, color: 'var(--fg-muted)', opacity: 0.5,
                  margin: '0 0 8px', textAlign: 'left',
                }}>
                  Continue where you left off
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {restorableSessions.slice(0, 6).map((s) => (
                    <div
                      key={s.key}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        width: '100%', padding: '6px 6px 6px 10px',
                        background: 'var(--bg-surface)',
                        border: '1px solid var(--border)',
                        borderRadius: 5,
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                        <div style={{ fontSize: 11, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {s.customName || s.projectName}
                        </div>
                        <div style={{
                          fontSize: 9, color: 'var(--fg-muted)', opacity: 0.55, marginTop: 1,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
                        }}>
                          {s.worktreeBranch ? `⎇ ${s.worktreeBranch}` : s.cwd.replace(/^\/Users\/[^/]+/, '~')}
                        </div>
                      </div>
                      {s.claudeSessionId && (
                        <button
                          onClick={() => handleRestoreSession(s, true)}
                          title="Resume the previous Claude conversation"
                          style={restoreBtnStyle(true)}
                        >
                          Resume
                        </button>
                      )}
                      <button
                        onClick={() => handleRestoreSession(s, false)}
                        title="Start the agent clean in this session"
                        style={restoreBtnStyle(false)}
                      >
                        {s.claudeSessionId ? 'Clean' : 'Open'}
                      </button>
                      <button
                        onClick={() => forgetSavedSession(s.key)}
                        title="Forget this session"
                        style={{
                          background: 'none', border: 'none', color: 'var(--fg-muted)',
                          cursor: 'pointer', fontSize: 13, padding: '0 4px', opacity: 0.4, fontFamily: 'inherit',
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {recentProjects.length > 0 && (
              <div style={{ width: '100%', marginTop: 24 }}>
                <p style={{
                  fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
                  letterSpacing: 0.5, color: 'var(--fg-muted)', opacity: 0.5,
                  margin: '0 0 8px', textAlign: 'left',
                }}>
                  Recent
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {recentProjects.slice(0, 5).map((p) => (
                    <button
                      key={p.path}
                      onClick={() => handleNewSessionInFolder(p.path)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        width: '100%', padding: '6px 10px',
                        background: 'transparent',
                        border: '1px solid var(--border)',
                        borderRadius: 5,
                        cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                      }}
                    >
                      <span style={{ fontSize: 11, color: 'var(--fg)', flexShrink: 0 }}>{p.name}</span>
                      <span style={{
                        fontSize: 10, color: 'var(--fg-muted)', opacity: 0.5,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
                        fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
                      }}>
                        {p.path.replace(/^\/Users\/[^/]+/, '~')}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Hook config (collapsible) */}
            <div style={{ marginTop: 28, marginBottom: 'auto', width: '100%' }}>
              <button
                onClick={() => setShowSetup(!showSetup)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--fg-muted)',
                  fontSize: 10,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                  opacity: 0.5,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  margin: '0 auto',
                }}
              >
                <span style={{ transform: showSetup ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', display: 'inline-block' }}>
                  &#9654;
                </span>
                Hook configuration
              </button>

              {showSetup && hookPath && (
                <div style={{ marginTop: 10, padding: '12px 14px', background: 'var(--bg-surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
                  <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '0 0 8px', lineHeight: 1.5 }}>
                    Operator configures hooks automatically on launch. If you need to set them up manually,
                    add this to <code style={{ fontSize: 10, background: 'var(--bg-terminal)', padding: '1px 4px', borderRadius: 3 }}>~/.claude/settings.json</code>:
                  </p>
                  <pre
                    style={{
                      fontSize: 10,
                      background: 'var(--bg-terminal)',
                      color: 'var(--fg)',
                      padding: '10px 12px',
                      borderRadius: 6,
                      overflow: 'auto',
                      margin: '0 0 8px',
                      lineHeight: 1.5,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                    }}
                  >
                    {hookConfigSnippet}
                  </pre>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(hookConfigSnippet)
                      setCopied(true)
                    }}
                    style={{
                      padding: '4px 12px',
                      background: copied ? 'var(--color-success)' : 'var(--bg-terminal)',
                      color: copied ? 'var(--fg-on-accent)' : 'var(--fg)',
                      border: '1px solid var(--border)',
                      borderRadius: 4,
                      fontSize: 11,
                      fontFamily: 'inherit',
                      cursor: 'pointer',
                    }}
                  >
                    {copied ? 'Copied!' : 'Copy Config'}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {paletteOpen && (
        <CommandPalette actions={paletteActions} onClose={() => setPaletteOpen(false)} />
      )}

      <Toasts messages={toasts} onDismiss={dismissToast} />
    </div>
  )
}

function restoreBtnStyle(primary: boolean): React.CSSProperties {
  return {
    padding: '3px 9px',
    fontSize: 10,
    fontWeight: 500,
    fontFamily: 'inherit',
    background: primary ? 'var(--btn-bg)' : 'transparent',
    color: primary ? 'var(--fg)' : 'var(--fg-muted)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    cursor: 'pointer',
    flexShrink: 0,
  }
}
