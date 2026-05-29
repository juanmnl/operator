import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { AgentSession, OperatorRequest, OperatorPrefs, DEFAULT_PREFS } from '../../shared/types'
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
import { PrefsView } from '../components/prefs/PrefsView'
import { CommandPalette, PaletteAction } from '../components/CommandPalette'
import { ActivityDashboard } from '../components/dashboard/ActivityDashboard'
import { Toasts, ToastMessage } from '../components/Toast'
import { themes, defaultTheme, applyTheme } from '../themes'
import type { OperatorTheme } from '../themes'
import logoUrl from '../../../assets/logo-light-64.png'

interface TerminalTab {
  id: string
  cwd: string
  effortLevel?: 'high' | 'normal' | 'low'
  permissionMode?: string
  worktreeBranch?: string
  worktreeBase?: string
  sourceCwd?: string
}

export function DashboardView() {
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [terminals, setTerminals] = useState<TerminalTab[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null)
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
  const [prefsViewActive, setPrefsViewActive] = useState(false)
  const [prefs, setPrefs] = useState<OperatorPrefs>(() => {
    try {
      const raw = localStorage.getItem('operator.prefs')
      return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : DEFAULT_PREFS
    } catch { return DEFAULT_PREFS }
  })

  // Push prefs to main process on mount + every change so it can act on them.
  useEffect(() => {
    window.operator.prefsUpdate(prefs)
    try { localStorage.setItem('operator.prefs', JSON.stringify(prefs)) } catch { /* quota */ }
  }, [prefs])
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
      // Pref-gated: auto-switch to the requesting session if it isn't already active.
      const prefsRaw = localStorage.getItem('operator.prefs')
      const autoFocus = (() => {
        try { return prefsRaw ? !!JSON.parse(prefsRaw).autoFocusPending : false } catch { return false }
      })()
      if (autoFocus && request.sessionId) {
        setActiveSessionId((current) => current === request.sessionId ? current : request.sessionId!)
        if (request.terminalId) setActiveTerminalId(request.terminalId)
      }
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

    return () => { unsubSession(); unsubRequest(); unsubExit(); clearInterval(pollInterval) }
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
    setPrefsViewActive(false)
  }, [])

  const handleOpenGlobalPrefs = useCallback(() => {
    setGlobalPrefsActive(true)
    setRulesViewActive(false)
    setPrefsViewActive(false)
    setActiveFolderPrefs(null)
    setActiveSessionId(null)
    setActiveTerminalId(null)
    setPendingSession(null)
  }, [])

  const handleOpenRules = useCallback(() => {
    setRulesViewActive(true)
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

  const handleLaunchSession = useCallback(async (cwd: string, config: SessionConfig) => {
    // Write effort level to global settings (Claude Code reads it from there)
    const prefs = await window.operator.folderPrefsLoad(cwd)
    const globalFile = prefs.settingsFiles.find((f) => f.scope === 'global')
    if (globalFile) {
      await window.operator.folderPrefsSaveSettings(globalFile.path, { effortLevel: config.effortLevel })
    }

    // Optionally create an isolated git worktree before spawning the agent
    let spawnCwd = cwd
    let worktreeBranch: string | undefined
    let worktreeBase: string | undefined
    if (config.useWorktree) {
      const result = await window.operator.worktreeCreate(cwd)
      if ('error' in result) {
        // Surface the failure; fall back to launching in the original folder
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

    const result = await window.operator.terminalSpawn(spawnCwd, launchOptions)
    if (result) {
      const tab: TerminalTab = {
        id: result.terminalId,
        cwd: result.cwd,
        effortLevel: config.effortLevel,
        permissionMode: config.permissionMode,
        worktreeBranch,
        worktreeBase,
        sourceCwd: worktreeBranch ? cwd : undefined,
      }
      setTerminals((prev) => [...prev, tab])
      setActiveTerminalId(result.terminalId)
      setActiveSessionId(`local-${result.terminalId}`)
      rememberRecent(cwd)
      setRecentProjects((prev) => {
        const name = cwd.split('/').pop() || cwd
        const filtered = prev.filter((p) => p.path !== cwd)
        return [{ path: cwd, name, lastUsedAt: new Date().toISOString() }, ...filtered].slice(0, 10)
      })
    }
    setPendingSession(null)
  }, [rememberRecent])

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
    setTerminals((prev) => prev.filter((t) => t.id !== terminalId))
    setActiveTerminalId((current) => (current === terminalId ? null : current))
    setActiveSessionId((current) => {
      if (current === session.id) return null
      if (current === `local-${terminalId}`) return null
      return current
    })
  }, [terminals])

  const handleSelectSession = useCallback((session: AgentSession) => {
    const localTerminalIds = new Set(terminals.map((t) => t.id))
    setActiveSessionId(session.id)
    setActiveFolderPrefs(null)
    setGlobalPrefsActive(false)
    setRulesViewActive(false)
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
  for (const t of terminals) {
    if (t.effortLevel) effortLevels[t.id] = t.effortLevel
  }

  const handleOpenFolderPrefs = useCallback((projectPath: string, projectName: string) => {
    setActiveFolderPrefs({ projectPath, projectName })
    setActiveSessionId(null)
    setActiveTerminalId(null)
    setPendingSession(null)
    setGlobalPrefsActive(false)
    setRulesViewActive(false)
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
    await window.operator.rulesAdd({ tool: toolName, pattern, action })
    await window.operator.respond(request.id, action)
    setPendingRequests((prev) => prev.filter((r) => r.id !== request.id))
    pushToast({
      text: `Rule added — ${action === 'approve' ? 'always allow' : 'always deny'} ${toolName}`,
      detail: pattern ? `pattern: ${pattern}` : 'any input',
      kind: action === 'approve' ? 'success' : 'error',
    })
  }, [pushToast])

  // Build sidebar entries: local terminals + external sessions
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

  const externalSessions = sessions.filter(
    (s) => s.status === 'active' && (!s.terminalId || !localTerminalIds.has(s.terminalId))
  )

  const allSidebarSessions = [...localSessions, ...externalSessions]

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
    // If active external session ended, clear selection
    if (activeSessionId && !activeTerminalId) {
      const extSession = sessions.find((s) => s.id === activeSessionId)
      if (extSession && extSession.status === 'ended') {
        setActiveSessionId(null)
      }
    }
  }, [sessions, activeSessionId, activeTerminalId])

  // Reset "Copied!" label 2s after a copy, with cleanup on unmount / re-copy
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(t)
  }, [copied])

  // Native notification click → focus the requesting session
  useEffect(() => {
    return window.operator.onFocusSession((sessionId) => {
      const session = allSidebarSessions.find((s) => s.id === sessionId)
      if (session) handleSelectSession(session)
    })
  }, [allSidebarSessions, handleSelectSession])

  // "Ready for review" detection — watch worktree sessions transitioning to idle
  // with uncommitted changes. Fire one notification per (terminalId, idle-arrival).
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

  // Find pending requests for the active session
  const activeSession = allSidebarSessions.find((s) => s.id === activeSessionId)
  const activeRequests = pendingRequests.filter(
    (r) => r.terminalId === activeTerminalId || r.sessionId === activeSession?.id
  )

  // Single source of truth for content area routing. Order = priority.
  const contentMode: 'pendingSession' | 'folderPrefs' | 'globalPrefs' | 'rules' | 'prefs' | 'localTerminal' | 'externalSession' | 'splash' = useMemo(() => {
    if (pendingSession) return 'pendingSession'
    if (prefsViewActive) return 'prefs'
    if (rulesViewActive) return 'rules'
    if (globalPrefsActive) return 'globalPrefs'
    if (activeFolderPrefs) return 'folderPrefs'
    if (activeTerminalId) return 'localTerminal'
    if (activeSessionId) return 'externalSession'
    return 'splash'
  }, [pendingSession, prefsViewActive, rulesViewActive, globalPrefsActive, activeFolderPrefs, activeTerminalId, activeSessionId])

  const externalActiveSession = contentMode === 'externalSession'
    ? sessions.find((s) => s.id === activeSessionId) ?? null
    : null

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
      { id: 'rules', group: 'Settings', label: 'Auto-approve rules', run: handleOpenRules },
      { id: 'prefs', group: 'Settings', label: 'Operator preferences', run: handleOpenPrefs },
      { id: 'globals', group: 'Settings', label: 'Global Claude files', run: handleOpenGlobalPrefs },
      { id: 'theme', group: 'View', label: currentTheme.isDark ? 'Switch to light mode' : 'Switch to dark mode', run: handleToggleTheme },
    )

    return actions
  }, [allSidebarSessions, customNames, recentProjects, currentTheme, handleSelectSession, handleOpenFolderPrefs, handleNewSession, handleNewSessionInFolder, handleOpenRules, handleOpenPrefs, handleOpenGlobalPrefs, handleToggleTheme])

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
        localTerminalIds={localTerminalIds}
        customNames={customNames}
        pendingRequests={pendingRequests}
        activeFolderPrefs={activeFolderPrefs?.projectPath ?? null}
        globalPrefsActive={globalPrefsActive}
        rulesViewActive={rulesViewActive}
        prefsViewActive={prefsViewActive}
        effortLevels={effortLevels}
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
        onOpenPrefs={handleOpenPrefs}
        onToggleTheme={handleToggleTheme}
      />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Drag region — full height only when no session toolbar is acting as drag region */}
        {contentMode !== 'localTerminal' && contentMode !== 'externalSession' && (
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

        {contentMode === 'prefs' && (
          <PrefsView prefs={prefs} onChange={setPrefs} />
        )}

        {(contentMode === 'localTerminal' || contentMode === 'externalSession') && activeSession && (() => {
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

        {contentMode === 'externalSession' && externalActiveSession && (
          <SessionActivityView
            session={externalActiveSession}
            pendingRequests={activeRequests}
          />
        )}

        {(contentMode === 'localTerminal' || contentMode === 'externalSession') && activeRequests.length > 0 && (
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
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: "'Inter', system-ui, sans-serif",
              padding: '40px 40px',
              overflow: 'auto',
              minHeight: 0,
              maxWidth: 480,
              margin: '0 auto',
            }}
          >
            <img src={logoUrl} width={64} height={64} alt="" style={{ marginBottom: 20, filter: currentTheme.isDark ? 'none' : 'invert(1)' }} />
            <div style={{ textAlign: 'center', marginBottom: 32 }}>
              <p style={{
                fontSize: 13,
                color: 'var(--fg)',
                fontWeight: 500,
                lineHeight: 1.7,
                margin: 0,
              }}>
                Mission control for your AI coding sessions.
              </p>
              <p style={{
                fontSize: 12,
                color: 'var(--fg-muted)',
                lineHeight: 1.7,
                margin: '12px 0 0',
              }}>
                Launch Claude Code sessions in isolated worktrees, watch what
                they do, and approve or deny anything they want to touch —
                inline here while you're working, or as a notification pill
                when you're somewhere else.
              </p>
              <p style={{
                fontSize: 11,
                color: 'var(--fg-muted)',
                lineHeight: 1.7,
                margin: '10px 0 0',
                opacity: 0.6,
              }}>
                Run agents in parallel without them stepping on each other.
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
            <div style={{ marginTop: 28, width: '100%' }}>
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
