import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { AgentSession, SavedSession, Project, ProjectPatch, Role, ProjectTask, SessionConfig, TaskDiffStat, DispatchRecord } from '../../shared/types'
import { resolveProject } from '../lib/resolve-project'
import { orchestrationNote, modelFamilyLabel, migrateLegacyCoordinator, reorderRoles, presetFor, rolePresets, isCoordinator } from '../lib/roster'
import { emptyDeliveryState, evaluateDelivery, deliveryPrefix, resetChainFor, chatterPausedFrom, CHATTER_KEY, type DeliveryState } from '../lib/agent-delivery'
import {
  resolveAgentConfig, pruneGlobals, clearSeededRoleFields, seedGlobalDefaults,
  migrateSeededWorktreeDefaults, clearAllPinnedRoleFields, pinnedFieldCounts, type GlobalRoleDefaults,
} from '../lib/model-config'
import { projectActivity, type ProjectActivity } from '../lib/project-status'
import { landingFor } from '../lib/project-landing'
import { shelvingMoves, closePlan } from '../lib/project-shelf'
import { reorderByIds } from '../lib/reorder'
import { reorderRail } from '../lib/project-shelf'
import { reconcileStaleRunning, liveLaneOf, type LiveLane } from '../lib/task-lifecycle'
import { pruneSavedSessions } from '../lib/session-prune'
import { pruneSeededIdleLanes } from '../lib/prune-seeded-lanes'
import { sessionLabel } from '../lib/session-label'
import { loadSessionAccents, saveSessionAccent } from '../lib/session-accents'
import { AccentPicker } from '../components/AccentPicker'
import { routeDispatch, liveLaneNames, pickLaneTab, dispatchNeedsApproval } from '../lib/dispatch'
import { submitQueue, onUndeliveredSubmission } from '../lib/submit-queue'
import { matchSubmission, userTurnsSince } from '../lib/delivery-confirm'
import { fetchTaskDiffStat, taskHasDiffSource } from '../lib/task-diff'
import { Sidebar } from '../components/sidebar/Sidebar'
import { SidebarRail } from '../components/sidebar/SidebarRail'
import { ProjectRail } from '../components/sidebar/ProjectRail'
import { ProjectChannel, channelHeader } from '../components/session/ProjectChannel'
import { ChannelPanel } from '../components/session/ChannelPanel'
import { AppShell } from '../components/AppShell'
import { buildChannelFeed, unreadEntries } from '../lib/project-channel'
import { planChannelSend, validateChannelMessage, type ChannelLane, type ChannelTarget } from '../lib/channel-send'
import type { ProjectReply } from '../../shared/types'
import { TerminalSurface } from '../components/terminal/TerminalSurface'
import { getTerminal } from '../lib/terminal-registry'
import { homeDir, join } from '@tauri-apps/api/path'
import { ShellSheet } from '../components/terminal/ShellSheet'
import { SessionActivityView } from '../components/session/SessionActivityView'
import { FolderPreferencesView } from '../components/preferences/FolderPreferencesView'
import { SessionToolbar } from '../components/session/SessionToolbar'
import { CanvasPanel } from '../components/session/CanvasPanel'
import { CanvasConversation } from '../components/session/CanvasConversation'
import { ProjectView } from '../components/session/ProjectView'
import { AppPreviewPanel } from '../components/session/AppPreviewPanel'
import { DiffPanel } from '../components/session/DiffPanel'
import { AgentsHubView } from '../components/agents/AgentsHubView'
import { PrefsView } from '../components/prefs/PrefsView'
import { CommandPalette, PaletteAction } from '../components/CommandPalette'
import { ProjectGallery } from '../components/dashboard/ProjectGallery'
import { Toasts, ToastMessage } from '../components/Toast'
import { themes, defaultTheme, applyTheme, resolveThemeKey, themeKey, identities } from '../themes'
import type { OperatorTheme } from '../themes'
import { playYourTurnChime } from '../lib/sounds'
import { computeFanMembership } from '../lib/fan-out'
import { isAppChord } from '../lib/key-routing'
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

// Same one-shot bookkeeping for the role-defaults seed migration (worktree posture). Separate key
// from the lane prune: they answer to different stores and must be able to run independently — a
// user who has done one has not necessarily done the other.
const SEED_MIGRATION_KEY = 'operator.worktreeSeedMigratedAt'
function seedMigrationDone(): boolean {
  try { return !!localStorage.getItem(SEED_MIGRATION_KEY) } catch { return true }
}
function markSeedMigrationDone() {
  try { localStorage.setItem(SEED_MIGRATION_KEY, new Date().toISOString()) } catch { /* quota */ }
}

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
  const [projectTab, setProjectTab] = useState<'roster' | 'moodboard'>('roster')
  // Gallery sub-view: the project grid, or the cross-project ActivityDashboard behind the
  // rollup chip. That read is legitimate HERE (launcher level) and nowhere inside a project.
  const [galleryTab, setGalleryTab] = useState<'projects' | 'activity'>('projects')
  /** The project channel (read-only agent feed) is the content area. Project-scoped, so it is a
   *  contentMode rather than a projectTab — the sidebar row switches to it and activeProjectId
   *  still scopes it. */
  const [channelActive, setChannelActive] = useState(false)
  /** OPERATOR-REPLY rows for the scoped project, read from chat.db. Empty until a lane emits one. */
  const [channelReplies, setChannelReplies] = useState<ProjectReply[]>([])
  /** projectId → ISO timestamp of the newest entry the user has seen. */
  const [channelReadAt, setChannelReadAt] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('operator.channelReadAt') || '{}') } catch { return {} }
  })
  /** Bumped when a reply arrives, to re-read the store. The setter's identity is stable, which is
   *  what lets the mount-once reply subscription reach it without a ref. */
  const [replyTick, setReplyTick] = useState(0)
  /** GLOBAL per-role defaults — the user-owned layer over `rolePresets()`, from
   *  `~/.operator/role-defaults.json`. Every project inherits it; see lib/model-config. */
  const [roleDefaults, setRoleDefaults] = useState<GlobalRoleDefaults>({})
  /** The launch path is reached from a mount-once dispatch subscription, so it reads the defaults
   *  through a ref — a lane launched by a dispatch must use the CURRENT config, not the one that
   *  existed when the subscription was set up. */
  const roleDefaultsRef = useRef<GlobalRoleDefaults>({})
  roleDefaultsRef.current = roleDefaults
  /** Blocks the persist effect until the file has been read, so an empty initial state can't
   *  overwrite real defaults — the same rule `savedHydrated` enforces for sessions/projects. */
  const [roleDefaultsHydrated, setRoleDefaultsHydrated] = useState(false)
  useEffect(() => {
    const p = window.operator.loadRoleDefaults?.()
    if (!p) { setRoleDefaultsHydrated(true); return }
    void p.then((raw) => {
      const stored = pruneGlobals((raw ?? {}) as GlobalRoleDefaults)
      // First run seeds the worktree posture only — see seedGlobalDefaults for why model and
      // effort are deliberately left to the built-in presets.
      if (!Object.keys(stored).length) {
        setRoleDefaults(seedGlobalDefaults())
        // A store seeded TODAY is already on the new posture, so the migration below has nothing
        // to do here — ever. Recording that now is what stops it re-scanning on every later launch.
        markSeedMigrationDone()
        setRoleDefaultsHydrated(true)
        return
      }
      // …and for everyone else, ONCE: the seed only runs on an empty store, so a changed default
      // reaches an existing install through this and nothing else (see
      // `migrateSeededWorktreeDefaults` for how narrowly it decides).
      if (seedMigrationDone()) { setRoleDefaults(stored); setRoleDefaultsHydrated(true); return }
      const { globals, roles } = migrateSeededWorktreeDefaults(stored)
      markSeedMigrationDone()
      setRoleDefaults(globals)
      setRoleDefaultsHydrated(true)
      if (roles.length) {
        // Where a lane RUNS is not something to change under someone silently — an isolated lane
        // lands its work on a branch, which is a different answer to "where is my diff?". Undo
        // restores the stored posture and leaves the flag set: undo means keep it.
        const named = roles.map((id) => rolePresets().find((r) => r.id === id)?.name ?? id)
        pushToast({
          text: `${named.join(' and ')} now run in their own worktree`,
          detail: 'Change it under Agents → Defaults.',
          action: { label: 'Undo', run: () => setRoleDefaults(stored) },
        })
      }
    }).catch(() => setRoleDefaultsHydrated(true))
  }, [])
  useEffect(() => {
    if (!roleDefaultsHydrated) return
    window.operator.saveRoleDefaults?.(pruneGlobals(roleDefaults))
  }, [roleDefaults, roleDefaultsHydrated])
  /** Edit one role's global default. `undefined` clears the field back to the built-in preset. */
  const patchRoleDefault = useCallback((roleId: string, patch: GlobalRoleDefaults[string]) => {
    setRoleDefaults((prev) => pruneGlobals({ ...prev, [roleId]: { ...prev[roleId], ...patch } }))
  }, [])
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
  // Load the project's replies whenever a project is SCOPED — not only when the channel opens.
  // Gating it on `channelActive` made the sidebar's unread badge under-count: it saw dispatches
  // but zero replies until you opened the channel, i.e. the badge disagreed with the feed it was
  // advertising. One query per project switch is nothing.
  //
  // Read-only: chat.db is tailer-write / frontend-read and this adds no write path. Re-read on
  // scope change rather than polling — the tailer ticks at 1s and this is history, not a console.
  //
  // …and on `replyTick`, bumped by the reply subscription below. This is not a nicety: since step 3
  // a delivery outcome is recorded against a reply and FOLDS INTO ITS ROW, so with no re-read the
  // reply row wouldn't exist yet and the outcome — including a brake — would be invisible until you
  // switched projects and back. The tailer persists before it emits (transcript.rs), so a read
  // triggered by the event always sees the row.
  useEffect(() => {
    if (!activeProjectId) { setChannelReplies([]); return }
    let cancelled = false
    void window.operator.projectReplies?.(activeProjectId)
      .then((rows) => { if (!cancelled) setChannelReplies(rows ?? []) })
      .catch(() => { if (!cancelled) setChannelReplies([]) })
    return () => { cancelled = true }
  }, [channelActive, activeProjectId, replyTick])

  const markChannelRead = useCallback((projectId: string, at: string) => {
    setChannelReadAt((prev) => {
      if (prev[projectId] === at) return prev // same feed head — don't churn localStorage
      const next = { ...prev, [projectId]: at }
      try { localStorage.setItem('operator.channelReadAt', JSON.stringify(next)) } catch { /* quota */ }
      return next
    })
  }, [])
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
        const waiting = submitQueue.pending(s.terminalId)
        if (!waiting) continue
        const turns = userTurnsSince(s.messages, waiting.at)
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
   *  by default, so the board became a single row with nothing to decide. Where it lands now is
   *  `landingFor` (lib/project-landing): several lanes → the channel, exactly one → that agent,
   *  none → the board, which is the only place to add one.
   *
   *  RE-ENTERING is re-applied, not restored. Coming back to a project you've been in before puts
   *  you where the rule says, not where you last were — predictable beats clever, and "restore
   *  where I was" is a whole separate feature with its own persistence. The one thing preserved is
   *  the existing instinct on line 583: opening the project you are ALREADY in does not yank you
   *  off what you are looking at. Only a genuine change of project re-lands.
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
      const landing = landingFor(projectsRef.current.find((p) => p.id === projectId), terminalsRef.current)
      setProjectTab('roster')
      setChannelActive(landing.kind === 'channel')
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
    setChannelActive(false)
    setProjectTab('roster')
    setPrefsViewActive(false)
    setAgentsViewActive(false)
    setGlobalPrefsActive(false)
    setActiveFolderPrefs(null)
    setActiveSessionId(null)
    setActiveTerminalId(null)
  }, [])

  // Leave every project — the logo, the switcher's "All projects" and ⌘⇧O. This is the ONE
  // path that clears scope; it stops nothing, the agents keep running (spec §4 rule 3).
  const handleShowGallery = useCallback(() => {
    setChannelActive(false)
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
      return raw ? JSON.parse(raw) : []
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
      return raw ? (JSON.parse(raw) as Project[]).map(migrateLegacyCoordinator) : []
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
          ? { ...p, path: r.path, name: p.name || r.name, lastActiveAt: now, defaults: p.defaults ?? opts?.defaults, archivedAt: undefined }
          : p)
      }
      // AUTO-LIFT: launching, restoring, opening a folder and background cwd resolution all
      // funnel through here, so clearing `archivedAt` in this one spread un-shelves a project
      // on EVERY revival path. Without it a running agent can hide inside a collapsed
      // section. It also fires at boot for a pty that survived a restart (the cwd-resolution
      // effect below) — correct, since that agent really is live, but it looks like a mystery
      // write if nobody wrote it down. Note that merely OPENING a project does not come
      // through here: see handleOpenProject.
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
  const forgottenProjectsRef = useRef(new Set<string>())

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
    const detail = only
      ? stuck.length
        ? 'Still running, so it stays on Active.'
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

  /** CLOSE a project: end its live sessions, then shelve it.
   *
   *  The verb that did not exist. Closing meant clicking ■ on every live lane by hand, then
   *  Shelve, and knowing to do it in that order — and doing it in the other order produced the
   *  false "moved to Previous" above.
   *
   *  SEQUENCE MATTERS and is the whole reason this is one action: the sessions are ended and
   *  awaited FIRST, and only then is `archivedAt` written. Writing the flag first re-creates the
   *  lie, because the project is still lifted onto Active while the lanes are alive.
   *
   *  Reuses `handleCloseSession` per lane — the same path the ■ button takes, which already kills
   *  the pty, finishes its running tasks, removes the worktree dir (keeping the branch) and drops
   *  the saved session. No second teardown route, and nothing pattern-kills: every session is
   *  closed by id, and only ones stamped with THIS project.
   *
   *  Data — roster, tasks, notes, branches — is untouched, exactly as Shelve promises. */
  const closeProject = useCallback(async (id: string) => {
    const project = projectsRef.current.find((p) => p.id === id)
    if (!project) return
    const plan = closePlan(id, sessionsRef.current)
    const live = sessionsRef.current.filter((s) => plan.sessions.includes(s.id))
    // Awaited: `handleCloseSession` kills the pty before returning, so by the time this resolves
    // the lanes really are gone and the shelf write below is telling the truth.
    for (const s of live) await handleCloseSessionRef.current(s)
    const at = new Date().toISOString()
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, archivedAt: at } : p)))
    setActiveProjectId((cur) => (cur === id ? null : cur))
    const n = plan.sessions.length
    pushToast({
      text: n ? `Closed ${project.name} — ${n} agent${n === 1 ? '' : 's'} ended` : `Closed ${project.name}`,
      // Undo puts the project back on Active. It CANNOT bring the sessions back — the ptys are
      // gone — and saying otherwise is the same class of lie this change exists to remove.
      // The half that must survive the clamp is the one that could mislead: Undo brings the
      // project back to Active, and cannot bring back a pty that has been killed.
      detail: n
        ? 'Undo restores the shelf, not the agents.'
        : 'It moves to Previous. Launching an agent here brings it straight back.',
      action: {
        label: 'Undo',
        run: () => setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, archivedAt: undefined } : p))),
      },
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
  const completeTerminalTasks = useCallback(async (terminalId: string, roleId?: string, projectId?: string, lane?: TaskLane) => {
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
  /** Per-project liveness, and the per-lane close path — both declared far below the shelve and
   *  close actions that need them, so they arrive through refs assigned on render. */
  const activitiesRef = useRef<Record<string, ProjectActivity>>({})
  const handleCloseSessionRef = useRef<(s: AgentSession) => Promise<void>>(async () => {})
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

      // The store already has it (persist-then-emit); pull it into the feed so the delivery
      // outcome recorded below has a row to fold into.
      setReplyTick((n) => n + 1)

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
      // to a runaway. It posts to the channel and stops there.
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
      // the channel folds it into that reply's row, so a stopped chain reads as "posted · chain
      // limit reached" instead of looking like the addressee ignored it.
      const record = (outcome: DispatchRecord['outcome']) => log(project.id, {
        id: crypto.randomUUID(), at: new Date().toISOString(),
        fromRoleId: from.id, toRoleId: to.id, task: r.text, outcome, replyId: r.id,
      })

      if (decision.kind === 'block') {
        record(decision.reason === 'queued' ? 'queued' : decision.reason)
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
        toast({ text: `Trimmed a long message to ${to.name}`, kind: 'info', detail: 'The full text is in the channel.' })
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
      if (!project) return
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
        addTask(project.id, d.task) // unknown role → unassigned backlog
        record('unassigned')
        toast({ text: 'Queued (unassigned)', kind: 'info', detail: preview })
        feedback(`No lane named "${d.role}" exists in this project, so your task went to the unassigned backlog. Reassign it to one of the project's actual lanes, or ask the user.`)
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
      if (!project) return

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

  /** Send a HUMAN message from the project channel to one lane, or to everyone.
   *
   *  Reuses the dispatch delivery primitive (`submitQueue.submit`) — there is exactly one path
   *  that writes to a pty and this is not a second one. What it deliberately does NOT reuse is
   *  dispatch's idle-lane LAUNCH: see planChannelSend for why a message must never spawn a session.
   *
   *  Returns what happened so the composer can report it without guessing. */
  const sendChannelMessage = useCallback((projectId: string, text: string, target: ChannelTarget) => {
    // Second enforcement point, and the one that actually matters: the composer checks too, but a
    // paste followed immediately by ⌘↵ must not be able to outrun it.
    const check = validateChannelMessage(text)
    if (!check.ok) return { ok: false as const, error: check.error }

    const project = projectsRef.current.find((p) => p.id === projectId)
    if (!project) return { ok: false as const, error: 'No project in scope.' }
    const roster = project.roster ?? []
    const lanes: ChannelLane[] = roster.map((role) => ({
      role,
      terminalId: pickLaneTab(withActivity(terminalsRef.current), projectId, role.id)?.id,
    }))
    const plan = planChannelSend(text, target, lanes, crypto.randomUUID())
    if (!plan.records.length) return { ok: false as const, error: 'No lane to send to.' }

    const at = new Date().toISOString()
    for (const rec of plan.records) {
      // Delivered ones go through the shared queue: serialized per terminal with a length-scaled
      // watchdog, so two sends can't merge into one composer draft.
      if (rec.outcome === 'sent' && rec.terminalId) void submitQueue.submit(rec.terminalId, rec.task)
      // A HUMAN in the conversation is what makes the agent→agent hop budget recover, and it is
      // the only thing that does — the alternative would be a timer, i.e. a chain that becomes
      // legitimate again by waiting. Whoever you just addressed starts a fresh chain.
      if (rec.toRoleId) deliveryStateRef.current = resetChainFor(deliveryStateRef.current, rec.toRoleId)
      logDispatch(projectId, {
        id: crypto.randomUUID(), at,
        fromHuman: true, toRoleId: rec.toRoleId, task: rec.task, outcome: rec.outcome,
        ...(rec.groupId ? { groupId: rec.groupId } : {}),
      })
    }
    const delivered = plan.records.filter((r) => r.outcome === 'sent').length
    return { ok: true as const, delivered, skipped: plan.skipped.map((r) => r.name) }
  }, [logDispatch])

  /** Clear EVERY per-lane model/effort pin across every project, so the global defaults win.
   *
   *  Distinct from the hydrate migration, which only clears fields that match their preset. This is
   *  the harder case — a user who really did pin models per project and has changed their mind — so
   *  it is explicit, confirmed in the UI with a named count, and backed up first. A failed backup
   *  ABORTS: there is no undo for this other than the file it copies. */
  const resetPinnedRoleFields = useCallback(async () => {
    const before = projectsRef.current
    const counts = pinnedFieldCounts(before)
    if (!counts.fields) return
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const at = await window.operator.backupProjects?.(stamp)
      setProjects(clearAllPinnedRoleFields(before))
      pushToast({
        text: `Cleared ${counts.fields} pinned setting${counts.fields === 1 ? '' : 's'} on ${counts.lanes} lane${counts.lanes === 1 ? '' : 's'}`,
        kind: 'info',
        detail: at ? `Every lane now inherits your Agents defaults. Backup: ${at}` : 'Every lane now inherits your Agents defaults.',
      })
    } catch (e) {
      pushToast({ text: 'Nothing was changed', kind: 'error', detail: `projects.json could not be backed up, so the pins were left alone. ${String(e)}` })
    }
  }, [pushToast])

  /** Decline it. Terminal: `rejected` never delivers, and nothing reads it as pending again. */
  const rejectDispatch = useCallback((projectId: string, id: string) => {
    const project = projectsRef.current.find((p) => p.id === projectId)
    const rec = project?.dispatches?.find((x) => x.id === id)
    if (!rec || rec.outcome !== 'pending-approval') return
    setDispatchOutcome(projectId, id, 'rejected')
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
        const reconciled = renamed.map(clearSeededRoleFields)
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
    })
      .catch(() => { /* no re-attach */ })
      .finally(() => setReattachDone(true))
  }, [savedHydrated, savedSessions])

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
        const path = await join(await homeDir(), '.operator', 'backups', `sessions.json.${stamp}`)
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

  const handleLaunchSession = useCallback(async (cwd: string, config: SessionConfig, opts?: { roleId?: string; orchestrationNote?: string; focus?: boolean }): Promise<TerminalTab[]> => {
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
    const settings = resolveAgentConfig(role, roleDefaultsRef.current, project.defaults)
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
      { roleId: role.id, orchestrationNote: note, focus: opts?.focus },
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
      setActiveProjectId(project.id)
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
        void handleLaunchRole(project, role) // picks up its queue
      }
    }
  }, [terminals, dispatchToRole, handleLaunchRole, markTasksRunning, updateProject, assignProjectTask, pushToast])

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

    // Same reply-scoping stamp as the launch path.
    launchOptions.projectId = saved.projectId ?? proj.id

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
    setActiveProjectId(tab.projectId ?? null) // restoring focuses the session → scope follows it
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
        // `result?.ok` — an unexpected answer became an unhandled rejection here, and with
        // worktrees now a global default this path runs on every close of a writing lane.
        if (!result?.ok) console.warn('Worktree removal failed:', result?.error ?? 'no result')
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
  handleCloseSessionRef.current = handleCloseSession

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
    const operatorFields = { projectId: t.projectId, roleId: t.roleId, savedKey: t.key, model: t.model, effortLevel: t.effortLevel }
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

  // The scoped world: with navigation now project-first, the sidebar, ⌘1-9 and the rail all
  // read from THIS list — the live sessions of the project you're in — so the numbers on the
  // rows are the numbers the shortcuts use (spec §4 rule 4). Legacy sessions carry no
  // projectId and so belong to no scope; they stay reachable from the gallery's activity view.
  const activeProject = useMemo(
    () => (activeProjectId ? projects.find((p) => p.id === activeProjectId) ?? null : null),
    [activeProjectId, projects],
  )
  /** Who can be named as the author of a reply.
   *
   *  Keyed by the CLAUDE session id, which is what a reply carries. Live sessions first (freshest
   *  roleId), then the DURABLE saved-session store — that second half is the fix: the channel
   *  renders history, and a list built from this run's ptys can only ever name lanes that happen
   *  to be running right now. Every older reply fell through to its raw uuid. */
  const channelSessions = useMemo(() => [
    ...allSidebarSessions.map((x) => ({ id: x.id, roleId: x.roleId })),
    ...savedSessions
      .filter((s) => s.claudeSessionId)
      .map((s) => ({ id: s.claudeSessionId as string, roleId: s.roleId })),
  ], [allSidebarSessions, savedSessions])

  const scopedSessions = useMemo(
    () => (activeProjectId ? allSidebarSessions.filter((s) => s.projectId === activeProjectId) : []),
    [allSidebarSessions, activeProjectId],
  )
  /** Unread = entries newer than this project's lastReadAt. Computed from the SAME merge the view
   *  renders, so the badge can never disagree with the feed. */
  const channelUnread = useMemo(() => {
    if (!activeProject) return 0
    const feed = buildChannelFeed(activeProject.dispatches, channelReplies, activeProject.roster,
      channelSessions)
    return unreadEntries(feed, channelReadAt[activeProject.id] ?? null).length
  }, [activeProject, channelReplies, channelSessions, channelReadAt])

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
  // Which digest row is open in the channel panel's Message tab. Kept here rather than in
  // ProjectChannel because the panel is a sibling in the shell's slot, not a child of the feed.
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null)
  // Resolved from the same feed the rows come from, so a selection that scrolls out of the store
  // (or whose project changed) simply stops resolving and the panel falls back to Project.
  const selectedChannelEntry = useMemo(() => {
    if (!selectedChannelId || !activeProject) return undefined
    return buildChannelFeed(activeProject.dispatches, channelReplies, activeProject.roster, channelSessions)
      .find((e) => e.id === selectedChannelId)
  }, [selectedChannelId, activeProject, channelReplies, channelSessions])

  const handleReorderProject = useCallback((draggedId: string, targetId: string, edge: 'before' | 'after') => {
    setProjects((prev) => reorderRail(prev, draggedId, targetId, edge))
  }, [])

  const handleReorderLane = useCallback((draggedRoleId: string, targetRoleId: string, edge: 'before' | 'after') => {
    if (!activeProjectId) return
    updateProject(activeProjectId, (p) => ({ roster: reorderRoles(p.roster ?? [], draggedRoleId, targetRoleId, edge) }))
  }, [activeProjectId, updateProject])

  // --- Agent colour --------------------------------------------------------------------
  // A lane's colour belongs to its Role (roster = source of truth, so every surface
  // recolours together). A session with NO lane keeps a per-session override, keyed by the
  // stable saved key rather than the per-run session id.
  const [sessionAccents, setSessionAccents] = useState<Record<string, string>>(() => loadSessionAccents())
  const [accentPicker, setAccentPicker] = useState<{ sessionId: string; top: number; left: number } | null>(null)

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

  // The sidebar's count is of the project you're IN, matching the list above it.
  const sidebarStats = useMemo(() => ({
    activeSessions: scopedSessions.filter((s) => s.status === 'active').length,
  }), [scopedSessions])

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

  // (No roster "top-up" migration here: a trimmed roster must never regrow. The one-time
  // backfill that added Review/Design/QA to pre-existing rosters has already run on real
  // data, and new projects seed the full defaultRoster() at creation — see upsertProject,
  // and RosterPanel's seed-if-absent for a project that somehow has none.)

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
        const active = allSidebarSessions.find((s) => s.id === activeSessionId)
        if (active && active.terminalId && localTerminalIds.has(active.terminalId)) {
          e.preventDefault()
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
      const path = await join(await homeDir(), '.operator', 'terminal-dumps', `${shortId}-${shortTid}-${ts}.txt`)
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
  const contentMode: 'folderPrefs' | 'globalPrefs' | 'agents' | 'prefs' | 'localTerminal' | 'channel' | 'project' | 'gallery' = useMemo(() => {
    if (prefsViewActive) return 'prefs'
    if (agentsViewActive) return 'agents'
    if (globalPrefsActive) return 'globalPrefs'
    if (activeFolderPrefs) return 'folderPrefs'
    // Only 'localTerminal' if the active id still refers to a live terminal — a
    // stale activeTerminalId (e.g. left set after its tab was removed) would
    // otherwise render neither the terminal container (needs terminals.length>0)
    // nor the gallery, i.e. a blank screen.
    if (activeTerminalId && terminals.some((t) => t.id === activeTerminalId)) return 'localTerminal'
    // Inside a project with no session focused → Project Home. (The old `splash` mode is
    // gone: with no scope it's the gallery, with scope it's the project.)
    // The channel outranks Project Home but not a focused session: opening a lane from the
    // channel should show the lane, not bounce back to the feed.
    if (channelActive && activeProjectId && projects.some((p) => p.id === activeProjectId)) return 'channel'
    if (activeProjectId && projects.some((p) => p.id === activeProjectId)) return 'project'
    return 'gallery'
  }, [prefsViewActive, agentsViewActive, globalPrefsActive, activeFolderPrefs, activeTerminalId, terminals, channelActive, activeProjectId, projects])

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
          detail: `${modelFamilyLabel(role.model)}${role.useWorktree ? ' · worktree' : ''}`,
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

  return (
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
      {/* The left strip: the PERSISTENT project rail, then the collapsible sidebar beside it.
          They're grouped so the root's 8px gap falls between this pair and the content card,
          and the two strips stay flush — peers sharing the sidebar field, parted by a
          hairline. At the gallery the sidebar animates to 0 and the rail stays put, which is
          the entire point of it. */}
      <div style={{ display: 'flex', flexShrink: 0, height: '100%' }}>
      <ProjectRail
        projects={projects}
        activities={projectActivities}
        activeProjectId={contentMode === 'gallery' ? null : activeProjectId}
        onOpenProject={handleOpenProject}
        onShowGallery={handleShowGallery}
        onOpenFolder={handleNewSession}
        onOpenAgents={handleOpenAgents}
        agentsActive={contentMode === 'agents'}
        onReorder={handleReorderProject}
      />
      {/* Collapsible wrapper: animates width between the full sidebar (220) and
          the narrow quick-access rail (64). The RAIL now hosts the macOS traffic lights, so
          the content card never slides under them — including at the gallery, where this
          strip collapses to 0 and the gallery's own header reserves its own space (spec §2A). */}
      <div
        style={{
          width: contentMode === 'gallery' ? 0 : sidebarCollapsed ? 64 : 220,
          flexShrink: 0,
          overflow: 'hidden',
          transition: 'width 260ms cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
      {contentMode === 'gallery' ? null : sidebarCollapsed ? (
        <SidebarRail
          project={activeProject}
          sessions={scopedSessions}
          projects={projects}
          activeSessionId={activeSessionId}
          customNames={customNames}
          shortcutIndices={shortcutIndices}
          onSelectSession={handleSelectSession}
          onNewSession={handleNewSession}
          onExpand={toggleSidebar}
          onShowGallery={handleShowGallery}
          accentOf={accentOf}
          onPickAccent={(session, anchor) => setAccentPicker({ sessionId: session.id, ...anchor })}
        />
      ) : (
      <Sidebar
        project={activeProject}
        sessions={scopedSessions}
        onRestoreProject={restoreProject}
        onOpenChannel={() => { setChannelActive(true); setActiveSessionId(null); setActiveTerminalId(null) }}
        channelActive={contentMode === 'channel'}
        channelUnread={channelUnread}
        onOpenProjectHome={handleOpenProjectHome}
        projectHomeActive={contentMode === 'project'}
        activeSessionId={activeSessionId}
        customNames={customNames}
        activeFolderPrefs={activeFolderPrefs?.projectPath ?? null}
        globalPrefsActive={globalPrefsActive}
        prefsViewActive={prefsViewActive}
        effortLevels={effortLevels}
        fanInfo={fanInfo}
        shortcutIndices={shortcutIndices}
        stats={sidebarStats}
        isDark={currentTheme.isDark}
        onSelectSession={handleSelectSession}
        onRenameSession={handleRename}
        onCloseSession={handleCloseSession}
        onLaunchRole={(project, role) => { void handleLaunchRole(project, role) }}
        accentOf={accentOf}
        onPickAccent={(session, anchor) => setAccentPicker({ sessionId: session.id, ...anchor })}
        onReorderSession={handleReorderSession}
        onReorderLane={handleReorderLane}
        onOpenFolderPrefs={handleOpenFolderPrefs}
        onOpenGlobalPrefs={handleOpenGlobalPrefs}
        onOpenPrefs={handleOpenPrefs}
        onToggleTheme={handleToggleTheme}
        version={appVersion}
        update={availableUpdate}
        onInstallUpdate={() => { void window.operator.installUpdate() }}
      />
      )}
      </div>
      </div>

      <div data-term-focus-zone style={{
        position: 'relative', flex: 1,
        display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--bg-terminal)', borderRadius: 'var(--radius-lg)', overflow: 'hidden',
      }}>
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
            roleDefaults={roleDefaults}
            onPatchRoleDefault={patchRoleDefault}
            onResetPinnedRoleFields={resetPinnedRoleFields}
          />
          </AppShell>
        )}

        {contentMode === 'project' && activeProjectId && (() => {
          const proj = projects.find((p) => p.id === activeProjectId)
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
              tab={projectTab}
              onSelectTab={setProjectTab}
              onBack={handleShowGallery}
              onToggleSidebar={toggleSidebar}
              sidebarCollapsed={sidebarCollapsed}
              onUpdateProject={updateProject}
              onLaunchRole={(project, role, dev) => handleLaunchRole(project, role, undefined, dev)}
              liveRoles={live}
              laneSessions={laneSessions}
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
              // DispatchLog would render the pending row with nothing able to act on it.
              onApproveDispatch={approveDispatch}
              onRejectDispatch={rejectDispatch}
              roleDefaults={roleDefaults}
              resumableCount={restorableSessions.filter((s) => s.projectId === proj.id).length}
              onResumeProject={() => { void handleResumeProject(proj.id) }}
            />
          )
        })()}

        {contentMode === 'channel' && activeProject && (
          <AppShell
            header={channelHeader({ project: activeProject, chatterPaused, onToggleChatter: toggleChatterPaused })}
            onToggleSidebar={toggleSidebar}
            sidebarCollapsed={sidebarCollapsed}
            /* The slot phase 1 built, now filled: the channel's panel is about the PROJECT, where a
               session's is about that session. Same slot, same geometry, different contents — which
               is why the shell lets a mode supply the panel rather than owning one.
               No status bar: the channel has no equivalent of the session's Terminal/Review verbs,
               and an empty-but-present bar is worse than none. */
            rightPanel={(
              <ChannelPanel
                project={activeProject}
                selected={selectedChannelEntry}
                onClearSelection={() => setSelectedChannelId(null)}
              />
            )}
          >
            <ProjectChannel
              project={activeProject}
              replies={channelReplies}
              sessions={channelSessions}
              onApproveDispatch={approveDispatch}
              onRejectDispatch={rejectDispatch}
              onMarkRead={markChannelRead}
              onSend={sendChannelMessage}
              chatterPaused={chatterPaused}
              onToggleChatter={toggleChatterPaused}
              selectedId={selectedChannelId ?? undefined}
              onSelectEntry={(e) => setSelectedChannelId(e.id)}
            />
          </AppShell>
        )}

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
                    role={roleOf(activeSession)}
                    customName={customNames[activeSession.id]}
                    accent={accentOf(activeSession)}
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

