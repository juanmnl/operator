import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { AgentSession, SavedSession, Project, ProjectPatch, Role, ProjectTask, SessionConfig, TaskDiffStat, DispatchRecord, ArtifactReport, EffortLevel } from '../../shared/types'
import { resolveProject } from '../lib/resolve-project'
import { orchestrationNote, modelFamilyLabel, migrateLegacyCoordinator, presetFor, rolePresets, isCoordinator, reorderRoles } from '../lib/roster'
import { emptyDeliveryState, evaluateDelivery, deliveryPrefix, resetChainFor, chatterPausedFrom, CHATTER_KEY, DELIVER_MAX_CHARS, type DeliveryState } from '../lib/agent-delivery'
import {
  resolveAgentConfig, clearSeededRoleFields, clearCoordinatorWorktree, migrateGlobalsToLanePins, type LegacyGlobalDefaults,
} from '../lib/model-config'
import { migrateEffort, migrateProjectEfforts, migrateSavedEfforts, settingsEffort, isLegacyEffort } from '../lib/effort'
import { projectActivity, type ProjectActivity } from '../lib/project-status'
import { landingWithLastAgent } from '../lib/project-landing'
import { shelvingMoves, closePlan } from '../lib/project-shelf'
import { reorderByIds } from '../lib/reorder'
import { reorderRail } from '../lib/project-shelf'
import { reconcileStaleRunning, liveLaneOf, finishedTurn, type LiveLane } from '../lib/task-lifecycle'
import { planLaneCloses, laneClosePolicy, type LaneSnapshot, type LaneCloseReason } from '../lib/lane-lifecycle'
import { pruneSavedSessions } from '../lib/session-prune'
import { pruneSeededIdleLanes } from '../lib/prune-seeded-lanes'
import { IDLE, installPressed, installProgressed, installFailed, type InstallState } from '../lib/update-install'
import { sessionLabel } from '../lib/session-label'
import { loadSessionAccents, saveSessionAccent } from '../lib/session-accents'
import { AccentPicker } from '../components/AccentPicker'
import { CardMenu, type CardMenuItem } from '../components/CardMenu'
import { routeDispatch, liveLaneNames, pickLaneTab, dispatchNeedsApproval, orphanTabs, COORDINATOR_ROLE_IDS } from '../lib/dispatch'
import { canDismissDispatch } from '../lib/dispatch-outcome'
import { endedByBackend } from '../lib/terminal-liveness'
import { joinReattach, tabSessionStatus } from '../lib/session-reattach'
import { submitQueue, onUndeliveredSubmission, composerLines } from '../lib/submit-queue'
import { matchSubmission, promptsSince } from '../lib/delivery-confirm'
import { fetchTaskDiffStat, taskHasDiffSource } from '../lib/task-diff'
import { ProjectRail } from '../components/sidebar/ProjectRail'
import { AppShell } from '../components/AppShell'
import { TerminalSurface } from '../components/terminal/TerminalSurface'
import { GridTerminalPane } from '../components/terminal/GridTerminalPane'
import { getTerminal } from '../lib/terminal-registry'
import { ShellSheet } from '../components/terminal/ShellSheet'
import { SessionActivityView } from '../components/session/SessionActivityView'
import { FolderPreferencesView } from '../components/preferences/FolderPreferencesView'
import { FilesView } from '../components/files/FilesView'
import { FilesPanel } from '../components/files/FilesPanel'
import { EMPTY_NAV, type FilesNav } from '../lib/code-nav'
import { announcement, canAnnounceTo } from '../lib/comms'
import { SessionToolbar } from '../components/session/SessionToolbar'
import { CanvasPanel } from '../components/session/CanvasPanel'
import { CanvasConversation } from '../components/session/CanvasConversation'
import { ProjectView } from '../components/session/ProjectView'
import { AppPreviewPanel } from '../components/session/AppPreviewPanel'
import { DiffPanel } from '../components/session/DiffPanel'
import { AgentsHubView } from '../components/agents/AgentsHubView'
import { PrefsView } from '../components/prefs/PrefsView'
import { CommandPalette, PaletteAction } from '../components/CommandPalette'
import { QuitGuard } from '../components/QuitGuard'
import { askBeforeQuitEnabled, type LaneIdentity, type QuitRequest } from '../lib/quit-guard'
import { chatSignal } from '../lib/chat-signal'
import { ProjectGallery } from '../components/dashboard/ProjectGallery'
import { Toasts, ToastMessage } from '../components/Toast'
import { themes, defaultTheme, applyTheme, resolveThemeKey, themeKey, identities } from '../themes'
import type { OperatorTheme } from '../themes'
import { playYourTurnChime } from '../lib/sounds'
import { computeFanMembership } from '../lib/fan-out'
import { isAppChord } from '../lib/key-routing'
import { loadForgottenProjects, rememberProjectForgotten, rememberProjectOpened } from '../lib/forgotten-projects'
import { DragRegion } from '../components/DragRegion'
import { planRestore, readWorkspace, describeRestore, resumeOnLaunchEnabled, WORKSPACE_KEY, WORKSPACE_VERSION, type Workspace } from '../lib/workspace'
import { isStaleTask, taskAgeDays, splitStale, describeSkipped } from '../lib/task-staleness'
import { writesForDroppedPaths } from '../lib/paste-image'
import { paneVisibility } from '../lib/pane-visibility'

/** Who asked for a project upsert. `user` may lift a shelf and cancel a forget; `background`
 *  may do neither. Default is `background` — a new call site opts IN to the destructive
 *  direction rather than inheriting it. */
type UpsertIntent = 'user' | 'background'

interface TerminalTab {
  id: string
  /** Stable key that survives restart, used to persist & restore this session. */
  key: string
  cwd: string
  model?: string
  effortLevel?: EffortLevel
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
  /** Spawned in GRID-renderer mode, so this tab mounts `GridTerminalPane` instead of
   *  `TerminalSurface`. BOUND AT SPAWN and never re-read from the pref: the alacritty core is
   *  created by `terminal_spawn`, so a session cannot change renderer while it runs, and a pref
   *  flipped mid-flight must never mount a different pane over a live pty. Freshly launched tabs
   *  take it from the spawn result; re-attached ones from `ManagedTerminal.grid`, which the
   *  backend reports off the pty itself. */
  grid?: boolean
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
type MainView = 'terminal' | 'chat' | 'preview' | 'files'
// The right side panel's tabs. Contextual to the main view: Chat is offered here when the
// main view is Console or Preview (so you can watch the terminal / preview AND read the
// conversation), but dropped in Chat view where it's already the main surface.
type PanelTab = 'plan' | 'diff' | 'chat' | 'files'
type SessionLayout = { mainView: MainView; panelOpen: boolean; panelTab: PanelTab }
// The seeded-lane prune runs ONCE per install; this records that it has. The stamp is for a human
// reading localStorage — nothing branches on the value, only on its presence. Storage being
// unreachable reads as DONE, because a prune that can't remember it ran would run every launch.
const PRUNE_KEY = 'operator.seededLanePrunedAt'
function seededLanePruneDone(): boolean {
  try { return !!localStorage.getItem(PRUNE_KEY) } catch { return true }
}
function markSeededLanePruneDone() {
  try { localStorage.setItem(PRUNE_KEY, new Date().toISOString()) } catch { /* quota */ }
}

// Same one-shot bookkeeping for the ONE-ALTITUDE migration: the global per-role tier
// (`role-defaults.json`, edited on the deleted Agents → Defaults tab) is written down onto each
// lane as explicit pins, so removing the tier changes nobody's effective config. Separate key
// from the lane prune: they answer to different stores and must run independently.
const ONE_ALTITUDE_KEY = 'operator.oneAltitudeMigratedAt'
function oneAltitudeMigrationDone(): boolean {
  try { return !!localStorage.getItem(ONE_ALTITUDE_KEY) } catch { return true }
}
function markOneAltitudeMigrationDone() {
  try { localStorage.setItem(ONE_ALTITUDE_KEY, new Date().toISOString()) } catch { /* quota */ }
}

const LAYOUT_KEY = 'operator.sessionLayouts'
const DEFAULT_LAYOUT: SessionLayout = { mainView: 'terminal', panelOpen: false, panelTab: 'plan' }
function loadLayouts(): Record<string, SessionLayout> {
  try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') } catch { return {} }
}

export function DashboardView() {
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [terminals, setTerminals] = useState<TerminalTab[]>([])
  // The port the ACTIVE session is really serving on (session_ports): its reserved +
  // sniffed ports, filtered to the ones answering. The project usually ignores the
  // OPERATOR_DEV_PORT we hand it and binds its own default, so this — not the reserved
  // port — is what the toolbar's open-in-browser chip should point at. Only the active
  // session is polled; Preview does its own richer discovery (it needs the full list).
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
  const [prefsViewActive, setPrefsViewActive] = useState(false)
  // WHERE YOU ARE. The durable navigation scope: null = at the gallery (outside every
  // project), set = inside that project — the sidebar is scoped to it and it SURVIVES
  // visiting Preferences / Agents / Claude files / a session. Only the switcher's "All projects",
  // the logo and ⌘⇧O clear it. Split out of the old `projectView`, which conflated "which
  // project" with "show the workspace" and so was nulled by every view-switch handler.
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => {
    try { return localStorage.getItem('operator.activeProjectId') } catch { return null }
  })
  // Which tab of Project Home is showing. Independent of scope, so leaving and returning
  // to a project puts you back on the tab you were reading.
  const [projectTab, setProjectTab] = useState<'board' | 'team' | 'moodboard'>('board')
  // Gallery sub-view: the project grid, or the cross-project ActivityDashboard behind the
  // rollup chip. That read is legitimate HERE (launcher level) and nowhere inside a project.
  const [galleryTab, setGalleryTab] = useState<'projects' | 'activity'>('projects')
  /** The kill switch for agent→agent delivery. It now DEFAULTS TO LIVE — flipped 2026-07-30.
   *
   *  It shipped paused, on the reasoning that two cooperative agents which can each answer the
   *  other ping-pong indefinitely and the bill arrives whether or not anyone is watching. That
   *  risk is real, but it is the job of the BRAKES (lib/agent-delivery: hop budget, per-pair
   *  cycle brake, length cap), and they exist now. Making the user opt in as well was belt AND
   *  braces where the braces already hold — and it had a cost that only showed up in use: a
   *  reply posted to the channel and reached nobody. The channel filled with `POSTED` rows while
   *  the lane they were addressed to sat idle, never learning it had been answered, which reads
   *  as the return path being broken rather than switched off.
   *
   *  So: absent key → LIVE. Both explicit choices are preserved — `'1'` stays paused, `'0'` stays
   *  live — because a user who deliberately pulled this switch must not have it pulled back.
   *
   *  THE SWITCH STAYS. A kill switch you can hit when something misbehaves is worth having; a
   *  default-off mode you have to discover is not. Human→lane is a different path, unaffected. */
  const [chatterPaused, setChatterPaused] = useState<boolean>(() => {
    try { return chatterPausedFrom(localStorage.getItem(CHATTER_KEY)) } catch { return false }
  })
  const toggleChatterPaused = useCallback(() => {
    setChatterPaused((p) => {
      const next = !p
      try { localStorage.setItem(CHATTER_KEY, next ? '1' : '0') } catch { /* quota */ }
      return next
    })
  }, [])
  /** Hop counts, pair windows and suspensions for agent→agent delivery. Deliberately in a ref and
   *  NOT persisted: a restart is a natural circuit-breaker reset, and a hop chain that survives one
   *  would be unkillable by the only recovery every user knows. */
  const deliveryStateRef = useRef<DeliveryState>(emptyDeliveryState())
  /** The reply subscription mounts once, so it reads the switch through a ref — the file's idiom
   *  for a mount-once subscription reaching fresh state. Pausing must take effect on the NEXT
   *  reply, not on the next remount: a kill switch you have to restart to apply is not one. */
  const chatterPausedRef = useRef(chatterPaused)
  chatterPausedRef.current = chatterPaused
  // Project-switcher popover (sidebar header, ⌘⇧P).
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
  // Files is offered in the panel EXCEPT when it is already the main view — the two placements
  // are one reader, and a tab that duplicates the surface beside it is the thing §4's rule A
  // exists to prevent, expressed in the tab set rather than only in the routing.
  const panelTabs: PanelTab[] = mainView === 'chat'
    ? ['plan', 'diff', 'files']
    : mainView === 'files'
      ? ['plan', 'diff', 'chat']
      : ['plan', 'diff', 'chat', 'files']
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
  // FILES NAV — per session, mirroring `sessionLayouts` (§9), and shared by BOTH placements.
  // One reader, two windows onto it: the main view and the panel must agree about which file is
  // open, or following a link in one and glancing at the other shows two different files.
  const [filesNavs, setFilesNavs] = useState<Record<string, FilesNav>>({})
  const filesNav = (activeSessionId && filesNavs[activeSessionId]) || EMPTY_NAV
  const setFilesNav = useCallback((next: FilesNav) => {
    setFilesNavs((prev) => (activeSessionIdRef.current ? { ...prev, [activeSessionIdRef.current]: next } : prev))
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
        // Attributable ports only. The chip names "this session's dev server", and a `foreign`
        // port is one we cannot tie to this session — pointing the chip at it is the same
        // mistake the preview used to make, in a smaller box.
        .then((ps) => {
          if (cancelled) return
          setDetectedDevPort((ps ?? []).find((p) => p.attributed === 'sniffed' || p.attributed === 'reserved')?.port)
        })
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
  // Presentation only. Clearing the notices never touches a DispatchRecord outcome:
  // an `undelivered` dispatch stays `undelivered` in the project log after its toast
  // is gone. The log is the record; the toast is the notice. Takes explicit ids
  // rather than emptying the array, so a toast pushed while the stack fades out
  // survives the clear.
  const dismissAllToasts = useCallback((ids: string[]) => {
    const gone = new Set(ids)
    setToasts((prev) => prev.filter((t) => !gone.has(t.id)))
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
    // CLOSING THE DISPATCH LOOP. Every session update is also the answer to "did the thing we
    // typed actually become a turn?" — the transcript records real human prompts as `user`
    // narration entries (transcript.rs `apply_user`), so a submission awaiting confirmation can
    // simply be looked for. Confirming here is what lets the submit queue skip its rescue CR,
    // and that CR arriving against an already-committed paste is what split long dispatches in
    // half. Reading it off an event we already receive costs nothing and adds no polling.
    const unsubSession = window.operator.onSessionUpdate((next) => {
      setSessions(next)
      for (const s of next) {
        if (!s.terminalId) continue
        // A tracked session means a transcript is being tailed, which is what makes waiting for a
        // turn worth doing at all. Told to the queue so it can wait patiently here and NOT on a
        // pty nobody is reading — see `rescueDelayFor`.
        if (!s.id.startsWith('local-')) submitQueue.observable(s.terminalId)
        // …and whether it is mid-turn, which is what tells the queue that silence is not yet a
        // verdict. A lane whose pty is gone is never "busy": that submission has nothing left to
        // wait for and must be reported.
        submitQueue.busy(s.terminalId, s.status !== 'ended' && s.phase === 'running')
        const waiting = submitQueue.pending(s.terminalId)
        if (!waiting) continue
        // Turns AND queued prompts: a message typed into a working lane is accepted into its
        // queue and consumed inside the turn it is already running, so it produces no turn of
        // its own — the queue entry is the only record that it arrived.
        const turns = promptsSince([...(s.messages ?? []), ...(s.queued ?? [])], waiting.at)
        // Only 'delivered' confirms. A 'split' is the failure this whole change exists to
        // catch, so it must NOT satisfy the loop — letting it through would report the broken
        // half as a success and leave the tail stranded exactly as before.
        if (matchSubmission(waiting.text, turns) === 'delivered') submitQueue.confirm(s.terminalId)
      }
    })

    const unsubExit = window.operator.onTerminalExit((id) => {
      // Don't drop the tab — unmounting the pane blanks the final output. xterm
      // keeps its buffer after the pty dies, so mark the tab ended and leave it
      // mounted + active; the last frame stays on screen until the user dismisses
      // it (Cmd+W / sidebar close / the pane's "ended" overlay). Intentional
      // closes (handleCloseSession, worktree merge/discard) still remove the tab.
      exitCompleteRef.current(id) // a lane's session ended → its running tasks are done
      // A dead pty is done working, and this is the ONLY place that can say so: an ended
      // session drops out of `session:update` (it emits the active ones), so a lane that died
      // mid-turn would keep the queue waiting on a lane that no longer exists — and a message
      // written into that pty is exactly the loss the report must not swallow.
      submitQueue.busy(id, false)
      setTerminals((prev) => prev.map((t) => (t.id === id ? { ...t, ended: true } : t)))
    })

    // …and the same conclusion, reconciled, because the event above is not reliable.
    //
    // WebKit kills and respawns this renderer under memory pressure (measured: 737MB resting on a
    // project with eight mounted terminals, its WebContent 77s old inside an 11-hour-old app).
    // Every `terminal:exit` fired while it was dead is gone, so the respawned renderer carries
    // tabs marked live for children that exited long ago. `routeDispatch` reads exactly that flag,
    // so the cost is not cosmetic: a dispatch takes the SEND path into a dead pty, the write is
    // swallowed, and the task is filed `running` against a terminal id nothing can ever match.
    // Measured 2026-08-04: three dispatches, two filed running against a five-hour-dead pty, zero
    // delivered, and no error raised anywhere — which is why it went unnoticed for a session.
    //
    // `terminal_list` now reports each child's real `try_wait` state, so this heals from the one
    // source that cannot be stale. One direction only (see `endedByBackend`), and it skips the
    // state update entirely when nothing changed — this polls a renderer already under memory
    // pressure, and a `setState` per tick would be its own bug.
    const RECONCILE_MS = 5000
    let reconciling = false
    const reconcile = async () => {
      if (reconciling) return // a slow list must not stack up behind itself
      reconciling = true
      try {
        const live = await window.operator.terminalList?.()
        // The call failed: believing nothing is far safer than concluding everything is dead.
        if (!Array.isArray(live)) return
        // RE-STAMP FIRST — recovery without a restart, and it runs on every tick rather than
        // once at mount. A tab that is alive but carries no `projectId`/`roleId` is UNROUTABLE:
        // `pickLaneTab` cannot see it, so `routeDispatch` returns `queue` and the work silently
        // never leaves. Re-stamping here means the cure for that state is waiting five seconds,
        // not relaunching six healthy agents.
        //
        // Keyed on `claudeSessionId`, which is why this can work at all: the backend reports it
        // per live pty and it outlives every renderer.
        setTerminals((prev) => {
          const saved = savedSessionsRef.current
          let healed = 0
          const next = prev.map((t) => {
            if (t.ended || (t.projectId && t.roleId)) return t
            const info = live.find((x) => x.id === t.id)
            const row = info?.claudeSessionId
              ? saved.find((sv) => sv.claudeSessionId === info.claudeSessionId)
              : undefined
            const projectId = t.projectId ?? row?.projectId ?? info?.projectId
            const roleId = t.roleId ?? row?.roleId
            if (projectId === t.projectId && roleId === t.roleId) return t
            healed++
            return { ...t, projectId, roleId, key: t.key ?? row?.key }
          })
          // WHAT RE-STAMPING COULD NOT HEAL is the real bug state, and it gets said out loud
          // ONCE. A live pty we cannot label is not "no lane running" — it is an agent that will
          // never receive a dispatch, and the only signal until now was the user noticing six
          // lanes had gone quiet. Reported once per id rather than every 5s: a banner that
          // repeats is a banner people learn to ignore.
          const stuck = orphanTabs(next).filter((t: TerminalTab) => !reportedOrphansRef.current.has(t.id))
          if (stuck.length) {
            for (const t of stuck) reportedOrphansRef.current.add(t.id)
            pushToast({
              text: `${stuck.length} live agent${stuck.length === 1 ? '' : 's'} could not be linked to a lane`,
              detail: 'They are running but will not receive dispatches. Their session records may be missing a project or role.',
            })
          }
          return healed ? next : prev
        })
        setTerminals((prev) => {
          const stale = endedByBackend(prev, live)
          if (stale.length === 0) return prev
          // The same bookkeeping the event path does, so a lane healed here also closes its
          // running tasks — otherwise they sit `running` forever, which is a leak this store
          // has already had once.
          for (const id of stale) { exitCompleteRef.current(id); submitQueue.busy(id, false) }
          const dead = new Set(stale)
          return prev.map((t) => (dead.has(t.id) ? { ...t, ended: true } : t))
        })
      } catch { /* transient — the next tick tries again */ } finally { reconciling = false }
    }
    void reconcile()
    const reconcileTimer = setInterval(() => { void reconcile() }, RECONCILE_MS)

    // Files dropped ANYWHERE ELSE on the window → into the active terminal, so you can drop an
    // image straight into the conversation without aiming at the terminal. A drop that lands ON
    // a pane never gets here: `TerminalPane.handleDrop` stops it, because that pane already
    // delivers the file itself and two deliveries per gesture is the bug this replaced.
    //
    // Images go as a bracketed paste of the raw path, so they become `[Image #N]` here exactly
    // as they do on the pane; other files keep the shell-quoted plain write.
    const unsubDrop = window.operator.onFileDrop?.((paths) => {
      const tid = activeTerminalIdRef.current
      if (!tid || !paths.length) return
      for (const write of writesForDroppedPaths(paths)) window.operator.terminalWrite(tid, write)
    }) ?? (() => {})

    return () => { unsubSession(); unsubExit(); unsubDrop(); clearInterval(reconcileTimer) }
  }, [])

  const handleOpenGlobalPrefs = useCallback(() => {
    setGlobalPrefsActive(true)
    setAgentsViewActive(false)
    setPrefsViewActive(false)
    setActiveFolderPrefs(null)
    setActiveSessionId(null)
    setActiveTerminalId(null)
  }, [])

  const handleOpenAgents = useCallback(() => {
    setAgentsViewActive(true)
    setPrefsViewActive(false)
    setGlobalPrefsActive(false)
    setActiveFolderPrefs(null)
    setActiveSessionId(null)
    setActiveTerminalId(null)
  }, [])

  const handleOpenPrefs = useCallback(() => {
    setPrefsViewActive(true)
    setAgentsViewActive(false)
    setGlobalPrefsActive(false)
    setActiveFolderPrefs(null)
    setActiveSessionId(null)
    setActiveTerminalId(null)
    // NB: scope (activeProjectId) is deliberately kept — an overlay view is somewhere you
    // VISIT from inside a project, so leaving it returns you there (spec §4 rule 5).
  }, [])

  // Enter a project: sets the navigation scope and drops the active session so Project
  // Home can surface (see contentMode). Landing tab resets to the roster when you switch
  // to a DIFFERENT project; re-entering the one you were in keeps the tab you left on.
  //
  // This deliberately does NOT clear `archivedAt`. Browsing a shelved project — to read its
  // notes, or to check what's in there before deciding — is not a decision to un-shelve it.
  // OPEN ≠ REVIVE, LAUNCH = REVIVE (upsertProject's auto-lift); that asymmetry is the whole
  // ergonomics of the shelf, so don't "fix" this by adding a restore here.
  /** ENTER a project — from the gallery, the rail tile, ⌘K, the Agents hub or a folder open.
   *
   *  It used to land on the roster board, always. That was right when a project arrived with six
   *  seeded lanes and the board was the only thing that explained them; the roster is now one lane
   *  by default, so the board became a single row with nothing to decide.
   *
   *  RE-ENTERING RESTORES THE LAST AGENT — "when switching projects, show me the last selected
   *  agent, not the project itself". This REVERSES what this comment used to say (re-apply the
   *  rule, never restore, predictable beats clever): the memory is now the rule and `landingFor`
   *  is the fallback. Both live in lib/project-landing — `landingWithLastAgent` in front,
   *  `landingFor` unchanged behind it — so the pure rule stays pure and separately testable.
   *  The memory only wins when the remembered lane is LIVE; a lane that ended, was deleted, or
   *  simply isn't running after a restart falls through to the board. There is no session object
   *  for a lane with no pty, so landing on one would mean landing on nothing.
   *
   *  Two things it does NOT change. `handleOpenProjectHome`/`handleOpenProjectTeam` are explicit
   *  destinations — the back chevron and the sidebar project header must keep reaching the board,
   *  or the dead-control bug those two just had comes straight back. And opening the project you
   *  are ALREADY in still does not yank you off what you are looking at; only a genuine change of
   *  project re-lands.
   *
   *  It does not launch anything. Landing somewhere is navigation; starting an agent is a decision
   *  that costs a process, a worktree and a dev port. */
  const handleOpenProject = useCallback((projectId: string) => {
    setPrefsViewActive(false)
    setAgentsViewActive(false)
    setGlobalPrefsActive(false)
    setActiveFolderPrefs(null)
    setActiveProjectId((prev) => {
      // Already here — leave the view alone. The sidebar header and the toolbar's back chevron
      // want the project HOME and go through handleOpenProjectHome instead, so this branch is
      // only ever a re-select of the current project.
      if (prev === projectId) return projectId
      const landing = landingWithLastAgent(
        projectsRef.current.find((p) => p.id === projectId),
        terminalsRef.current,
        lastAgentRef.current[projectId],
      )
      setProjectTab('board')
      if (landing.kind === 'session') {
        // Focus its pty. `focusTerminal` also stamps the scope, which is the same rule the
        // backstop enforces — landing on a session must never desync `activeProjectId`.
        setActiveTerminalId(landing.terminalId)
        setActiveSessionId(sessionsRef.current.find((x) => x.terminalId === landing.terminalId)?.id ?? `local-${landing.terminalId}`)
      } else {
        setActiveSessionId(null)
        setActiveTerminalId(null)
      }
      return projectId
    })
  }, [])

  /** The project HOME — the roster board — regardless of where the landing rule would put you.
   *
   *  A separate verb on purpose. The sidebar's project header and the toolbar's `‹ name` chevron
   *  are requests to go to the board; routing them through `handleOpenProject` would make them
   *  no-ops now that re-selecting the current project deliberately leaves the view alone. Two
   *  intents that were sharing one function, which is how the "don't yank me" rule and the "take
   *  me home" button would have cancelled each other out. */
  const handleOpenProjectHome = useCallback(() => {
    setProjectTab('board')
    setPrefsViewActive(false)
    setAgentsViewActive(false)
    setGlobalPrefsActive(false)
    setActiveFolderPrefs(null)
    setActiveSessionId(null)
    setActiveTerminalId(null)
  }, [])

  /** Project Home on the TEAM tab — the roster, where lanes are added and launched.
   *
   *  Same unfocus-the-session move as `handleOpenProjectHome`, landing on a different tab.
   *  The collapsed rail's foot button is one caller: that rail lists this project's AGENTS,
   *  so its one control belongs to the roster rather than duplicating the project rail's
   *  new-session verb (which it did — same handler, same ⌘N, same `+`, two labels). The
   *  expanded sidebar's `+` and its empty-state control are the others: both say "roster",
   *  and both used to call `handleOpenProjectHome` and land on the board instead. */
  /** The sidebar's `+` says "Add or edit lanes on the roster" — a CREATION verb, and one that
   *  has to produce something visible every time it's pressed. `handleOpenProjectTeam` alone
   *  doesn't: press it while you are already on the team tab and all six setStates below are
   *  no-ops, so the `+` advertises itself and does nothing — the exact defect this pair of
   *  commits exists to remove. So it navigates AND asks the roster to open its add-lane menu
   *  (`RosterPanel` owns the one implementation; there is no second one here).
   *  The flag is consume-once: the roster clears it via `onAddLaneRequestHandled` as soon as it
   *  acts, so arriving on the team tab by any other route never opens the menu. */
  const [addLaneRequest, setAddLaneRequest] = useState(false)

  const handleOpenProjectTeam = useCallback(() => {
    setProjectTab('team')
    setPrefsViewActive(false)
    setAgentsViewActive(false)
    setGlobalPrefsActive(false)
    setActiveFolderPrefs(null)
    setActiveSessionId(null)
    setActiveTerminalId(null)
  }, [])

  /** …and the same landing WITH the add-lane menu opened. The sidebar's `+` and its
   *  empty-state control are the callers; the rail's foot button is not — that one says
   *  "open the roster", which is navigation, and it already has a visible result. */
  const handleAddLane = useCallback(() => {
    handleOpenProjectTeam()
    setAddLaneRequest(true)
  }, [handleOpenProjectTeam])
  // Stable identity: the roster calls this from an effect, so a new function each render would
  // re-run it.
  const clearAddLaneRequest = useCallback(() => setAddLaneRequest(false), [])

  // Leave every project — the logo, the switcher's "All projects" and ⌘⇧O. This is the ONE
  // path that clears scope; it stops nothing, the agents keep running (spec §4 rule 3).
  const handleShowGallery = useCallback(() => {
    setPrefsViewActive(false)
    setAgentsViewActive(false)
    setGlobalPrefsActive(false)
    setActiveFolderPrefs(null)
    setActiveSessionId(null)
    setActiveTerminalId(null)
    setActiveProjectId(null)
    // …and land on the PROJECT GRID. Without this, leaving via "All projects" reopened
    // whatever gallery sub-view you last used — including the activity page, which on a
    // machine with nothing running is an empty screen where the projects should be.
    setGalleryTab('projects')
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
      // Effort migration on the seed too, so the pre-hydrate paint never shows a lane badged with
      // an effort level Claude Code does not have (see lib/effort).
      return raw ? migrateSavedEfforts(JSON.parse(raw) as SavedSession[]).sessions : []
    } catch { return [] }
  })

  // Projects: the durable top-level unit (a folder/repo owning many sessions over time).
  // Seeded from localStorage for instant render, reconciled with ~/.operator/projects.json
  // on hydrate (below), and migrated from prior session/recent data on first run.
  const [projects, setProjects] = useState<Project[]>(() => {
    try {
      const raw = localStorage.getItem('operator.projects')
      // Legacy-coordinator migration on the seed too, so the pre-hydrate first paint
      // never flashes the old "Orchestrator" lane.
      return raw ? (JSON.parse(raw) as Project[]).map(migrateLegacyCoordinator).map(migrateProjectEfforts) : []
    } catch { return [] }
  })

  /** WHO is asking for this upsert. The distinction exists because one of the four callers is an
   *  EFFECT — it adopts a surviving pty at boot, with no user anywhere near it — and only a
   *  deliberate act may lift a shelf or resurrect a forgotten project. Default is `background`,
   *  so a caller that does not say cannot do either. */
  // Create-or-touch a project by id: fills missing defaults, bumps lastActiveAt, and keeps
  // any user rename (existing name wins). The single mutation point for the projects store.
  const upsertProject = useCallback((r: { id: string; path: string; name: string }, opts?: { defaults?: Project['defaults']; intent?: UpsertIntent }) => {
    const now = new Date().toISOString()
    // WHO ASKED. Defaulting to `background` is the safe half of the asymmetry: a caller that does
    // not say is not allowed to un-shelve anything, so a new call site has to opt IN to the
    // destructive direction rather than inherit it by omission.
    const intent: UpsertIntent = opts?.intent ?? 'background'
    // DECIDED OUT HERE, not inside the updater, so the updater stays pure — and so the trace
    // below is emitted once rather than once per React invocation.
    const shelved = projectsRef.current.find((p) => p.id === r.id)?.archivedAt
    const lifting = intent === 'user' && !!shelved
    // A DELIBERATE ACT ALSO CANCELS A FORGET. Opening the folder or launching a lane in it is
    // the user saying they want the project back; the durable list must not keep refusing to
    // adopt its own agents afterwards.
    if (intent === 'user' && forgottenProjectsRef.current.has(r.id)) {
      forgottenProjectsRef.current.delete(r.id)
      rememberProjectOpened(r.id, forgottenProjectsRef.current)
    }
    if (lifting) {
      // AN AUTOMATIC LIFT WITH NO TRACE IS WHAT MADE THIS INVISIBLE. Even now that only a
      // deliberate action can do it, say so: "why is this back on Active" must always have an
      // answer on screen.
      pushToast({ text: `${r.name} is back on Active`, detail: 'It was shelved; opening or launching here brought it back.' })
    }
    setProjects((prev) => {
      const existing = prev.find((p) => p.id === r.id)
      if (existing) {
        return prev.map((p) => {
          if (p.id !== r.id) return p
          const next: Project = { ...p, path: r.path, name: p.name || r.name, lastActiveAt: now, defaults: p.defaults ?? opts?.defaults }
          // THE ASYMMETRY, FIXED. `archivedAt` used to be cleared unconditionally here, which
          // made un-shelving a SIDE EFFECT of four unrelated paths — one of them background cwd
          // resolution, which involves no user at all. Setting the flag has always required
          // explicit intent (see `archiveProjects`); clearing it now does too, and a project the
          // user shelved survives every background touch.
          if (lifting) delete next.archivedAt
          return next
        })
      }
      // THE LIFT IS NOW OPT-IN, and the four callers are categorised rather than assumed:
      //
      //   openFolderAsProject   USER        picked a folder in the dialog
      //   handleLaunchSession   USER        launched a lane here
      //   handleRestoreSession  USER        clicked a dormant session (incl. Resume project)
      //   cwd resolution        BACKGROUND  an effect adopting a surviving pty — NO user
      //
      // The last one is the bug the user reported as "a whole project that i marked as forget,
      // is launching by itself": it runs at boot for every pty that outlived a restart, and it
      // used to clear `archivedAt` on the way past. A shelved project came back on its own, and
      // once on Active its saved sessions are eligible to restore.
      //
      // A running agent can now sit inside a shelved project, which the old comment argued
      // against. That is the correct trade: the agent is still reachable (the gallery's activity
      // view lists it, and the strip shows any project with something live regardless of shelf),
      // and "the user's decision stands until the user changes it" outranks tidiness.
      // Note that merely OPENING a project does not come through here: see handleOpenProject.
      // New project → ONE lane: Operator.
      //
      // This PARTLY REVERSES `dev/briefs/roster-on-demand.md`, deliberately — do not "restore"
      // the empty default as a regression fix. That brief was right about the real objection
      // (six lanes nobody asked for, sitting in the sidebar looking like they were waiting for
      // something) but overshot to zero, and zero is a dead end rather than a blank canvas:
      // `OPERATOR-DISPATCH [lane] …` addresses a lane by id, so a project with no roster has
      // nothing to talk to and nothing that can create the others. Operator is the coordinator —
      // the lane that receives an intent and routes it — so it is the one lane worth seeding.
      // The other five stay templates behind "+ Add agent" (lib/roster rolePresets).
      //
      // The empty state that brief added is still needed: a user can still delete their way to
      // zero, which is their decision to make.
      // Seeded WITHOUT model/effort, on purpose. Copying the preset verbatim would write
      // `model: 'fable'` onto the lane, and a value on the lane is a PIN — it beats the user's
      // global role default (lib/model-config's cascade), which is the exact mistake
      // `clearSeededRoleFields` exists to undo. Absent means inherit, so the cascade resolves it
      // to the same place while leaving a global default able to reach it.
      const preset = rolePresets().find((role) => isCoordinator(role.id))!
      const operator: Role[] = [{ id: preset.id, name: preset.name, accent: preset.accent, prompt: preset.prompt }]
      return [...prev, { id: r.id, path: r.path, name: r.name, createdAt: now, lastActiveAt: now, defaults: opts?.defaults, roster: operator }]
    })
  }, [])

  // Latest snapshots for callbacks that must read the CURRENT state synchronously — the
  // forget path's undo snapshot (a setState updater runs too late to build one) and the
  // async task helpers' diff capture — without re-subscribing every render.
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  // Live pty set for the completion matcher below (which must not re-subscribe per render).
  const terminalsRef = useRef(terminals)
  terminalsRef.current = terminals
  const savedSessionsRef = useRef(savedSessions)
  savedSessionsRef.current = savedSessions
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions

  /** A terminal's Claude session id — the task lifecycle's liveness key. `terminalId` is a
   *  per-run counter that collides across runs (three sessions in the real store hold `t5`), so
   *  it can't answer "is this lane alive?"; this UUID can. Undefined for an untracked session,
   *  whose tasks then fall back to the legacy terminal+role bridge in lib/task-lifecycle. */
  const claudeIdOf = (terminalId?: string): string | undefined => {
    if (!terminalId) return undefined
    const s = sessionsRef.current.find((x) => x.terminalId === terminalId && x.status !== 'ended')
    return s && !s.id.startsWith('local-') ? s.id : undefined
  }
  /** Tabs stamped with their session's last activity, so `pickLaneTab` can break a duplicate
   *  tie by recency rather than by whatever order reattach produced. */
  const withActivity = (tabs: TerminalTab[]) => tabs.map((t) => ({
    ...t,
    lastActivityAt: sessionsRef.current.find((s) => s.terminalId === t.id)?.lastActivityAt,
  }))

  /** The live lanes of one project, as lib/task-lifecycle wants them. */
  const liveLanesOf = (projectId: string): LiveLane[] => terminalsRef.current
    .filter((t) => !t.ended && t.projectId === projectId)
    .map((t) => ({ claudeSessionId: claudeIdOf(t.id), terminalId: t.id, roleId: t.roleId, projectId: t.projectId }))

  // Forget a project: drops it from the store (and from the gallery). Its folder, worktrees
  // and any live sessions are untouched — this only removes Operator's record of it, so
  // re-opening the folder brings it back with a fresh roster.
  // Forgetting must ALSO strip the project's id off everything that references it. A live
  // session left stamped with a deleted project id is a dangling scope pointer: it survives
  // into sessions.json, and re-focusing that session made the scope-validation effect and the
  // focus-implies-scope backstop fight each other to React's update ceiling (measured: 5084
  // scope writes before "Maximum update depth exceeded"). The guard in the backstop below
  // stops the loop; this stops the dangling data that armed it.
  //
  // DURABLE, NOT PER-RUN — and that was the second half of "a project i marked as forget is
  // launching by itself". This was a bare `useRef(new Set())`, so the guard existed only for the
  // lifetime of the renderer. Forgetting drops the project from the store and unstamps its
  // sessions, but it does NOT kill the ptys — so on the next boot (or the next renderer respawn,
  // which happens on its own under memory pressure) the cwd-resolution effect sees an unstamped
  // live pty, resolves its folder, finds an EMPTY guard, and re-creates the project from scratch
  // with a fresh roster and a bumped `lastActiveAt`. It then looks like the most recently used
  // project you own.
  //
  // `archivedAt` could not carry this: a forgotten project has no record left to hold a flag.
  // So the id list is the record, and it has to outlive the process that made the decision.
  /** Orphans already reported, so the 5s reconcile names each one once rather than every tick. */
  const reportedOrphansRef = useRef(new Set<string>())

  const forgottenProjectsRef = useRef<Set<string>>(new Set(loadForgottenProjects()))

  /** Projects whose teardown is in flight. Rendered immediately so "close" has an effect on
   *  screen the instant it is asked for, instead of after every pty has been confirmed dead —
   *  and now that Close writes nothing at all, this chip is the ONLY progress signal, which is
   *  the job it was written for.
   *
   *  Deliberately NOT persisted: a closing project that outlives the renderer is just a project
   *  whose ptys are gone, and a stuck "closing…" restored from disk would be a lie no action
   *  could clear. */
  const [closingProjects, setClosingProjects] = useState<Set<string>>(new Set())

  /** Everything forgetting destroys, captured so Undo can put it back. The roster, tasks,
   *  dispatches and notes all ride along inside `project`; the two id lists are what has to
   *  be re-stamped, since unstamping is what makes them unfindable afterwards. */
  type ForgottenSnapshot = { project: Project; terminalIds: string[]; savedKeys: string[] }

  const restoreForgottenProject = useCallback((snap: ForgottenSnapshot) => {
    const { project, terminalIds, savedKeys } = snap
    // TRAP: the cwd-resolution effect below reads this set to refuse re-adoption. A restored
    // project left in it gets its terminals silently unstamped again a tick later, so the
    // undo only half-works — and the half that fails is the scope pointer.
    forgottenProjectsRef.current.delete(project.id)
    rememberProjectOpened(project.id, forgottenProjectsRef.current)
    setProjects((prev) => (prev.some((p) => p.id === project.id) ? prev : [...prev, project]))
    const tids = new Set(terminalIds)
    setTerminals((prev) => prev.map((t) => (tids.has(t.id) ? { ...t, projectId: project.id } : t)))
    const keys = new Set(savedKeys)
    setSavedSessions((prev) => prev.map((sv) => (keys.has(sv.key) ? { ...sv, projectId: project.id } : sv)))
  }, [])

  const forgetProject = useCallback((id: string) => {
    const project = projectsRef.current.find((p) => p.id === id)
    if (!project) return
    // Snapshot BEFORE anything is unstamped — after the writes below there is no way left to
    // tell which terminals and saved sessions belonged here.
    const snap: ForgottenSnapshot = {
      project,
      terminalIds: terminalsRef.current.filter((t) => t.projectId === id).map((t) => t.id),
      savedKeys: savedSessionsRef.current.filter((sv) => sv.projectId === id).map((sv) => sv.key),
    }
    forgottenProjectsRef.current.add(id)
    // DURABLE: the ptys outlive this renderer, so the decision has to as well — otherwise the
    // next boot re-adopts the project from its own surviving agents.
    rememberProjectForgotten(id, forgottenProjectsRef.current)
    setProjects((prev) => prev.filter((p) => p.id !== id))
    setActiveProjectId((cur) => (cur === id ? null : cur))
    setTerminals((prev) => (prev.some((t) => t.projectId === id)
      ? prev.map((t) => (t.projectId === id ? { ...t, projectId: undefined } : t))
      : prev))
    setSavedSessions((prev) => (prev.some((sv) => sv.projectId === id)
      ? prev.map((sv) => (sv.projectId === id ? { ...sv, projectId: undefined } : sv))
      : prev))
    // This delete is persisted and otherwise unrecoverable — the roster, the backlog, the
    // dispatch log and the description all go. The menu already made you click twice; the
    // toast is the way back for the time you meant the item above it.
    pushToast({
      text: `Forgot ${project.name}`,
      detail: 'Its roster, tasks and notes are gone — the folder itself is untouched.',
      action: { label: 'Undo', run: () => restoreForgottenProject(snap) },
    })
  }, [pushToast, restoreForgottenProject])

  // Patch a project by id (roster edits, rename, …) and persist via the effect below.
  // `patch` may be a function of the CURRENT project rather than a fixed object: a caller
  // holding a rendered snapshot (the roster board) would otherwise compute its next state
  // from a stale copy, so two edits in quick succession lost the earlier one.
  const updateProject = useCallback((id: string, patch: ProjectPatch) => {
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, ...(typeof patch === 'function' ? patch(p) : patch) } : p)))
  }, [])

  // Shelving: `archivedAt` is a DECISION, so it is only ever written from here (and cleared
  // by upsertProject's auto-lift). No confirm — confirming a one-click-reversible action just
  // teaches people to click through the confirms that matter — but an undo toast, which
  // doubles as discovery for a verb the ⋯ menu only just grew.
  const restoreProject = useCallback((id: string) => {
    updateProject(id, { archivedAt: undefined })
  }, [updateProject])

  // One write path for shelving, whether it's one card's ⋯ menu or a tidy pass over twelve.
  // Everything in a batch shares ONE `archivedAt`, which is exactly the tie the Previous
  // shelf's `lastActiveAt` tiebreak exists to break. Undo restores precisely the ids this
  // call shelved — not "everything archived" — so it can't unshelve someone else's work.
  const archiveProjects = useCallback((ids: string[]) => {
    if (!ids.length) return
    const at = new Date().toISOString()
    const set = new Set(ids)
    setProjects((prev) => prev.map((p) => (set.has(p.id) ? { ...p, archivedAt: at } : p)))
    const only = ids.length === 1 ? projectsRef.current.find((p) => p.id === ids[0]) : undefined
    // HONESTY: a project with a live lane is lifted straight back onto the active shelf
    // (`isActiveProject`), so "it moves to Previous" was a success message for something that
    // visibly did not happen — flag written, Undo offered, nothing moved. The flag is still
    // written, because it IS the user's decision and it takes effect the moment the lane ends;
    // what changes is that the toast stops claiming a move it can't make.
    const stuck = ids.filter((id) => !shelvingMoves(activitiesRef.current[id]))
    // …and points at the verb that RESOLVES it: the lanes have to stop for the shelf to take
    // effect, and Close is the one gesture that stops them.
    const detail = only
      ? stuck.length
        ? 'Still running, so it stays on Active — Close ends its agents.'
        : 'It moves to Previous. Launching an agent here brings it straight back.'
      : stuck.length
        ? `${stuck.length} still running, so they stay on Active.`
        : 'They keep their rosters, tasks and notes. Launching an agent brings one back.'
    pushToast({
      text: only ? `Shelved ${only.name}` : `Shelved ${ids.length} projects`,
      detail,
      action: {
        label: 'Undo',
        run: () => setProjects((prev) => prev.map((p) => (set.has(p.id) ? { ...p, archivedAt: undefined } : p))),
      },
    })
  }, [pushToast])

  /** CLOSE a project: end its live agents. That is all it does.
   *
   *  IT NO LONGER SHELVES. Close and Shelve were fused — closing wrote `archivedAt` — which made
   *  one gesture do two unrelated things and left the user with no way to say "take this off the
   *  rail" without also filing it under Previous, the buried-away state they called "forget".
   *  Unfusing them is the whole change; everything else about this function is a consequence.
   *
   *  WHY NOT "HIDE IT WHILE IT RUNS" INSTEAD. Because `lib/forgotten-projects` is the written
   *  record of what happens when Operator drops a project from its UI while the project's ptys
   *  keep running: the cwd-resolution effect meets a live pty with no project, resolves its
   *  folder, upserts — and the project comes back by itself. That cost a durable localStorage
   *  list to fix. `isActiveProject` and `shelvingMoves` both exist to hold the same line: a
   *  running agent must never hide. So Close ENDS the lanes, and the rail clears itself because
   *  its membership is derived (`isOnRail`) — no new stored state anywhere.
   *
   *  `archivedAt` is now written from exactly ONE place, `archiveProjects` — the discipline
   *  v0.14.0 established for CLEARING it, finally applied to writing it too.
   *
   *  Reuses `handleCloseSession` per lane — the same path the ■ button takes, which already kills
   *  the pty, finishes its running tasks, removes the worktree dir (keeping the branch) and drops
   *  the saved session. No second teardown route, and nothing pattern-kills: every session is
   *  closed by id, and only ones stamped with THIS project.
   *
   *  Data — roster, tasks, notes, branches — is untouched, and the project stays on Active. */
  const closeProject = useCallback(async (id: string) => {
    const project = projectsRef.current.find((p) => p.id === id)
    if (!project) return
    const plan = closePlan(id, sessionsRef.current)
    const live = sessionsRef.current.filter((s) => plan.sessions.includes(s.id))

    // CLOSING IS A STATE, and it is rendered immediately. The old sequence awaited every pty
    // death before anything at all happened on screen, so with several lanes the project just sat
    // there for seconds looking ignored — the user's "it takes a while to get removed". With the
    // shelf write gone this chip is the WHOLE progress signal, which is what it was written for.
    //
    // Not armed when there is nothing to tear down: an idle close finishes in the same frame, and
    // a `closing…` chip that appears and vanishes for one frame is noise about no work.
    if (plan.sessions.length) {
      setClosingProjects((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
    }
    setActiveProjectId((cur) => (cur === id ? null : cur))

    // BOUNDED, AND IN PARALLEL. Sequentially awaiting each lane meant one hung `handleCloseSession`
    // stalled every lane behind it, so a single wedged pty could hold the whole close open
    // indefinitely — the user's "it takes a while to get removed". The timeout turns that into a
    // reported fact instead of a hang.
    const KILL_TIMEOUT_MS = 4000
    // A PTY THAT IS ALREADY DEAD IS NOT AN AGENT THAT REFUSED TO STOP. Asked once, up front, so
    // the verdict below can tell the two apart: `stuck` is supposed to mean "this process would
    // not die", and reporting a lane whose child exited hours ago as stuck is both wrong and
    // unactionable — there is nothing for the user to go and look at. `null` when the backend
    // cannot answer, which falls back to the old all-or-nothing reading rather than guessing
    // everything is dead.
    const listed = await window.operator.terminalList?.().catch(() => undefined)
    const aliveIds = Array.isArray(listed)
      ? new Set(listed.filter((t) => t.alive).map((t) => t.id))
      : null
    const wasDead = (s: AgentSession) => aliveIds !== null && !!s.terminalId && !aliveIds.has(s.terminalId)

    const outcomes = await Promise.all(live.map(async (s) => {
      try {
        await Promise.race([
          handleCloseSessionRef.current(s),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), KILL_TIMEOUT_MS)),
        ])
        return { s, ok: true }
      } catch {
        // Timed out — but if there was no process behind it when we started, the teardown had
        // nothing to wait for and the close SUCCEEDED. Only a lane that was genuinely running is
        // allowed to be reported as one that would not stop.
        return { s, ok: wasDead(s) }
      }
    }))
    const stuck = outcomes.filter((o) => !o.ok).map((o) => o.s)
    // Whatever the teardown managed, a tab with no live pty must not keep the project on the rail:
    // `isOnRail` reads `projectActivity.live`, so one tab that never got dropped is the whole
    // "closing it left it there" bug. Marking them ended (rather than deleting) keeps the ordinary
    // exit bookkeeping — the sidebar still shows the lane as finished, it just stops counting.
    const deadIds = new Set(live.filter(wasDead).map((s) => s.terminalId!))
    if (deadIds.size) {
      setTerminals((prev) => (prev.some((t) => deadIds.has(t.id) && !t.ended)
        ? prev.map((t) => (deadIds.has(t.id) ? { ...t, ended: true } : t))
        : prev))
    }

    // NOTHING IS WRITTEN TO THE PROJECT. This is where `archivedAt` used to be stamped, and its
    // absence is the change: the project stays exactly where it was, on Active, with its roster,
    // tasks, notes and branches. Reopening it is just opening it.
    setClosingProjects((prev) => { const next = new Set(prev); next.delete(id); return next })
    if (stuck.length) {
      pushToast({
        text: `${project.name} — ${stuck.length} agent${stuck.length === 1 ? '' : 's'} did not stop`,
        detail: stuck.map((s) => sessionLabel({ session: s })).join(', '),
      })
    }
    const n = plan.sessions.length
    // NO UNDO, ON EITHER VARIANT, and that is honesty rather than a removed feature. Undo used to
    // restore the shelf — which is no longer written — while the ptys it appeared to be offering
    // back were already gone. With nothing to reverse, the toast's job is to say where the
    // project went, which is also the "reads as done, not lost" answer.
    pushToast(n
      // A receipt for something irreversible.
      ? {
        text: `Closed ${project.name} — ${n} agent${n === 1 ? '' : 's'} ended`,
        detail: 'It stays in Active. Launching an agent here brings it back to the rail.',
      }
      // Nothing ended, so this is a pointer, not a receipt — and it needs no action: closing an
      // idle project lands you on the gallery with its card in front of you, so "show me where
      // it went" would point at itself.
      : {
        text: `Closed ${project.name}`,
        detail: 'It stays in Active — open it again any time.',
      })
  }, [pushToast])

  const archiveProject = useCallback((id: string) => archiveProjects([id]), [archiveProjects])

  // Open a folder as its Project workspace (Agents/Roster) — this is now how "New Session"
  // / picking a folder works: no ad-hoc single-session form, land straight on the roster so
  // the user picks/tunes agent lanes and launches from there (RosterPanel's Launch/Launch all).
  // Registers the project (seeding the default roster) if this is the first time we've seen
  // it; launches nothing itself.
  const openFolderAsProject = useCallback(async (cwd: string) => {
    const proj = await resolveProject(cwd)
    upsertProject(proj, { intent: 'user' }) // picked a folder in the dialog — may lift a shelf
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
  // Lifecycle transitions. Dispatching a task marks it running (with its lane) instead of
  // deleting it, so it stays visible until done. `terminalId` is optional — the lane pickup
  // path doesn't know the new terminal id yet, so it matches on roleId for auto-complete.
  const markTasksRunning = useCallback((projectId: string, ids: string[], terminalId?: string, lane?: TaskLane) => {
    if (!ids.length) return
    const idset = new Set(ids)
    const now = new Date().toISOString()
    setProjects((prev) => prev.map((p) => (p.id === projectId
      ? { ...p, tasks: (p.tasks ?? []).map((t) => (idset.has(t.id)
        ? { ...t, status: 'running' as const, startedAt: t.startedAt ?? now, terminalId: terminalId ?? t.terminalId, claudeSessionId: claudeIdOf(terminalId) ?? t.claudeSessionId, ...(lane ?? {}) }
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
    stampTaskCheck(projectId, ids, { status: res?.ok ? 'pass' : 'fail', output: res?.output, at: new Date().toISOString() })
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
    const task: ProjectTask = { id: crypto.randomUUID(), text: t, roleId, status: 'running', terminalId, claudeSessionId: claudeIdOf(terminalId), createdAt: now, startedAt: now, ...(lane ?? {}) }
    setProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, tasks: [...(p.tasks ?? []), task] } : p)))
  }, [])
  // When a lane's session ends, its still-running tasks are treated as done (auto-complete).
  // Also captures each task's diff summary — awaited by the close path BEFORE it removes the
  // worktree, so the stat survives the dir. `lane` backfills provenance the pickup path missed.
  //
  // `outcome` exists for ONE caller: the went-quiet backstop (lib/lane-lifecycle). A lane that
  // was closed because it fell silent without ever reporting has not been seen to finish
  // anything, and writing `done` on its tasks would be the exact lie `abandoned` was added to
  // stop — reconciliation used to do it to 56 tasks at a time. Same close path, honest label.
  const completeTerminalTasks = useCallback(async (terminalId: string, roleId?: string, projectId?: string, lane?: TaskLane, outcome: 'done' | 'abandoned' = 'done') => {
    const now = new Date().toISOString()
    // Matched by SESSION id first — `terminalId` collides across runs, so matching on it alone
    // let an exiting lane close a previous run's tasks that happened to share its counter.
    // The role fallback stays for tasks stamped before the session id existed, and is still
    // gated on the stamped terminal not being live in this run.
    const claudeId = claudeIdOf(terminalId)
    const lanes = projectId ? liveLanesOf(projectId) : []
    const isMatch = (t: ProjectTask) =>
      t.status === 'running' && (
        (!!claudeId && t.claudeSessionId === claudeId)
        || (!t.claudeSessionId && t.terminalId === terminalId)
        || (!!roleId && t.roleId === roleId && !t.claudeSessionId && !liveLaneOf(t, lanes))
      )
    const matched: { projectId: string; ids: string[]; task: ProjectTask }[] = []
    for (const p of projectsRef.current) {
      if (projectId && p.id !== projectId) continue
      const hits = (p.tasks ?? []).filter(isMatch)
      if (hits.length) matched.push({ projectId: p.id, ids: hits.map((t) => t.id), task: hits[0] })
    }
    // `abandoned` carries `reconciledAt`, not `doneAt` — the same split the reconciler uses, so
    // every reader that already distinguishes "its run ended" from "it finished" keeps working.
    setProjects((prev) => prev.map((p) => {
      if (projectId && p.id !== projectId) return p
      const tasks = (p.tasks ?? []).map((t) => (isMatch(t)
        ? {
          ...t,
          status: outcome,
          ...(outcome === 'done' ? { doneAt: now } : { reconciledAt: now }),
          cwd: t.cwd ?? lane?.cwd, sourceCwd: t.sourceCwd ?? lane?.sourceCwd, worktreeBranch: t.worktreeBranch ?? lane?.worktreeBranch, worktreeBase: t.worktreeBase ?? lane?.worktreeBase,
        }
        : t))
      return tasks === p.tasks ? p : { ...p, tasks }
    }))
    // One capture per lane (all matched tasks shared the terminal/role → same diff),
    // then the verification gate — awaited so a worktree close removes the dir only
    // after the check has run in it. The gate is skipped for abandoned work: "done and green"
    // is a claim about finished work, and running the project's check command (minutes, and the
    // whole test suite) on a lane that merely fell silent buys nothing. The DIFF is still
    // captured — whatever it did write is exactly what you need to see.
    for (const m of matched) {
      const src = lane ?? m.task
      if (taskHasDiffSource(src)) {
        const stat = await fetchTaskDiffStat(src).catch(() => undefined)
        attachTaskDiffStats(m.projectId, m.ids, stat)
      }
      if (outcome === 'done') await runTaskChecks(m.projectId, m.ids, src.cwd)
    }
  }, [attachTaskDiffStats, runTaskChecks])
  // Fresh closure over terminals + completeTerminalTasks for the mount-time exit subscription.
  /** Per-project liveness, and the per-lane close path — both declared far below the shelve and
   *  close actions that need them, so they arrive through refs assigned on render. */
  const activitiesRef = useRef<Record<string, ProjectActivity>>({})
  const handleCloseSessionRef = useRef<(s: AgentSession, suspend?: LaneCloseReason) => Promise<void>>(async () => {})
  /** `focusTerminal` is declared much further down, so the undelivered toast reaches it the
   *  same way the exit handler reaches its own late sibling — through a ref assigned on render. */
  const focusTerminalRef = useRef<(id: string) => void>(() => {})
  const exitCompleteRef = useRef<(id: string) => void>(() => {})
  exitCompleteRef.current = (id: string) => {
    const tab = terminals.find((t) => t.id === id)
    if (tab?.projectId) void completeTerminalTasks(id, tab.roleId, tab.projectId, laneOf(tab))
  }

  // Append a routed dispatch to the project's activity log (capped tail, newest last).
  /** Update one dispatch record's outcome in place (approval / rejection). Keeps the log at one
   *  row per dispatch, and is what makes a second approval a no-op. */
  const setDispatchOutcome = useCallback((projectId: string, id: string, outcome: DispatchRecord['outcome'], toRoleId?: string) => {
    setProjects((prev) => prev.map((p) => (p.id === projectId
      ? { ...p, dispatches: (p.dispatches ?? []).map((d) => (d.id === id ? { ...d, outcome, toRoleId: toRoleId ?? d.toRoleId } : d)) }
      : p)))
  }, [])

  /** THE LAST STEP OF THE LOOP: a submission that went to the pty and never became a turn.
   *
   *  It does not retry. A dispatch that re-sends itself unattended is how the same work gets
   *  done twice, and the failure it recovers from is rare enough that a human deciding is the
   *  right cost. What it must do is stop the log LYING: the record said `sent`, the lane never
   *  started, and until now those two facts never met — which is precisely how a stranded task
   *  could sit in a composer for an hour while the channel showed it delivered.
   *
   *  Matched by TEXT rather than by a terminal id, because a record carries no terminal: the
   *  submitted string is `deliveryPrefix(...) + task` on the agent→agent path and the bare task
   *  elsewhere, so an endsWith covers both without either path having to hand anything over. */
  const reportUndelivered = useCallback((terminalId: string, text: string) => {
    const tab = terminalsRef.current.find((t) => t.id === terminalId)
    const project = projectsRef.current.find((p) => p.id === tab?.projectId)
    const rec = [...(project?.dispatches ?? [])].reverse()
      .find((d) => (d.outcome === 'sent' || d.outcome === 'launched') && text.endsWith(d.task))
    if (project && rec) setDispatchOutcome(project.id, rec.id, 'undelivered')
    const lane = tab?.roleId
      ? (project?.roster ?? []).find((r) => r.id === tab.roleId)?.name ?? tab.roleId
      : 'That lane'
    // Actionable, so it stays until dismissed: the recovery is to look at the lane, and a toast
    // that disappears on its own would be a notice nobody was guaranteed to see about work
    // nobody is doing.
    pushToast({
      text: `${lane} never started the task it was sent`,
      // One ellipsised line, minus the action button — about 40 characters land (Toast.tsx).
      detail: 'It may still be sitting in its composer.',
      kind: 'error',
      action: { label: 'Show', run: () => { if (tab) focusTerminalRef.current(tab.id) } },
    })
  }, [pushToast, setDispatchOutcome])

  // Installed rather than imported: lib/submit-queue must not learn what a project is.
  useEffect(() => { onUndeliveredSubmission(reportUndelivered) }, [reportUndelivered])

  const logDispatch = useCallback((projectId: string, rec: DispatchRecord) => {
    setProjects((prev) => prev.map((p) => (p.id === projectId
      ? { ...p, dispatches: [...(p.dispatches ?? []), rec].slice(-100) }
      : p)))
  }, [])

  // --- Orchestrator dispatch routing ----------------------------------------------------
  // An agent emitted `OPERATOR-DISPATCH [role] task`; the backend parsed it and fires the
  // event. Route it to the target lane WITHIN the emitting session's project: a live lane
  // gets the task typed into its pty (no focus steal); an idle lane is LAUNCHED with the
  // task as its opening brief (without stealing focus). Dedupe by dispatch id plus the
  // in-flight guard below bound any re-dispatch loop.
  // Latest routing inputs held in a ref so the subscription is set up once (no missed events).
  // The enricher, in a ref: the dispatch subscription below is mounted once and must not
  // re-subscribe per render just to see fresh session activity.
  const withActivityRef = useRef(withActivity)
  withActivityRef.current = withActivity
  const dispatchRef = useRef({ terminals, projects, addProjectTask, addRunningTask, pushToast, logDispatch, updateProject })
  dispatchRef.current = { terminals, projects, addProjectTask, addRunningTask, pushToast, logDispatch, updateProject }
  // handleLaunchRole is declared further down; the subscription reaches it through a ref.
  const launchRoleRef = useRef<((project: Project, role: Role, prompt?: string, launchDevServer?: boolean, opts?: { focus?: boolean }) => Promise<TerminalTab | undefined>) | null>(null)
  // One launch per (project, lane) at a time: a burst of dispatches to the same idle lane
  // must join the session being spawned, not fan out into sibling lanes.
  // The RETURN path, and since step 3 it is also a SEND path: a lane's reply is typed into the
  // addressee's session. The tailer has already persisted the reply itself (project-scoped) before
  // this fires, so nothing here stores the message — what it does is resolve the two identities the
  // backend can't (which lane SENT it, which lane the `to` token names), decide whether handing it
  // on is safe, and record what happened either way.
  useEffect(() => {
    const SEEN_KEY = 'operator.reply.seen'
    const unsub = window.operator.onOrchestratorReply?.((r) => {
      let seen: string[] = []
      try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]') } catch { /* */ }
      if (seen.includes(r.id)) return // already handled (dedupe across transcript re-reads)
      try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, r.id].slice(-500))) } catch { /* */ }

      const { terminals: tabs, projects: projs, pushToast: toast, logDispatch: log } = dispatchRef.current
      const srcTab = tabs.find((t) => t.id === r.terminalId)
      const project = projs.find((p) => p.id === (r.projectId || srcTab?.projectId))
      const roster = project?.roster ?? []
      // Who spoke: the emitting terminal's lane, exactly as dispatch attributes its sender.
      const from = roster.find((role) => role.id === srcTab?.roleId)
      // Who it's for: `project` is a broadcast; anything else is matched against the live
      // roster, and an unmatched token is kept verbatim rather than dropped — the parser is
      // liberal on purpose and a reply nobody can route is still a reply somebody wrote.
      const to = r.to.toLowerCase() === 'project'
        ? null
        : roster.find((role) => role.id === r.to.toLowerCase())
      const preview = r.text.length > 60 ? r.text.slice(0, 60) + '…' : r.text
      toast({
        text: `${from?.name ?? 'A lane'} replied${to ? ` to ${to.name}` : ''}`,
        kind: 'info',
        detail: preview,
      })

      // DELIVERY — the step that makes agents actually talk to each other, and the only place in
      // the app where one agent's words become another agent's prompt. Every branch below is a
      // refusal to send; lib/agent-delivery owns the decision, this owns the plumbing.
      //
      // A broadcast (`to === 'project'`) is never delivered to anyone: it is addressed to the room,
      // and fanning it out would multiply one message by the roster on every hop — the fastest way
      // to a runaway. It is persisted by the tailer and stops here.
      //
      // There is no longer a room to address: the channel that rendered broadcasts is deleted, so
      // one written today is stored and displayed nowhere. `REPLY_PROTOCOL` (lib/roster) has been
      // changed to stop lanes emitting them — this branch stays as the backstop for a lane running
      // on an older system prompt, not as a supported path.
      if (!to || !from || !project) return
      // Durable double-delivery guard. The seen-set above is the fast one, but it lives in
      // localStorage; the record does not, so a cleared cache can't re-deliver a month of replies.
      if (project.dispatches?.some((x) => x.replyId === r.id)) return

      const target = tabs.find((t) => t.roleId === to.id && t.projectId === project.id && !t.ended)
      const { decision, state } = evaluateDelivery({
        from: from.id,
        to: to.id,
        text: r.text,
        targetLive: !!target,
        paused: chatterPausedRef.current,
        now: Date.now(),
        state: deliveryStateRef.current,
      })
      // The returned state already carries the hop the recipient inherits — assigning it here as
      // well would be a second copy of the rule that bounds the chain.
      deliveryStateRef.current = state
      // Record the outcome either way, keyed to the reply. This is what puts the brake on screen:
      // Team → Dispatches renders every one of these rows, so a stopped chain reads as an outcome
      // against the pair instead of looking like the addressee ignored it. (The board deliberately
      // does not: a `replyId` record is chat about work, never work — see TaskBoard's
      // WAITING_OUTCOMES — which is exactly why the dispatch log had to survive this move.)
      const record = (outcome: DispatchRecord['outcome'], note?: string) => log(project.id, {
        id: crypto.randomUUID(), at: new Date().toISOString(),
        fromRoleId: from.id, toRoleId: to.id, task: r.text, outcome, replyId: r.id, note,
      })

      if (decision.kind === 'block') {
        // The brake's own sentence rides along, so the Comms log can show WHY without inventing a
        // second vocabulary for it. These notes have existed and been displayed nowhere.
        record(decision.reason === 'queued' ? 'queued' : decision.reason, decision.note)
        // Surface WHY. A message that silently fails to arrive is indistinguishable from an agent
        // that ignored you, and that ambiguity is what makes people stop trusting the feature.
        // `queued` is the ordinary case (nobody home) so the chip alone carries it; a brake means
        // something is looping and is worth interrupting the user for.
        //
        // NOTHING is written back to the SENDER's pty on a block — deliberately. A "wasn't
        // delivered" note is itself a prompt, so the one moment we've decided the lanes are talking
        // too much is the worst moment to make one of them talk again. The cost is real (the sender
        // may wait on an answer that never comes) and it is the cheaper of the two.
        if (decision.reason !== 'queued') {
          // 'info', not 'error': a tripped circuit-breaker is the system working. It still needs
          // to be seen, which is what the note is for.
          toast({ text: `Not delivered to ${to.name}`, kind: 'info', detail: decision.note })
        }
        return
      }
      if (!target) return // belt: evaluateDelivery already blocks a dead target
      // One pty writer, shared with dispatch: serialized per terminal with a length-scaled
      // watchdog, so two arrivals can't merge into one composer draft.
      void submitQueue.submit(target.id, deliveryPrefix(from.name) + decision.text)
      record('sent')
      if (decision.truncated) {
        // Was "The full text is in the channel." — false the moment the channel went, and this
        // is the one toast whose whole job is telling you something was lost. The sender's own
        // transcript is where the untruncated text actually survives.
        toast({ text: `Trimmed a long message to ${to.name}`, kind: 'info', detail: `Only the first ${DELIVER_MAX_CHARS} characters were delivered; the full text is in ${from.name}'s transcript.` })
      }
    })
    return () => unsub?.()
  }, [])

  const launchingLanesRef = useRef(new Map<string, Promise<TerminalTab | undefined>>())

  // DELIVERY, split out of the subscription so an APPROVAL can run the exact same path. A
  // pending dispatch that delivered through a second, near-identical code path would be a
  // guarantee nobody could check; this way "approved" is literally "what would have happened".
  // Held in a ref (the file's idiom for a mount-once subscription reaching fresh state).
  const deliverDispatchRef = useRef<(a: { id: string; roleToken: string; task: string; terminalId?: string; projectId: string; approving?: boolean }) => void>(() => {})
  deliverDispatchRef.current = ({ id, roleToken, task, terminalId, projectId, approving }) => {
      const { terminals: tabs, projects: projs, addProjectTask: addTask, addRunningTask: addRunning, pushToast: toast, logDispatch: log } = dispatchRef.current
      const srcTab = tabs.find((t) => t.id === terminalId)
      const project = projs.find((p) => p.id === projectId)
      // NEVER A SILENT RETURN. This line used to be `if (!project) return` with nothing before
      // it: no log row, no toast, no trace anywhere. It is the "2/9 dispatches vanished
      // traceless" in the standing handoff — and grepping the lane jsonls, which is the right
      // instinct, finds nothing, because the drop happens in the RENDERER on the sending lane's
      // own mis-tracked tab state, before the sentinel's target is ever consulted.
      //
      // A dispatch that cannot be routed is still a thing that HAPPENED. It gets a toast so a
      // human sees it now, and a dispatch-log row so it is still there tomorrow.
      if (!project) {
        toast({
          text: 'A dispatch could not be routed',
          detail: srcTab
            ? `The lane that sent it isn't attached to a project, so there is no roster to route "${roleToken}" against.`
            : 'The lane that sent it is no longer open.',
          kind: 'error',
        })
        // Logged against the project id the event CARRIED, even though nothing matched it: an
        // orphan row under a stale id is recoverable, a dropped dispatch is not.
        if (projectId) {
          log(projectId, {
            id, at: new Date().toISOString(), fromRoleId: srcTab?.roleId,
            toRoleId: undefined, task, outcome: 'unassigned',
          })
        }
        return
      }
      const roster = project.roster ?? []
      const d = { id, role: roleToken, task }
      const route = routeDispatch(d.role, roster, withActivityRef.current(tabs), project.id)
      const routedRole = route.kind === 'unassigned' ? undefined : route.role
      const preview = d.task.length > 60 ? d.task.slice(0, 60) + '…' : d.task
      // On approval the record already exists — UPDATE it in place, so the log keeps one row per
      // dispatch and re-approving a delivered one has nothing left to find (that is what makes
      // "delivers once and only once" true rather than merely likely).
      const record = (outcome: DispatchRecord['outcome']) => (approving
        ? setDispatchOutcome(project.id, id, outcome, routedRole?.id)
        : log(project.id, { id, at: new Date().toISOString(), fromRoleId: srcTab?.roleId, toRoleId: routedRole?.id, task: d.task, outcome }))
      // Status notes typed back into the DISPATCHER's pty so it can adapt (e.g. an unknown
      // role, or confirmation that an idle lane was launched). Naming the currently-live
      // lanes (routing logic + the ended-lane guard live in lib/dispatch) lets it reassign
      // informedly. The note carries no OPERATOR-DISPATCH token, so it isn't itself parsed.
      const feedback = (msg: string) => {
        if (!srcTab) return
        const live = liveLaneNames(tabs, roster, project.id, srcTab.id)
        const liveHint = live.length ? ` Lanes running now: ${live.join(', ')}.` : ' No other lanes are running.'
        void submitQueue.submit(srcTab.id, `[Operator] ${msg}${liveHint}`)
      }
      // A dispatch named a template lane the project doesn't have yet: add it, then fall
      // through to the launch path below. `updateProject`'s function form reads the CURRENT
      // project, so two dispatches naming different new lanes in the same tick both land.
      if (route.kind === 'create') {
        dispatchRef.current.updateProject(project.id, (cur) => ({
          roster: (cur.roster ?? []).some((r) => r.id === route.role.id)
            ? (cur.roster ?? [])
            : [...(cur.roster ?? []), route.role],
        }))
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
      } else if (route.kind === 'queue' || route.kind === 'create') {
        // Idle lane → LAUNCH it with the task as its opening brief (the user asked for
        // dispatches to start the agent, not park work in the queue). If the launch fails,
        // the task falls back to the queue so it's never lost.
        const { role } = route
        const key = `${project.id}:${role.id}`
        const trackOrQueue = (tab: TerminalTab | undefined) => {
          if (tab) addRunning(project.id, d.task, role.id, tab.id, { cwd: tab.cwd, sourceCwd: tab.sourceCwd, worktreeBranch: tab.worktreeBranch, worktreeBase: tab.worktreeBase })
          else addTask(project.id, d.task, role.id)
        }
        const inflight = launchingLanesRef.current.get(key)
        if (inflight) {
          // This lane is already spawning from a moments-ago dispatch — hand the task to
          // that same session once it's live instead of fanning out a sibling.
          void inflight.then((tab) => {
            if (tab) void submitQueue.submit(tab.id, d.task)
            trackOrQueue(tab)
          })
        } else {
          const launch = (async () => {
            const tab = await launchRoleRef.current?.(project, role, d.task, false, { focus: false })
            trackOrQueue(tab)
            return tab
          })()
          launchingLanesRef.current.set(key, launch)
          void launch.finally(() => launchingLanesRef.current.delete(key))
        }
        record('launched')
        toast({ text: `Launching ${role.name}`, kind: 'info', detail: preview })
        feedback(route.kind === 'create'
          ? `This project had no "${role.name}" lane, so Operator CREATED one from its template and is launching it now with your task as its opening brief.`
          : `The "${role.name}" lane wasn't running — Operator is LAUNCHING it now with your task as its opening brief.`)
      } else {
        // A DISPATCH TO A LANE THAT DOES NOT EXIST IS A DELIVERY FAILURE, NOT WORK.
        //
        // This used to call `addTask` as well, which minted a durable `ProjectTask`
        // indistinguishable from something a human queued — and once such a row exists it can be
        // assigned and started. That is not hypothetical: eight rows from 2026-07-21/22 were lane
        // STATUS REPORTS ("code done: …") filed this way, and months later they were assigned to
        // the coordinator and dispatched back into its session as if they were work. Six of the
        // eight described work that was already finished.
        //
        // So nothing is created. The failed dispatch surfaces where dispatches needing a human
        // already live — the board's Waiting column — carrying its own reason, which the backlog
        // row could only borrow by a text join that dies as records age out.
        record('unassigned')
        toast({ text: `No "${d.role}" lane — waiting for you`, kind: 'info', detail: preview })
        feedback(`No lane named "${d.role}" exists in this project, so your task was NOT queued — it is on the board's Waiting column for the user to route or dismiss. Name one of the project's actual lanes, or ask the user.`)
      }
  }

  useEffect(() => {
    const SEEN_KEY = 'operator.dispatch.seen'
    const unsub = window.operator.onOrchestratorDispatch?.((d) => {
      let seen: string[] = []
      try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]') } catch { /* */ }
      if (seen.includes(d.id)) return // already handled (dedupe across transcript re-reads)
      try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, d.id].slice(-500))) } catch { /* */ }

      const { terminals: tabs, projects: projs, pushToast: toast, logDispatch: log } = dispatchRef.current
      const srcTab = tabs.find((t) => t.id === d.terminalId)
      const project = srcTab?.projectId ? projs.find((p) => p.id === srcTab.projectId) : undefined
      // The same traceless drop, on the subscription side. `orphanTabs` documents the shape: a
      // live tab missing `projectId` is invisible to routing, and six el-encanto lanes sat in
      // that state with "the only signal was the user noticing they had gone quiet".
      if (!project) {
        toast({
          text: 'A dispatch could not be routed',
          detail: srcTab
            ? `"${srcTab.roleId ?? 'A lane'}" isn't attached to a project, so its dispatch has no roster to route against.`
            : 'The lane that sent it is no longer open.',
          kind: 'error',
        })
        if (srcTab?.projectId) {
          log(srcTab.projectId, {
            id: d.id, at: new Date().toISOString(), fromRoleId: srcTab.roleId,
            toRoleId: undefined, task: d.task, outcome: 'unassigned',
          })
        }
        return
      }

      // AUTHORITY GATE. Only the coordinator commissions work unsupervised. Any other lane's
      // dispatch is recorded `pending-approval` and NOT delivered — lanes still talk, they just
      // can't silently put work into another lane's pty. Nothing expires into delivery: with no
      // approval it stays pending forever, which is the whole point of a guardrail.
      //
      // EVERY route is held, including `unassigned`. Filing a task into the backlog is still
      // commissioning work — "Start all" would run it — so the hold is on the decision to add
      // work to the project, not merely on writing into a pty.
      if (dispatchNeedsApproval(srcTab?.roleId)) {
        const roster = project.roster ?? []
        // Resolved only to NAME the target for the UI; no side effect runs here.
        const route = routeDispatch(d.role, roster, withActivityRef.current(tabs), project.id)
        const toRole = route.kind === 'unassigned' ? undefined : route.role
        const from = roster.find((r) => r.id === srcTab?.roleId)
        const preview = d.task.length > 60 ? d.task.slice(0, 60) + '…' : d.task
        log(project.id, { id: d.id, at: new Date().toISOString(), fromRoleId: srcTab?.roleId, toRoleId: toRole?.id, task: d.task, outcome: 'pending-approval' })
        // Tell the dispatcher, so it doesn't sit waiting on work that was never sent.
        if (srcTab) {
          void submitQueue.submit(srcTab.id, `[Operator] Held for approval: only the coordinator dispatches work directly. Your task for "${toRole?.name ?? d.role}" is in this project's dispatch log awaiting the user's approval — it has NOT been delivered. Recommend it in your report rather than dispatching it.`)
        }
        toast({
          text: `${from?.name ?? 'A lane'} wants to dispatch to ${toRole?.name ?? d.role}`,
          detail: `Needs your approval — see Dispatches. ${preview}`,
          kind: 'info',
        })
        return
      }

      deliverDispatchRef.current({ id: d.id, roleToken: d.role, task: d.task, terminalId: d.terminalId, projectId: project.id })
    })
    return () => { unsub?.() }
  }, [])

  /** Approve a held dispatch: deliver it exactly as a coordinator's would have been. A no-op
   *  unless the record is still `pending-approval`, so a double-click (or a second approval from
   *  another surface) cannot deliver twice. */
  const approveDispatch = useCallback((projectId: string, id: string) => {
    const project = projectsRef.current.find((p) => p.id === projectId)
    const rec = project?.dispatches?.find((x) => x.id === id)
    if (!rec || rec.outcome !== 'pending-approval') return
    // Re-routed against the CURRENT lanes, not the ones alive when it was held — the target may
    // have started or died since, and the approval means "do this now".
    const srcTab = terminalsRef.current.find((t) => t.roleId === rec.fromRoleId && t.projectId === projectId && !t.ended)
    deliverDispatchRef.current({
      id, roleToken: rec.toRoleId ?? '', task: rec.task,
      terminalId: srcTab?.id, projectId, approving: true,
    })
  }, [])

  /** Decline it. Terminal: `rejected` never delivers, and nothing reads it as pending again.
   *
   *  Also the DISMISS verb for an `unassigned` failure and for an `undelivered` one. Neither mints
   *  a backlog task, so the Waiting card is the only representation of that work and it needs a
   *  way to be closed — removing a row must never strand the need behind it. Same outcome, same
   *  finality. Which outcomes qualify is `canDismissDispatch`; this used to be an inline pair of
   *  `!==` comparisons that `undelivered` was simply missing from, so the button the board would
   *  have rendered for it would have done nothing, silently. */
  const rejectDispatch = useCallback((projectId: string, id: string) => {
    const project = projectsRef.current.find((p) => p.id === projectId)
    const rec = project?.dispatches?.find((x) => x.id === id)
    if (!rec || !canDismissDispatch(rec.outcome)) return
    setDispatchOutcome(projectId, id, 'rejected')
  }, [])

  /** THE RECOVERY PATH for a dispatch that was SENT and never arrived.
   *
   *  `undelivered` is detected by the closed loop and, until now, offered no way forward: the card
   *  had `Open lane →` and `Dismiss`, one of which was broken and the other of which abandons the
   *  work. Nine of these accumulated over two days. Detection without recovery is why.
   *
   *  IT RE-DELIVERS THE WHOLE MESSAGE, rather than submitting whatever is in the lane's composer.
   *  Both were on the table and the composer-CR is cheaper, but it is only correct if the composer
   *  still holds exactly what was pasted there — and these cards are hours to days old. A bare CR
   *  against a composer someone has since typed into submits text nobody chose to send; against a
   *  cleared one it is a silent no-op. Re-delivery depends on nothing that may have changed.
   *
   *  It also goes through `deliverDispatch`, the SAME machinery approval and routing use, which is
   *  what makes a failed retry visible: that path arms the delivery confirmation, so a retry that
   *  does not arrive lands back on `undelivered` instead of quietly flipping the card to
   *  delivered. A second send path would have had to re-implement that, and would drift.
   *
   *  THE COST, STATED: if the original paste is still sitting in the composer, the new one appends
   *  to it and the lane reads the task twice, concatenated. That is ugly and it is not
   *  destructive — the lane still gets the task and acts once. There is no composer-clear
   *  primitive in the app today (the rescue is a CR, which submits rather than clears); adding one
   *  would remove the duplication and is the obvious follow-up.
   *
   *  SEVERAL CARDS, ONE LANE: they queue. `submitQueue` is an ordered FIFO per terminal, so
   *  retries are delivered in the order they were clicked rather than racing each other. No
   *  refusal to retry more than one — the queue already answers it. */
  const retryDispatch = useCallback((projectId: string, id: string) => {
    const project = projectsRef.current.find((p) => p.id === projectId)
    const rec = project?.dispatches?.find((x) => x.id === id)
    if (!rec || rec.outcome !== 'undelivered') return
    // Re-routed against the CURRENT lanes, exactly as an approval is: the target may have started
    // or died since it was sent, and the retry means "do this now".
    const srcTab = terminalsRef.current.find((t) => t.roleId === rec.fromRoleId && t.projectId === projectId && !t.ended)
    // CLEAR FIRST, when the target is live. The stale paste is very likely still sitting in that
    // composer — that is what `sent · never started` MEANS — and re-delivering onto it would make
    // the lane read the task twice, concatenated. Queued on the same per-terminal chain as the
    // delivery that follows, so it cannot overtake it. Bounded by the lines WE pasted; anything a
    // human typed beyond that survives, deliberately.
    const targetTab = terminalsRef.current.find((t) => t.roleId === rec.toRoleId && t.projectId === projectId && !t.ended)
    if (targetTab) void submitQueue.clearComposer(targetTab.id, composerLines(rec.task))
    deliverDispatchRef.current({
      id, roleToken: rec.toRoleId ?? '', task: rec.task,
      terminalId: srcTab?.id, projectId, approving: true,
    })
  }, [])

  /** THE RECOVERY PATH for a dispatch that named no lane: route it to a real one now.
   *
   *  The backlog row it used to create was a rescue path — you could assign and send it — so
   *  removing the row had to keep that. It re-enters the SAME delivery machinery an approval
   *  uses (`deliverDispatch` with a valid role token), so live lanes, idle lanes and
   *  create-from-template all behave exactly as they do for any other dispatch; there is no
   *  second send path to drift. */
  const assignDispatch = useCallback((projectId: string, id: string, roleId: string) => {
    const project = projectsRef.current.find((p) => p.id === projectId)
    const rec = project?.dispatches?.find((x) => x.id === id)
    if (!rec || rec.outcome !== 'unassigned') return
    const srcTab = terminalsRef.current.find((t) => t.roleId === rec.fromRoleId && t.projectId === projectId && !t.ended)
    deliverDispatchRef.current({
      id, roleToken: roleId, task: rec.task,
      terminalId: srcTab?.id, projectId, approving: true,
    })
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

  // The seeded-lane prune's one-shot flag. Read once into a ref: the hydrate effect below is the
  // only reader, and it must decide from the value as it was at mount.
  const pruneDoneRef = useRef<boolean>(seededLanePruneDone())
  const markPruneDone = useCallback(() => {
    pruneDoneRef.current = true
    markSeededLanePruneDone()
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
      // Saved sessions launched on the legacy coordinator lane follow the rename too,
      // so they still resolve against the migrated roster.
      let nextSaved: SavedSession[] = saved.some((s) => s.roleId === 'orchestrator')
        ? saved.map((s) => (s.roleId === 'orchestrator' ? { ...s, roleId: 'operator' } : s))
        : saved
      // …and the effort ladder: a row saying `normal` names a level Claude Code never had, so it
      // becomes `medium` (lib/effort). Returns the same array when there is nothing to migrate.
      nextSaved = migrateSavedEfforts(nextSaved).sessions
      if (Array.isArray(pList) && pList.length) {
        // projects.json exists → no path backfill, but rosters saved before the
        // Orchestrator→Operator rename still migrate (persisted by the effect below).
        const renamed = (pList as Project[]).map(migrateLegacyCoordinator)
        // …and then the SEEDED-FIELD migration: clear every roster field that exactly equals its
        // built-in preset, so it reads as inherited and a global default can reach it. Content-
        // sniffing and idempotent — `clearSeededRoleFields` returns the same object when there is
        // nothing to do, so the second run finds nothing and the third is free.
        //
        // Clearing a field that equals the preset is a NO-OP today: the cascade falls straight
        // through to the same preset value. It only becomes meaningful once a global default is set,
        // which is what makes it safe to run unattended on hydrate.
        // …then the same treatment for a COORDINATOR's `useWorktree` pin, which is not a seeded
        // value that merely looks pinned but a stored value that is now contradicted: the
        // coordinator runs in the repo whatever it says (`resolveAgentConfig`), so leaving it
        // would keep `projects.json` claiming otherwise. Five projects carry it. Composed as its
        // own pass rather than folded into `clearSeededRoleFields` because the test is different —
        // that one clears what EQUALS the preset, this clears any value at all on a role that is
        // no longer offered the choice.
        // …the effort-ladder migration runs FIRST of the three, so `clearSeededRoleFields` compares a
        // migrated `medium` against the migrated preset rather than a stale `normal` against it —
        // otherwise every operator/design lane keeps a pin that is now identical to its preset.
        const reconciled = renamed.map(migrateProjectEfforts).map(clearSeededRoleFields).map(clearCoordinatorWorktree)
        const rewrites = reconciled.filter((p, i) => p !== renamed[i]).length
        // …and then, ONCE per install, the seeded-lane PRUNE: projects created before seeding was
        // removed still carry six lanes nobody asked for, so drop the ones that were never used and
        // never edited (lib/prune-seeded-lanes decides; it errs toward keeping).
        //
        // The flag is what makes this one-time, and it is not an optimisation: the predicate can't
        // tell a leftover seeded lane from one the user just added back and hasn't launched yet, so
        // without it every "+ Add agent" would be undone at the next launch. It is set even when
        // nothing was pruned — the scan happened, the answer was none.
        const prune = pruneDoneRef.current ? null : pruneSeededIdleLanes(reconciled, nextSaved)
        // A scan that found nothing is finished the moment it ran, whatever else this branch
        // writes — and it has to be recorded here, not only alongside a successful prune, or a
        // store with nothing to drop would re-scan on every launch and eventually catch a lane
        // the user added back in the meantime.
        if (prune && !prune.lanes) markPruneDone()
        if (rewrites || prune?.lanes) {
          // No backup, no write. A failed copy means we keep the pinned values rather than rewrite
          // rosters with no way back — the same rule chatstore's purge follows.
          try {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-')
            await window.operator.backupProjects?.(stamp)
            setProjects(prune?.lanes ? prune.projects : reconciled)
            if (prune?.lanes) {
              markPruneDone()
              // Removing lanes off-screen during launch is the kind of change you notice a day
              // later, so it announces itself and stays until dismissed (an `action` toast does).
              // Undo restores the pre-prune rosters and leaves the flag SET — undo means "keep
              // them", so the next launch must not prune them again.
              pushToast({
                text: `Tidied ${prune.lanes} unused lane${prune.lanes === 1 ? '' : 's'} from ${prune.touched} project${prune.touched === 1 ? '' : 's'}`,
                // The detail line is ONE line with an ellipsis (Toast.tsx) and the Undo button eats
                // into it: ~40 characters land, so this says why and lets the button say the rest.
                detail: 'Never launched, never edited.',
                action: { label: 'Undo', run: () => setProjects(reconciled) },
              })
            }
          } catch (e) {
            console.warn('roster reconcile skipped — projects.json backup failed:', e)
            setProjects(renamed)
          }
        } else {
          setProjects(renamed)
          if (prune) markPruneDone()
        }
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

  /** THE ONE-ALTITUDE MIGRATION, once per install.
   *
   *  Model, effort and worktree used to be settable at three altitudes — the lane's pin, a global
   *  per-role layer in `~/.operator/role-defaults.json`, and (for effort and permission mode) the
   *  project's own defaults. The global tier and its editor are gone; a lane now shows what it
   *  will use and lets you pin it, and that is the whole model.
   *
   *  Deleting a tier is only safe if nothing resolved THROUGH it changes answer, so this reads the
   *  old file one last time and writes its verdict down as per-lane pins wherever the two cascades
   *  would disagree (`migrateGlobalsToLanePins` resolves each lane both ways and compares, rather
   *  than pattern-matching what it thinks the tier was doing). The file is left on disk: nothing
   *  reads it again, and it is the record of what was there.
   *
   *  Gated on `savedHydrated`, which is not incidental — the projects hydrate applies
   *  `clearSeededRoleFields` first, and that changes the answer. A lane whose seeded `model`
   *  equals its preset resolves through the GLOBAL once that redundant pin is cleared, which is
   *  exactly today's post-hydrate behaviour and therefore what has to be preserved. Running this
   *  against the pre-hydrate rosters would faithfully migrate a state the user never launched in. */
  const oneAltitudeDoneRef = useRef(oneAltitudeMigrationDone())
  /** Set when pins are computed and not yet durable. The persist effect stamps and clears it —
   *  see the ORDERING note below. */
  const oneAltitudePendingRef = useRef(false)
  useEffect(() => {
    if (!savedHydrated || oneAltitudeDoneRef.current) return
    oneAltitudeDoneRef.current = true // in-memory too: the effect must not re-enter before the write lands
    const p = window.operator.loadRoleDefaults?.()
    if (!p) { markOneAltitudeMigrationDone(); return }
    void p.then((raw) => {
      const globals = (raw ?? {}) as LegacyGlobalDefaults
      // Counts for the TOAST only, and deliberately advisory: the authoritative migration is the
      // functional update below, which runs against whatever `prev` actually is.
      const preview = migrateGlobalsToLanePins(projectsRef.current, globals)
      // Nothing to write down → nothing can be lost, so the stamp is safe here and only here.
      if (!preview.pins) { markOneAltitudeMigrationDone(); return }
      oneAltitudePendingRef.current = true
      // FUNCTIONAL, not `setProjects(next)`. `projectsRef.current` is assigned in the render body,
      // so it lags any update scheduled in the current commit but not yet rendered — and the
      // stale-task reconciliation fires on the same `savedHydrated` flag. If `loadRoleDefaults()`
      // resolved first, a plain value would overwrite that reconciliation wholesale, taking any
      // `logDispatch` record written in the window with it. Reading `prev` cannot go stale.
      // Re-running the migration on `prev` is free: it is pure, idempotent, and returns its input
      // by reference when there is nothing to do.
      setProjects((prev) => migrateGlobalsToLanePins(prev, globals).projects)
      // No Undo, deliberately: by construction this changed no lane's effective config, so there
      // is nothing to undo. It is worth SAYING because the settings moved house — the place to
      // change them is now the lane itself.
      pushToast({
        text: `${preview.pins} agent setting${preview.pins === 1 ? '' : 's'} moved onto ${preview.lanes} lane${preview.lanes === 1 ? '' : 's'}`,
        kind: 'info',
        // Names exactly the fields this can write. It briefly named a fourth, `permissionMode`,
        // which was 37 of the real store's 56 pins — that field now reads the project in both
        // cascades (see resolveAgentConfig), so the migration writes none of it and the toast is
        // true again. Permission mode is deliberately NOT "set on the agent": it stayed on the
        // project, which is the only thing that ever set it.
        detail: 'Model, effort and worktree are set on the agent now — your Agents defaults were written onto each lane, so nothing changed.',
      })
      // The stamp is NOT written here. See the persist effect.
    }).catch(() => {
      // Deliberately UNSTAMPED. A read that failed migrated nothing, so the next launch must try
      // again — stamping here would mean the file is never read and every lane silently falls to
      // preset/fallback, which is the exact flip this migration exists to prevent.
    })
  }, [savedHydrated, pushToast])

  // Scope is durable — relaunch lands you back inside your last project, at Project Home.
  useEffect(() => {
    try {
      if (activeProjectId) localStorage.setItem('operator.activeProjectId', activeProjectId)
      else localStorage.removeItem('operator.activeProjectId')
    } catch { /* quota */ }
  }, [activeProjectId])

  // …falling back to the gallery when the restored project is gone from the store. Gated on
  // hydration: projects.json arrives async, so checking any earlier would drop a valid scope
  // during the window where `projects` is still the (possibly empty) localStorage seed.
  useEffect(() => {
    if (!savedHydrated || !activeProjectId) return
    if (!projects.some((p) => p.id === activeProjectId)) setActiveProjectId(null)
  }, [savedHydrated, activeProjectId, projects])

  // The invariant behind spec §4 rule 1, as a backstop: whatever session is focused, the
  // scope contains it. Every user-facing path sets both itself; this catches the ones that
  // don't go through a handler at all — notably the pty re-attach after a webview reload,
  // which restores a focused terminal that may not belong to the restored scope.
  useEffect(() => {
    if (!activeTerminalId) return
    const tab = terminals.find((t) => t.id === activeTerminalId)
    if (!tab?.projectId || tab.projectId === activeProjectId) return
    // ONLY adopt a scope the store actually holds. Without this, a tab stamped with a
    // forgotten project id ping-pongs with the validation effect above — that one clears the
    // scope because it isn't in `projects`, this one restores it from the tab, forever.
    // Anchoring both effects to the same source of truth is what breaks the cycle.
    if (!projects.some((p) => p.id === tab.projectId)) return
    setActiveProjectId(tab.projectId)
  }, [activeTerminalId, terminals, activeProjectId, projects])

  // Spec §4 rule 9: a session launched before projects existed carries no projectId, so it
  // belongs to no scope and a project-first sidebar could never show it. Resolve each unknown
  // cwd to its canonical project once, register it, and stamp the tab — after which it lands
  // in that project like any other. Anything unresolvable (folder gone) stays reachable from
  // the gallery's activity view only.
  const resolvingCwdsRef = useRef(new Set<string>())
  useEffect(() => {
    for (const t of terminals) {
      if (t.projectId) continue
      const cwd = t.sourceCwd ?? t.cwd
      if (!cwd || resolvingCwdsRef.current.has(cwd)) continue
      resolvingCwdsRef.current.add(cwd)
      void resolveProject(cwd)
        .then((proj) => {
          // Don't re-adopt a project the user forgot in THIS run: its sessions keep running
          // with no scope (reachable from the gallery's activity view), which is what
          // "forget" means. Opening the folder again still registers it explicitly.
          if (forgottenProjectsRef.current.has(proj.id)) return
          upsertProject(proj)
          setTerminals((prev) => prev.map((x) => ((x.sourceCwd ?? x.cwd) === cwd && !x.projectId ? { ...x, projectId: proj.id } : x)))
        })
        .catch(() => { /* unresolvable — leave it unscoped */ })
    }
  }, [terminals, upsertProject])

  // Re-attach the sidebar to ptys that survived a renderer/webview reload. The Rust
  // backend (and its running ptys) outlive a reload, but React state resets, so the
  // sidebar would otherwise go blank. Once the durable store is hydrated, intersect
  // the live pty list with the saved metadata (matched by the still-valid terminalId
  // from this same backend run) and rebuild the tabs. A full app restart has no live
  // ptys → terminal_list is empty → nothing re-attaches (the restorable-sessions
  // splash handles cold starts instead).
  const reattachedRef = useRef(false)
  // Set once the re-attach has resolved (either way) — the task reconciliation below must
  // not run until the live pty set is actually known.
  const [reattachDone, setReattachDone] = useState(false)
  useEffect(() => {
    if (!savedHydrated || reattachedRef.current) return
    reattachedRef.current = true
    const p = window.operator.terminalList?.()
    if (!p) { setReattachDone(true); return }
    p.then((all) => {
      // Exclude scratch shells (`sh` ids from ShellModal) — those belong to the
      // toolbar modal, not the sidebar. Claude sessions use `t` ids.
      const live = (Array.isArray(all) ? all : []).filter((t) => !t.id.startsWith('sh'))
      if (live.length === 0) return // nothing survived; `finally` still settles reattachDone
      // JOINED ON THE DURABLE KEY, and on the recycled one only where it cannot lie — see
      // `joinReattach`, which owns the rule and is tested against it. The short version: a saved
      // `terminalId` is a per-run counter, so after a backend restart it can staple one project's
      // record onto another project's live pty, and a MISLABELLED tab never heals the way an
      // unlabelled one does (the 5s re-stamp below fixes unlabelled; nothing fixes wrong).
      setTerminals((prev) => {
        if (prev.length > 0) return prev // already populated (a launch raced the re-attach)
        return joinReattach(live, savedSessions).map(({ pty: t, saved: s }): TerminalTab => {
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
            // The backend's record is the FALLBACK, not the fallback's fallback: a pty whose
            // saved row is missing entirely is still routable if Rust knows its project.
            projectId: s?.projectId ?? t.projectId,
            roleId: s?.roleId,
            reattached: true, // replay buffered scrollback on mount
            // Off the PTY, not off the pref: this session's renderer was decided when it was
            // spawned, possibly before a reload and possibly before the pref was last changed.
            grid: t.grid,
          }
        })
      })
      setActiveTerminalId((cur) => cur ?? live[0].id)
      setActiveSessionId((cur) => cur ?? `local-${live[0].id}`)
    })
      .catch(() => { /* no re-attach */ })
      .finally(() => setReattachDone(true))
  }, [savedHydrated, savedSessions])

  /** WHEN EACH LANE LAST REPORTED A TASK DONE, by terminal id — the only "finished" signal this
   *  app has that isn't a guess (see lib/lane-lifecycle for why silence is not one). Stamped by
   *  the poller below, read by the lane-close effect.
   *
   *  A REF, so it dies with the renderer: after a reload no lane counts as having reported, and
   *  the worst case is a lane that stays up until it reports again. Persisting it would make the
   *  failure point the other way — a stale stamp closing a lane that is mid-turn. */
  const doneReportsRef = useRef<Record<string, string>>({})

  // THE ARTIFACT PLANE'S COMPLETION SIGNAL, applied here.
  //
  // `fix-session-task-lifecycle-RESULT.md` concluded, about the ~200 tasks stuck in `running`:
  // "Completion only fires when a lane DIES… there is no per-turn completion signal… Not fixed
  // here and not fixable by reconciliation… Closing them needs a real completion signal."
  // `operator__task_status` IS that signal, and this effect is where it lands.
  //
  // POLLED, NOT PUSHED, and that is a consequence of the design rather than a shortcut: the MCP
  // server runs in a separate short-lived process spawned by the lane's own Claude Code, so it
  // cannot emit a Tauri event into this window. It appends to `~/.operator/artifacts.db`; this
  // reads what has not been applied yet. 4s matches the session-ports poller already here.
  //
  // ACKED ONLY AFTER THE WRITE. `setTaskStatus` is synchronous state, so by the time we ack, the
  // task has been updated and the persist effect will write it. A renderer that dies in between
  // replays the event on the next boot rather than dropping it — applying `done` twice is the
  // same task; dropping it once is the leak.
  //
  // GATED ON HYDRATION, and this is not belt-and-braces — it is a bug I shipped into this effect
  // and caught in the harness. The first tick runs on mount, BEFORE `loadProjects` resolves, so
  // every task looks unknown; the unknown-task branch acked, and the event was gone forever. A
  // signal dropped because we asked too early is the same lost completion as no signal at all.
  useEffect(() => {
    if (!savedHydrated) return
    let stopped = false
    const tick = async () => {
      try {
        const pending = await window.operator.artifactPendingStatus?.()
        if (stopped || !pending?.length) return
        const applied: number[] = []
        for (const ev of pending) {
          // THE LANE-LIFECYCLE HALF of the same event: a `done` report is what makes its lane
          // closable (lib/lane-lifecycle). Stamped even when the TASK id resolves to nothing —
          // lanes are told to call `task_status(id,'done')` but are never handed the store's uuid,
          // so an unresolvable id is the common case and it is still an explicit "I finished".
          // What must not happen is inferring completion from silence, and this is not that.
          //
          // AGE-GUARDED because `terminalId` is a per-run counter that collides across runs: an
          // event left pending by a renderer that died could otherwise mark a DIFFERENT lane
          // done after a restart. Events are polled every 4s, so anything an hour old is not
          // this run's.
          if (ev.status === 'done' && Date.now() - Date.parse(ev.at) < 60 * 60 * 1000) {
            const tab = terminalsRef.current.find((t) => t.id === ev.terminalId)
            if (tab && (!ev.projectId || ev.projectId === tab.projectId)) {
              doneReportsRef.current[ev.terminalId] = ev.at
            }
          }
          // Resolve the project from the EVENT first, then from the lane that sent it — a lane
          // that reported before `sessions.json` caught up still has a terminal id we can match.
          const projectId = ev.projectId
            ?? terminalsRef.current.find((t) => t.id === ev.terminalId)?.projectId
            ?? projectsRef.current.find((p) => (p.tasks ?? []).some((t) => t.id === ev.taskId))?.id
          if (!projectId) continue // leave it pending: unattributable now may be attributable later
          const known = projectsRef.current.find((p) => p.id === projectId)?.tasks?.some((t) => t.id === ev.taskId)
          // A status for a task we do not have is ACKED, not retried forever: the lane may have
          // invented an id, and an event that can never apply would otherwise be re-read every
          // 4 seconds for the life of the install.
          if (known && (ev.status === 'queued' || ev.status === 'running' || ev.status === 'done')) {
            setTaskStatus(projectId, ev.taskId, ev.status)
          }
          applied.push(ev.id)
        }
        if (applied.length) await window.operator.artifactAckStatus?.(applied)
      } catch { /* the store is best-effort; a failed poll retries in 4s */ }
    }
    void tick()
    const timer = window.setInterval(() => { void tick() }, 4000)
    return () => { stopped = true; clearInterval(timer) }
  }, [setTaskStatus, savedHydrated])


  // Close out tasks left `running` by a previous run. `ProjectTask.terminalId` is a pty id
  // from the CURRENT backend run, so a task carrying a dead one can never be matched again by
  // the completion path — which is why the store had ~200 tasks stuck in `running`, one
  // project with 26 running and zero done. Runs ONCE, after re-attach has established which
  // ptys really survived (any earlier and it would close tasks whose terminal is about to
  // come back). See lib/task-lifecycle for why they land on `done` rather than `queued`.
  const reconciledRef = useRef(false)
  useEffect(() => {
    if (!savedHydrated || !reattachDone || reconciledRef.current) return
    reconciledRef.current = true

    // --- PRUNE THE RESTORE LIST (separate concern from the task reconcile below) -----------
    // Duplicate lane records: the same (project, role) saved four or five times, because the
    // launch path used to spawn a second lane for a role that already had a live one. Runs
    // AFTER reattach so `liveClaudeIds` is real — a live lane's record is never pruned, whatever
    // else exists for its role. Idempotent, so it early-bails on every launch after the first.
    void (async () => {
      const liveClaudeIds = new Set(
        sessionsRef.current.filter((x) => x.status !== 'ended' && !x.id.startsWith('local-')).map((x) => x.id),
      )
      const { kept, dropped } = pruneSavedSessions(savedSessionsRef.current, liveClaudeIds)
      if (!dropped.length) return
      // Back up before the first destructive write. No Rust needed: folderPrefsSaveMd is a
      // verbatim text writer that creates its parent dirs (the buffer-dump uses it the same
      // way). Re-serialized rather than byte-copied — same data, not the same bytes.
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const path = `${await window.operator.operatorHome()}/backups/sessions.json.${stamp}`
        await window.operator.folderPrefsSaveMd(path, JSON.stringify(savedSessionsRef.current, null, 2))
      } catch (e) {
        // No backup, no prune. Losing restore records with no way back is not a trade worth
        // making for tidiness.
        console.warn('sessions.json backup failed; skipping prune', e)
        return
      }
      setSavedSessions(kept)
      pushToast({
        text: `Pruned ${dropped.length} duplicate lane record${dropped.length === 1 ? '' : 's'}`,
        detail: 'Older duplicates of a lane that already had a newer session. Backed up first.',
        kind: 'info',
      })
    })()
    const now = new Date().toISOString()
    setProjects((prev) => {
      let changed = false
      const next = prev.map((p) => {
        // Scoped per project: a lane only owns tasks filed against its own project, and
        // `terminalId` is far too collidable to match across them.
        const tasks = reconcileStaleRunning(p.tasks, liveLanesOf(p.id), now)
        if (tasks === p.tasks) return p
        changed = true
        return { ...p, tasks }
      })
      return changed ? next : prev
    })
  }, [savedHydrated, reattachDone, terminals])

  // THE USER'S OWN `~/.claude/settings.json`, migrated once. Operator wrote `effortLevel: "normal"`
  // there on every launch, and the file's schema drops an out-of-enum value SILENTLY — so the
  // setting has been inert for as long as it has been there. Nothing else will fix it: the launch
  // path no longer writes the file at all, and Preferences only rewrites it if the user goes and
  // clicks something.
  //
  // Narrow on purpose. It rewrites ONLY the exact legacy value, on the two files Operator was ever
  // the author of (global user + global local), so it is idempotent, needs no one-shot flag, and
  // cannot touch a level the user chose in Claude Code itself.
  useEffect(() => {
    void (async () => {
      try {
        const prefs = await window.operator.folderPrefsLoadGlobal?.()
        for (const f of prefs?.settingsFiles ?? []) {
          if (f.scope !== 'global' && f.scope !== 'global-local') continue
          if (f.readOnly || !f.exists || !isLegacyEffort(f.settings.effortLevel)) continue
          await window.operator.folderPrefsSaveSettings(f.path, { effortLevel: settingsEffort('medium') })
        }
      } catch { /* the settings file is the user's, not ours — a failure here is not the app's problem */ }
    })()
  }, [])

  /** `resume` continues a SUSPENDED lane instead of starting a cold one: the same Claude thread
   *  (`--resume`), the same worktree branch reattached, and the same saved-session key so the
   *  record is updated in place rather than duplicated. Single-session launches only — fan-out
   *  spawns siblings, and there is one thread to resume. */
  const handleLaunchSession = useCallback(async (cwd: string, config: SessionConfig, opts?: { roleId?: string; orchestrationNote?: string; focus?: boolean; resume?: { key: string; claudeSessionId: string; worktreeBranch?: string; worktreeBase?: string } }): Promise<TerminalTab[]> => {
    // NO GLOBAL SETTINGS WRITE. This used to load the folder prefs and put `config.effortLevel`
    // into `~/.claude/settings.json` before spawning — one app-wide file standing in for a per-lane
    // choice, so launching six lanes at six efforts was last-write-wins across all of them (and the
    // value it wrote, `normal`, was not even in the file's enum). The effort rides the lane's own
    // `--effort` flag now; see lib/launch-args.

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
        // A resumed lane goes back on the branch it left, so its own committed work is in the
        // tree its transcript remembers writing (see worktree::reattach_worktree). A fresh lane
        // passes nothing and forks from the default branch exactly as before.
        const reuse = count === 1 ? opts?.resume?.worktreeBranch : undefined
        const result = await window.operator.worktreeCreate(cwd, reuse, opts?.roleId)
        // `!result` first: `'error' in undefined` THROWS, and it threw out of the whole launch —
        // so a worktree backend that answered unexpectedly took the session with it rather than
        // falling back. Now it degrades the same way a reported error does.
        if (!result || 'error' in result) {
          console.warn('Worktree creation failed:', result && 'error' in result ? result.error : 'no result')
        } else {
          spawnCwd = result.path
          worktreeBranch = result.branch
          worktreeBase = result.baseBranch
        }
      }

      const launchOptions: Record<string, unknown> = {}
      if (config.permissionMode !== 'default') launchOptions.permissionMode = config.permissionMode
      if (config.model) launchOptions.model = config.model
      if (config.effortLevel) launchOptions.effort = config.effortLevel
      if (config.allowedTools) launchOptions.allowedTools = config.allowedTools
      // "Launch dev server" → ask the agent (single session only; fan-out worktrees would
      // collide on ports) to start it in the background on its reserved port, before any task.
      const devInstr = config.launchDevServer && count === 1
        ? "First, make sure this project's dev server is up on the port Operator reserved for you (named in your system prompt): if that port already responds, another lane is serving the same code — just use it. Only if it's down, start the dev server yourself in the BACKGROUND on EXACTLY that port (--port with strict-port semantics, or the PORT env — never accept an auto-incremented fallback port), and don't block the terminal on it."
        : ''
      const initial = [devInstr, config.prompt].filter(Boolean).join('\n\n')
      if (initial) launchOptions.initialPrompt = initial
      if (opts?.orchestrationNote) launchOptions.orchestrationNote = opts.orchestrationNote
      // Rides to the tailer so any OPERATOR-REPLY this lane posts is stamped with its project
      // (the backend can't derive our canonical-repo-root ids).
      launchOptions.projectId = proj.id
      // And the role, for the same reason one layer down: it becomes `OPERATOR_ROLE_ID` in the
      // lane's environment, which is what lets its MCP server stamp a report with who filed it
      // rather than looking up a terminal id that several sessions share.
      if (opts?.roleId) launchOptions.roleId = opts.roleId
      // `--resume <id>` instead of `--session-id <new uuid>` (lib/launch-args): the lane comes
      // back with its thread, so a re-dispatch costs a process start and not a cold context.
      if (count === 1 && opts?.resume) launchOptions.resumeSessionId = opts.resume.claudeSessionId

      const result = await window.operator.terminalSpawn(spawnCwd, launchOptions)
      if (!result) continue

      const tab: TerminalTab = {
        id: result.terminalId,
        // A resumed lane keeps its saved-session KEY, so the persist effect rewrites that row
        // (clearing `suspendedAt` with it) instead of leaving a suspended twin behind — the
        // duplicate-lane-record shape this store has already been cleaned of once.
        key: (count === 1 ? opts?.resume?.key : undefined) ?? crypto.randomUUID(),
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
        grid: result.grid,
      }
      setTerminals((prev) => [...prev, tab])
      spawned.push(tab)
      // Focus the first agent; the rest run in the background. An auto-launched lane
      // (dispatch to an idle lane) passes focus:false — it must not yank the user away
      // from whatever they're watching.
      if (i === 0 && opts?.focus !== false) {
        setActiveTerminalId(result.terminalId)
        setActiveSessionId(`local-${result.terminalId}`)
        setActiveProjectId(proj.id) // launching switches to the new agent's console, in its project
      }
    }

    rememberRecent(cwd)
    // USER: launching a lane here is as deliberate as opening the folder.
    upsertProject(proj, { intent: 'user', defaults: { model: config.model, effortLevel: config.effortLevel, permissionMode: config.permissionMode } })
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
  //
  // In-flight guard: launching takes seconds (worktreeCreate + terminalSpawn) and the
  // UI's live-lane filtering only updates after the spawn resolves, so a double-click
  // (RosterPanel Launch, hub PassiveCard) would otherwise spawn two worktrees + two
  // ptys for one lane. Concurrent callers JOIN the pending launch; a joiner's prompt
  // is typed into the spawned pty instead of being dropped.
  const launchInFlightRef = useRef(new Map<string, Promise<TerminalTab | undefined>>())
  const handleLaunchRole = useCallback(async (project: Project, role: Role, prompt?: string, launchDevServer = false, opts?: { focus?: boolean }): Promise<TerminalTab | undefined> => {
    const laneKey = `${project.id}:${role.id}`
    // REUSE A LIVE LANE. The in-flight guard below only covers the seconds a launch takes; it
    // never stopped a SECOND lane being spawned for a role that already had a live session, and
    // that is what actually happened — the real store held 4-5 sessions per role in one project.
    // The damage isn't the extra pty: dispatch resolves a role to ONE terminal, so every
    // duplicate beyond the winner is live, unreachable, and holding whatever it was last sent.
    // Work went into them and the answers came back where nothing was looking.
    // `pickLaneTab` is the SAME resolution dispatch uses, so a reused lane and a dispatched
    // one can never disagree about which terminal is the lane.
    const existing = pickLaneTab(withActivity(terminalsRef.current), project.id, role.id)
    if (existing) {
      const joined = prompt?.trim()
      if (joined) void submitQueue.submit(existing.id, joined)
      if (opts?.focus !== false) setActiveTerminalId(existing.id)
      return existing
    }
    const pending = launchInFlightRef.current.get(laneKey)
    if (pending) {
      const tab = await pending
      const joined = prompt?.trim()
      if (tab && joined) void submitQueue.submit(tab.id, joined)
      return tab
    }
    const run = (async (): Promise<TerminalTab | undefined> => {
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
    // THE ONE RESOLVER (lib/model-config). Per field: this lane's pin → the global role default →
    // the project's saved defaults → the built-in preset. Nothing here reads `role.model` or
    // `role.useWorktree` directly any more — that is what made every seeded value look pinned and
    // left a global default with nothing to override.
    const settings = resolveAgentConfig(role, project.defaults)
    // SPAWN ON DEMAND, BUT NOT FROM SCRATCH. A lane closed by the task-scoped path left a record
    // behind on purpose (see handleCloseSession's `suspend`); relaunching it resumes that thread
    // rather than starting cold, which is what makes closing a lane cheap enough to do at all.
    // Most recent wins if a role somehow has several — same rule as `pickLaneTab`.
    const suspended = savedSessionsRef.current
      .filter((s) => s.projectId === project.id && s.roleId === role.id && s.suspendedAt && s.claudeSessionId)
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))[0]
    const tabs = await handleLaunchSession(
      project.path,
      {
        effortLevel: settings.effort,
        permissionMode: settings.permissionMode as SessionConfig['permissionMode'],
        model: settings.model,
        allowedTools: '',
        useWorktree: settings.useWorktree, // isolated lane → attributable diff + merge-back
        launchDevServer,
        count: 1,
        prompt: combined,
      },
      {
        roleId: role.id,
        orchestrationNote: note,
        focus: opts?.focus,
        resume: suspended
          ? { key: suspended.key, claudeSessionId: suspended.claudeSessionId!, worktreeBranch: suspended.worktreeBranch, worktreeBase: suspended.worktreeBase }
          : undefined,
      },
    )
    // Now the terminal (and worktree) exist — stamp the picked-up tasks with their lane.
    if (tabs[0] && queued.length) markTasksRunning(project.id, queued.map((t) => t.id), tabs[0].id, laneOf(tabs[0]))
    return tabs[0]
    })()
    launchInFlightRef.current.set(laneKey, run)
    try {
      return await run
    } finally {
      launchInFlightRef.current.delete(laneKey)
    }
  }, [handleLaunchSession, markTasksRunning])
  launchRoleRef.current = handleLaunchRole // fresh closure every render for the dispatch subscription

  /** A HUMAN just addressed a lane from the chat composer. The delivery brakes' hop budget is
   *  restored by a human message and by nothing else — `exhausted` has no timer, and a lane that
   *  hit the chain limit is barred from SENDING as well as receiving, so without this a lane you
   *  are actively talking to stays silently unable to answer anyone until the app restarts.
   *
   *  `dispatchToRole` was the only caller, and it is reached only from the board's Send → and
   *  Start all. That is the right home for the reset; it was never a sufficient SET of callers —
   *  the chat composer is where a human actually talks to a lane. */
  const handleHumanSend = useCallback((roleId?: string) => {
    if (!roleId) return
    deliveryStateRef.current = resetChainFor(deliveryStateRef.current, roleId)
  }, [])

  // Focus an already-live lane/session (the "View" action — vs "Launch" which spawns a new one).
  const focusTerminal = useCallback((terminalId: string) => {
    const tab = terminals.find((t) => t.id === terminalId)
    if (!tab) return
    setActiveTerminalId(terminalId)
    const hook = sessions.find((s) => s.terminalId === terminalId)
    setActiveSessionId(hook?.id ?? `local-${terminalId}`)
    // Focusing a session implies its project scope, so the sidebar always contains what
    // you're looking at (spec §4 rule 1).
    if (tab.projectId) setActiveProjectId(tab.projectId)
  }, [terminals, sessions])
  focusTerminalRef.current = focusTerminal

  /** OPEN a lane — focus it AND go there. Distinct from `focusTerminal` on purpose.
   *
   *  `focusTerminal` sets `activeTerminalId`/`activeSessionId`/`activeProjectId` and nothing else,
   *  which is right for its callers (a toast's "Show", the reconcile effect) — they nudge state
   *  under whatever the user is looking at. From the BOARD that is not enough: `contentMode`
   *  ranks `prefs`/`agents`/`globalPrefs`/`folderPrefs` ABOVE `localTerminal`, so if any of those
   *  is up the click changes ids behind the screen and you see nothing happen. It also returns
   *  early when the id is not a live tab, which is the other way `Open lane →` did nothing at all.
   *
   *  So this clears the competing surfaces the way `handleSelectSession` does, pins the surface to
   *  the Console (the lane's own output — landing on a stale Chat/Preview overlay is the same
   *  "nothing happened" from the user's side), and REPORTS whether it found the lane, so the
   *  caller can fall back instead of silently doing nothing. Added here rather than inside
   *  `focusTerminal` because its other callers rely on focus-without-navigation. */
  const openLaneTerminal = useCallback((terminalId: string): boolean => {
    const tab = terminals.find((t) => t.id === terminalId)
    if (!tab) return false
    setActiveFolderPrefs(null)
    setGlobalPrefsActive(false)
    setAgentsViewActive(false)
    setPrefsViewActive(false)
    setActiveTerminalId(terminalId)
    const hook = sessions.find((s) => s.terminalId === terminalId)
    setActiveSessionId(hook?.id ?? `local-${terminalId}`)
    if (tab.projectId) setActiveProjectId(tab.projectId)
    selectMainView('terminal')
    return true
  }, [terminals, sessions, selectMainView])

  // Delegation: send a task to a lane. If the lane has a live session, type it into that pty
  // (bracketed paste + CR); otherwise launch the lane with the task. The autonomous
  // "orchestrator delegates on its own" remains the deferred structured-UI path.
  //
  // IT DOES NOT NAVIGATE, and that is the point. Two motions used to share this implementation
  // and they mean opposite things: clicking a lane's chip is "take me to that lane" (navigation
  // IS the verb), while `Send →` on a card is "put this work into that lane" — you want to stay
  // and watch it move Backlog → Running. Focusing the pty here made the board read as a form you
  // filled in on the way to the real place, which is the posture the whole board was built to
  // remove. Both of this function's callers are board verbs (`Send →`, `Start all`) and neither
  // wants to move you; `Start all` wanted it least of all, since it would have yanked you into
  // whichever lane happened to be last in the loop. The chip keeps its navigation through a
  // different path entirely (`onOpenLane` → `focusTerminal`).
  const dispatchToRole = useCallback((project: Project, role: Role, task: string) => {
    const t = task.trim()
    if (!t) return
    // A HUMAN MESSAGE RESETS THE ADDRESSEE'S CHAIN. This used to live in `sendChannelMessage`,
    // the channel composer's send — which was `resetChainFor`'s only caller, so deleting the
    // channel would have taken the hop budget's only recovery path with it.
    //
    // That is not a cosmetic loss. `exhausted` has no timer of its own (see agent-delivery): a
    // lane that hits HOP_LIMIT is barred from SENDING as well as receiving, and the mark is
    // cleared by exactly two things — a delivery that itself passed the budget check, which a
    // barred lane can no longer produce, and this. Without a home for it the brakes would still
    // engage and never release: one runaway chain and that lane is mute until the app restarts.
    //
    // `dispatchToRole` is the right home because it is the same act by the same authority: the
    // human addressing a lane. Its only callers are Send → on a board card and Start all, both
    // human-initiated; agent→agent delivery goes through `deliverDispatchRef`, never here.
    deliveryStateRef.current = resetChainFor(deliveryStateRef.current, role.id)
    const liveTab = terminals.find((tab) => tab.projectId === project.id && tab.roleId === role.id)
    if (liveTab) {
      void submitQueue.submit(liveTab.id, t)
    } else {
      // `focus: false` for the same reason: sending to an idle lane should not land you somewhere
      // different from sending to a live one. Where you end up must depend on the verb, never on
      // whether the lane happened to be running.
      void handleLaunchRole(project, role, t, false, { focus: false })
    }
  }, [terminals, handleLaunchRole])

  // Send one queued task: to a live lane's pty, or (if the lane isn't up) launch it — which
  // picks up the whole queue for that lane, this task included.
  const sendProjectTask = useCallback((project: Project, task: ProjectTask, opts?: { force?: boolean }) => {
    const role = project.roster?.find((r) => r.id === task.roleId)
    if (!role) return
    // AGE IS A GATE, NOT A FILTER. A queued task older than the horizon does not go out on a
    // single press — eight rows from July were sent twelve days later and six of them described
    // work that was already finished. The guard sits AHEAD of `markTasksRunning`: marking a task
    // running and then not delivering it is the ~200-stuck-in-running failure this project has
    // already had once.
    if (!opts?.force && isStaleTask(task, Date.now())) {
      pushToast({
        text: `Held — ${taskAgeDays(task, Date.now())} days old`,
        kind: 'info',
        detail: task.text.slice(0, 60),
        action: { label: 'Send anyway', run: () => sendProjectTaskRef.current(project, task, { force: true }) },
      })
      return
    }
    const liveTab = terminals.find((t) => t.projectId === project.id && t.roleId === role.id)
    if (liveTab) {
      dispatchToRole(project, role, task.text)
      markTasksRunning(project.id, [task.id], liveTab.id, laneOf(liveTab)) // now running on this lane
    } else {
      // A human sending work to an IDLE lane is the same act as sending it to a live one; only
      // the plumbing differs. This branch bypassed `dispatchToRole`, so it bypassed the reset —
      // and a lane you have to launch is exactly the one most likely to be sitting exhausted.
      deliveryStateRef.current = resetChainFor(deliveryStateRef.current, role.id)
      // `focus: false` for the same reason as the live branch: where you end up must depend on
      // the verb, never on whether the lane happened to be running.
      void handleLaunchRole(project, role, undefined, false, { focus: false }) // picks up its queue
    }
    // Says WHERE it went, and covers the case the card's own move can't: at narrow widths the
    // board stacks and the Running column is below the fold, so the card can move correctly and
    // still be off screen. Not clickable-to-follow on purpose — a running card already carries
    // the chip that goes there, and one verb per control.
    pushToast({ text: `Sent to ${role.name}`, kind: 'info', detail: task.text.slice(0, 60) })
  }, [terminals, dispatchToRole, handleLaunchRole, markTasksRunning, pushToast])

  // "Start all": dispatch every ASSIGNED, still-QUEUED task, grouped per lane — live lanes get
  // the combined message (→ running), idle lanes launch and pick up their queue.
  const startProjectTasks = useCallback((project: Project, opts?: { force?: boolean }) => {
    const queued = (project.tasks ?? []).filter((t) => t.roleId && (t.status ?? 'queued') === 'queued')
    // Same gate as the per-task send, applied before anything is grouped or marked. NO SILENT
    // CAPS: whatever is held back is named, with a way to send it anyway — a skip the user
    // cannot see is how a "Start all" quietly becomes "start some".
    const { fresh, stale } = opts?.force ? { fresh: queued, stale: [] as ProjectTask[] } : splitStale(queued, Date.now())
    if (stale.length) {
      pushToast({
        text: `${stale.length} stale task${stale.length > 1 ? 's' : ''} held back`,
        kind: 'info',
        detail: describeSkipped(stale, Date.now()),
        action: { label: 'Send them too', run: () => startProjectTasksRef.current(project, { force: true }) },
      })
    }
    const byRole = new Map<string, ProjectTask[]>()
    for (const t of fresh) {
      const arr = byRole.get(t.roleId!) ?? []
      arr.push(t); byRole.set(t.roleId!, arr)
    }
    for (const [roleId, tasks] of byRole) {
      let role = project.roster?.find((r) => r.id === roleId)
      // The lane is gone (deleted, or never created now that rosters start empty). Silently
      // skipping is how these tasks became permanently stuck — recreate the lane from its
      // template if the id names one, otherwise hand the task back to the visible backlog.
      if (!role) {
        const preset = presetFor(roleId)
        if (preset) {
          role = preset
          updateProject(project.id, (cur) => ({
            roster: (cur.roster ?? []).some((r) => r.id === preset.id) ? (cur.roster ?? []) : [...(cur.roster ?? []), preset],
          }))
        } else {
          for (const t of tasks) assignProjectTask(project.id, t.id, undefined)
          pushToast({ text: `No "${roleId}" lane — ${tasks.length} task${tasks.length > 1 ? 's' : ''} moved to unassigned`, kind: 'info' })
          continue
        }
      }
      const liveTab = terminals.find((t) => t.projectId === project.id && t.roleId === roleId)
      if (liveTab) {
        const text = tasks.map((t, i) => `${i + 1}. ${t.text}`).join('\n')
        dispatchToRole(project, role, `Please work through these tasks:\n${text}`)
        markTasksRunning(project.id, tasks.map((t) => t.id), liveTab.id, laneOf(liveTab))
      } else {
        void handleLaunchRole(project, role, undefined, false, { focus: false }) // picks up its queue
      }
    }
  }, [terminals, dispatchToRole, handleLaunchRole, markTasksRunning, updateProject, assignProjectTask, pushToast])

  // The toast actions above re-enter these, and a `useCallback` cannot reference itself in its
  // own initialiser. A ref is the smallest honest way to give "Send anyway" the same code path
  // as the press that was held — an override that took a second path could drift from it.
  const sendProjectTaskRef = useRef(sendProjectTask)
  sendProjectTaskRef.current = sendProjectTask
  const startProjectTasksRef = useRef(startProjectTasks)
  startProjectTasksRef.current = startProjectTasks

  // Re-open a previously saved session. `resume` continues the prior Claude
  // conversation (--resume); otherwise it starts the agent clean in the same
  // folder/worktree with the same config.
  const handleRestoreSession = useCallback(async (saved: SavedSession, resume: boolean) => {
    // THE DIRECTORY MAY BE GONE, and since lanes close themselves it usually is: a suspended
    // worktree lane kept its branch and lost its dir. Put it back on that branch before anything
    // else touches the path — spawning into a missing cwd fails, and every step below (the prefs
    // read, the pty) assumes it exists. A rebuild that cannot happen falls back to the source
    // repo rather than failing the restore outright.
    let cwd = saved.cwd
    let worktreeBranch = saved.worktreeBranch
    let worktreeBase = saved.worktreeBase
    // `?? true` for a bridge without `pathExists`: assume the dir is there and restore as before,
    // rather than rebuilding a worktree over a live one.
    const cwdGone = !(await window.operator.pathExists?.(saved.cwd).catch(() => true) ?? true)
    if (saved.worktreeBranch && saved.sourceCwd && cwdGone) {
      const made = await window.operator.worktreeCreate(saved.sourceCwd, saved.worktreeBranch, saved.roleId)
      if (made && !('error' in made)) {
        cwd = made.path
        worktreeBranch = made.branch
        worktreeBase = made.baseBranch ?? saved.worktreeBase
      } else {
        console.warn('Could not rebuild the lane worktree; restoring in the source repo', made && 'error' in made ? made.error : 'no result')
        cwd = saved.sourceCwd
        worktreeBranch = undefined
        worktreeBase = undefined
      }
    }

    const launchOptions: Record<string, unknown> = {}
    if (saved.permissionMode && saved.permissionMode !== 'default') launchOptions.permissionMode = saved.permissionMode
    if (saved.model) launchOptions.model = saved.model
    // Same rule as the launch path: the lane's effort is its own flag, never a global settings
    // write. `migrateEffort` because a saved row can predate the ladder fix.
    const restoredEffort = migrateEffort(saved.effortLevel)
    if (restoredEffort) launchOptions.effort = restoredEffort
    if (resume && saved.claudeSessionId) launchOptions.resumeSessionId = saved.claudeSessionId

    // Resolve the project (canonical repo root) — always, so an old saved session with no
    // projectId gets backfilled and the project's lastActiveAt is touched on reopen.
    const proj = await resolveProject(saved.sourceCwd ?? saved.cwd)

    // Same reply-scoping stamp as the launch path.
    launchOptions.projectId = saved.projectId ?? proj.id
    if (saved.roleId) launchOptions.roleId = saved.roleId

    // Restore spawns directly into the saved cwd (the worktree path persists
    // across quits), or into the one just reattached for a suspended lane.
    const result = await window.operator.terminalSpawn(cwd, launchOptions)
    if (!result) return

    const tab: TerminalTab = {
      id: result.terminalId,
      key: saved.key,
      cwd: result.cwd,
      model: saved.model,
      effortLevel: saved.effortLevel,
      permissionMode: saved.permissionMode,
      worktreeBranch,
      worktreeBase,
      sourceCwd: saved.sourceCwd,
      projectId: saved.projectId ?? proj.id,
      roleId: saved.roleId,
      grid: result.grid,
    }
    setTerminals((prev) => [...prev, tab])
    setActiveTerminalId(result.terminalId)
    setActiveSessionId(`local-${result.terminalId}`)
    setActiveProjectId(tab.projectId ?? null) // restoring focuses the session → scope follows it
    if (saved.customName) {
      setCustomNames((prev) => {
        const next = { ...prev, [`local-${result.terminalId}`]: saved.customName! }
        try { localStorage.setItem('operator.customNames', JSON.stringify(next)) } catch { /* quota */ }
        return next
      })
    }
    rememberRecent(cwd) // the same value unless a suspended lane's worktree was just rebuilt
    upsertProject(proj, { intent: 'user' }) // clicked a dormant session (or Resume project)
    setActiveFolderPrefs(null)
    setGlobalPrefsActive(false)
    setAgentsViewActive(false)
    setPrefsViewActive(false)
  }, [rememberRecent, upsertProject])

  // Resume a PROJECT: re-open every saved agent of the project that isn't already live,
  // each resuming its prior Claude conversation when one exists (else clean in the same
  // cwd/worktree). Sequential on purpose — each spawn allocates its port and re-attaches
  // cleanly; the last restored session ends up focused.
  const handleResumeProject = useCallback(async (projectId: string) => {
    const liveKeys = new Set(terminals.map((t) => t.key))
    const toRestore = savedSessions
      .filter((s) => s.projectId === projectId && !liveKeys.has(s.key))
      .sort((a, b) => a.lastActiveAt.localeCompare(b.lastActiveAt)) // oldest first → sidebar keeps its familiar order
    for (const s of toRestore) {
      await handleRestoreSession(s, true)
    }
  }, [terminals, savedSessions, handleRestoreSession])

  const forgetSavedSession = useCallback((key: string) => {
    setSavedSessions((prev) => {
      const next = prev.filter((s) => s.key !== key)
      try { localStorage.setItem('operator.savedSessions', JSON.stringify(next)) } catch { /* quota */ }
      window.operator.saveSessions?.(next) // keep the durable store in sync
      return next
    })
  }, [])

  /** Close a lane.
   *
   *  `suspend` is what makes lanes task-scoped: the automatic path passes it, and then close
   *  means DETACH — the pty dies and the worktree directory goes, but the saved session survives
   *  carrying `claudeSessionId` + `worktreeBranch`, which is exactly what `handleLaunchRole`
   *  needs to bring the lane back with `--resume` on its own branch. If "close" ever means
   *  "gone" here, task-scoped lanes are wrong. A close the USER asks for keeps its old meaning
   *  and forgets the record. */
  const handleCloseSession = useCallback(async (session: AgentSession, suspend?: LaneCloseReason) => {
    const terminalId = session.terminalId
    if (!terminalId) return
    const tab = terminals.find((t) => t.id === terminalId)
    // Kill the pty first so any in-flight git operations on the worktree die.
    await window.operator.terminalKill(terminalId)
    delete doneReportsRef.current[terminalId]
    // Its running tasks → done: capture their diff summary and run the verification
    // gate while the dir still exists. NOT awaited here (a check can take minutes) —
    // worktree removal is CHAINED behind it instead, so close stays snappy and the
    // dir survives until the capture + check finish.
    const finishTasks = tab?.projectId
      ? completeTerminalTasks(terminalId, tab.roleId, tab.projectId, laneOf(tab), suspend === 'went-quiet' ? 'abandoned' : 'done')
      : Promise.resolve()
    // If this was a worktree session, clean up the worktree directory afterwards.
    // Branch is intentionally left intact — user may want to merge or review later.
    if (tab?.worktreeBranch && tab?.sourceCwd) {
      void finishTasks.then(async () => {
        // SNAPSHOT FIRST, UNCONDITIONALLY. `worktree remove` takes uncommitted edits with it, and
        // with lanes now closing on their own that is no longer a directory the user chose to
        // delete. The precedent is the "WIP preserved before reaping this worktree" commits from
        // 2026-08-05, message and all; the branch survives the close, so the commit is how the
        // work survives with it. A failed commit CANCELS the removal — leaving a stray directory
        // is recoverable, deleting unsaved work is not.
        const status = await window.operator.worktreeStatus(tab.cwd).catch(() => undefined)
        if (status?.valid && status.changes > 0) {
          const saved = await window.operator.worktreeCommit(tab.cwd, 'WIP preserved before reaping this worktree')
          if (!saved?.ok) {
            console.warn('WIP snapshot failed; keeping the worktree', saved?.error)
            return
          }
        }
        const result = await window.operator.worktreeRemove(tab.cwd, tab.sourceCwd!)
        // `result?.ok` — an unexpected answer became an unhandled rejection here, and with
        // worktrees now a global default this path runs on every close of a writing lane.
        if (!result?.ok) console.warn('Worktree removal failed:', result?.error ?? 'no result')
      })
    }
    // Drop the tab; the onTerminalExit handler also runs and will reconcile state.
    // Closing is intentional — forget the saved session so it won't offer to restore. Unless it
    // is a SUSPEND, where the record is the whole point: stamped, and stripped of the pty id it
    // no longer has (a stale `terminalId` is what made tasks unmatchable for months).
    if (tab && suspend) {
      setSavedSessions((prev) => {
        const next = prev.map((sv) => (sv.key === tab.key
          ? { ...sv, terminalId: undefined, suspendedAt: new Date().toISOString(), suspendedReason: suspend }
          : sv))
        try { localStorage.setItem('operator.savedSessions', JSON.stringify(next)) } catch { /* quota */ }
        window.operator.saveSessions?.(next)
        return next
      })
    } else if (tab) {
      forgetSavedSession(tab.key)
    }
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
  handleCloseSessionRef.current = handleCloseSession

  // TASK-SCOPED LANES: a lane that has finished stops holding a pty.
  //
  // The decision is entirely in lib/lane-lifecycle (pure, tested); this is the side effect. It
  // ticks on a timer rather than on state, because the interesting input is the PASSAGE of time —
  // a lane goes quiet by nothing happening, so there is no render to react to.
  //
  // WHAT IT CANNOT DO IS INVENT A COMPLETION. Only two things put a lane on this path: an
  // explicit `operator__task_status(id,'done')` (`doneReportsRef`), or the long went-quiet
  // backstop, which closes on different terms and labels its work `abandoned`. Idle alone is
  // never enough — see the `waiting`/`idle` guard, the one the brief calls out as the one that
  // will bite.
  useEffect(() => {
    if (!savedHydrated || !reattachDone) return
    const tick = () => {
      const policy = laneClosePolicy()
      if (policy.keepWarmMs <= 0) return // auto-close off
      const lanes: LaneSnapshot[] = terminalsRef.current.map((tab) => {
        const session = sessionsRef.current.find((s) => s.terminalId === tab.id)
        const claudeId = claudeIdOf(tab.id)
        // OPEN WORK = tasks IN FLIGHT, not the whole backlog. A lane's queued tasks are not
        // being worked on and are picked up again by the launch path when it comes back, so
        // counting them would pin a lane open for a backlog nobody is touching.
        const openWork = (projectsRef.current.find((p) => p.id === tab.projectId)?.tasks ?? []).filter((t) => (
          t.status === 'running' && (
            (!!claudeId && t.claudeSessionId === claudeId)
            || (!!tab.roleId && t.roleId === tab.roleId)
          )
        )).length
        // A lane that took new work invalidates its old report: it is not the same "finished".
        if (openWork > 0) delete doneReportsRef.current[tab.id]
        return {
          terminalId: tab.id,
          roleId: tab.roleId,
          projectId: tab.projectId,
          phase: session?.status === 'ended' ? undefined : session?.phase,
          ended: tab.ended || session?.status === 'ended',
          lastActivityAt: session?.lastActivityAt,
          reportedDoneAt: doneReportsRef.current[tab.id],
          openWork,
          focused: tab.id === activeTerminalIdRef.current,
        }
      })
      const plan = planLaneCloses(lanes, Date.now(), policy)
      if (!plan.close.length) return
      for (const { lane, reason } of plan.close) {
        // Always found: a lane with no tracked session has no phase, and an unknown phase is
        // never closable (lib/lane-lifecycle).
        const session = sessionsRef.current.find((s) => s.terminalId === lane.terminalId)
        if (!session) continue
        const name = projectsRef.current.find((p) => p.id === lane.projectId)?.roster?.find((r) => r.id === lane.roleId)?.name
          ?? lane.roleId ?? 'A lane'
        void handleCloseSessionRef.current(session, reason)
        // TWO OUTCOMES, SAID DIFFERENTLY — silence must never read as success. The reported one
        // is routine housekeeping; the quiet one is a lane that never called `task_status`, and
        // that is a fact about the lane worth seeing.
        pushToast(reason === 'reported-done'
          ? { text: `Closed ${name} — reported done`, kind: 'info', detail: 'Suspended, not gone: re-dispatching resumes the same thread on its branch.' }
          : { text: `${name} went quiet — closed`, kind: 'info', detail: 'It never reported a task done. Its work is marked abandoned, not done; the thread is still resumable.' })
      }
      // Paced, never silently capped (lib/lane-lifecycle) — the rest go on the next tick.
      if (plan.deferred) console.info(`[lanes] ${plan.deferred} more eligible to close; pacing to the next tick`)
    }
    const timer = window.setInterval(tick, 30_000)
    return () => clearInterval(timer)
  }, [savedHydrated, reattachDone, pushToast])

  const handleSelectSession = useCallback((session: AgentSession) => {
    const localTerminalIds = new Set(terminals.map((t) => t.id))
    setActiveSessionId(session.id)
    setActiveFolderPrefs(null)
    setGlobalPrefsActive(false)
    setAgentsViewActive(false)
    setPrefsViewActive(false)
    // The single rule that keeps every entry point honest — ⌘1-9, the ⌘K palette, a toast,
    // the Agents hub, a restore: selecting a session scopes you to its project, so you can
    // never end up focused on a session that isn't in the sidebar (spec §4 rule 1). A legacy
    // session with no projectId can't be scoped, so it leaves scope alone (spec §4 rule 9).
    if (session.projectId) setActiveProjectId(session.projectId)
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
    // THE TAB'S OWN DEATH IS PART OF ITS IDENTITY HERE, and it was being dropped. `t.ended` is the
    // reconciled truth (`endedByBackend`, polling the backend's real `try_wait`); the observer's
    // silence is not, because `get_sessions` returns only sessions it still considers active — so a
    // lane that exits DISAPPEARS from `sessions` and the synthetic branch below used to resurrect
    // it as `status: 'active'`, permanently. Everything downstream believed that: the "N running"
    // label, `projectActivity.live`, `isOnRail` (which is why closing a project left it on the
    // rail), and `closePlan`. See `tabSessionStatus`.
    const status = tabSessionStatus(t, hookSession)
    const operatorFields = { projectId: t.projectId, roleId: t.roleId, savedKey: t.key, model: t.model, effortLevel: t.effortLevel, status }
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

  // The left strip takes ALL of these and groups them by project itself. There is no
  // `scopedSessions` any more: it existed because the rail and the sidebar were scoped
  // differently — one to every project, one to the open one — and joining them into a single
  // surface is exactly what made a second, narrower list of the same sessions unnecessary.
  // ⌘1-9 still scopes to the open project (`shortcutTerminals`), which is where that rule lives.
  // Legacy sessions carry no projectId and belong to no group; they stay reachable from the
  // gallery's activity view.
  // What each project is doing — the switcher's per-row orb and state label. Rolled up by
  // lib/project-status so the popover and the gallery card read a project identically.
  const projectActivities = useMemo(() => {
    const byProject: Record<string, AgentSession[]> = {}
    for (const s of allSidebarSessions) {
      if (!s.projectId) continue
      ;(byProject[s.projectId] ??= []).push(s)
    }
    const out: Record<string, ProjectActivity> = {}
    for (const p of projects) out[p.id] = projectActivity(byProject[p.id] ?? [], p.roster?.length ?? 0)
    return out
  }, [allSidebarSessions, projects])
  activitiesRef.current = projectActivities


  // Drag-to-reorder the sidebar's AD-HOC session rows: move the dragged terminal before/after
  // the drop target in the canonical `terminals` order (which drives the list + ⌘1..9).
  // Per-run; not persisted across restarts.
  const handleReorderSession = (draggedId: string, targetId: string, edge: 'before' | 'after') => {
    const tidOf = (id: string) => allSidebarSessions.find((s) => s.id === id)?.terminalId
    const dragTid = tidOf(draggedId)
    const targetTid = tidOf(targetId)
    if (!dragTid || !targetTid || dragTid === targetTid) return
    setTerminals((prev) => reorderByIds(prev, dragTid, targetTid, edge))
  }

  // Dragging a LANE row reorders the roster itself — the roster is what orders those rows,
  // so anything else would be a drag with no effect. Same helper (and therefore the same
  // result) as dragging the lane on the roster board.
  // Drag-to-reorder the PROJECT RAIL. `reorderRail` restamps the durable `railOrder` field across
  // the whole store (see lib/project-shelf), and the persist effect below writes it to
  // projects.json — so the arrangement survives a restart, which is the acceptance test here.
  // Deliberately NOT the array's own order: that happens to be stable today, but nothing declares
  // it, and the sidebar's own reorder is already a shipped example of a position that looks saved
  // and isn't.
  const handleReorderProject = useCallback((draggedId: string, targetId: string, edge: 'before' | 'after') => {
    setProjects((prev) => reorderRail(prev, draggedId, targetId, edge))
  }, [])

  // Dragging a LANE row reorders the ROSTER itself — the roster is what orders those rows, so
  // anything else would be a drag with no effect. Same helper, and therefore the same result, as
  // dragging the lane on the Team screen: one order, two surfaces. `updateProject` already
  // persists it, so the arrangement survives a restart, which is the real acceptance test.
  //
  // THIS WAS DELETED BY THE v0.13.7 RAIL/SIDEBAR JOIN and the tombstone that replaced it reasoned:
  // "those rows are gone (the strip lists only what is live), and with them the only caller."
  // That was half true and it is why the regression shipped — the IDLE lane rows went, but a LIVE
  // lane row is still a lane row, and since an agent is exactly a session WITH a roleId, dropping
  // the lane half of the drag removed reordering for every agent. Only ad-hoc sessions kept it,
  // which is why it looked half-working rather than gone.
  //
  // The project comes from the DRAG, not from `activeProjectId` as the pre-join version had it:
  // the joined strip shows several projects' groups at once, so the lane you dragged is not
  // necessarily in the project you are in, and rewriting the active project's roster from another
  // group's drag would be a silent misroute.
  const handleReorderLane = useCallback((projectId: string, draggedRoleId: string, targetRoleId: string, edge: 'before' | 'after') => {
    updateProject(projectId, (p) => ({ roster: reorderRoles(p.roster ?? [], draggedRoleId, targetRoleId, edge) }))
  }, [updateProject])

  // --- Agent colour --------------------------------------------------------------------
  // A lane's colour belongs to its Role (roster = source of truth, so every surface
  // recolours together). A session with NO lane keeps a per-session override, keyed by the
  // stable saved key rather than the per-run session id.
  const [sessionAccents, setSessionAccents] = useState<Record<string, string>>(() => loadSessionAccents())
  const [accentPicker, setAccentPicker] = useState<{ sessionId: string; top: number; left: number } | null>(null)
  // The rail tile's context menu. Held HERE, not in ProjectRail, for the same reason the accent
  // picker is: the rail's tile column clips its overflow at 44px.
  const [railMenu, setRailMenu] = useState<{ projectId: string; top: number; left: number } | null>(null)
  // The strip's `+ Start an agent` menu. Held here for the same reason as the two above: the
  // strip is a clipping scroller at the window's edge, so it reports an anchor and the view
  // renders the popover.
  const [laneMenu, setLaneMenu] = useState<{ projectId: string; top: number; left: number } | null>(null)

  const roleOf = useCallback((session: AgentSession): Role | undefined => {
    if (!session.roleId) return undefined
    return projects.find((p) => p.id === session.projectId)?.roster?.find((r) => r.id === session.roleId)
  }, [projects])

  // The colour a session actually draws with: its lane's, else its own override. This is
  // exactly where `role?.accent` used to be read, so every call site keeps its own fallback.
  const accentOf = useCallback((session: AgentSession): string | undefined => {
    const role = roleOf(session)
    if (role?.accent) return role.accent
    return session.savedKey ? sessionAccents[session.savedKey] : undefined
  }, [roleOf, sessionAccents])

  const setAccentForSession = useCallback((session: AgentSession, accent: string) => {
    const role = roleOf(session)
    if (role) {
      // On a lane → write the ROSTER, so the board, sidebar, rail and dashboard all follow.
      const project = projects.find((p) => p.id === session.projectId)
      if (project?.roster) {
        updateProject(project.id, { roster: project.roster.map((r) => (r.id === role.id ? { ...r, accent } : r)) })
      }
      return
    }
    // No lane → per-session override. Without a saved key there's nowhere durable to put
    // it, so skip rather than write an entry that can't be read back.
    if (!session.savedKey) return
    // Merge against what's on disk right now, not this instance's snapshot — the other app
    // instance shares this localStorage (see saveSessionAccent). Done outside the state
    // updater so the updater stays pure.
    setSessionAccents(saveSessionAccent(session.savedKey, accent))
  }, [roleOf, projects, updateProject])

  // --- Quit guard ----------------------------------------------------------------------
  // Rust holds the veto and sends the snapshot; this only renders it. Kept as a frozen
  // payload rather than derived state on purpose: a list that re-orders (or a dialog that
  // disappears) because a lane finished mid-decision is a mis-click generator, and the
  // mis-click here is the accident again.
  const [quitRequest, setQuitRequest] = useState<QuitRequest | null>(null)

  useEffect(() => {
    // Rust cannot read localStorage, and must still be right when the renderer is gone.
    window.operator.quitSetAsk?.(askBeforeQuitEnabled())
    return window.operator.onQuitRequested?.((req) => {
      // Frozen once it's up: a second ⌘Q re-emits, and swapping the snapshot would re-order
      // the list under the pointer. The re-emit exists for the other case — a renderer that
      // respawned mid-question and has no dialog to show.
      setQuitRequest((cur) => cur ?? req)
      window.operator.quitDialogShown?.()
    })
  }, [])

  const answerQuit = useCallback((quit: boolean) => {
    setQuitRequest(null)
    window.operator.quitDecision?.(quit)
  }, [])

  /** What only this view knows about a lane Rust named: the label ladder, the lane accent,
   *  and the same state wording the chat and sidebar already use. A lane it cannot match
   *  still renders — quit-guard.ts falls back to the payload's own project and phase word. */
  const identifyQuitLane = useCallback((terminalId: string): LaneIdentity | undefined => {
    const session = sessions.find((s) => s.terminalId === terminalId)
    if (!session) return undefined
    return {
      name: sessionLabel({ session, role: roleOf(session), customName: customNames[session.id] }),
      state: chatSignal(session)?.label,
      accent: accentOf(session),
    }
  }, [sessions, roleOf, customNames, accentOf])

  // ⌘1..9 over the SCOPED list, in the order the sidebar shows it (terminals order), so the
  // hint on a row is the chord that reaches it. Kept as the single source both the hints and
  // the key handler read from.
  const shortcutTerminals = useMemo(() => {
    if (!activeProjectId) return []
    const scoped = terminals.filter((t) => t.projectId === activeProjectId)
    // In the order the sidebar DRAWS them — roster order for lanes, then the ad-hoc rows —
    // so ⌘1..9 counts down the list you can see rather than down the launch order.
    const roster = projects.find((p) => p.id === activeProjectId)?.roster ?? []
    const byRole = new Map(scoped.filter((t) => t.roleId).map((t) => [t.roleId!, t]))
    const lanes = roster.map((r) => byRole.get(r.id)).filter((t): t is TerminalTab => !!t)
    const seen = new Set(lanes.map((t) => t.id))
    return [...lanes, ...scoped.filter((t) => !seen.has(t.id))].slice(0, 9)
  }, [terminals, activeProjectId, projects])
  const shortcutIndices = useMemo(() => {
    const map: Record<string, number> = {}
    shortcutTerminals.forEach((t, i) => {
      const session = localSessions.find((s) => s.terminalId === t.id)
      if (session) map[session.id] = i + 1
    })
    return map
  }, [shortcutTerminals, localSessions])

  // The `N active` count is GONE with the sidebar that footed it: in the joined strip the agents
  // ARE the count — two live rows is what "2 active" was telling you, and a line counting what is
  // visible 40px above it is not information.

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
    // ORDERING: the one-altitude migration stamps HERE, never at the point it computed its pins.
    // Stamping first left a window — this effect is separate, and `saveProjects` is an async IPC
    // — in which a crash, a quit or a failed write leaves the stamp set and the pins unwritten.
    // `role-defaults.json` is then never read again and every lane silently falls to
    // preset/fallback, which is precisely the flip the migration exists to prevent (37 of the
    // real store's 56 pins are `permissionMode`). localStorage.setItem above is synchronous and
    // durable, so by this line the pins genuinely survive a hard kill.
    //
    // If the functional update found nothing to write, `ser` is unchanged, this effect returned
    // early, and no stamp lands — so the migration simply runs again next launch, finds nothing,
    // and stamps through its own zero-pin path. Self-correcting rather than silently done.
    if (oneAltitudePendingRef.current) {
      oneAltitudePendingRef.current = false
      markOneAltitudeMigrationDone()
    }
  }, [projects, savedHydrated])

  // (No roster "top-up" migration here: a trimmed roster must never regrow. The one-time
  // backfill that added Review/Design/QA to pre-existing rosters has already run on real
  // data, and new projects seed the full defaultRoster() at creation — see upsertProject,
  // and RosterPanel's seed-if-absent for a project that somehow has none.)

  // App version (shown next to the name) + a pending update (surfaced as a badge
  // in the sidebar, in addition to the toast).
  const [appVersion, setAppVersion] = useState('')
  const [availableUpdate, setAvailableUpdate] = useState<{ version: string } | null>(null)
  // …and what the install is DOING, which the toasts alone could not carry: a toast is a moment
  // and a download is a duration. The sidebar's arrow renders this (see ProjectRail's RailFoot),
  // so there is a live thing to look at after the toast has faded.
  const [installState, setInstallState] = useState<InstallState>(IDLE)
  useEffect(() => { window.operator.getVersion?.().then(setAppVersion).catch(() => {}) }, [])

  // THE UPDATE'S OWN VOICE. Both of these used to end at `console.error` in main, which in a
  // packaged app is nowhere the user can reach — so "Install & Restart did nothing" was
  // indistinguishable from "the button is broken". Subscribed ONCE on mount, not per check: the
  // check runs on a timer and on demand, and re-subscribing there would stack listeners.
  useEffect(() => {
    const offProgress = window.operator.onUpdateProgress?.((percent, transferred, total) => {
      // The arrow gets EVERY tick — it is a live affordance and can afford to move.
      setInstallState((prev) => installProgressed(prev, percent, transferred, total))
      // Coarse steps only. A toast per percent is a stream, not information.
      if (percent > 0 && percent < 100 && percent % 25 !== 0) return
      pushToast({
        text: percent >= 100 ? 'Update downloaded' : `Downloading update… ${percent}%`,
        kind: 'info',
      })
    })
    const offError = window.operator.onUpdateError?.((message) => {
      setInstallState(installFailed(message))
      pushToast({ text: 'Update failed', detail: message, kind: 'error' })
    })
    return () => { offProgress?.(); offError?.() }
  }, [pushToast])

  // One press, whichever control was pressed — the toast's action and the sidebar's arrow both
  // land here, so both see the same state move.
  const startInstall = useCallback(() => {
    setInstallState(installPressed())
    void window.operator.installUpdate?.()
  }, [])

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
        action: { label: 'Install & Restart', run: startInstall },
      })
    }).catch(() => {
      if (manual) pushToast({ text: 'Update check failed', detail: 'Could not reach the releases feed.', kind: 'error' })
    })
  }, [pushToast, startInstall])

  // Check on launch, then re-check every 3h so a long-running instance still
  // notices releases published after it started (the launch-only check missed
  // them — see v0.1.2). Cleared on unmount.
  useEffect(() => {
    runUpdateCheck()
    const id = setInterval(() => runUpdateCheck(), 1000 * 60 * 60 * 3)
    return () => clearInterval(id)
  }, [runUpdateCheck])

  // "Ready for review" detection — watch worktree sessions transitioning to idle
  // A LANE THAT FINISHES A TURN CLOSES ITS RUNNING TASKS.
  //
  // Until now the only automatic close was `exitCompleteRef` — the lane's SESSION ENDING. Lanes
  // are long-lived and take task after task, so nothing ever closed while a lane stayed alive.
  // Measured across the real store: 72 tasks `running`, zero done, every one stamped with a LIVE
  // terminal id. Not the old stale-id leak; a lifecycle with no exit. See `finishedTurn` for why
  // the busy→not-busy edge is the right signal and what it cannot know.
  //
  // Its own phase ref, deliberately not shared with the review-toast effect below: that one is
  // gated on `worktreeBranch` and skips lanes without a worktree, and a task must close whether
  // or not its lane happens to have one. Two readers of the same edge, two records.
  const lastTaskPhaseRef = useRef<Record<string, string>>({})
  useEffect(() => {
    for (const tab of terminals) {
      const session = sessions.find((s) => s.terminalId === tab.id)
      if (!session) continue
      const prev = lastTaskPhaseRef.current[tab.id]
      lastTaskPhaseRef.current[tab.id] = session.phase
      if (!finishedTurn(prev, session.phase)) continue
      // Only if this lane actually holds running work — `completeTerminalTasks` captures a diff
      // and runs the project's check command, which must not fire on every idle arrival.
      const hasRunning = projectsRef.current.some((p) => (p.tasks ?? []).some((t) => (
        t.status === 'running' && (t.terminalId === tab.id || (!!tab.roleId && t.roleId === tab.roleId))
      )))
      if (!hasRunning) continue
      void completeTerminalTasks(tab.id, tab.roleId, tab.projectId, laneOf(tab))
    }
  }, [terminals, sessions, completeTerminalTasks])

  // with uncommitted changes. Show one in-app toast per (terminalId, idle-arrival).
  const lastPhaseRef = useRef<Record<string, string>>({})
  // REPORT DELIVERY-ON-IDLE. The audit is explicit that this must NOT be pty-typed like an
  // OPERATOR-REPLY: reports exist precisely because pasting a long result into a live TUI races
  // its own composer. So a report is announced, not delivered — one short line naming the id and
  // where the text is, and only when the lane is between turns so nothing is interrupted.
  //
  // `delivered_at` is written by the same pass, which is what stops a report being announced on
  // every subsequent idle. The mark is the memory; there is no in-renderer seen-set to lose on a
  // respawn (which is how the delivery brakes lost theirs — see the audit's loss #5).
  // THE REPORT FETCH. One poll, app-wide, feeding both surfaces that read a report: the board
  // (a result on its own task card) and the project's Comms log. It is hoisted because it used
  // to live inside the panel that showed it, so nothing outside that panel could know a report
  // had landed — the mount was the fetch.
  const [reports, setReports] = useState<ArtifactReport[]>([])
  const refreshReports = useCallback(() => {
    window.operator.artifactReports?.(200)
      .then((rs) => setReports(rs ?? []))
      .catch(() => { /* best-effort; an empty list reads as "nothing yet", which is honest */ })
  }, [])
  useEffect(() => {
    refreshReports()
    const t = window.setInterval(refreshReports, 4000)
    return () => clearInterval(t)
  }, [refreshReports])


  const announcingRef = useRef(false)
  useEffect(() => {
    for (const tab of terminals) {
      const role = (tab.roleId ?? '').toLowerCase()
      if (!COORDINATOR_ROLE_IDS.includes(role)) continue
      // BETWEEN TURNS ONLY — see `canAnnounceTo`.
      if (!canAnnounceTo(sessions.find((s) => s.terminalId === tab.id))) continue
      if (announcingRef.current) continue

      announcingRef.current = true
      // SCOPED TO THIS COORDINATOR'S PROJECT. `artifacts.db` is one global store for every
      // project on the machine, so the role filter alone had `uwazi-app`'s reports announced into
      // the composer of whatever project's coordinator was idle first — observed with #313/#316/
      // #318. A coordinator is only told about work in the project it is coordinating.
      void window.operator.artifactUndelivered?.(role, 3, tab.projectId)
        .then(async (pending) => {
          if (pending?.length) refreshReports()
          for (const report of pending ?? []) {
            // RE-ASKED PER REPORT, off the REF rather than the closure's `sessions` — the first
            // announcement is what wakes the lane, so by the second one the phase has usually
            // flipped to `running` and this closure's snapshot still says `idle`. Without this the
            // batch pasted lines 2 and 3 straight into a live composer, which is the exact race
            // reports exist to avoid. Whatever is left stays undelivered and goes out on the next
            // idle.
            if (!canAnnounceTo(sessionsRef.current.find((s) => s.terminalId === tab.id))) break
            if (!tab.id) break
            // Mark AFTER the line has actually gone in, and only if it did. The other order
            // marked a report delivered whether or not it ever reached the composer, so a failed
            // announcement was silently swallowed — the report sat on its task and in the project
            // Comms log with nothing ever saying it had arrived.
            //
            // THE OUTCOME IS READ FROM THE QUEUE, NOT FROM A THROW. `submit` never rejects: its
            // chain ends in `.catch()` so one dropped write cannot break ordering for everything
            // queued behind it, which means a `try/catch` here is dead code that only looks like
            // a check. `pending(id)` is the real signal — it is cleared when the transcript
            // confirms a user turn for that write, and still holds the text when the write went
            // out unconfirmed (the rescue-CR path, or a lane nobody is tailing). Unconfirmed
            // leaves the row announceable; the worst case is one duplicate line, which is
            // recoverable where a silent drop is not.
            //
            // AND IT HOLDS THE BATCH. `submit` resolves on the write, but not before waiting out
            // the confirmation deadline — up to RESCUE_AFTER_MS (30s) for a lane whose turn never
            // appears, so a batch of three can occupy this pass for a minute and a half. That is
            // acceptable here precisely because it is serialised and bounded: nothing else waits
            // on this effect, `announcingRef` keeps a second pass from starting, and the
            // alternative — firing all three and marking them — is the mid-turn paste this whole
            // guard exists to prevent.
            const line = announcement(report)
            await submitQueue.submit(tab.id, line)
            if (submitQueue.pending(tab.id)?.text === line) break
            await window.operator.artifactMarkDelivered?.(report.id)
          }
        })
        .catch(() => { /* best-effort: the Comms log still has everything */ })
        .finally(() => { announcingRef.current = false })
      break
    }
  }, [terminals, sessions])

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
      // ⌘⇧O and ⌘⇧P both leave for the gallery. Checked before the unshifted keys so neither
      // can read as ⌘O / ⌘P. ⌘⇧P used to open the sidebar's project-switcher popover; that
      // popover is gone, and the gallery is now the one place that lists every project — so
      // the chord keeps meaning "go to projects" rather than becoming dead muscle memory.
      if (e.shiftKey && (e.key === 'o' || e.key === 'O' || e.key === 'p' || e.key === 'P')) {
        e.preventDefault()
        handleShowGallery()
        return
      }
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
        // ALWAYS preventDefault, even with nothing to close. The File menu's native
        // `performClose:` is also bound to ⌘W, so falling through here doesn't close a lane —
        // it closes the WINDOW, which is the same blast radius as the red traffic-light, for a
        // shortcut people believe is lane-scoped. ⌘W with nothing to close is a no-op.
        e.preventDefault()
        const active = allSidebarSessions.find((s) => s.id === activeSessionId)
        if (active && active.terminalId && localTerminalIds.has(active.terminalId)) {
          handleCloseSession(active)
        }
      } else if (e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key, 10) - 1
        const t = shortcutTerminals[idx]
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
            if (t.projectId) setActiveProjectId(t.projectId) // scope follows focus (rule 1)
          }
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleNewSession, handleCloseSession, handleSelectSession, toggleSidebar, toggleChat, allSidebarSessions, activeSessionId, localTerminalIds, shortcutTerminals, sessions, handleShowGallery, activeProjectId])

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

  // (The "open at last quit" key set — `operator.lastOpenKeys` — was read only by the
  // sidebar's dormant-session list, which is now a Recent PROJECTS list; restoring an
  // individual session lives on the splash, ⌘K, and the workspace's "Resume N agents".)

  // Match on the session id, but fall back to the active terminal: when a session
  // ends it drops out of getSessions() and its sidebar id flips from the hook id
  // to `local-<tid>`, which would otherwise leave activeSessionId stale and
  // activeSession undefined (blank toolbar over a still-open terminal).
  const activeSession =
    allSidebarSessions.find((s) => s.id === activeSessionId) ??
    (activeTerminalId ? allSidebarSessions.find((s) => s.terminalId === activeTerminalId) : undefined)

  // Debug diagnostic (⌘K "Dump terminal buffer"): make the recurring composer
  // garble decidable — buffer corruption vs pixel-only compositing. Walks the LIVE
  // xterm buffer read-only (the on-screen rows + ~50 lines of scrollback tail) via
  // translateToString and writes it to ~/.operator/terminal-dumps/. If the dumped
  // buffer is clean while the screen is garbled → the corruption is pixel-only.
  const handleDumpBuffer = useCallback(async () => {
    const tid = activeSession?.terminalId ?? activeTerminalId
    if (!tid) { pushToast({ text: 'No active terminal to dump', kind: 'error' }); return }
    const term = getTerminal(tid)
    if (!term) { pushToast({ text: 'Terminal buffer not available', kind: 'error' }); return }

    const buf = term.buffer.active
    const rows = term.rows
    const TAIL = 50
    const start = Math.max(0, buf.length - (rows + TAIL))
    const lines: string[] = []
    for (let i = start; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? '')
    }

    const now = new Date()
    const sid = activeSession?.id ?? tid
    const short = (s: string, fallback: string) => s.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || fallback
    // BOTH ids in the NAME, not just the body: a garble report is matched against a pty,
    // and terminal ids are what the backend and the heal loop talk about. Two dumps of the
    // same session across a restart carry different terminal ids, and that difference is
    // the first thing you want to see in a directory listing.
    const shortId = short(sid, 'session')
    const shortTid = short(tid, 'term')
    const ts = now.toISOString().replace(/[:.]/g, '-')
    const content =
      [`# terminal buffer dump`,
        `timestamp: ${now.toISOString()}`,
        `sessionId: ${sid}`,
        `terminalId: ${tid}`,
        `size: ${term.cols}x${rows}  bufferLength: ${buf.length}  dumped: ${start}..${buf.length - 1}`,
        ``].join('\n') + lines.join('\n') + '\n'

    try {
      // folderPrefsSaveMd is a generic verbatim text writer that creates parent
      // dirs — reused here so the diagnostic needs no new bridge/Rust surface.
      const path = `${await window.operator.operatorHome()}/terminal-dumps/${shortId}-${shortTid}-${ts}.txt`
      await window.operator.folderPrefsSaveMd(path, content)
      pushToast({ text: 'Terminal buffer dumped', kind: 'success', detail: path })
    } catch (e) {
      pushToast({ text: 'Buffer dump failed', kind: 'error', detail: String(e) })
    }
  }, [activeSession, activeTerminalId, pushToast])

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
  const contentMode: 'folderPrefs' | 'globalPrefs' | 'agents' | 'prefs' | 'localTerminal' | 'project' | 'gallery' = useMemo(() => {
    if (prefsViewActive) return 'prefs'
    if (agentsViewActive) return 'agents'
    if (globalPrefsActive) return 'globalPrefs'
    if (activeFolderPrefs) return 'folderPrefs'
    // Only 'localTerminal' if the active id still refers to a live terminal — a
    // stale activeTerminalId (e.g. left set after its tab was removed) would
    // otherwise render neither the terminal container (needs terminals.length>0)
    // nor the gallery, i.e. a blank screen.
    if (activeTerminalId && terminals.some((t) => t.id === activeTerminalId)) return 'localTerminal'
    // Inside a project with no session focused → Project Home, which is the board.
    if (activeProjectId && projects.some((p) => p.id === activeProjectId)) return 'project'
    return 'gallery'
  }, [prefsViewActive, agentsViewActive, globalPrefsActive, activeFolderPrefs, activeTerminalId, terminals, activeProjectId, projects])

  // ── WHERE YOU WERE ────────────────────────────────────────────────────────────────────────
  // Written on CHANGE, never only at quit. An app that records your place solely on a clean
  // exit loses it to exactly the stop this feature exists to survive.
  // projectId → durable key of the agent last selected there. Kept in a ref because
  // `handleOpenProject` is a stable callback that reads refs by design, and this is exactly the
  // kind of value that must be current at the moment of the click rather than at the moment the
  // callback was built. Persisted inside the workspace snapshot — one record, see its type.
  const lastAgentRef = useRef<Record<string, string>>({})
  // Lanes that were live before the restart and have not been resumed yet — see the persist
  // effect for why an empty terminal list must not overwrite them.
  const pendingLaneKeysRef = useRef<string[]>([])
  // True once the launch restore below has finished reading the snapshot (or decided there was
  // nothing to read). Declared here because the PERSIST effect is gated on it — see there.
  const [restoreSettled, setRestoreSettled] = useState(false)

  // ⚠ Gated on `restoreSettled`, and that gate is the whole reason this works. Both effects key
  // off `savedHydrated`, so without it the persist ran FIRST — writing the fresh, default state
  // (gallery, board, no live keys) over the snapshot a beat before the restore read it. The
  // symptom was a restore that "worked" but always landed on the defaults, which reads as the
  // feature being broken rather than as a race. Nothing may write the snapshot until the launch
  // has finished reading it.
  useEffect(() => {
    if (!savedHydrated || !restoreSettled) return // pre-restore state is a seed, not a place
    const focused = allSidebarSessions.find((s) => s.id === activeSessionId)
    // RECORDED ON SELECTION, not on quit — same reasoning as the snapshot itself: it has to
    // survive a crash. A selection only counts when we can name both halves durably.
    if (focused?.savedKey && focused.projectId) {
      lastAgentRef.current = { ...lastAgentRef.current, [focused.projectId]: focused.savedKey }
    }
    const snapshot: Workspace = {
      v: WORKSPACE_VERSION,
      projectId: activeProjectId,
      // `localTerminal` is this view's name for "a lane is focused"; the workspace calls it
      // `session`, because what it records is the LANE, not the pty that happened to serve it.
      mode: contentMode === 'localTerminal' ? 'session'
        : contentMode === 'folderPrefs' ? 'prefs'
        : contentMode,
      projectTab,
      // The lane's DURABLE key, not its terminal id — `SavedSession.terminalId`'s own comment
      // says it is stale after a restart, and it is.
      focusedKey: focused?.savedKey,
      // The resume offer has to be "the ones you had". `savedSessions` cannot answer that: it
      // keeps every session never explicitly closed, including ones from earlier runs.
      //
      // ⚠ CARRIED FORWARD while nothing is live. The obvious version — always write the current
      // terminals — erases the offer the moment it is restored: launch with the setting off, the
      // restore reads "four lanes", nothing is spawned, and the very next snapshot records zero.
      // Restart twice and the lanes you had are simply forgotten. So an empty terminal list does
      // not mean "you had none", it means "not resumed yet", and the pending set stands until
      // something real replaces it.
      liveKeys: terminals.length ? terminals.map((t) => t.key) : pendingLaneKeysRef.current,
      lastAgentByProject: lastAgentRef.current,
      at: new Date().toISOString(),
    }
    try { localStorage.setItem(WORKSPACE_KEY, JSON.stringify(snapshot)) } catch { /* quota */ }
  }, [savedHydrated, restoreSettled, activeProjectId, contentMode, projectTab, activeSessionId, allSidebarSessions, terminals])

  // ── AND PUTTING YOU BACK ──────────────────────────────────────────────────────────────────
  // ⚠ RUNS EXACTLY ONCE, AT LAUNCH. This is NOT "restore where I was" as a general rule, and the
  // distinction is load-bearing: `handleOpenProject` deliberately re-applies `landingFor` rather
  // than restoring a remembered view, because re-entering a project mid-session is a different
  // event from starting the app. Both behaviours are correct and they look contradictory side by
  // side — the `restoredRef` guard is the boundary between them. Do not remove one thinking it
  // duplicates the other.
  //
  // Gated on `reattachDone` because ptys can survive a renderer reload: if the terminals came
  // back, you were never away, and there is nothing to restore.
  const restoredRef = useRef(false)
  useEffect(() => {
    if (!savedHydrated || !reattachDone || restoredRef.current) return
    restoredRef.current = true
    // Every path below must release the persist gate, including the ones that restore nothing.
    if (terminals.length > 0) { setRestoreSettled(true); return } // ptys survived: a reload, not a restart

    const workspace = readWorkspace(localStorage.getItem(WORKSPACE_KEY))
    if (!workspace) { setRestoreSettled(true); return }

    // The filesystem check is best-effort and asynchronous, so the plan is computed and applied
    // FIRST (a launch that waits on stat() before drawing is a slow launch for a rare case) and
    // the folder-missing notes arrive a beat later.
    const plan = planRestore({
      workspace,
      projectIds: projects.map((p) => p.id),
      savedSessions,
    })
    // Carried so the offer survives a second restart (see the persist effect).
    pendingLaneKeysRef.current = plan.lanes.map((l) => l.saved.key)
    // The per-project last agent outlives the restart too. It only ever WINS when the lane is
    // live, so seeding it from a run where nothing is running is harmless — it starts mattering
    // again the moment something is resumed.
    lastAgentRef.current = workspace.lastAgentByProject ?? {}
    setActiveProjectId(plan.projectId)
    setProjectTab(plan.projectTab)
    setPrefsViewActive(plan.mode === 'prefs')
    setAgentsViewActive(plan.mode === 'agents')
    setGlobalPrefsActive(plan.mode === 'globalPrefs')

    void (async () => {
      // Which of those lanes could not be resumed even if asked. `worktreeStatus` answers for
      // any path, worktree or not — a missing folder and a removed worktree are the same
      // question here: is there still somewhere to spawn into.
      const missing = new Set<string>()
      await Promise.all(plan.lanes.map(async (l) => {
        try {
          // `pathExists`, not `worktreeStatus`: the latter reports `valid: false` for any
          // folder that isn't a git repo, which would call a perfectly good directory gone.
          if ((await window.operator.pathExists?.(l.saved.cwd)) === false) missing.add(l.saved.cwd)
        } catch { /* unknown → assume present; a wrong "gone" is worse than a late one */ }
      }))
      const settled = planRestore({
        workspace,
        projectIds: projects.map((p) => p.id),
        savedSessions,
        missingPaths: missing,
      })
      const line = describeRestore(settled)
      // Every failure mode gets a VISIBLE state. A lane whose folder is gone, or which has no
      // saved conversation and could therefore only start FRESH, is named before anything acts
      // on it — silently starting a new agent where someone expected their conversation back is
      // the outcome this whole feature is trying not to produce.
      if (line) pushToast({ text: 'Picked up where you left off', kind: 'info', detail: line })

      // AUTO-RESUME — off by default, and deliberately so: reopening the app should not silently
      // spawn six processes, six worktrees and six dev ports. When it is on, it runs the SAME
      // per-project resume the ⌘K action and Project Home use; there is no second resume path.
      const resumable = settled.lanes.filter((l) => !l.blocked)
      if (resumeOnLaunchEnabled() && settled.projectId && resumable.length) {
        void handleResumeProject(settled.projectId)
      }
      // Released only now: the folder checks can still change what the plan says, and a
      // snapshot written mid-check would record a half-applied restore.
      setRestoreSettled(true)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot: reads current values by design
  }, [savedHydrated, reattachDone])

  const paletteActions: PaletteAction[] = useMemo(() => {
    const actions: PaletteAction[] = []

    // Session switches
    allSidebarSessions.forEach((s, i) => {
      const project = s.projectId ? projects.find((p) => p.id === s.projectId) : undefined
      const role = s.roleId ? project?.roster?.find((r) => r.id === s.roleId) : undefined
      actions.push({
        id: `select-${s.id}`,
        group: 'Session',
        // The one label ladder (lib/session-label), same as the sidebar, the rail and the
        // dashboard: custom name → lane → its own first prompt → the model it runs → the
        // project. Built from the RAW summary, this showed Operator's injected dev-server
        // preamble as the session's title — every launched lane reading identically.
        label: sessionLabel({ session: s, role, customName: customNames[s.id], fallback: s.projectName || 'Session' }),
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

    // --- Operator's own functions -------------------------------------------------------
    // The palette used to reach only sessions/settings/themes, so most of what Operator can
    // DO (switch surface, open a panel, launch a lane, dispatch a backlog) was mouse-only.
    // Each block is gated on the state that makes it meaningful, so the list stays honest.
    if (activeSession) {
      const view = (v: MainView, label: string, hint?: string) => actions.push({
        id: `view-${v}`, group: 'View',
        label: `${label}${mainView === v ? ' ✓' : ''}`,
        hint,
        run: () => selectMainView(v),
      })
      view('terminal', 'Show Console', '⌘J')
      view('chat', 'Show Chat', '⌘J')
      view('preview', 'Show Preview')
      actions.push(
        { id: 'toggle-panel', group: 'View', label: panelOpen ? 'Hide side panel' : 'Show side panel (Plan / Diff)', run: togglePanel },
        { id: 'panel-plan', group: 'View', label: 'Side panel: Plan', run: () => { selectPanelTab('plan'); if (!panelOpen) togglePanel() } },
        { id: 'panel-diff', group: 'View', label: 'Side panel: Diff', run: () => { selectPanelTab('diff'); if (!panelOpen) togglePanel() } },
        { id: 'close-session', group: 'Session', label: 'Close this session', hint: '⌘W', run: () => { void handleCloseSession(activeSession) } },
      )
      if (mainView === 'preview') {
        actions.push({
          id: 'preview-annotate', group: 'View',
          label: previewAnnotate ? 'Preview: Interact mode' : 'Preview: Annotate mode',
          hint: '⌘E',
          run: () => setPreviewAnnotate((v) => !v),
        })
      }
    }
    actions.push(
      { id: 'toggle-sidebar', group: 'View', label: sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar', run: toggleSidebar },
      { id: 'gallery', group: 'View', label: 'All projects', hint: '⌘⇧O', run: handleShowGallery },
      { id: 'scratch-shell', group: 'New', label: 'Open scratch terminal', run: () => { setShellStarted(true); setShellOpen(true) } },
    )

    // Per project: open its workspace, launch any lane, and start its queued backlog —
    // the orchestration surface, previously reachable only through the Agents board.
    projects.forEach((p) => {
      // The palette lists BOTH shelves — it's the one surface that reaches a shelved project
      // without expanding anything — so it has to say which shelf you're about to land on,
      // and offer the way back. A mis-archive should be recoverable from anywhere.
      const shelved = !!p.archivedAt
      actions.push({
        id: `project-${p.id}`, group: 'Project',
        label: `Open ${p.name} workspace`, detail: shelved ? `${p.path} · previous` : p.path,
        run: () => handleOpenProject(p.id),
      })
      if (shelved) {
        actions.push({
          id: `restore-project-${p.id}`, group: 'Project',
          label: `Restore ${p.name} to active`,
          detail: 'Brings it back out of Previous',
          run: () => restoreProject(p.id),
        })
      }
      const resumable = restorableSessions.filter((s) => s.projectId === p.id).length
      if (resumable > 0) {
        actions.push({
          id: `resume-project-${p.id}`, group: 'Project',
          label: `Resume ${p.name} — ${resumable} agent${resumable > 1 ? 's' : ''}`,
          detail: 'Re-opens every previously open agent, continuing its conversation',
          run: () => { void handleResumeProject(p.id) },
        })
      }
      const queued = (p.tasks ?? []).filter((t) => t.roleId && (t.status ?? 'queued') === 'queued').length
      if (queued > 0) {
        actions.push({
          id: `start-tasks-${p.id}`, group: 'Project',
          label: `Start ${queued} queued task${queued > 1 ? 's' : ''} in ${p.name}`,
          detail: 'Dispatches each to its assigned lane',
          run: () => startProjectTasks(p),
        })
      }
      ;(p.roster ?? []).forEach((role) => {
        const live = terminals.some((t) => t.projectId === p.id && t.roleId === role.id && !t.ended)
        if (live) return // already running — the Session group switches to it
        actions.push({
          id: `launch-${p.id}-${role.id}`, group: 'Project',
          label: `Launch ${role.name} in ${p.name}`,
          // RESOLVED, not the raw pin: a coordinator resolves to `false` however it is stored, so
          // the palette stops advertising a worktree the launch will not create.
          detail: `${modelFamilyLabel(role.model)}${resolveAgentConfig(role, p.defaults).useWorktree ? ' · worktree' : ''}`,
          run: () => { void handleLaunchRole(p, role) },
        })
      })
    })

    // Static entries
    actions.push(
      { id: 'new-session', group: 'New', label: 'New session (pick folder)', hint: '⌘N', run: handleNewSession },
      { id: 'agents', group: 'Settings', label: 'Agents — fleet across all projects', run: handleOpenAgents },
      { id: 'prefs', group: 'Settings', label: 'Operator preferences', run: handleOpenPrefs },
      { id: 'globals', group: 'Settings', label: 'Global Claude files', run: handleOpenGlobalPrefs },
      { id: 'check-update', group: 'Settings', label: 'Check for updates', run: () => runUpdateCheck(true) },
      { id: 'theme', group: 'View', label: currentTheme.isDark ? 'Switch to light mode' : 'Switch to dark mode', run: handleToggleTheme },
    )

    // Debug: dump the active terminal's live buffer to disk (buffer-vs-pixel triage).
    if (activeSession?.terminalId ?? activeTerminalId) {
      actions.push({
        id: 'dump-terminal-buffer', group: 'Settings',
        label: 'Dump terminal buffer (debug)',
        detail: 'Writes the live xterm buffer to ~/.operator/terminal-dumps/',
        run: () => { void handleDumpBuffer() },
      })
    }

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
  }, [allSidebarSessions, customNames, recentProjects, restorableSessions, currentTheme, handleSelectSession, handleOpenFolderPrefs, handleNewSession, handleNewSessionInFolder, handleRestoreSession, handleOpenAgents, handleOpenPrefs, handleOpenGlobalPrefs, handleToggleTheme, handleSelectTheme, runUpdateCheck,
      activeSession, activeTerminalId, handleDumpBuffer, mainView, panelOpen, previewAnnotate, sidebarCollapsed, projects, terminals,
      selectMainView, selectPanelTab, togglePanel, toggleSidebar, handleShowGallery, handleCloseSession, handleOpenProject, handleLaunchRole, startProjectTasks, handleResumeProject, restoreProject])

  const accentTarget = accentPicker ? allSidebarSessions.find((s) => s.id === accentPicker.sessionId) : undefined
  const accentTargetRole = accentTarget ? roleOf(accentTarget) : undefined

  // THE RAIL TILE'S MENU — deliberately SHORTER than the gallery card's, because the rail is a
  // switcher and the card is the project's admin surface.
  //
  //   Reveal in Finder / Project Claude files   carry straight over: they act on the folder, need
  //                                             no room, and are the two things you want about a
  //                                             project you are working beside.
  //   Close project · end N agents              the one verb that belongs HERE rather than there:
  //                                             the rail is where you notice a project is still
  //                                             live, because a tile only appears while it is.
  //   Rename / Edit description                 NOT here. Both edit in place on the card, and a
  //                                             44px strip has nowhere to host an editor.
  //   Forget project                            NOT here, and this is the deliberate omission.
  //                                             Rail membership IS liveness — a tile is on screen
  //                                             because something is running in that project — so
  //                                             the one surface where Forget would sit next to a
  //                                             running agent is this one. It destroys roster,
  //                                             tasks and notes; the gallery is ⌘⇧O away and is
  //                                             where it already lives, separated and confirmed.
  const railMenuProject = railMenu ? projects.find((p) => p.id === railMenu.projectId) : undefined
  const railMenuItems = useMemo((): CardMenuItem[] => {
    if (!railMenuProject) return []
    const project = railMenuProject
    const lost = !project.path
    const live = projectActivities[project.id]?.live ?? 0
    return [
      { label: 'Reveal in Finder', onClick: () => { void window.operator.revealPath?.(project.path) }, disabled: lost },
      { label: 'Project Claude files', onClick: () => handleOpenFolderPrefs(project.path, project.name), disabled: lost },
      // ALWAYS PRESENT. Close means "take this off the rail", and every tile in this menu is on
      // the rail by definition (`isOnRail` is the filter that drew it) — so the `live > 0` gate
      // that used to hide it here was always answering the wrong question. It hid the case the
      // user actually asked for: a project you opened, launched nothing in, and could not remove
      // from the strip except by shelving it away to Previous.
      //
      // ONE VERB, GRADUATED. The label carries the count only when there is a count, and the
      // confirm engages only when there is something irreversible to confirm — ending ptys, two
      // clicks from a mis-aimed right-click on the strip you navigate by. Confirming the idle
      // close would teach people to click through the confirms that matter. Not danger-toned:
      // red is the gallery's mark for Forget, and one verb must not read as two weights.
      {
        label: live > 0 ? `Close project · end ${live} agent${live === 1 ? '' : 's'}` : 'Close project',
        onClick: () => { void closeProject(project.id) },
        separator: true,
        confirm: live > 0,
      },
    ]
  }, [railMenuProject, projectActivities, handleOpenFolderPrefs, closeProject])

  /** THE LAUNCH PATH THE IDLE ROWS USED TO CARRY. The strip lists only what is LIVE now, so the
   *  roster's quiet lanes have no row to click — and removing a control must never strand the need
   *  behind it. Same verb, same one step, one gesture further in: pick the lane, it launches. */
  const laneMenuProject = useMemo(
    () => (laneMenu ? projects.find((p) => p.id === laneMenu.projectId) ?? null : null),
    [laneMenu, projects],
  )
  const laneMenuItems = useMemo((): CardMenuItem[] => {
    const project = laneMenuProject
    if (!project) return []
    const liveRoles = new Set(
      allSidebarSessions.filter((s) => s.projectId === project.id && s.status !== 'ended').map((s) => s.roleId),
    )
    const idle = (project.roster ?? []).filter((r) => !liveRoles.has(r.id))
    return [
      ...idle.map((role) => ({
        label: `Start ${role.name}`,
        onClick: () => { void handleLaunchRole(project, role) },
      })),
      // The other verb, named, under a hairline — never sharing a glyph or a word with the four
      // above it.
      { label: 'Add an agent on the roster…', onClick: handleAddLane, separator: idle.length > 0 },
    ]
  }, [laneMenuProject, allSidebarSessions, handleLaunchRole, handleAddLane])

  return (
    /* THE FRAME — 8 on all four sides, and the top is not an exception. That is the decision, and
       it is the vertical half of the traffic-light relationship `ProjectRail`'s `RAIL_W` settles
       horizontally.
    
       Under `titleBarStyle: 'hidden'` the cluster spans y 9 → 23, so the card's lid at 8 sits a
       point ABOVE the crown of the lights — an almost-alignment, which normally reads as a mistake.
       Here it is not one, because the card's toolbar IS the title bar on the right of the window:
       the card is not ignoring the band the lights sit in, it is being it. Push it below that band
       and you get the 84px double-count this file already rejected once — see the note by the
       disabled 40px `DragRegion` further down.
    
       TWO ALTERNATIVES WERE RENDERED, not argued, and both rejected:
         • card top = 9, tangent to the lights' crown — PIXEL-IDENTICAL to the frame at 2x. It buys
           an invisible relationship (a straight edge tangent to a circle is not one the eye reads)
           and costs a uniform frame.
         • card top = 16, on the lights' centreline — visible, and it does read as deliberate, but
           it costs 8pt of height in EVERY mode to buy a relationship that exists in one corner.
       Shots and numbers: `~/.operator/briefs/OUT-rail-cluster-vertical.md`.
    
       What the user actually saw ("the border looking like a bump, and the traffic lights almost
       overlapping") was HORIZONTAL: at `RAIL_W = 60` the card's edge came within 7pt of the zoom
       button. It is 17 now. `dev/drive-rail-invariant.mjs` assertion TL gates both halves — the
       frame, and the gap — so neither can drift back without the driver saying so. */
    <div style={{ display: 'flex', width: '100%', height: '100vh', background: 'var(--bg-sidebar)', padding: 8, gap: 8, boxSizing: 'border-box' }}>
      {/* Agent colour picker (right-click an orb). Rendered here, outside the sidebar and
          rail scrollers, which clip their overflow. */}
      {accentPicker && accentTarget && (
        <AccentPicker
          top={accentPicker.top}
          left={accentPicker.left}
          value={accentOf(accentTarget)}
          title={accentTargetRole ? `${accentTargetRole.name} lane` : (customNames[accentTarget.id] || accentTarget.projectName)}
          onPick={(accent) => { setAccentForSession(accentTarget, accent); setAccentPicker(null) }}
          onClose={() => setAccentPicker(null)}
        />
      )}
      {/* Project actions (right-click a rail tile). Same reason it lives out here: the rail's
          tile column is a 44px clipping scroller. Same menu the gallery card uses, shorter list. */}
      {railMenu && railMenuProject && (
        <CardMenu
          at={{ top: railMenu.top, left: railMenu.left }}
          title={railMenuProject.name}
          items={railMenuItems}
          onClose={() => setRailMenu(null)}
        />
      )}
      {laneMenu && laneMenuProject && (
        <CardMenu
          at={{ top: laneMenu.top, left: laneMenu.left }}
          title={`${laneMenuProject.name} — agents`}
          items={laneMenuItems}
          onClose={() => setLaneMenu(null)}
        />
      )}
      {/* THE LEFT SURFACE — one strip at two widths. There is no pair to group any more: the
          rail and the sidebar were two components each listing agents, which is why the same
          list kept appearing twice 40px apart, and the sidebar is deleted. ⌘B and the gallery
          set `collapsed`; the strip animates its own width and NOTHING unmounts, which is what
          keeps the theme toggle, Preferences and both `.claude` shortcuts on screen at 60px. */}
      <ProjectRail
        collapsed={contentMode === 'gallery' || sidebarCollapsed}
        projects={projects}
        activities={projectActivities}
        activeProjectId={contentMode === 'gallery' ? null : activeProjectId}
        // Clicking the tile of the project you are ALREADY in takes you to its home.
        // `handleOpenProject` deliberately no-ops on a re-select (the "don't yank me out of my
        // session" rule), but that rule was written for the sidebar header and the toolbar
        // chevron — which have their own way home. The rail tile had none, so from inside an
        // agent it was a control that did nothing at all. Going home is only a "yank" if you
        // are already home, and that case is still a no-op here.
        onOpenProject={(id) => {
          if (id === activeProjectId && contentMode !== 'project') handleOpenProjectHome()
          else handleOpenProject(id)
        }}
        onShowGallery={handleShowGallery}
        onOpenFolder={handleNewSession}
        onOpenAgents={handleOpenAgents}
        agentsActive={contentMode === 'agents'}
        onReorder={handleReorderProject}
        onTileMenu={(projectId, anchor) => setRailMenu({ projectId, ...anchor })}
        menuProjectId={railMenu?.projectId ?? null}
        // EVERY live session, not just this project's. The strip groups them itself — which is
        // the whole point of joining the two surfaces: membership is one rule applied in one
        // place, rather than a rail scoped one way and a panel scoped another.
        sessions={allSidebarSessions}
        activeSessionId={activeSessionId}
        onSelectSession={handleSelectSession}
        accentOf={accentOf}
        onPickAccent={(session, anchor) => setAccentPicker({ sessionId: session.id, ...anchor })}
        onOpenProjectHome={handleOpenProjectHome}
        projectHomeActive={contentMode === 'project'}
        onRestoreProject={restoreProject}
        customNames={customNames}
        effortLevels={effortLevels}
        fanInfo={fanInfo}
        shortcutIndices={shortcutIndices}
        onRenameSession={handleRename}
        onCloseSession={handleCloseSession}
        onAgentMenu={(projectId, anchor) => setLaneMenu({ projectId, ...anchor })}
        onAddLane={handleAddLane}
        onReorderSession={handleReorderSession}
        onReorderLane={handleReorderLane}
        activeFolderPrefs={activeFolderPrefs?.projectPath ?? null}
        globalPrefsActive={globalPrefsActive}
        prefsViewActive={prefsViewActive}
        isDark={currentTheme.isDark}
        onOpenFolderPrefs={handleOpenFolderPrefs}
        onOpenGlobalPrefs={handleOpenGlobalPrefs}
        onOpenPrefs={handleOpenPrefs}
        onToggleTheme={handleToggleTheme}
        version={appVersion}
        update={availableUpdate}
        installState={installState}
        onInstallUpdate={startInstall}
      />

      <div data-term-focus-zone style={{
        position: 'relative', flex: 1,
        display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--bg-terminal)', borderRadius: 'var(--radius-lg)', overflow: 'hidden',
        // ELEVATION — the landing kit's `.panel` depth, and the one place it belongs: this is
        // THE content card, so every mode inherits it and no mode can drift.
        //
        // The card and the field it sits on are one step apart in lightness, and until now
        // nothing else separated them — the card read as the field. A shadow plus a defined
        // edge is the difference between a surface and an object.
        //
        // Both come from `box-shadow`, not `border`. This element is radiused and the panel
        // edge is a colour, and a colour-CHANGING border on a radiused element is the
        // WKWebView re-rasterization trap. `inset` for the edge so it paints within the
        // card's own footprint rather than over the sidebar's last column; the drop shadow
        // is the only thing allowed outside it.
        boxShadow: 'var(--shadow-panel), inset 0 0 0 1px var(--panel-edge)',
      }}>
        {/* NO VERTICAL RULE CROSSES THE TITLEBAR. With the strip's own right-hand seam deleted,
            this card's edge is the only vertical line left in that corner — and it ran the full
            height, straight through the 40px drag band the traffic lights sit in.
            A gradient masks it over the band. NOT as this element's `background-image`, which was
            the first attempt and cannot work: an inset box-shadow paints ABOVE the background, so
            the edge drew straight over the mask. A child does paint above it.
            NARROW, not full-width: the card's top 40px is where the toolbar's own controls live,
            and an opaque band across all of it would cover them. It is 4px — the vertical rule and
            nothing else. The card keeps its top and its full height; nothing is pushed down, and
            no radiused element changes border colour (the WKWebView re-rasterize trap).
            WHAT IT DOES NOT COVER, measured rather than assumed: this element is clipped by the
            card's own `overflow: hidden` and 12px radius, so above y≈12 it covers NOTHING. The
            corner ARC and the top edge draw across the band regardless, and the run it actually
            hides starts below the lights rather than beside them.
            THAT IS CORRECT, and widening it is not the fix — tried at 14px, which is the radius:
            the arc vanishes and the top edge starts in mid-air, so the card reads as a lid with a
            broken corner. The rule this mask enforces is the one it is named for — no VERTICAL
            rule in the titlebar — and an arc is where a vertical rule becomes a horizontal one.
            It stays. */}
        <div aria-hidden style={{
          position: 'absolute', top: 0, left: 0, width: 4, height: 40, zIndex: 2, pointerEvents: 'none',
          background: 'linear-gradient(to bottom, var(--bg-terminal) 0, var(--bg-terminal) 28px, transparent 40px)',
        }} />
        {/* Drag region — only where nothing else is acting as one. Three modes bring their
            own: the session toolbar (`localTerminal`), the gallery's taller header (which
            also clears the traffic lights, since no rail sits beside it), and ProjectView's
            own 44px strip — adding this 40px spacer on top of that double-counted to 84px.
            PageShell's pages (prefs / agents / folderPrefs) have NO strip of their own and
            still need it. */}
        {/* The PageShell modes used to get a bare 40px DragRegion here purely to clear the traffic
            lights, and no sidebar toggle at all — six modes had no way to collapse the sidebar.
            They sit in AppShell now, whose 44px header does both jobs: it clears the lights AND
            carries the toggle, in the same box every other mode uses. The channel and Project Home
            bring their own shell below, and the session keeps its own frame for now — see
            dev/briefs/one-app-shell-RESULT.md for why it is migrated separately. */}
        {false && <DragRegion style={{ height: 40, flexShrink: 0 }} />}

        {contentMode === 'folderPrefs' && activeFolderPrefs && (
          <AppShell onToggleSidebar={toggleSidebar} sidebarCollapsed={sidebarCollapsed}>
          <FolderPreferencesView
            projectPath={activeFolderPrefs.projectPath}
            projectName={activeFolderPrefs.projectName}
            // The Operator-side record, for the Environment tab. Matched by PATH because that
            // is all this view is opened with; `projects.json` keys on the canonical repo root,
            // which is what `projectPath` already is here.
            project={projects.find((p) => p.path === activeFolderPrefs.projectPath) ?? null}
            onPatchProject={(patch) => {
              const proj = projects.find((p) => p.path === activeFolderPrefs.projectPath)
              if (proj) updateProject(proj.id, patch)
            }}
          />
          </AppShell>
        )}

        {contentMode === 'globalPrefs' && (
          <AppShell onToggleSidebar={toggleSidebar} sidebarCollapsed={sidebarCollapsed}>
          <FolderPreferencesView
            projectPath=""
            projectName="Global Claude Files"
            globalOnly
          />
          </AppShell>
        )}

        {contentMode === 'agents' && (
          <AppShell onToggleSidebar={toggleSidebar} sidebarCollapsed={sidebarCollapsed}>
          <AgentsHubView
            projects={projects}
            sessions={allSidebarSessions}
            accentOf={accentOf}
            customNames={customNames}
            onFocusSession={handleSelectSession}
            onLaunchRole={(project, role) => { void handleLaunchRole(project, role, undefined, false, { focus: true }) }}
            onOpenProject={handleOpenProject}
          />
          </AppShell>
        )}

        {contentMode === 'project' && activeProjectId && (() => {
          const proj = projects.find((p) => p.id === activeProjectId)
          if (!proj) return null
          const live: Record<string, string> = {}
          for (const t of terminals) if (t.projectId === proj.id && t.roleId) live[t.roleId] = t.id
          // Live runtime per lane, from the transcript observer. ONE map, read by two consumers
          // with narrower views of it: RosterPanel's `LaneSession` (phase + usage, for the Team
          // card's mission-control read) and TaskBoard's `LaneSignal` (status/phase/lastToolName/
          // activeSubagents, for the running card's activity line and its child-threads row).
          // A superset satisfies both structurally, so there is one loop and one source — two
          // loops over `sessions` is how the board and the roster start disagreeing about which
          // lane is busy.
          const laneRuntime: Record<string, {
            status: AgentSession['status']; phase: AgentSession['phase']
            lastToolName: string | null; activeSubagents: number
            usage?: AgentSession['usage']; lastActivityAt?: string
          }> = {}
          for (const [roleId, tid] of Object.entries(live)) {
            const s = sessions.find((x) => x.terminalId === tid)
            if (s) laneRuntime[roleId] = {
              status: s.status, phase: s.phase,
              lastToolName: s.lastToolName, activeSubagents: s.activeSubagents,
              usage: s.usage, lastActivityAt: s.lastActivityAt,
            }
          }
          return (
            <ProjectView
              project={proj}
              reports={reports}
              tab={projectTab}
              onSelectTab={setProjectTab}
              onBack={handleShowGallery}
              onToggleSidebar={toggleSidebar}
              sidebarCollapsed={sidebarCollapsed}
              onUpdateProject={updateProject}
              // The roster's brief IS `handleLaunchRole`'s `prompt` — the same argument the
              // dispatch auto-launch path uses, so a launch brief reaches the agent by the
              // route that already works. Empty brief → undefined → today's behaviour exactly.
              // No `??` default on launchDevServer: the field is required by the prop type, so
              // there is nothing to default and no way to silently launch with it off.
              onLaunchRole={(project, role, o) => handleLaunchRole(project, role, o.brief, o.launchDevServer)}
              liveRoles={live}
              laneSessions={laneRuntime}
              laneSignals={laneRuntime}
              onFocusTerminal={focusTerminal}
              // Closing a lane's session from its card goes through the SAME path as closing it
              // from the sidebar — pty kill, running tasks completed with their diff + check,
              // worktree chained behind. A second close route must not become a second lifecycle.
              onCloseTerminal={(tid) => {
                const s = sessions.find((x) => x.terminalId === tid)
                if (s) void handleCloseSession(s)
              }}
              onAddTask={(text, roleId) => addProjectTask(proj.id, text, roleId)}
              onAssignTask={(taskId, roleId) => assignProjectTask(proj.id, taskId, roleId)}
              onRemoveTask={(taskId) => removeProjectTasks(proj.id, [taskId])}
              onSendTask={(task) => sendProjectTask(proj, task)}
              onStartAll={() => startProjectTasks(proj)}
              onSetTaskStatus={(taskId, status) => setTaskStatus(proj.id, taskId, status)}
              // A dispatch from a non-coordinator lane is HELD (`pending-approval`) and can only
              // be delivered from here. Without these two wires the hold is a silent drop:
              // The Comms log would render the pending row with nothing able to act on it.
              onApproveDispatch={approveDispatch}
              onRejectDispatch={rejectDispatch}
              onRetryDispatch={retryDispatch}
              onOpenLaneTerminal={openLaneTerminal}
              onAssignDispatch={assignDispatch}
              // The delivery kill switch, rehomed from the channel header onto Team.
              chatterPaused={chatterPaused}
              onToggleChatter={toggleChatterPaused}
              addLaneRequest={addLaneRequest}
              onAddLaneRequestHandled={clearAddLaneRequest}
              resumableCount={restorableSessions.filter((s) => s.projectId === proj.id).length}
              onResumeProject={() => { void handleResumeProject(proj.id) }}
            />
          )
        })()}

        {contentMode === 'prefs' && (
          <AppShell onToggleSidebar={toggleSidebar} sidebarCollapsed={sidebarCollapsed}>
          <PrefsView currentTheme={currentTheme} onSelectTheme={handleSelectTheme} onToggleTheme={handleToggleTheme} />
          </AppShell>
        )}

        {contentMode === 'localTerminal' && activeSession && (() => {
          const tab = terminals.find((t) => t.id === activeTerminalId)
          return (
            <SessionToolbar
              key={activeSession.workingDirectory}
              projectPath={activeSession.workingDirectory}
              projectName={activeSession.projectName}
              onOpenProjectHome={activeProjectId ? handleOpenProjectHome : undefined}
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
                  // Not just "is this the active lane" — also "is anything covering it". A
                  // cross-origin preview iframe is composited out-of-process under Chromium and
                  // the terminal below it can land ON TOP; see `paneVisibility`.
                  visibility: paneVisibility(t.id, activeTerminalId, mainView),
                  // Inert while a Chat/Preview overlay covers it — otherwise the wheel falls
                  // through the canvas (pointerEvents:none) to the still-visible console and
                  // scrolls ITS scrollback under the overlay (the "chat won't scroll, but the
                  // scrollbar moves" bug — that scrollbar was the console's).
                  pointerEvents: mainView === 'terminal' ? undefined : 'none',
                }}
              >
                {/* PER SESSION, never per app. `t.grid` was decided when this pty was spawned
                    (the alacritty core is created there), so flipping the pref cannot swap the
                    pane under a running session — and a reload reads it back off the pty.
                    `TerminalSurface` is unchanged and remains the default and the fallback. */}
                {t.grid ? (
                  <GridTerminalPane
                    terminalId={t.id}
                    theme={currentTheme.xterm}
                    // Same activity rule as the xterm pane. The grid pane owns its own
                    // lifecycle from this one prop: it attaches (and pushes a fresh full
                    // frame) when it becomes active, resizes from its own ResizeObserver,
                    // re-themes on a new `theme`, and detaches on unmount.
                    active={t.id === activeTerminalId && !t.ended && mainView === 'terminal'}
                  />
                ) : (
                  <TerminalSurface
                    terminalId={t.id}
                    theme={currentTheme.xterm}
                    // Deactivated when a Chat/Preview overlay covers it, so the hidden terminal
                    // doesn't grab focus/keystrokes; re-activates on switch back (its size is
                    // unchanged, so the activation fit is a no-op — no resize-hang risk).
                    active={t.id === activeTerminalId && !t.ended && mainView === 'terminal'}
                    suspendFit={resizingPanel || windowResizing || sidebarAnimating}
                    // Hand every sniffed dev-server port to the backend, for EVERY pane
                    // (not just the active one) — a background lane's server is still its
                    // server, and the banner scrolls past exactly once. This is the only
                    // attribution source that survives a session Operator didn't hand a
                    // port to, now that nothing inspects the process tree.
                    onDevServerDetected={(port) => window.operator.noteSessionPort?.(t.id, port)}
                  />
                )}
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
              // A FLEX COLUMN, for the same reason the panel body is one: the surfaces mounted
              // here ask for their height with `flex: 1`, and a plain block gives them nothing —
              // they size to their content, overflow this box, and get clipped, which is what
              // made Files unscrollable in 0.18.0. Column keeps full-width stretch, so Chat and
              // Preview lay out exactly as they did.
              <div style={{ position: 'absolute', inset: 0, borderRadius: 'var(--radius-lg)', overflow: 'hidden', background: 'var(--bg-terminal)', display: 'flex', flexDirection: 'column' }}>
                {mainView === 'chat' && (
                  <CanvasConversation
                    session={activeSession}
                    role={roleOf(activeSession)}
                    customName={customNames[activeSession.id]}
                    accent={accentOf(activeSession)}
                    onHumanSend={handleHumanSend}
                    onModelChange={(m) => patchActiveTerminal({ model: m })}
                    onEffortChange={(e) => patchActiveTerminal({ effortLevel: e })}
                  />
                )}
                {/* PLACEMENT A (§2). The lane's worktree is `tab.cwd`; `tab.sourceCwd` is the
                    project checkout the root switch offers. `onAsk` is the app's own answer to
                    "I want to change this" — it hands the line to the lane through the same
                    `submitQueue` the Plan tab's "Send to agent" uses. */}
                {mainView === 'files' && (() => {
                  const tab = terminals.find((t) => t.id === activeTerminalId)
                  return (
                    <FilesView
                      laneRoot={tab?.cwd ?? ''}
                      projectRoot={tab?.sourceCwd}
                      nav={filesNav}
                      onNav={setFilesNav}
                      onAsk={activeSession.terminalId
                        ? (p, range) => { void submitQueue.submit(activeSession.terminalId!, range ? `\`${p}:${range[0]}\`` : `\`${p}\``) }
                        : undefined}
                    />
                  )
                })()}
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
                      onDispatch={activeSession.terminalId ? (text) => { void submitQueue.submit(activeSession.terminalId!, text) } : undefined}
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

        {/* The launcher: full-bleed, no sidebar and no rail beside it (see the wrapper
            above), so "outside a project" is unmistakable. */}
        {contentMode === 'gallery' && (
          <ProjectGallery
            projects={projects}
            sessions={allSidebarSessions}
            activities={projectActivities}
            tab={galleryTab}
            onSelectTab={setGalleryTab}
            accentOf={accentOf}
            customNames={customNames}
            onOpenProject={handleOpenProject}
            onOpenFolder={handleNewSession}
            onRenameProject={(id, name) => updateProject(id, { name })}
            onSetProjectNotes={(id, contextNotes) => updateProject(id, { contextNotes })}
            onForgetProject={forgetProject}
            onArchiveProject={archiveProject}
            onCloseProject={(id) => { void closeProject(id) }}
            activeProjectId={activeProjectId}
            closingIds={closingProjects}
            onArchiveProjects={archiveProjects}
            onRestoreProject={restoreProject}
            onOpenFolderPrefs={handleOpenFolderPrefs}
            onSelectSession={handleSelectSession}
            restorableSessions={restorableSessions}
            recentProjects={recentProjects}
            onRestore={handleRestoreSession}
            onForget={forgetSavedSession}
            onOpenFolderPath={openProjectOrFolder}
          />
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
            role={activeSession ? roleOf(activeSession) : undefined}
            customName={activeSession ? customNames[activeSession.id] : undefined}
            accent={activeSession ? accentOf(activeSession) : undefined}
            tabs={panelTabs}

            filesTab={(() => {
              const tab = terminals.find((t) => t.id === activeTerminalId)
              return (
                <FilesPanel
                  laneRoot={tab?.cwd ?? ''}
                  projectRoot={tab?.sourceCwd}
                  nav={filesNav}
                  onNav={setFilesNav}
                  onAsk={activeSession?.terminalId
                    ? (p, range) => { void submitQueue.submit(activeSession.terminalId!, range ? `\`${p}:${range[0]}\`` : `\`${p}\``) }
                    : undefined}
                />
              )
            })()}
            mode={effPanelTab}
            onSelectMode={selectPanelTab}
            onHumanSend={handleHumanSend}
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

      {/* Mounted HERE rather than in AppShell: AppShell is instantiated once per content mode,
          so a dialog placed in it would exist once per mode. This is the one root that renders
          over the gallery, settings and preview alike — the same place the palette mounts. */}
      {quitRequest && (
        <QuitGuard
          request={quitRequest}
          identify={identifyQuitLane}
          onStay={() => answerQuit(false)}
          onQuit={() => answerQuit(true)}
        />
      )}

      <Toasts messages={toasts} onDismiss={dismissToast} onDismissAll={dismissAllToasts} />
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

