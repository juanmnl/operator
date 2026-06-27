import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { AgentSession } from '../../shared/types'
import { Sidebar } from '../components/sidebar/Sidebar'
import { SidebarRail } from '../components/sidebar/SidebarRail'
import { TerminalPane } from '../components/terminal/TerminalPane'
import { SessionActivityView } from '../components/session/SessionActivityView'
import { FolderPreferencesView } from '../components/preferences/FolderPreferencesView'
import { SessionToolbar } from '../components/session/SessionToolbar'
import { SessionInfoBar } from '../components/session/SessionInfoBar'
import { NewSessionPanel, SessionConfig } from '../components/session/NewSessionPanel'
import { DiffPanel } from '../components/session/DiffPanel'
import { AgentLibraryView } from '../components/agents/AgentLibraryView'
import { UsageView } from '../components/usage/UsageView'
import { PrefsView } from '../components/prefs/PrefsView'
import { CommandPalette, PaletteAction } from '../components/CommandPalette'
import { ActivityDashboard } from '../components/dashboard/ActivityDashboard'
import { RecentLists } from '../components/dashboard/RecentLists'
import { Toasts, ToastMessage } from '../components/Toast'
import { themes, defaultTheme, applyTheme, resolveThemeKey, themeKey, identities } from '../themes'
import type { OperatorTheme } from '../themes'
import { playYourTurnChime } from '../lib/sounds'
import { computeFanMembership } from '../lib/fan-out'
import { isAppChord } from '../lib/key-routing'
import { LogoMark } from '../components/LogoMark'
import { DragRegion } from '../components/DragRegion'

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
  /** Pty has exited (Claude/shell finished). Pane stays mounted showing the
   *  final frame; user dismisses it explicitly. */
  ended?: boolean
  /** This tab was re-attached to a surviving pty after a reload (not freshly
   *  launched), so its pane should replay buffered scrollback on mount. */
  reattached?: boolean
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
  /** Live pty id from the CURRENT backend run. Stable across a renderer/webview
   *  reload (the Rust process survives), so it's used to re-attach the sidebar to
   *  still-running ptys. Stale (ignored) after a full app restart. */
  terminalId?: string
  lastActiveAt: string
}

export function DashboardView() {
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [terminals, setTerminals] = useState<TerminalTab[]>([])
  // Dev-server port sniffed from each session's terminal output (the "Local:"
  // banner a dev server prints when it boots). The project usually ignores the
  // OPERATOR_DEV_PORT we hand it and binds its own default, so this is the port
  // that's actually serving — it takes priority over the allocated one.
  const [detectedDevPorts, setDetectedDevPorts] = useState<Record<string, number>>({})
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null)
  // Latest active terminal, for the (single, mount-time) file-drop listener.
  const activeTerminalIdRef = useRef<string | null>(null)
  useEffect(() => { activeTerminalIdRef.current = activeTerminalId }, [activeTerminalId])
  // Native terminal: drop the opaque backmost layers once so the wgpu view shows
  // through (gated on the flag; not per-pane, so closing one terminal can't strip
  // transparency from the others).
  const [customNames, setCustomNames] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem('operator.customNames')
      return raw ? JSON.parse(raw) : {}
    } catch { return {} }
  })
  const [activeFolderPrefs, setActiveFolderPrefs] = useState<{ projectPath: string; projectName: string } | null>(null)
  const [globalPrefsActive, setGlobalPrefsActive] = useState(false)
  const [agentsViewActive, setAgentsViewActive] = useState(false)
  const [usageViewActive, setUsageViewActive] = useState(false)
  const [prefsViewActive, setPrefsViewActive] = useState(false)
  const [reviewingTerminalId, setReviewingTerminalId] = useState<string | null>(null)
  const [activityViewingTerminalId, setActivityViewingTerminalId] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  // Sidebar hide/show — persisted so it survives restarts. The collapse itself
  // is a CSS width/opacity transition on the wrapper (see render).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('operator.sidebarCollapsed') === '1' } catch { return false }
  })
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((c) => {
      const next = !c
      try { localStorage.setItem('operator.sidebarCollapsed', next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }, [])

  const pushToast = useCallback((message: Omit<ToastMessage, 'id'>) => {
    setToasts((prev) => [...prev, { ...message, id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }])
  }, [])

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])
  const [pendingSession, setPendingSession] = useState<string | null>(null) // cwd awaiting launch
  const [currentTheme, setCurrentTheme] = useState<OperatorTheme>(() => {
    return themes[resolveThemeKey(localStorage.getItem('operator.theme'))]
  })
  const handleRename = useCallback((sessionId: string, name: string) => {
    setCustomNames((prev) => {
      const next = { ...prev, [sessionId]: name }
      try { localStorage.setItem('operator.customNames', JSON.stringify(next)) } catch { /* quota */ }
      return next
    })
  }, [])

  useEffect(() => {
    window.operator.getSessions().then(setSessions)

    // Push-only: the transcript tailer (transcript.rs) emits `session:update`
    // whenever anything actually changes — transcript lines AND pty-activity phase
    // transitions (running↔idle both set `dirty`). A 1s getSessions() poll used to
    // sit here too, but it was pure redundant overhead: an IPC round-trip + full
    // dashboard re-render every second even when nothing changed (a real idle-energy
    // sink). The push delivers the same updates at the same ~1s tailer cadence, only
    // when there's something to deliver.
    const unsubSession = window.operator.onSessionUpdate(setSessions)

    const unsubExit = window.operator.onTerminalExit((id) => {
      // Don't drop the tab — unmounting the pane blanks the final output. xterm
      // keeps its buffer after the pty dies, so mark the tab ended and leave it
      // mounted + active; the last frame stays on screen until the user dismisses
      // it (Cmd+W / sidebar close / the pane's "ended" overlay). Intentional
      // closes (handleCloseSession, worktree merge/discard) still remove the tab.
      setTerminals((prev) => prev.map((t) => (t.id === id ? { ...t, ended: true } : t)))
    })

    // Files dropped on the window → paste their paths into the active terminal,
    // so you can drop an image straight into the conversation.
    const unsubDrop = window.operator.onFileDrop?.((paths) => {
      const tid = activeTerminalIdRef.current
      if (!tid || !paths.length) return
      const text = paths.map((p) => (/\s/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p)).join(' ') + ' '
      window.operator.terminalWrite(tid, text)
    }) ?? (() => {})

    return () => { unsubSession(); unsubExit(); unsubDrop() }
  }, [])

  const handleNewSession = useCallback(async () => {
    const folder = await window.operator.pickFolder()
    if (folder) {
      setPendingSession(folder)
      setActiveSessionId(null)
      setActiveTerminalId(null)
      setActiveFolderPrefs(null)
      setGlobalPrefsActive(false)
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
    setAgentsViewActive(false)
    setUsageViewActive(false)
    setPrefsViewActive(false)
  }, [])

  const handleOpenGlobalPrefs = useCallback(() => {
    setGlobalPrefsActive(true)
    setAgentsViewActive(false)
    setUsageViewActive(false)
    setPrefsViewActive(false)
    setActiveFolderPrefs(null)
    setActiveSessionId(null)
    setActiveTerminalId(null)
    setPendingSession(null)
  }, [])

  const handleOpenAgents = useCallback(() => {
    setAgentsViewActive(true)
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
    setPrefsViewActive(false)
    setGlobalPrefsActive(false)
    setActiveFolderPrefs(null)
    setActiveSessionId(null)
    setActiveTerminalId(null)
    setPendingSession(null)
  }, [])

  const handleOpenPrefs = useCallback(() => {
    setPrefsViewActive(true)
    setAgentsViewActive(false)
    setUsageViewActive(false)
    setGlobalPrefsActive(false)
    setActiveFolderPrefs(null)
    setActiveSessionId(null)
    setActiveTerminalId(null)
    setPendingSession(null)
  }, [])

  // Clicking the "Operator" header clears every view so the content area falls
  // through to the splash — the live active-sessions dashboard.
  const handleShowDashboard = useCallback(() => {
    setPrefsViewActive(false)
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

  // Re-attach the sidebar to ptys that survived a renderer/webview reload. The Rust
  // backend (and its running ptys) outlive a reload, but React state resets, so the
  // sidebar would otherwise go blank. Once the durable store is hydrated, intersect
  // the live pty list with the saved metadata (matched by the still-valid terminalId
  // from this same backend run) and rebuild the tabs. A full app restart has no live
  // ptys → terminal_list is empty → nothing re-attaches (the restorable-sessions
  // splash handles cold starts instead).
  const reattachedRef = useRef(false)
  useEffect(() => {
    if (!savedHydrated || reattachedRef.current) return
    reattachedRef.current = true
    const p = window.operator.terminalList?.()
    if (!p) return
    p.then((all) => {
      // Exclude scratch shells (`sh` ids from ShellModal) — those belong to the
      // toolbar modal, not the sidebar. Claude sessions use `t` ids.
      const live = (Array.isArray(all) ? all : []).filter((t) => !t.id.startsWith('sh'))
      if (live.length === 0) return
      const byId = new Map(savedSessions.filter((s) => s.terminalId).map((s) => [s.terminalId!, s]))
      setTerminals((prev) => {
        if (prev.length > 0) return prev // already populated (a launch raced the re-attach)
        return live.map((t): TerminalTab => {
          const s = byId.get(t.id)
          return {
            id: t.id,
            key: s?.key ?? crypto.randomUUID(),
            cwd: s?.cwd ?? t.cwd,
            model: s?.model,
            effortLevel: s?.effortLevel,
            permissionMode: s?.permissionMode,
            worktreeBranch: s?.worktreeBranch,
            worktreeBase: s?.worktreeBase,
            sourceCwd: s?.sourceCwd,
            reattached: true, // replay buffered scrollback on mount
          }
        })
      })
      setActiveTerminalId((cur) => cur ?? live[0].id)
      setActiveSessionId((cur) => cur ?? `local-${live[0].id}`)
    }).catch(() => { /* no re-attach */ })
  }, [savedHydrated, savedSessions])

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

  // The toggle swaps mode within the current identity (Mission Control dark ↔
  // Mission Control light), instead of jumping to a different theme.
  const handleToggleTheme = useCallback(() => {
    const nextKey = themeKey(currentTheme.identity, currentTheme.isDark ? 'light' : 'dark')
    const next = themes[nextKey] ?? defaultTheme
    setCurrentTheme(next)
    applyTheme(next)
    localStorage.setItem('operator.theme', themeKey(next.identity, next.mode))
  }, [currentTheme])

  // The picker selects an identity and keeps the current light/dark mode.
  const handleSelectTheme = useCallback((identityId: string) => {
    const mode = currentTheme.isDark ? 'dark' : 'light'
    const next = themes[themeKey(identityId, mode)] ?? defaultTheme
    setCurrentTheme(next)
    applyTheme(next)
    localStorage.setItem('operator.theme', themeKey(next.identity, next.mode))
  }, [currentTheme])

  // Effort map + fan-out membership (per-agent badge), recomputed from the open
  // terminals each render so closing siblings shrinks the totals (see lib/fan-out).
  const { effortLevels, fanInfo } = computeFanMembership(terminals)

  const handleOpenFolderPrefs = useCallback((projectPath: string, projectName: string) => {
    setActiveFolderPrefs({ projectPath, projectName })
    setActiveSessionId(null)
    setActiveTerminalId(null)
    setPendingSession(null)
    setGlobalPrefsActive(false)
    setAgentsViewActive(false)
    setUsageViewActive(false)
    setPrefsViewActive(false)
  }, [])

  // Sidebar entries are only the sessions Operator launched in-app. External
  // Claude Code processes are intentionally not tracked — no OPERATOR_TERMINAL_ID,
  // so nothing arrives without a managed pty.
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
      activity: [],
      activeSubagents: 0,
      lastToolName: null,
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      terminalId: t.id,
    }
  })

  const allSidebarSessions = localSessions

  // Drag-to-reorder in the sidebar: move the dragged session's terminal to sit
  // where the drop target's terminal is, in the canonical `terminals` order
  // (which drives both the sidebar list and ⌘1..9). Sessions are grouped by
  // folder in the sidebar, so dragging the only session in a folder reorders the
  // folders too. (Order is per-run; it isn't persisted across restarts yet.)
  const handleReorderSession = (draggedSessionId: string, targetSessionId: string) => {
    if (draggedSessionId === targetSessionId) return
    const tidOf = (sid: string) => allSidebarSessions.find((s) => s.id === sid)?.terminalId
    const dTid = tidOf(draggedSessionId)
    const tTid = tidOf(targetSessionId)
    if (!dTid || !tTid || dTid === tTid) return
    setTerminals((prev) => {
      const from = prev.findIndex((t) => t.id === dTid)
      const to = prev.findIndex((t) => t.id === tTid)
      if (from < 0 || to < 0) return prev
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

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
  }), [allSidebarSessions])

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
          terminalId: t.id,
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

  // App version (shown next to the name) + a pending update (surfaced as a badge
  // in the sidebar, in addition to the toast).
  const [appVersion, setAppVersion] = useState('')
  const [availableUpdate, setAvailableUpdate] = useState<{ version: string } | null>(null)
  useEffect(() => { window.operator.getVersion?.().then(setAppVersion).catch(() => {}) }, [])

  // Check the public releases feed; prompt to install + restart if an update is
  // available. `manual` adds feedback toasts for the no-update / error cases so
  // an explicit "Check for updates" never looks like it did nothing.
  const runUpdateCheck = useCallback((manual = false) => {
    window.operator.checkUpdate?.().then((u) => {
      if (!u) {
        setAvailableUpdate(null)
        if (manual) pushToast({ text: "Operator is up to date", kind: 'success' })
        return
      }
      setAvailableUpdate(u)
      pushToast({
        text: `Update ${u.version} available`,
        detail: 'Install and restart Operator.',
        action: { label: 'Install & Restart', run: () => { void window.operator.installUpdate() } },
      })
    }).catch(() => {
      if (manual) pushToast({ text: 'Update check failed', detail: 'Could not reach the releases feed.', kind: 'error' })
    })
  }, [pushToast])

  // Check on launch, then re-check every 3h so a long-running instance still
  // notices releases published after it started (the launch-only check missed
  // them — see v0.1.2). Cleared on unmount.
  useEffect(() => {
    runUpdateCheck()
    const id = setInterval(() => runUpdateCheck(), 1000 * 60 * 60 * 3)
    return () => clearInterval(id)
  }, [runUpdateCheck])

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
      if (prevPhase === 'running' && session.phase === 'waiting') {
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
            // Clicking the notification jumps straight to the session it's about.
            onClick: () => handleSelectSession(session),
          })
        })
      }
    }
  }, [sessions, terminals, pushToast, handleSelectSession])

  // Your-turn chime — a soft cue when ANY session finishes its turn
  // (running/compacting → waiting). Separate from the worktree "ready for review"
  // toast above so it fires for every session, worktree or not. The chime itself
  // is gated on the Operator-preferences toggle (off by default).
  const lastSoundPhaseRef = useRef<Record<string, string>>({})
  useEffect(() => {
    for (const s of sessions) {
      const prev = lastSoundPhaseRef.current[s.id]
      lastSoundPhaseRef.current[s.id] = s.phase
      if ((prev === 'running' || prev === 'compacting') && s.phase === 'waiting') {
        playYourTurnChime()
      }
    }
  }, [sessions])

  // Global keyboard shortcuts: Cmd+N new session, Cmd+W close active session,
  // Cmd+1..9 switch to local terminal by index.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Shared predicate with the terminal's key handler (lib/key-routing) so the
      // two can't disagree about which chords belong to the app vs the pty.
      if (!isAppChord(e)) return
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault()
        setPaletteOpen((open) => !open)
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        handleNewSession()
      } else if (e.key === 'b' || e.key === 'B') {
        e.preventDefault()
        toggleSidebar()
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
  }, [handleNewSession, handleCloseSession, handleSelectSession, toggleSidebar, allSidebarSessions, activeSessionId, localTerminalIds, terminals, sessions])

  // Saved sessions not currently open — offered for restore on the splash & palette.
  const restorableSessions = useMemo(() => {
    const liveKeys = new Set(terminals.map((t) => t.key))
    return savedSessions
      .filter((s) => !liveKeys.has(s.key))
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
  }, [savedSessions, terminals])

  // Match on the session id, but fall back to the active terminal: when a session
  // ends it drops out of getSessions() and its sidebar id flips from the hook id
  // to `local-<tid>`, which would otherwise leave activeSessionId stale and
  // activeSession undefined (blank toolbar over a still-open terminal).
  const activeSession =
    allSidebarSessions.find((s) => s.id === activeSessionId) ??
    (activeTerminalId ? allSidebarSessions.find((s) => s.terminalId === activeTerminalId) : undefined)

  // Single source of truth for content area routing. Order = priority.
  const contentMode: 'pendingSession' | 'folderPrefs' | 'globalPrefs' | 'agents' | 'usage' | 'prefs' | 'localTerminal' | 'splash' = useMemo(() => {
    if (pendingSession) return 'pendingSession'
    if (prefsViewActive) return 'prefs'
    if (agentsViewActive) return 'agents'
    if (usageViewActive) return 'usage'
    if (globalPrefsActive) return 'globalPrefs'
    if (activeFolderPrefs) return 'folderPrefs'
    // Only 'localTerminal' if the active id still refers to a live terminal — a
    // stale activeTerminalId (e.g. left set after its tab was removed) would
    // otherwise render neither the terminal container (needs terminals.length>0)
    // nor the splash (needs contentMode==='splash'), i.e. a blank screen.
    if (activeTerminalId && terminals.some((t) => t.id === activeTerminalId)) return 'localTerminal'
    return 'splash'
  }, [pendingSession, prefsViewActive, agentsViewActive, usageViewActive, globalPrefsActive, activeFolderPrefs, activeTerminalId, terminals])

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
      { id: 'prefs', group: 'Settings', label: 'Operator preferences', run: handleOpenPrefs },
      { id: 'globals', group: 'Settings', label: 'Global Claude files', run: handleOpenGlobalPrefs },
      { id: 'check-update', group: 'Settings', label: 'Check for updates', run: () => runUpdateCheck(true) },
      { id: 'theme', group: 'View', label: currentTheme.isDark ? 'Switch to light mode' : 'Switch to dark mode', run: handleToggleTheme },
    )

    // One entry per registered theme, so every palette (incl. Mission Control
    // and 1984) is reachable — not just the binary light/dark toggle.
    identities.forEach(({ id, name }) => {
      actions.push({
        id: `theme-${id}`,
        group: 'View',
        label: `Theme: ${name}${currentTheme.identity === id ? ' ✓' : ''}`,
        detail: currentTheme.isDark ? 'Dark' : 'Light',
        run: () => handleSelectTheme(id),
      })
    })

    return actions
  }, [allSidebarSessions, customNames, recentProjects, restorableSessions, currentTheme, handleSelectSession, handleOpenFolderPrefs, handleNewSession, handleNewSessionInFolder, handleRestoreSession, handleOpenAgents, handleOpenUsage, handleOpenPrefs, handleOpenGlobalPrefs, handleToggleTheme, handleSelectTheme, runUpdateCheck])

  return (
    <div style={{ display: 'flex', width: '100%', height: '100vh', background: 'var(--bg-sidebar)', padding: 8, gap: 8, boxSizing: 'border-box' }}>
      {/* Collapsible wrapper: animates width between the full sidebar (220) and
          the narrow quick-access rail (64). The rail always hosts the macOS
          traffic lights, so the content card never slides under them. */}
      <div
        style={{
          width: sidebarCollapsed ? 64 : 220,
          flexShrink: 0,
          overflow: 'hidden',
          transition: 'width 260ms cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
      {sidebarCollapsed ? (
        <SidebarRail
          sessions={allSidebarSessions}
          activeSessionId={activeSessionId}
          customNames={customNames}
          shortcutIndices={shortcutIndices}
          onSelectSession={handleSelectSession}
          onNewSession={handleNewSession}
          onExpand={toggleSidebar}
        />
      ) : (
      <Sidebar
        sessions={allSidebarSessions}
        activeSessionId={activeSessionId}
        customNames={customNames}
        activeFolderPrefs={activeFolderPrefs?.projectPath ?? null}
        globalPrefsActive={globalPrefsActive}
        agentsViewActive={agentsViewActive}
        usageViewActive={usageViewActive}
        prefsViewActive={prefsViewActive}
        effortLevels={effortLevels}
        fanInfo={fanInfo}
        shortcutIndices={shortcutIndices}
        stats={sidebarStats}
        isDark={currentTheme.isDark}
        onShowDashboard={handleShowDashboard}
        onSelectSession={handleSelectSession}
        onRenameSession={handleRename}
        onCloseSession={handleCloseSession}
        onReorderSession={handleReorderSession}
        onNewSession={handleNewSession}
        onOpenFolderPrefs={handleOpenFolderPrefs}
        onOpenGlobalPrefs={handleOpenGlobalPrefs}
        onOpenAgents={handleOpenAgents}
        onOpenUsage={handleOpenUsage}
        onOpenPrefs={handleOpenPrefs}
        onToggleTheme={handleToggleTheme}
        version={appVersion}
        update={availableUpdate}
        onInstallUpdate={() => { void window.operator.installUpdate() }}
        onToggleCollapse={toggleSidebar}
      />
      )}
      </div>

      <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--bg-terminal)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
        {/* Drag region — full height only when no session toolbar is acting as drag region */}
        {contentMode !== 'localTerminal' && (
          <DragRegion style={{ height: 40, flexShrink: 0 }} />
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

        {contentMode === 'agents' && <AgentLibraryView />}

        {contentMode === 'usage' && <UsageView />}

        {contentMode === 'prefs' && (
          <PrefsView currentTheme={currentTheme} onSelectTheme={handleSelectTheme} onToggleTheme={handleToggleTheme} />
        )}

        {contentMode === 'localTerminal' && activeSession && (() => {
          const tab = terminals.find((t) => t.id === activeTerminalId)
          return (
            <SessionToolbar
              key={activeSession.workingDirectory}
              projectPath={activeSession.workingDirectory}
              projectName={activeSession.projectName}
              terminalId={activeTerminalId}
              detectedDevPort={activeTerminalId ? detectedDevPorts[activeTerminalId] : undefined}
              effortLevel={tab?.effortLevel}
              permissionMode={tab?.permissionMode || activeSession.permissionMode}
              lastToolName={activeSession.lastToolName}
              branch={tab?.worktreeBranch}
              theme={currentTheme.xterm}
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

        {/* Activity timeline — overlays the terminal when viewing activity */}
        {contentMode === 'localTerminal' && activityViewingTerminalId === activeTerminalId && activeSession && (
          <SessionActivityView session={activeSession} />
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
                  replayHistory={t.reattached}
                  active={t.id === activeTerminalId && !t.ended}
                  onDevServerDetected={(port) =>
                    setDetectedDevPorts((m) => (m[t.id] === port ? m : { ...m, [t.id]: port }))
                  }
                />
                {t.ended && (
                  <EndedOverlay
                    onClose={() => {
                      const s = allSidebarSessions.find((x) => x.terminalId === t.id)
                      if (s) handleCloseSession(s)
                      else {
                        setTerminals((prev) => prev.filter((x) => x.id !== t.id))
                        setActiveTerminalId((c) => (c === t.id ? null : c))
                        setActiveSessionId((c) => (c === `local-${t.id}` ? null : c))
                      }
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        {contentMode === 'splash' && allSidebarSessions.length > 0 && (
          <ActivityDashboard
            sessions={allSidebarSessions}
            customNames={customNames}
            onSelectSession={handleSelectSession}
            onNewSession={handleNewSession}
            restorableSessions={restorableSessions}
            recentProjects={recentProjects}
            onRestore={handleRestoreSession}
            onForget={forgetSavedSession}
            onOpenFolder={handleNewSessionInFolder}
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
            <div style={{ marginTop: 'auto', marginBottom: 20 }}><LogoMark size={96} cells={11} /></div>
            <div style={{ textAlign: 'center', marginBottom: 32 }}>
              <p style={{
                fontSize: 13,
                color: 'var(--fg)',
                fontWeight: 500,
                lineHeight: 1.7,
                margin: 0,
              }}>
                Welcome to your mission control.
              </p>
              <p style={{
                fontSize: 12,
                color: 'var(--fg-muted)',
                lineHeight: 1.7,
                margin: '12px 0 0',
              }}>
                Kick off a Claude Code session, hand it to an agent and the model
                that suit the task, and let it work in its own git worktree. You'll
                see every tool call and subagent as it happens.
              </p>
              <p style={{
                fontSize: 11,
                color: 'var(--fg-muted)',
                lineHeight: 1.7,
                margin: '10px 0 0',
                opacity: 0.6,
              }}>
                Got a big job? Fan it out across as many agents as you like —
                and keep an eye on what each one's doing, and what it costs.
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

            <RecentLists
              sessions={restorableSessions}
              projects={recentProjects}
              onRestore={handleRestoreSession}
              onForget={forgetSavedSession}
              onOpenFolder={handleNewSessionInFolder}
            />

            {/* spacer keeps the splash block vertically centered */}
            <div style={{ marginBottom: 'auto' }} />
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

/** Floating pill shown over an ended session's pane — small enough that the
 *  terminal's final frame stays readable behind it. The container ignores
 *  pointer events so only the pill is interactive. */
function EndedOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      style={{
        position: 'absolute', left: 0, right: 0, bottom: 16,
        display: 'flex', justifyContent: 'center',
        pointerEvents: 'none',
        fontFamily: "'Inter', system-ui, sans-serif",
      }}
    >
      <div
        style={{
          pointerEvents: 'auto',
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '6px 8px 6px 12px',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 999,
          boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
          fontSize: 11, color: 'var(--fg-muted)',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--fg-muted)', opacity: 0.55 }} />
          Session ended
        </span>
        <button
          onClick={onClose}
          style={{
            background: 'var(--btn-bg)', color: 'var(--fg)', border: 'none',
            borderRadius: 999, padding: '3px 12px', fontSize: 11, fontWeight: 500,
            cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          Close
        </button>
      </div>
    </div>
  )
}

