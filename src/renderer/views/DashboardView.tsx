import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { AgentSession, SavedSession, Project, Role, ProjectTask, SessionConfig, TaskDiffStat, DispatchRecord } from '../../shared/types'
import { resolveProject } from '../lib/resolve-project'
import { defaultRoster, orchestrationNote } from '../lib/roster'
import { routeDispatch, liveLaneNames } from '../lib/dispatch'
import { submitQueue } from '../lib/submit-queue'
import { fetchTaskDiffStat, taskHasDiffSource } from '../lib/task-diff'
import { Sidebar } from '../components/sidebar/Sidebar'
import { SidebarRail } from '../components/sidebar/SidebarRail'
import { TerminalSurface } from '../components/terminal/TerminalSurface'
import { ShellSheet } from '../components/terminal/ShellSheet'
import { SessionActivityView } from '../components/session/SessionActivityView'
import { FolderPreferencesView } from '../components/preferences/FolderPreferencesView'
import { SessionToolbar } from '../components/session/SessionToolbar'
import { CanvasPanel } from '../components/session/CanvasPanel'
import { CanvasConversation } from '../components/session/CanvasConversation'
import { ProjectView } from '../components/session/ProjectView'
import { AppPreviewPanel } from '../components/session/AppPreviewPanel'
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
  /** Canonical project id (repo root) — links this session to its Project. */
  projectId?: string
  /** Orchestration role (lane) this session was launched against, if any. */
  roleId?: string
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



// Height of the actions footer at the bottom of the main view + Canvas panel. The
// scratch-terminal sheet sits directly above the main footer (bottom = FOOTER_H).
const FOOTER_H = 34
/** Default width (CSS px) of the right side panel (Plan / Diff). */
const CONVERSATION_PANEL_W = 460

// Per-session Canvas layout — each session remembers whether its panel is open and
// which surface it shows. Keyed by session id, persisted across reloads.
// Main content area shows ONE of these (Console = the raw terminal). Chat + Preview can
// fill the main window; Console is the live agent terminal (always mounted underneath).
type MainView = 'terminal' | 'chat' | 'preview'
// The right side panel's tabs. Contextual to the main view: Chat is offered here when the
// main view is Console or Preview (so you can watch the terminal / preview AND read the
// conversation), but dropped in Chat view where it's already the main surface.
type PanelTab = 'plan' | 'diff' | 'chat'
type SessionLayout = { mainView: MainView; panelOpen: boolean; panelTab: PanelTab }
const LAYOUT_KEY = 'operator.sessionLayouts'
const DEFAULT_LAYOUT: SessionLayout = { mainView: 'terminal', panelOpen: false, panelTab: 'plan' }
function loadLayouts(): Record<string, SessionLayout> {
  try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') } catch { return {} }
}

export function DashboardView() {
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [terminals, setTerminals] = useState<TerminalTab[]>([])
  // The port the ACTIVE session is really serving on, from the backend's process-tree
  // walk (session_ports). The project usually ignores the OPERATOR_DEV_PORT we hand it
  // and binds its own default, so this — not the reserved port — is what the toolbar's
  // open-in-browser chip should point at. Only the active session is polled; Preview
  // does its own richer discovery (it needs the full port list for the picker).
  const [detectedDevPort, setDetectedDevPort] = useState<number | undefined>(undefined)
  // Reserved OPERATOR_DEV_PORT per terminal — the Preview falls back to this when
  // no dev-server banner was detected (a best-effort guess; may not be serving).
  const [reservedDevPorts, setReservedDevPorts] = useState<Record<string, number>>({})
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
      const parsed: Record<string, string> = raw ? JSON.parse(raw) : {}
      // Drop `local-<terminalId>` keys on load. Terminal ids are a per-run counter
      // (t0, t1, … — see terminal_spawn), so they REPEAT every launch: a stray
      // `local-t0` left behind by a session that never migrated to its Claude id
      // (below) would silently name the next run's first agent after a dead one.
      // These keys are only meaningful within the run that created them.
      return Object.fromEntries(Object.entries(parsed).filter(([k]) => !k.startsWith('local-')))
    } catch { return {} }
  })
  const [activeFolderPrefs, setActiveFolderPrefs] = useState<{ projectPath: string; projectName: string } | null>(null)
  const [globalPrefsActive, setGlobalPrefsActive] = useState(false)
  const [agentsViewActive, setAgentsViewActive] = useState(false)
  const [usageViewActive, setUsageViewActive] = useState(false)
  const [prefsViewActive, setPrefsViewActive] = useState(false)
  // Project workspace (Agents roster + Moodboard), opened from a project title in the sidebar.
  const [projectView, setProjectView] = useState<{ id: string; tab: 'roster' | 'moodboard' } | null>(null)
  const [reviewingTerminalId, setReviewingTerminalId] = useState<string | null>(null)
  const [activityViewingTerminalId, setActivityViewingTerminalId] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  // Sidebar hide/show — persisted so it survives restarts. The collapse itself
  // is a CSS width/opacity transition on the wrapper (see render).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('operator.sidebarCollapsed') === '1' } catch { return false }
  })
  // Reading panel (ConversationPanel) + Canvas surface — now PER SESSION (each
  // session keeps its own open-state and tab). Keyed by session id, persisted.
  const [sessionLayouts, setSessionLayouts] = useState<Record<string, SessionLayout>>(loadLayouts)
  const activeSessionIdRef = useRef<string | null>(null)
  useEffect(() => { activeSessionIdRef.current = activeSessionId }, [activeSessionId])
  const activeLayout = activeSessionId ? sessionLayouts[activeSessionId] : undefined
  const mainView: MainView = activeLayout?.mainView ?? DEFAULT_LAYOUT.mainView
  const panelOpen = activeLayout?.panelOpen ?? DEFAULT_LAYOUT.panelOpen
  const panelTab: PanelTab = activeLayout?.panelTab ?? DEFAULT_LAYOUT.panelTab
  // Contextual panel tabs: Chat appears after Diff in Console/Preview, not in Chat view.
  // (Roster + Moodboard are PROJECT-level now — they live in the ProjectView opened from the
  // project title, not per-session here.)
  const panelTabs: PanelTab[] = mainView === 'chat'
    ? ['plan', 'diff']
    : ['plan', 'diff', 'chat']
  const effPanelTab: PanelTab = panelTabs.includes(panelTab) ? panelTab : 'plan'
  const patchLayout = useCallback((patch: Partial<SessionLayout>) => {
    setSessionLayouts((prev) => {
      const sid = activeSessionIdRef.current
      if (!sid) return prev
      const next = { ...prev, [sid]: { ...DEFAULT_LAYOUT, ...prev[sid], ...patch } }
      try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(next)) } catch { /* quota */ }
      return next
    })
  }, [])
  const selectMainView = useCallback((v: MainView) => patchLayout({ mainView: v }), [patchLayout])
  const selectPanelTab = useCallback((t: PanelTab) => patchLayout({ panelTab: t }), [patchLayout])
  // User-adjustable right side-panel width (drag handle on its left edge), persisted.
  const [panelW, setPanelW] = useState<number>(() => {
    try { const v = parseInt(localStorage.getItem('operator.canvasWidth') || '', 10); return v >= 300 && v <= 1000 ? v : CONVERSATION_PANEL_W } catch { return CONVERSATION_PANEL_W }
  })
  const panelWRef = useRef(panelW); panelWRef.current = panelW
  // True while dragging the panel divider — the terminal suspends its fit during the drag.
  const [resizingPanel, setResizingPanel] = useState(false)
  // True while the OS window is actively resizing/zooming (edge-drag, titlebar
  // double-click maximize, display change). Same reason as the panel drag: each
  // ghostty fit reallocates the Canvas backing store, and doing that repeatedly
  // through a window zoom thrashes the WKWebView compositor into a hang. We suspend
  // the terminal's fit while the window churns and let it fit once after it settles.
  const [windowResizing, setWindowResizing] = useState(false)
  useEffect(() => {
    let settle = 0
    const unsub = window.operator.onWindowResize?.(() => {
      setWindowResizing(true)
      clearTimeout(settle)
      settle = window.setTimeout(() => setWindowResizing(false), 200)
    })
    return () => { clearTimeout(settle); unsub?.() }
  }, [])
  // Open/close the right side panel (Plan / Diff / Preview). Per-session (ref avoids a stale id).
  const togglePanel = useCallback(() => {
    patchLayout({ panelOpen: !(activeSessionIdRef.current ? sessionLayouts[activeSessionIdRef.current]?.panelOpen : false) })
  }, [patchLayout, sessionLayouts])
  // ⌘J flips the main view between Console (terminal) and Chat.
  const toggleChat = useCallback(() => {
    const cur = activeSessionIdRef.current ? sessionLayouts[activeSessionIdRef.current]?.mainView : undefined
    patchLayout({ mainView: cur === 'chat' ? 'terminal' : 'chat' })
  }, [patchLayout, sessionLayouts])

  // Scratch terminal (ShellSheet) — opens as a bottom sheet from the main actions
  // footer. `shellStarted` keeps it MOUNTED after first open (so the shell +
  // scrollback survive close→reopen); `shellOpen` slides it up/down.
  const [shellStarted, setShellStarted] = useState(false)
  const [shellOpen, setShellOpen] = useState(false)
  // Preview mode (Interact ↔ Annotate) — lifted here so ⌘E can toggle it globally.
  const [previewAnnotate, setPreviewAnnotate] = useState(false)
  const openShell = useCallback(() => { setShellStarted(true); setShellOpen(true) }, [])
  const closeShell = useCallback(() => setShellOpen(false), [])

  // The scratch shell is per-session: its state lived globally, so opening it once
  // left it mounted+open (and a second ghostty canvas rendering → overprint) in EVERY
  // session. Tear it down on session switch — the ShellSheet unmounts, killing its
  // pty — so the hub belongs only to the session it was opened in.
  useEffect(() => {
    setShellOpen(false)
    setShellStarted(false)
  }, [activeSessionId])

  // Drag the right panel's left edge to resize it — rAF-throttled, and the terminal
  // suspends fitting until release for a smooth drag.
  const startPanelResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = panelWRef.current
    setResizingPanel(true)
    let raf = 0
    let target = startW
    const apply = () => { raf = 0; setPanelW(target) }
    const onMove = (ev: MouseEvent) => {
      target = Math.min(1000, Math.max(300, Math.round(startW + (startX - ev.clientX))))
      if (!raf) raf = requestAnimationFrame(apply)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (raf) cancelAnimationFrame(raf)
      setPanelW(target)
      setResizingPanel(false)
      document.body.style.cursor = ''
      try { localStorage.setItem('operator.canvasWidth', String(target)) } catch { /* ignore */ }
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // Keep the reserved-port map fresh (changes as sessions spawn) so Preview can
  // fall back to it when no dev-server banner was detected.
  useEffect(() => {
    let cancelled = false
    const load = () => window.operator.getDevPorts?.().then((p) => { if (!cancelled) setReservedDevPorts(p || {}) }).catch(() => { /* */ })
    load()
    const iv = setInterval(load, 5000)
    return () => { cancelled = true; clearInterval(iv) }
  }, [])

  // The active session's live dev-server port, for the toolbar chip. Reset to
  // undefined on switch so the chip can't briefly point at the previous session's app.
  useEffect(() => {
    setDetectedDevPort(undefined)
    if (!activeTerminalId) return
    let cancelled = false
    const load = () => {
      window.operator.sessionPorts?.(activeTerminalId)
        .then((ps) => { if (!cancelled) setDetectedDevPort(ps?.[0]) })
        .catch(() => { /* best-effort */ })
    }
    load()
    const iv = setInterval(load, 5000)
    return () => { cancelled = true; clearInterval(iv) }
  }, [activeTerminalId])

  // True during the sidebar's 260ms width animation — the terminal suspends its fit
  // while the content column animates, then fits once on settle. Without this the
  // ghostty grid reflowed every frame of the collapse/expand → overprint corruption.
  const [sidebarAnimating, setSidebarAnimating] = useState(false)
  const sidebarAnimTimer = useRef(0)
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((c) => {
      const next = !c
      try { localStorage.setItem('operator.sidebarCollapsed', next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
    setSidebarAnimating(true)
    clearTimeout(sidebarAnimTimer.current)
    sidebarAnimTimer.current = window.setTimeout(() => setSidebarAnimating(false), 320)
  }, [])

  const pushToast = useCallback((message: Omit<ToastMessage, 'id'>) => {
    setToasts((prev) => [...prev, { ...message, id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }])
  }, [])

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])
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
      exitCompleteRef.current(id) // a lane's session ended → its running tasks are done
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

  const handleOpenGlobalPrefs = useCallback(() => {
    setGlobalPrefsActive(true)
    setAgentsViewActive(false)
    setUsageViewActive(false)
    setPrefsViewActive(false)
    setActiveFolderPrefs(null)
    setActiveSessionId(null)
    setActiveTerminalId(null)
  }, [])

  const handleOpenAgents = useCallback(() => {
    setAgentsViewActive(true)
    setPrefsViewActive(false)
    setUsageViewActive(false)
    setGlobalPrefsActive(false)
    setActiveFolderPrefs(null)
    setActiveSessionId(null)
    setActiveTerminalId(null)
  }, [])

  const handleOpenUsage = useCallback(() => {
    setUsageViewActive(true)
    setAgentsViewActive(false)
    setPrefsViewActive(false)
    setGlobalPrefsActive(false)
    setActiveFolderPrefs(null)
    setActiveSessionId(null)
    setActiveTerminalId(null)
  }, [])

  const handleOpenPrefs = useCallback(() => {
    setPrefsViewActive(true)
    setAgentsViewActive(false)
    setUsageViewActive(false)
    setGlobalPrefsActive(false)
    setActiveFolderPrefs(null)
    setActiveSessionId(null)
    setActiveTerminalId(null)
    setProjectView(null)
  }, [])

  // A recent-project click: open its workspace if we already know it as a Project (so you can
  // launch/manage its agents even with nothing live), else fall back to starting fresh there.
  // Open a project's workspace (Agents roster + Moodboard) — from its title in the sidebar.
  // Clears the active session so the project area can surface (see contentMode).
  const handleOpenProject = useCallback((projectId: string) => {
    setProjectView((prev) => ({ id: projectId, tab: prev?.id === projectId ? prev.tab : 'roster' }))
    setPrefsViewActive(false)
    setAgentsViewActive(false)
    setUsageViewActive(false)
    setGlobalPrefsActive(false)
    setActiveFolderPrefs(null)
    setActiveSessionId(null)
    setActiveTerminalId(null)
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
    setProjectView(null)
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

  // Projects: the durable top-level unit (a folder/repo owning many sessions over time).
  // Seeded from localStorage for instant render, reconciled with ~/.operator/projects.json
  // on hydrate (below), and migrated from prior session/recent data on first run.
  const [projects, setProjects] = useState<Project[]>(() => {
    try {
      const raw = localStorage.getItem('operator.projects')
      return raw ? JSON.parse(raw) : []
    } catch { return [] }
  })

  // Create-or-touch a project by id: fills missing defaults, bumps lastActiveAt, and keeps
  // any user rename (existing name wins). The single mutation point for the projects store.
  const upsertProject = useCallback((r: { id: string; path: string; name: string }, opts?: { defaults?: Project['defaults'] }) => {
    const now = new Date().toISOString()
    setProjects((prev) => {
      const existing = prev.find((p) => p.id === r.id)
      if (existing) {
        return prev.map((p) => p.id === r.id
          ? { ...p, path: r.path, name: p.name || r.name, lastActiveAt: now, defaults: p.defaults ?? opts?.defaults }
          : p)
      }
      // New project → seed the default orchestration roster (editable afterwards).
      return [...prev, { id: r.id, path: r.path, name: r.name, createdAt: now, lastActiveAt: now, defaults: opts?.defaults, roster: defaultRoster() }]
    })
  }, [])

  // Patch a project by id (roster edits, rename, …) and persist via the effect below.
  const updateProject = useCallback((id: string, patch: Partial<Project>) => {
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }, [])

  // Open a folder as its Project workspace (Agents/Roster) — this is now how "New Session"
  // / picking a folder works: no ad-hoc single-session form, land straight on the roster so
  // the user picks/tunes agent lanes and launches from there (RosterPanel's Launch/Launch all).
  // Registers the project (seeding the default roster) if this is the first time we've seen
  // it; launches nothing itself.
  const openFolderAsProject = useCallback(async (cwd: string) => {
    const proj = await resolveProject(cwd)
    upsertProject(proj)
    rememberRecent(proj.path)
    setRecentProjects((prev) => {
      const filtered = prev.filter((p) => p.path !== proj.path)
      return [{ path: proj.path, name: proj.name, lastUsedAt: new Date().toISOString() }, ...filtered].slice(0, 10)
    })
    handleOpenProject(proj.id)
  }, [upsertProject, rememberRecent, handleOpenProject])

  const handleNewSession = useCallback(async () => {
    const folder = await window.operator.pickFolder()
    if (folder) await openFolderAsProject(folder)
  }, [openFolderAsProject])

  const handleNewSessionInFolder = useCallback((cwd: string) => {
    void openFolderAsProject(cwd)
  }, [openFolderAsProject])

  // --- Project task backlog (race-safe functional updates) ------------------------------
  const addProjectTask = useCallback((projectId: string, text: string, roleId?: string) => {
    const t = text.trim()
    if (!t) return
    const task: ProjectTask = { id: crypto.randomUUID(), text: t, roleId, createdAt: new Date().toISOString() }
    setProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, tasks: [...(p.tasks ?? []), task] } : p)))
  }, [])
  const assignProjectTask = useCallback((projectId: string, taskId: string, roleId?: string) => {
    setProjects((prev) => prev.map((p) => (p.id === projectId
      ? { ...p, tasks: (p.tasks ?? []).map((t) => (t.id === taskId ? { ...t, roleId } : t)) }
      : p)))
  }, [])
  const removeProjectTasks = useCallback((projectId: string, ids: string[]) => {
    const idset = new Set(ids)
    setProjects((prev) => prev.map((p) => (p.id === projectId
      ? { ...p, tasks: (p.tasks ?? []).filter((t) => !idset.has(t.id)) }
      : p)))
  }, [])
  // Where a task's lane ran — stamped onto the task at dispatch so its diff stays
  // resolvable after the session (worktree lanes: dir + surviving branch/base).
  type TaskLane = { cwd?: string; sourceCwd?: string; worktreeBranch?: string; worktreeBase?: string }
  const laneOf = (tab?: { cwd: string; sourceCwd?: string; worktreeBranch?: string; worktreeBase?: string }): TaskLane | undefined =>
    tab ? { cwd: tab.cwd, sourceCwd: tab.sourceCwd, worktreeBranch: tab.worktreeBranch, worktreeBase: tab.worktreeBase } : undefined
  // Latest projects snapshot for async task helpers (diff capture) without re-subscribing.
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  // Lifecycle transitions. Dispatching a task marks it running (with its lane) instead of
  // deleting it, so it stays visible until done. `terminalId` is optional — the lane pickup
  // path doesn't know the new terminal id yet, so it matches on roleId for auto-complete.
  const markTasksRunning = useCallback((projectId: string, ids: string[], terminalId?: string, lane?: TaskLane) => {
    if (!ids.length) return
    const idset = new Set(ids)
    const now = new Date().toISOString()
    setProjects((prev) => prev.map((p) => (p.id === projectId
      ? { ...p, tasks: (p.tasks ?? []).map((t) => (idset.has(t.id)
        ? { ...t, status: 'running' as const, startedAt: t.startedAt ?? now, terminalId: terminalId ?? t.terminalId, ...(lane ?? {}) }
        : t)) }
      : p)))
  }, [])
  // Verification gate: stamp + run the project's check command in the lane's dir when
  // tasks complete. Fire-and-await per lane; the close path chains worktree removal
  // behind it so the dir survives until the check finishes.
  const stampTaskCheck = useCallback((projectId: string, ids: string[], check: ProjectTask['check']) => {
    const idset = new Set(ids)
    setProjects((prev) => prev.map((p) => (p.id === projectId
      ? { ...p, tasks: (p.tasks ?? []).map((t) => (idset.has(t.id) ? { ...t, check } : t)) }
      : p)))
  }, [])
  const runTaskChecks = useCallback(async (projectId: string, ids: string[], cwd?: string) => {
    const cmd = projectsRef.current.find((p) => p.id === projectId)?.checkCommand?.trim()
    if (!cmd || !ids.length || !cwd) return
    stampTaskCheck(projectId, ids, { status: 'running', at: new Date().toISOString() })
    const res = await window.operator.runCheck(cwd, cmd).catch((e) => ({ ok: false, output: String(e) }))
    stampTaskCheck(projectId, ids, { status: res.ok ? 'pass' : 'fail', output: res.output, at: new Date().toISOString() })
  }, [stampTaskCheck])

  // Attach the captured change summary (files/+/−) to completed tasks.
  const attachTaskDiffStats = useCallback((projectId: string, ids: string[], stat?: TaskDiffStat) => {
    if (!stat || !ids.length) return
    const idset = new Set(ids)
    setProjects((prev) => prev.map((p) => (p.id === projectId
      ? { ...p, tasks: (p.tasks ?? []).map((t) => (idset.has(t.id) ? { ...t, diffStat: stat } : t)) }
      : p)))
  }, [])
  const setTaskStatus = useCallback((projectId: string, id: string, status: ProjectTask['status']) => {
    setProjects((prev) => prev.map((p) => (p.id === projectId
      ? { ...p, tasks: (p.tasks ?? []).map((t) => (t.id === id ? { ...t, status, doneAt: status === 'done' ? new Date().toISOString() : t.doneAt } : t)) }
      : p)))
    // Manual "Done ✓": capture the task's change summary while its dir/branch still
    // resolves, and run the verification gate in its dir.
    if (status === 'done') {
      const task = projectsRef.current.find((p) => p.id === projectId)?.tasks?.find((t) => t.id === id)
      if (task && !task.diffStat && taskHasDiffSource(task)) {
        void fetchTaskDiffStat(task).then((stat) => attachTaskDiffStats(projectId, [id], stat))
      }
      if (task && !task.check) void runTaskChecks(projectId, [id], task.cwd)
    }
  }, [attachTaskDiffStats, runTaskChecks])
  // Record a task that's ALREADY running (orchestrator dispatched it straight to a live lane).
  const addRunningTask = useCallback((projectId: string, text: string, roleId: string, terminalId: string, lane?: TaskLane) => {
    const t = text.trim()
    if (!t) return
    const now = new Date().toISOString()
    const task: ProjectTask = { id: crypto.randomUUID(), text: t, roleId, status: 'running', terminalId, createdAt: now, startedAt: now, ...(lane ?? {}) }
    setProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, tasks: [...(p.tasks ?? []), task] } : p)))
  }, [])
  // When a lane's session ends, its still-running tasks are treated as done (auto-complete).
  // Also captures each task's diff summary — awaited by the close path BEFORE it removes the
  // worktree, so the stat survives the dir. `lane` backfills provenance the pickup path missed.
  const completeTerminalTasks = useCallback(async (terminalId: string, roleId?: string, projectId?: string, lane?: TaskLane) => {
    const now = new Date().toISOString()
    const isMatch = (t: ProjectTask) =>
      t.status === 'running' && (t.terminalId === terminalId || (!!roleId && t.roleId === roleId && !t.terminalId))
    const matched: { projectId: string; ids: string[]; task: ProjectTask }[] = []
    for (const p of projectsRef.current) {
      if (projectId && p.id !== projectId) continue
      const hits = (p.tasks ?? []).filter(isMatch)
      if (hits.length) matched.push({ projectId: p.id, ids: hits.map((t) => t.id), task: hits[0] })
    }
    setProjects((prev) => prev.map((p) => {
      if (projectId && p.id !== projectId) return p
      const tasks = (p.tasks ?? []).map((t) => (isMatch(t)
        ? { ...t, status: 'done' as const, doneAt: now, cwd: t.cwd ?? lane?.cwd, sourceCwd: t.sourceCwd ?? lane?.sourceCwd, worktreeBranch: t.worktreeBranch ?? lane?.worktreeBranch, worktreeBase: t.worktreeBase ?? lane?.worktreeBase }
        : t))
      return tasks === p.tasks ? p : { ...p, tasks }
    }))
    // One capture per lane (all matched tasks shared the terminal/role → same diff),
    // then the verification gate — awaited so a worktree close removes the dir only
    // after the check has run in it.
    for (const m of matched) {
      const src = lane ?? m.task
      if (taskHasDiffSource(src)) {
        const stat = await fetchTaskDiffStat(src).catch(() => undefined)
        attachTaskDiffStats(m.projectId, m.ids, stat)
      }
      await runTaskChecks(m.projectId, m.ids, src.cwd)
    }
  }, [attachTaskDiffStats, runTaskChecks])
  // Fresh closure over terminals + completeTerminalTasks for the mount-time exit subscription.
  const exitCompleteRef = useRef<(id: string) => void>(() => {})
  exitCompleteRef.current = (id: string) => {
    const tab = terminals.find((t) => t.id === id)
    if (tab?.projectId) void completeTerminalTasks(id, tab.roleId, tab.projectId, laneOf(tab))
  }

  // Append a routed dispatch to the project's activity log (capped tail, newest last).
  const logDispatch = useCallback((projectId: string, rec: DispatchRecord) => {
    setProjects((prev) => prev.map((p) => (p.id === projectId
      ? { ...p, dispatches: [...(p.dispatches ?? []), rec].slice(-100) }
      : p)))
  }, [])

  // --- Orchestrator dispatch routing ----------------------------------------------------
  // An agent emitted `OPERATOR-DISPATCH [role] task`; the backend parsed it and fires the
  // event. Route it to the target lane WITHIN the emitting session's project: a live lane
  // gets the task typed into its pty (no focus steal); an idle lane gets it QUEUED (we don't
  // auto-spawn agents from model output — the user launches, keeping a human in the loop).
  // Latest routing inputs held in a ref so the subscription is set up once (no missed events).
  const dispatchRef = useRef({ terminals, projects, addProjectTask, addRunningTask, pushToast, logDispatch })
  dispatchRef.current = { terminals, projects, addProjectTask, addRunningTask, pushToast, logDispatch }
  useEffect(() => {
    const SEEN_KEY = 'operator.dispatch.seen'
    const unsub = window.operator.onOrchestratorDispatch?.((d) => {
      let seen: string[] = []
      try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]') } catch { /* */ }
      if (seen.includes(d.id)) return // already handled (dedupe across transcript re-reads)
      try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, d.id].slice(-500))) } catch { /* */ }

      const { terminals: tabs, projects: projs, addProjectTask: addTask, addRunningTask: addRunning, pushToast: toast, logDispatch: log } = dispatchRef.current
      const srcTab = tabs.find((t) => t.id === d.terminalId)
      const project = srcTab?.projectId ? projs.find((p) => p.id === srcTab.projectId) : undefined
      if (!project) return
      const roster = project.roster ?? []
      const route = routeDispatch(d.role, roster, tabs, project.id)
      const routedRole = route.kind === 'unassigned' ? undefined : route.role
      const preview = d.task.length > 60 ? d.task.slice(0, 60) + '…' : d.task
      const record = (outcome: DispatchRecord['outcome']) =>
        log(project.id, { id: d.id, at: new Date().toISOString(), fromRoleId: srcTab?.roleId, toRoleId: routedRole?.id, task: d.task, outcome })
      // A dispatch to an idle/unknown lane is QUEUED, not started — but the orchestrator
      // gets no runtime signal of that and keeps coordinating as if the work is live. Type
      // a status note back into ITS pty so it can adapt (reassign to a live lane, or ask
      // the user to launch). We deliberately DON'T auto-spawn or auto-reroute here — the
      // decision stays with the agent (in the loop). Naming the currently-live lanes (routing
      // logic + the ended-lane guard live in lib/dispatch) lets it reassign informedly. Dedupe
      // by dispatch id (above) bounds any re-dispatch loop: the same task→role re-emitted is
      // dropped before it reaches here. The note carries no OPERATOR-DISPATCH token, so it
      // isn't itself parsed.
      const feedback = (msg: string) => {
        if (!srcTab) return
        const live = liveLaneNames(tabs, roster, project.id, srcTab.id)
        const liveHint = live.length ? ` Lanes running now: ${live.join(', ')}.` : ' No other lanes are running.'
        void submitQueue.submit(srcTab.id, `[Operator] ${msg}${liveHint}`)
      }
      if (route.kind === 'send') {
        const { role, tab } = route
        // Queued, not written directly: a coordinator that emits several dispatches at once
        // would otherwise land them faster than the TUI commits each paste, merging them into
        // one composer draft that never runs as separate turns (see lib/submit-queue).
        void submitQueue.submit(tab.id, d.task)
        // track it as running on the lane (with its dir, so the diff link resolves)
        addRunning(project.id, d.task, role.id, tab.id, { cwd: tab.cwd, sourceCwd: tab.sourceCwd, worktreeBranch: tab.worktreeBranch, worktreeBase: tab.worktreeBase })
        record('sent')
        toast({ text: `Dispatched to ${role.name}`, kind: 'info', detail: preview })
      } else if (route.kind === 'queue') {
        addTask(project.id, d.task, route.role.id) // idle lane → queued (user launches)
        record('queued')
        toast({ text: `Queued for ${route.role.name}`, kind: 'info', detail: preview })
        feedback(`The "${route.role.name}" lane is not running, so your task was QUEUED, not started. Reassign it to a lane that's live now, or ask the user to launch ${route.role.name}.`)
      } else {
        addTask(project.id, d.task) // unknown role → unassigned backlog
        record('unassigned')
        toast({ text: 'Queued (unassigned)', kind: 'info', detail: preview })
        feedback(`No lane named "${d.role}" exists in this project, so your task went to the unassigned backlog. Reassign it to one of the project's actual lanes, or ask the user.`)
      }
    })
    return () => { unsub?.() }
  }, [])

  // A recent-project click: open its workspace if we already know it as a Project (so you can
  // launch/manage its agents even with nothing live), else fall back to starting fresh there.
  const openProjectOrFolder = useCallback((path: string) => {
    const proj = projects.find((p) => p.path === path)
    if (proj) handleOpenProject(proj.id)
    else handleNewSessionInFolder(path)
  }, [projects, handleOpenProject, handleNewSessionInFolder])

  // One-time, non-destructive backfill: derive Projects from existing saved sessions +
  // recent-project paths (mapping each unique source path through resolveProject → canonical
  // repo root), and stamp projectId onto those sessions. Only runs when projects.json is empty.
  const migrateProjects = useCallback(async (saved: SavedSession[]): Promise<{ projects: Project[]; sessions: SavedSession[] }> => {
    const paths = new Set<string>()
    for (const s of saved) paths.add(s.sourceCwd ?? s.cwd)
    try {
      const raw = localStorage.getItem('operator.recentProjects')
      const recents: Array<{ path?: string }> = raw ? JSON.parse(raw) : []
      for (const r of recents) if (r?.path) paths.add(r.path)
    } catch { /* ignore */ }

    const byPath = new Map<string, { id: string; path: string; name: string }>()
    for (const p of paths) {
      try { byPath.set(p, await resolveProject(p)) } catch { /* skip unresolvable */ }
    }

    const sessions = saved.map((s) => {
      const res = byPath.get(s.sourceCwd ?? s.cwd)
      return res ? { ...s, projectId: res.id } : s
    })

    const now = new Date().toISOString()
    const projById = new Map<string, Project>()
    for (const res of byPath.values()) {
      if (!projById.has(res.id)) {
        projById.set(res.id, { id: res.id, path: res.path, name: res.name, createdAt: now, lastActiveAt: '' })
      }
    }
    // Seed lastActiveAt from the newest contributing session.
    for (const s of sessions) {
      if (!s.projectId) continue
      const proj = projById.get(s.projectId)
      if (proj && s.lastActiveAt > proj.lastActiveAt) proj.lastActiveAt = s.lastActiveAt
    }
    for (const proj of projById.values()) {
      if (!proj.lastActiveAt) proj.lastActiveAt = now
      proj.createdAt = proj.lastActiveAt // best-effort; no earlier signal survives
    }
    return { projects: [...projById.values()], sessions }
  }, [])

  // Block file-writes until the durable store has been read, so we never clobber
  // it with the (possibly staler) localStorage seed on launch.
  const [savedHydrated, setSavedHydrated] = useState(false)
  useEffect(() => {
    const sp = window.operator.loadSessions?.()
    if (!sp) { setSavedHydrated(true); return } // no file store (e.g. Electron) — localStorage only
    const pp = window.operator.loadProjects?.() ?? Promise.resolve([])
    Promise.all([sp, pp]).then(async ([sList, pList]) => {
      const hasSaved = Array.isArray(sList) && sList.length > 0
      const saved = (hasSaved ? sList : savedSessions) as SavedSession[]
      let nextSaved: SavedSession[] = saved
      if (Array.isArray(pList) && pList.length) {
        setProjects(pList as Project[]) // projects.json exists → no migration
      } else {
        try {
          const migrated = await migrateProjects(saved)
          if (migrated.projects.length) {
            setProjects(migrated.projects)
            window.operator.saveProjects?.(migrated.projects)
            try { localStorage.setItem('operator.projects', JSON.stringify(migrated.projects)) } catch { /* quota */ }
            nextSaved = migrated.sessions // projectId backfilled in-memory too
          }
        } catch { /* a migration failure must never block hydration */ }
      }
      if (hasSaved || nextSaved !== saved) setSavedSessions(nextSaved)
      setSavedHydrated(true)
    }).catch(() => setSavedHydrated(true))
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
            projectId: s?.projectId,
            roleId: s?.roleId,
            reattached: true, // replay buffered scrollback on mount
          }
        })
      })
      setActiveTerminalId((cur) => cur ?? live[0].id)
      setActiveSessionId((cur) => cur ?? `local-${live[0].id}`)
    }).catch(() => { /* no re-attach */ })
  }, [savedHydrated, savedSessions])

  const handleLaunchSession = useCallback(async (cwd: string, config: SessionConfig, opts?: { roleId?: string; orchestrationNote?: string }): Promise<TerminalTab[]> => {
    // Write effort level to global settings (Claude Code reads it from there)
    const prefs = await window.operator.folderPrefsLoad(cwd)
    const globalFile = prefs.settingsFiles.find((f) => f.scope === 'global')
    if (globalFile) {
      await window.operator.folderPrefsSaveSettings(globalFile.path, { effortLevel: config.effortLevel })
    }

    // Resolve the project once (canonical repo root) — all fan-out agents of this launch,
    // worktrees included, belong to the same source project.
    const proj = await resolveProject(cwd)

    // Fan-out: launch the same task on N agents, each in its own worktree.
    const count = Math.max(1, config.count || 1)
    const fanGroup = count > 1 ? crypto.randomUUID() : undefined
    const spawned: TerminalTab[] = []

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
      // "Launch dev server" → ask the agent (single session only; fan-out worktrees would
      // collide on ports) to start it in the background on its reserved port, before any task.
      const devInstr = config.launchDevServer && count === 1
        ? "First, start this project's dev server in the BACKGROUND on the port Operator reserved for you (named in your system prompt — pass it via --port or the PORT env), and don't block the terminal on it."
        : ''
      const initial = [devInstr, config.prompt].filter(Boolean).join('\n\n')
      if (initial) launchOptions.initialPrompt = initial
      if (opts?.orchestrationNote) launchOptions.orchestrationNote = opts.orchestrationNote

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
        projectId: proj.id,
        roleId: opts?.roleId,
        fanGroup,
        fanIndex: fanGroup ? i + 1 : undefined,
        fanTotal: fanGroup ? count : undefined,
      }
      setTerminals((prev) => [...prev, tab])
      spawned.push(tab)
      // Focus the first agent; the rest run in the background.
      if (i === 0) {
        setActiveTerminalId(result.terminalId)
        setActiveSessionId(`local-${result.terminalId}`)
        setProjectView(null) // launching switches to the new agent's console
      }
    }

    rememberRecent(cwd)
    upsertProject(proj, { defaults: { model: config.model, effortLevel: config.effortLevel, permissionMode: config.permissionMode } })
    setRecentProjects((prev) => {
      const name = cwd.split('/').pop() || cwd
      const filtered = prev.filter((p) => p.path !== cwd)
      return [{ path: cwd, name, lastUsedAt: new Date().toISOString() }, ...filtered].slice(0, 10)
    })
    return spawned
  }, [rememberRecent, upsertProject])

  // Orchestration: launch a session on a project's role (lane) — spawns in the project
  // root with the role's model/effort/permission and tags the session with roleId. An
  // optional `prompt` is handed to Claude as the first message (delegation).
  const handleLaunchRole = useCallback(async (project: Project, role: Role, prompt?: string, launchDevServer = false) => {
    // Auto-awareness: tell the agent its lane + its siblings (see orchestrationNote).
    const note = project.roster ? orchestrationNote(project.name, role, project.roster) : undefined
    // The agent picks up its assigned QUEUED tasks as its opening work; they move to running
    // (kept visible under this lane) rather than vanishing.
    const queued = (project.tasks ?? []).filter((t) => t.roleId === role.id && (t.status ?? 'queued') === 'queued')
    const taskBlock = queued.length
      ? `Please work through these tasks:\n${queued.map((t, i) => `${i + 1}. ${t.text}`).join('\n')}`
      : ''
    const combined = [prompt?.trim(), taskBlock].filter(Boolean).join('\n\n')
    if (queued.length) markTasksRunning(project.id, queued.map((t) => t.id)) // claim first (no double pickup)
    const tabs = await handleLaunchSession(
      project.path,
      {
        effortLevel: role.effort ?? 'high',
        permissionMode: (role.permissionMode as SessionConfig['permissionMode']) ?? 'default',
        model: role.model,
        allowedTools: '',
        useWorktree: !!role.useWorktree, // isolated lane → attributable diff + merge-back
        launchDevServer,
        count: 1,
        prompt: combined,
      },
      { roleId: role.id, orchestrationNote: note },
    )
    // Now the terminal (and worktree) exist — stamp the picked-up tasks with their lane.
    if (tabs[0] && queued.length) markTasksRunning(project.id, queued.map((t) => t.id), tabs[0].id, laneOf(tabs[0]))
  }, [handleLaunchSession, markTasksRunning])

  // Focus an already-live lane/session (the "View" action — vs "Launch" which spawns a new one).
  const focusTerminal = useCallback((terminalId: string) => {
    if (!terminals.some((t) => t.id === terminalId)) return
    setActiveTerminalId(terminalId)
    const hook = sessions.find((s) => s.terminalId === terminalId)
    setActiveSessionId(hook?.id ?? `local-${terminalId}`)
    setProjectView(null) // reveal the session's console
  }, [terminals, sessions])

  // Delegation: send a task to a lane. If the lane has a live session, type it into that pty
  // (bracketed paste + CR) and focus it; otherwise launch the lane with the task. The
  // autonomous "orchestrator delegates on its own" remains the deferred structured-UI path.
  const dispatchToRole = useCallback((project: Project, role: Role, task: string) => {
    const t = task.trim()
    if (!t) return
    const liveTab = terminals.find((tab) => tab.projectId === project.id && tab.roleId === role.id)
    if (liveTab) {
      void submitQueue.submit(liveTab.id, t)
      setActiveTerminalId(liveTab.id)
      setActiveSessionId(`local-${liveTab.id}`)
    } else {
      void handleLaunchRole(project, role, t)
    }
  }, [terminals, handleLaunchRole])

  // Send one queued task: to a live lane's pty, or (if the lane isn't up) launch it — which
  // picks up the whole queue for that lane, this task included.
  const sendProjectTask = useCallback((project: Project, task: ProjectTask) => {
    const role = project.roster?.find((r) => r.id === task.roleId)
    if (!role) return
    const liveTab = terminals.find((t) => t.projectId === project.id && t.roleId === role.id)
    if (liveTab) {
      dispatchToRole(project, role, task.text)
      markTasksRunning(project.id, [task.id], liveTab.id, laneOf(liveTab)) // now running on this lane
    } else {
      void handleLaunchRole(project, role) // launch picks up its queue (incl. this task → running)
    }
  }, [terminals, dispatchToRole, handleLaunchRole, markTasksRunning])

  // "Start all": dispatch every ASSIGNED, still-QUEUED task, grouped per lane — live lanes get
  // the combined message (→ running), idle lanes launch and pick up their queue.
  const startProjectTasks = useCallback((project: Project) => {
    const byRole = new Map<string, ProjectTask[]>()
    for (const t of project.tasks ?? []) {
      if (!t.roleId || (t.status ?? 'queued') !== 'queued') continue
      const arr = byRole.get(t.roleId) ?? []
      arr.push(t); byRole.set(t.roleId, arr)
    }
    for (const [roleId, tasks] of byRole) {
      const role = project.roster?.find((r) => r.id === roleId)
      if (!role) continue
      const liveTab = terminals.find((t) => t.projectId === project.id && t.roleId === roleId)
      if (liveTab) {
        const text = tasks.map((t, i) => `${i + 1}. ${t.text}`).join('\n')
        dispatchToRole(project, role, `Please work through these tasks:\n${text}`)
        markTasksRunning(project.id, tasks.map((t) => t.id), liveTab.id, laneOf(liveTab))
      } else {
        void handleLaunchRole(project, role) // picks up its queue
      }
    }
  }, [terminals, dispatchToRole, handleLaunchRole, markTasksRunning])

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

    // Resolve the project (canonical repo root) — always, so an old saved session with no
    // projectId gets backfilled and the project's lastActiveAt is touched on reopen.
    const proj = await resolveProject(saved.sourceCwd ?? saved.cwd)

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
      projectId: saved.projectId ?? proj.id,
      roleId: saved.roleId,
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
    upsertProject(proj)
    setActiveFolderPrefs(null)
    setGlobalPrefsActive(false)
    setAgentsViewActive(false)
    setUsageViewActive(false)
    setPrefsViewActive(false)
  }, [rememberRecent, upsertProject])

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
    // Its running tasks → done: capture their diff summary and run the verification
    // gate while the dir still exists. NOT awaited here (a check can take minutes) —
    // worktree removal is CHAINED behind it instead, so close stays snappy and the
    // dir survives until the capture + check finish.
    const finishTasks = tab?.projectId
      ? completeTerminalTasks(terminalId, tab.roleId, tab.projectId, laneOf(tab))
      : Promise.resolve()
    // If this was a worktree session, clean up the worktree directory afterwards.
    // Branch is intentionally left intact — user may want to merge or review later.
    if (tab?.worktreeBranch && tab?.sourceCwd) {
      void finishTasks.then(async () => {
        const result = await window.operator.worktreeRemove(tab.cwd, tab.sourceCwd!)
        if (!result.ok) console.warn('Worktree removal failed:', result.error)
      })
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
  }, [terminals, forgetSavedSession, completeTerminalTasks])

  const handleSelectSession = useCallback((session: AgentSession) => {
    const localTerminalIds = new Set(terminals.map((t) => t.id))
    setActiveSessionId(session.id)
    setActiveFolderPrefs(null)
    setGlobalPrefsActive(false)
    setAgentsViewActive(false)
    setUsageViewActive(false)
    setPrefsViewActive(false)
    setProjectView(null)
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
    // Operator-side fields the transcript observer can't know (it only sees the JSONL):
    // project/role linkage + the launch model/effort. Overlay them onto the tracked session
    // too — otherwise a session drops its projectId/roleId (→ sidebar group jump, lost lane
    // badge) the moment the observer starts tracking it.
    const operatorFields = { projectId: t.projectId, roleId: t.roleId, model: t.model, effortLevel: t.effortLevel }
    // Model precedence: the tab's model (launch config / the user's pill pick — updated the
    // instant they act) wins over the transcript, which lags an assistant turn behind and
    // would otherwise revert a fresh /model switch. The transcript fills the blank for
    // account-default launches, and transcript CHANGES are synced into the tab below.
    if (hookSession) return { ...hookSession, ...operatorFields, model: t.model ?? hookSession.model }
    return {
      id: `local-${t.id}`,
      agentId: 'claude-code',
      workingDirectory: t.cwd,
      projectName: t.cwd.split('/').pop() || t.cwd,
      ...operatorFields,
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

  // Drag-to-reorder FOLDER GROUPS in the sidebar: move the dragged project's whole
  // block of terminals to sit before/after the drop-target project, in the canonical
  // `terminals` order (which drives the sidebar list + ⌘1..9). `edge` is which side
  // of the target the group was dropped on. (Per-run; not persisted across restarts.)
  const handleReorderGroup = (draggedId: string, targetId: string, edge: 'before' | 'after') => {
    if (draggedId === targetId) return
    // Group identity mirrors the sidebar: projectId, or a basename key for legacy sessions.
    const groupIdOf = (s: AgentSession) => s.projectId || `name:${s.projectName || 'Unknown'}`
    const tidsOf = (id: string) =>
      allSidebarSessions.filter((s) => groupIdOf(s) === id).map((s) => s.terminalId).filter(Boolean) as string[]
    const draggedTids = tidsOf(draggedId)
    const targetTids = tidsOf(targetId)
    if (draggedTids.length === 0 || targetTids.length === 0) return
    const dSet = new Set(draggedTids)
    setTerminals((prev) => {
      const moved = prev.filter((t) => dSet.has(t.id))
      if (moved.length === 0) return prev
      const rest = prev.filter((t) => !dSet.has(t.id))
      const anchor = edge === 'after' ? targetTids[targetTids.length - 1] : targetTids[0]
      let idx = rest.findIndex((t) => t.id === anchor)
      if (idx < 0) return prev
      if (edge === 'after') idx += 1
      const next = [...rest]
      next.splice(idx, 0, ...moved)
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
          projectId: t.projectId,
          roleId: t.roleId,
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

  // Persist projects to localStorage + the durable file, mirroring savedSessions. The
  // JSON-diff (ignoring the volatile lastActiveAt) avoids churning writes on every touch.
  const projectsSerRef = useRef<string>('')
  useEffect(() => {
    if (!savedHydrated) return // don't clobber projects.json before it's been read
    const ser = JSON.stringify(projects.map(({ lastActiveAt: _omit, ...rest }) => rest))
    if (ser === projectsSerRef.current) return
    projectsSerRef.current = ser
    try { localStorage.setItem('operator.projects', JSON.stringify(projects)) } catch { /* quota */ }
    window.operator.saveProjects?.(projects)
  }, [projects, savedHydrated])

  // One-time top-up: existing projects (rosters created before Review/Design/QA) gain any
  // missing DEFAULT roles, so the new lanes show up without recreating the project. Guarded by
  // a flag so a role you later delete doesn't resurrect on the next launch.
  useEffect(() => {
    if (!savedHydrated) return
    const FLAG = 'operator.rosterDefaults.v2'
    try { if (localStorage.getItem(FLAG)) return } catch { return }
    const defs = defaultRoster()
    setProjects((prev) => prev.map((p) => {
      if (!p.roster || p.roster.length === 0) return p // rosterless is seeded fresh elsewhere
      const have = new Set(p.roster.map((r) => r.id))
      const missing = defs.filter((d) => !have.has(d.id))
      return missing.length ? { ...p, roster: [...p.roster, ...missing] } : p
    }))
    try { localStorage.setItem(FLAG, '1') } catch { /* quota */ }
  }, [savedHydrated])

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
      } else if (e.key === 'j' || e.key === 'J') {
        e.preventDefault()
        toggleChat()
      } else if (e.key === 'e' || e.key === 'E') {
        // Quick-switch the Preview between Interact and Annotate.
        e.preventDefault()
        setPreviewAnnotate((v) => !v)
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
          }
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleNewSession, handleCloseSession, handleSelectSession, toggleSidebar, toggleChat, allSidebarSessions, activeSessionId, localTerminalIds, terminals, sessions])

  // Esc closes the scratch terminal hub (ShellSheet) when it's open. Only mounted while open,
  // and CAPTURE phase + stopPropagation so it beats the sheet's xterm (which would otherwise
  // swallow Esc into the pty). With the hub closed there's no listener, so Esc reaches the
  // main terminal normally (vim, etc.).
  useEffect(() => {
    if (!shellOpen) return
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeShell()
      }
    }
    window.addEventListener('keydown', onEsc, { capture: true })
    return () => window.removeEventListener('keydown', onEsc, { capture: true } as EventListenerOptions)
  }, [shellOpen, closeShell])

  // Saved sessions not currently open — offered for restore on the splash & palette.
  const restorableSessions = useMemo(() => {
    const liveKeys = new Set(terminals.map((t) => t.key))
    return savedSessions
      .filter((s) => !liveKeys.has(s.key))
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
  }, [savedSessions, terminals])

  // Keys of the sessions that were OPEN at the last app quit — captured once at mount,
  // synchronously, BEFORE this run overwrites the store. Lets the sidebar list exactly
  // what was open before the close/restart, not the whole saved history.
  const lastOpenKeysRef = useRef<Set<string> | null>(null)
  if (lastOpenKeysRef.current === null) {
    try { lastOpenKeysRef.current = new Set<string>(JSON.parse(localStorage.getItem('operator.lastOpenKeys') || '[]')) }
    catch { lastOpenKeysRef.current = new Set<string>() }
  }
  // Persist the CURRENT open-set for the next launch (terminalIds die on restart, so
  // we track keys; closing a session drops it, so it won't resurface next time).
  useEffect(() => {
    if (!savedHydrated) return
    try { localStorage.setItem('operator.lastOpenKeys', JSON.stringify(terminals.map((t) => t.key))) } catch { /* quota */ }
  }, [terminals, savedHydrated])

  // The subset of restorable sessions that were open at the last quit, not yet
  // re-opened this run — what the sidebar shows so it isn't blank after a restart.
  const previouslyOpenSessions = useMemo(() => {
    const opened = lastOpenKeysRef.current ?? new Set<string>()
    return restorableSessions.filter((s) => opened.has(s.key))
  }, [restorableSessions])

  // Match on the session id, but fall back to the active terminal: when a session
  // ends it drops out of getSessions() and its sidebar id flips from the hook id
  // to `local-<tid>`, which would otherwise leave activeSessionId stale and
  // activeSession undefined (blank toolbar over a still-open terminal).
  const activeSession =
    allSidebarSessions.find((s) => s.id === activeSessionId) ??
    (activeTerminalId ? allSidebarSessions.find((s) => s.terminalId === activeTerminalId) : undefined)

  // Adopt transcript-reported model CHANGES into the tab. The first report just fills the
  // blank for account-default launches (handled by the ?? merge in localSessions); a change
  // from one reported model to another means the model really switched mid-session (e.g. the
  // user typed /model in the terminal, which Operator can't see) — adopt it so the sidebar
  // label and composer pill follow. Keyed per terminal; skips the '<synthetic>' placeholder.
  const lastTranscriptModelRef = useRef<Record<string, string>>({})
  useEffect(() => {
    const updates: Array<{ tid: string; model: string }> = []
    for (const s of sessions) {
      const tid = s.terminalId
      if (!tid || !s.model || s.model.startsWith('<')) continue
      const prev = lastTranscriptModelRef.current[tid]
      lastTranscriptModelRef.current[tid] = s.model
      if (prev && prev !== s.model) updates.push({ tid, model: s.model })
    }
    if (updates.length) {
      setTerminals((prev) => prev.map((t) => {
        const u = updates.find((x) => x.tid === t.id)
        return u ? { ...t, model: u.model } : t
      }))
    }
  }, [sessions])

  // Persist a chat-driven model/effort change onto the active session's tab (so it survives a
  // tab switch and is written into the durable SavedSession). Keyed by the active terminalId.
  const patchActiveTerminal = useCallback((patch: Partial<TerminalTab>) => {
    const tid = activeSession?.terminalId
    if (!tid) return
    setTerminals((prev) => prev.map((t) => (t.id === tid ? { ...t, ...patch } : t)))
  }, [activeSession?.terminalId])

  // Single source of truth for content area routing. Order = priority.
  const contentMode: 'folderPrefs' | 'globalPrefs' | 'agents' | 'usage' | 'prefs' | 'localTerminal' | 'project' | 'splash' = useMemo(() => {
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
    // Project workspace shows only when nothing else claims the area (openProject clears the
    // active session so this can surface); any lingering state is masked by the checks above.
    if (projectView && projects.some((p) => p.id === projectView.id)) return 'project'
    return 'splash'
  }, [prefsViewActive, agentsViewActive, usageViewActive, globalPrefsActive, activeFolderPrefs, activeTerminalId, terminals, projectView, projects])

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
          projects={projects}
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
        projects={projects}
        restorableSessions={previouslyOpenSessions}
        onRestoreSession={(s) => { void handleRestoreSession(s, !!s.claudeSessionId) }}
        onOpenProject={handleOpenProject}
        activeProjectId={contentMode === 'project' ? projectView?.id ?? null : null}
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
        onReorderGroup={handleReorderGroup}
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
      />
      )}
      </div>

      <div data-term-focus-zone style={{
        position: 'relative', flex: 1,
        display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--bg-terminal)', borderRadius: 'var(--radius-lg)', overflow: 'hidden',
      }}>
        {/* Drag region — full height only when no session toolbar is acting as drag region */}
        {contentMode !== 'localTerminal' && (
          <DragRegion style={{ height: 40, flexShrink: 0 }} />
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

        {contentMode === 'project' && projectView && (() => {
          const proj = projects.find((p) => p.id === projectView.id)
          if (!proj) return null
          const live: Record<string, string> = {}
          for (const t of terminals) if (t.projectId === proj.id && t.roleId) live[t.roleId] = t.id
          // Live runtime per lane (phase + token usage) from the transcript observer,
          // so RoleCards read as mission control rather than static config.
          const laneSessions: Record<string, { phase: string; usage?: AgentSession['usage']; lastActivityAt?: string }> = {}
          for (const [roleId, tid] of Object.entries(live)) {
            const s = sessions.find((x) => x.terminalId === tid)
            if (s) laneSessions[roleId] = { phase: s.phase, usage: s.usage, lastActivityAt: s.lastActivityAt }
          }
          return (
            <ProjectView
              project={proj}
              tab={projectView.tab}
              onSelectTab={(t) => setProjectView((prev) => (prev ? { ...prev, tab: t } : prev))}
              onUpdateProject={updateProject}
              onLaunchRole={(project, role, dev) => handleLaunchRole(project, role, undefined, dev)}
              liveRoles={live}
              laneSessions={laneSessions}
              onFocusTerminal={focusTerminal}
              onAddTask={(text, roleId) => addProjectTask(proj.id, text, roleId)}
              onAssignTask={(taskId, roleId) => assignProjectTask(proj.id, taskId, roleId)}
              onRemoveTask={(taskId) => removeProjectTasks(proj.id, [taskId])}
              onSendTask={(task) => sendProjectTask(proj, task)}
              onStartAll={() => startProjectTasks(proj)}
              onSetTaskStatus={(taskId, status) => setTaskStatus(proj.id, taskId, status)}
            />
          )
        })()}

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
              detectedDevPort={detectedDevPort}
              effortLevel={tab?.effortLevel}
              permissionMode={tab?.permissionMode || activeSession.permissionMode}
              lastToolName={activeSession.lastToolName}
              branch={tab?.worktreeBranch}
              mainView={mainView}
              onSelectMainView={selectMainView}
              panelOpen={panelOpen}
              onTogglePanel={togglePanel}
              sidebarCollapsed={sidebarCollapsed}
              onToggleSidebar={toggleSidebar}
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
            // Small gap so the terminal's last line (Claude's "auto mode" composer
            // hint) doesn't sit flush against the actions footer below.
            marginBottom: 8,
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
                  // Inert while a Chat/Preview overlay covers it — otherwise the wheel falls
                  // through the canvas (pointerEvents:none) to the still-visible console and
                  // scrolls ITS scrollback under the overlay (the "chat won't scroll, but the
                  // scrollbar moves" bug — that scrollbar was the console's).
                  pointerEvents: mainView === 'terminal' ? undefined : 'none',
                }}
              >
                <TerminalSurface
                  terminalId={t.id}
                  theme={currentTheme.xterm}
                  // Deactivated when a Chat/Preview overlay covers it, so the hidden terminal
                  // doesn't grab focus/keystrokes; re-activates on switch back (its size is
                  // unchanged, so the activation fit is a no-op — no resize-hang risk).
                  active={t.id === activeTerminalId && !t.ended && mainView === 'terminal'}
                  suspendFit={resizingPanel || windowResizing || sidebarAnimating}
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

            {/* Main-view overlays — Chat / Preview cover the (still-mounted, still-sized)
                terminal in the SAME area. OVERLAYING it (rather than display:none-ing) means
                the terminal never resizes on a Console⇄Chat⇄Preview switch, so it can't trip
                the ghostty resize/render hang. Hidden while reviewing a diff / viewing activity. */}
            {mainView !== 'terminal' && activeSession
              && reviewingTerminalId !== activeTerminalId
              && activityViewingTerminalId !== activeTerminalId && (
              <div style={{ position: 'absolute', inset: 0, borderRadius: 'var(--radius-lg)', overflow: 'hidden', background: 'var(--bg-terminal)' }}>
                {mainView === 'chat' && (
                  <CanvasConversation
                    session={activeSession}
                    onModelChange={(m) => patchActiveTerminal({ model: m })}
                    onEffortChange={(e) => patchActiveTerminal({ effortLevel: e })}
                  />
                )}
                {mainView === 'preview' && (() => {
                  // The reserved port is only the starting hint — AppPreviewPanel asks the
                  // backend which ports this session is ACTUALLY serving on and picks (or
                  // offers) among those.
                  const reserved = activeTerminalId ? reservedDevPorts[activeTerminalId] : undefined
                  const projId = activeSession.projectId
                  return (
                    <AppPreviewPanel
                      url={reserved ? `http://localhost:${reserved}` : null}
                      terminalId={activeTerminalId}
                      storageKey={`main-${activeSession.id}`}
                      onDispatch={activeSession.terminalId ? (text) => window.operator.terminalWrite(activeSession.terminalId!, `\x1b[200~${text}\x1b[201~\r`) : undefined}
                      onSendToTasks={projId && projects.some((p) => p.id === projId) ? (text) => addProjectTask(projId, text) : undefined}
                      annotate={previewAnnotate}
                      onAnnotateChange={setPreviewAnnotate}
                    />
                  )
                })()}
              </div>
            )}
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
            onOpenFolder={openProjectOrFolder}
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
              fontFamily: "var(--font-body)",
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
              onOpenFolder={openProjectOrFolder}
            />

            {/* spacer keeps the splash block vertically centered */}
            <div style={{ marginBottom: 'auto' }} />
          </div>
        )}

        {/* Consolidated action bar — the SINGLE place for session actions (scratch Terminal,
            Review changes, Activity timeline) + the working dir. Replaces the old
            SessionInfoBar strip, so there's one action surface, not three. */}
        {contentMode === 'localTerminal' && activeSession && (() => {
          const tab = terminals.find((t) => t.id === activeTerminalId)
          const worktreePath = tab?.worktreeBranch ? tab.cwd : null
          const reviewing = reviewingTerminalId === activeTerminalId
          const activityOn = activityViewingTerminalId === activeTerminalId
          return (
          <div className="actions-footer" style={{ marginTop: 'auto', zIndex: 31, background: 'var(--bg-terminal)' }}>
            <button
              className={`actions-footer-btn${shellOpen ? ' is-active' : ''}`}
              onClick={() => (shellOpen ? closeShell() : openShell())}
              title="Open a terminal in this path"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
                <path d="M4 6l2.4 2L4 10M8.6 10.5H12" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Terminal
            </button>
            {worktreePath && (
              <button
                className={`actions-footer-btn${reviewing ? ' is-active' : ''}`}
                onClick={() => { setReviewingTerminalId(reviewing ? null : activeTerminalId); setActivityViewingTerminalId(null) }}
                title="Review working-tree changes (commit / merge / discard)"
              >
                Review
              </button>
            )}
            {(activeSession.activity?.length ?? 0) > 0 && (
              <button
                className={`actions-footer-btn${activityOn ? ' is-active' : ''}`}
                onClick={() => { if (activityOn) setActivityViewingTerminalId(null); else { setActivityViewingTerminalId(activeTerminalId); setReviewingTerminalId(null) } }}
                title="View the activity timeline"
              >
                Activity
              </button>
            )}
            <span className="actions-footer-label" style={{ marginLeft: 'auto' }}>
              {activeSession.workingDirectory}
            </span>
          </div>
          )
        })()}

        {/* Scratch-terminal bottom sheet — mounted once opened, then only slid out of
            view on close so the shell persists. Lives inside the card → matches the
            main view's width, sits above the footer. */}
        {shellStarted && contentMode === 'localTerminal' && activeSession && (
          <ShellSheet
            cwd={activeSession.workingDirectory}
            theme={currentTheme.xterm}
            open={shellOpen}
            bottom={FOOTER_H}
            onClose={closeShell}
          />
        )}
      </div>

      {/* Right side panel — the "working" surfaces (Plan / Diff / Preview). A sibling of the
          content card so it sits to its right (the root row has gap: 8). Resizable via the
          left-edge handle; opened/closed from the toolbar's panel button. */}
      {contentMode === 'localTerminal' && panelOpen && activeSession && (
        <div style={{
          position: 'relative', width: panelW, flexShrink: 0, overflow: 'hidden',
          background: 'var(--bg-terminal)', borderRadius: 'var(--radius-lg)',
        }}>
          <div
            className={`panel-resize-handle${resizingPanel ? ' is-active' : ''}`}
            onMouseDown={startPanelResize}
            title="Drag to resize"
          />
          <CanvasPanel
            session={activeSession}
            tabs={panelTabs}
            mode={effPanelTab}
            onSelectMode={selectPanelTab}
            onModelChange={(m) => patchActiveTerminal({ model: m })}
            onEffortChange={(e) => patchActiveTerminal({ effortLevel: e })}
          />
        </div>
      )}

      {/* Full-window capture overlay during a panel drag (iframes/xterm swallow mousemove). */}
      {resizingPanel && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, cursor: 'col-resize' }} />
      )}

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
        fontFamily: "var(--font-body)",
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

