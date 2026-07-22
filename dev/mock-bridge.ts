// A fake `window.operator` so the REAL renderer boots in a plain browser.
//
// Why: the Tauri shell can't be driven here — a second dev instance fights the
// installed app, and the OS grants Operator only screenshot-level access, so no
// clicks or keystrokes. This mock lets the actual App render in Playwright/WebKit
// where the harness has full control (click, type, ⌘K) and can screenshot the
// result, making UI changes verifiable instead of merely compiled.
//
// It is DEV-ONLY: reached solely through dev/mock.html, never bundled into the app
// (src/tauri-main.tsx installs the real bridge). Fixtures are deliberately shaped to
// exercise the interesting states — several lanes in one project, a live and an
// ENDED lane, a queued backlog, multi-port preview.
import type { AgentSession } from '../src/shared/types'
import { deriveProjectId } from '../src/renderer/lib/project-id'

const now = new Date().toISOString()
const noop = () => {}
// Subscription stub: SUBSCRIBING (calling with a callback) returns a working
// unsubscribe. Use as `onX: sub` — NOT `sub()`, which would make unmount cleanup
// call undefined and throw (the close-all teardown errors of 2026-07-21).
const sub = (..._args: unknown[]) => () => {}

const PROJECT_PATH = '/Users/dev/operator'
// MUST match what resolveProject derives for PROJECT_PATH, or a session launched at
// runtime (auto-launch, resume) lands in a DIFFERENT sidebar group than the fixture
// sessions — an invented id split the group in two during dispatch driving (2026-07-21).
const PROJECT_ID = deriveProjectId(PROJECT_PATH)

// A second project with NO live sessions, so the sidebar's "Recent" list (projects the
// live groups don't already cover) renders and its rows are clickable in the harness.
const DORMANT_PATH = '/Users/dev/uwazi_app'
const DORMANT_ID = deriveProjectId(DORMANT_PATH)
// Older than `now` so the sort order (lastActiveAt desc) is actually exercised.
const earlier = new Date(Date.parse(now) - 36e5).toISOString()

// A SECOND project with a LIVE session, so the dashboard's per-project grouping has more
// than one group to draw (and the sidebar more than one live cluster). Kept separate from
// the dormant project above, which the Recent list depends on having nothing running.
const SECOND_PATH = '/Users/dev/el-encanto'
const SECOND_ID = deriveProjectId(SECOND_PATH)

// Operator's injected dev-server preamble, verbatim, glued to the real task exactly as a
// launch prompt builds it. The transcript summarises a session by this first prompt, so
// without lib/session-label's cleaner every such row reads as the instruction, not the work.
const DEV_PREAMBLE = "First, start this project's dev server in the BACKGROUND on the port Operator reserved for you (named in your system prompt — pass it via --port or the PORT env), and don't block the terminal on it."

export const MOCK_PROJECTS = [
  {
    id: PROJECT_ID,
    path: PROJECT_PATH,
    name: 'operator',
    createdAt: now,
    lastActiveAt: now,
    checkCommand: 'npm test',
    roster: [
      { id: 'operator', name: 'Operator', model: 'fable', effort: 'normal', accent: '#c98bff', prompt: 'You are Operator — you operate this project. Route each task to the best-suited lane.' },
      { id: 'research', name: 'Research', model: 'sonnet', effort: 'high', accent: '#5ac8fa', prompt: 'Investigate and report — never change code.' },
      { id: 'code', name: 'Code', model: 'opus', effort: 'high', accent: '#7ee787', useWorktree: true, prompt: 'Implement the task, nothing more.' },
      { id: 'design', name: 'Design', model: 'opus', effort: 'normal', accent: '#ff7ac6', prompt: 'Own UI/UX quality. Reuse the design system.' },
    ],
    tasks: [
      { id: 'task-1', text: 'Fix the login button alignment on mobile', roleId: 'design', status: 'queued', createdAt: now },
      { id: 'task-2', text: 'Why does the settings list render slowly?', roleId: 'research', status: 'queued', createdAt: now },
      { id: 'task-3', text: 'Extract the dispatch router', roleId: 'code', status: 'running', terminalId: 't1', cwd: PROJECT_PATH, createdAt: now, startedAt: now },
    ],
    dispatches: [],
  },
  {
    id: DORMANT_ID,
    path: DORMANT_PATH,
    name: 'uwazi_app',
    createdAt: earlier,
    lastActiveAt: earlier,
    roster: [
      { id: 'operator', name: 'Operator', model: 'fable', effort: 'normal', accent: '#c98bff' },
      { id: 'code', name: 'Code', model: 'opus', effort: 'high' },
    ],
    tasks: [],
    dispatches: [],
  },
  {
    id: SECOND_ID,
    path: SECOND_PATH,
    name: 'el-encanto',
    createdAt: earlier,
    lastActiveAt: now,
    roster: [{ id: 'code', name: 'Code', model: 'opus', effort: 'high', accent: '#7ee787' }],
    tasks: [],
    dispatches: [],
  },
]

const session = (o: Partial<AgentSession> & { id: string; terminalId: string }): AgentSession => ({
  agentId: 'claude-code',
  workingDirectory: PROJECT_PATH,
  projectName: 'operator',
  projectId: PROJECT_ID,
  status: 'active',
  phase: 'idle',
  activity: [],
  activeSubagents: 0,
  lastToolName: null,
  startedAt: now,
  lastActivityAt: now,
  ...o,
} as AgentSession)

export const MOCK_SESSIONS: AgentSession[] = [
  session({ id: 's-op', terminalId: 't0', roleId: 'operator', model: 'fable', phase: 'waiting', summary: 'Coordinate the mobile fixes' }),
  session({ id: 's-code', terminalId: 't1', roleId: 'code', model: 'opus', phase: 'running', summary: 'Extract the dispatch router',
    todos: [{ content: 'Extract routeDispatch into lib/dispatch', status: 'in_progress' }, { content: 'Add unit tests', status: 'pending' }],
    usage: { input: 41200, output: 8300, cacheRead: 120400 } }),
  session({ id: 's-res', terminalId: 't2', roleId: 'research', model: 'sonnet', phase: 'compacting', summary: 'Profile the settings list' }),
  // Second project, no lane (so the label ladder falls through to the summary) and a
  // summary that opens with the dev-server preamble — the row must read "Wire up the
  // booking form", never the instruction.
  session({
    id: 's-enc', terminalId: 't3', model: 'sonnet', phase: 'running',
    workingDirectory: SECOND_PATH, projectName: 'el-encanto', projectId: SECOND_ID,
    summary: `${DEV_PREAMBLE}\n\nWire up the booking form`,
  }),
]

const MOCK_TERMINALS = MOCK_SESSIONS.map((s) => ({
  id: s.terminalId!, pid: 0, cwd: s.workingDirectory, command: 'claude', alive: true,
  devPort: s.terminalId === 't1' ? 1421 : undefined,
}))

// The re-attach path builds each TerminalTab from terminalList() joined against the
// SAVED sessions by terminal id — projectId/roleId come from here, not from the
// terminal. Without these the lanes lose their role, so the sidebar falls back to the
// summary and none of the lane colouring/coordinator behaviour can be exercised.
const MOCK_SAVED = MOCK_SESSIONS.map((s) => ({
  key: `key-${s.terminalId}`,
  // Per-session, NOT the first project's constants: the re-attach path reads the project
  // from here, so hardcoding would file the second project's agent under the first.
  cwd: s.workingDirectory,
  projectName: s.projectName,
  projectId: s.projectId,
  roleId: s.roleId,
  model: s.model,
  effortLevel: s.effortLevel,
  claudeSessionId: s.id,
  terminalId: s.terminalId,
  lastActiveAt: now,
}))

// Saved sessions with no live terminal. The sidebar no longer lists these (it lists
// Recent PROJECTS), but they still feed the dashboard splash, the ⌘K restore actions,
// and the workspace's "Resume N agents" — so the dormant project owns one of them.
const MOCK_DORMANT = [
  { key: 'key-old-1', cwd: DORMANT_PATH, projectName: 'uwazi_app', projectId: DORMANT_ID, claudeSessionId: 'old-1', lastActiveAt: earlier },
  { key: 'key-old-2', cwd: '/tmp/el-encanto', projectName: 'el-encanto', claudeSessionId: 'old-2', lastActiveAt: earlier },
]

export function installMockBridge() {
  // Seed the stores the renderer reads at boot so it lands on a populated UI.
  try {
    localStorage.setItem('operator.projects', JSON.stringify(MOCK_PROJECTS))
    localStorage.setItem('operator.savedSessions', JSON.stringify([...MOCK_SAVED, ...MOCK_DORMANT]))
    localStorage.setItem('operator.customNames', JSON.stringify({ 's-op': 'Coordinator' }))
  } catch { /* ignore */ }

  // The dispatch subscription is capturable so a driver can fire directives as if the
  // transcript tailer parsed them: `window.__mockDispatch({ id, terminalId, role, task })`.
  let dispatchCb: ((d: unknown) => void) | null = null

  const bridge: Record<string, unknown> = {
    // --- subscriptions: push the fixture once, then stay quiet -------------------
    onSessionUpdate: (cb: (s: AgentSession[]) => void) => { setTimeout(() => cb(MOCK_SESSIONS), 0); return () => {} },
    onOrchestratorDispatch: (cb: (d: unknown) => void) => { dispatchCb = cb; return () => { dispatchCb = null } },
    onTerminalData: sub, onTerminalExit: sub,
    onGridUpdate: sub, onWindowResize: sub, onFileDrop: sub, onPreviewPick: sub,

    // --- reads ------------------------------------------------------------------
    getSessions: async () => MOCK_SESSIONS,
    chatHistory: async () => [],
    imageDataUrl: async () => '',
    terminalList: async () => MOCK_TERMINALS,
    terminalHistory: async () => '',
    getDevPorts: async () => ({ t1: 1421 }),
    // Two servers on the Code lane so the multi-server picker is exercised.
    sessionPorts: async (id: string) => (id === 't1' ? [1421, 5173] : []),
    loadSessions: async () => [...MOCK_SAVED, ...MOCK_DORMANT],
    loadProjects: async () => MOCK_PROJECTS,
    agentsList: async () => [],
    getUsageStats: async () => ({ totalCost: 0, totalTokens: 0, days: [], projects: [], models: [] }),
    getUsageInsights: async () => ({ busiestHour: 0, streakDays: 0, topProject: null, hourly: [], weekday: [] }),
    getVersion: async () => '0.8.8-mock',
    checkUpdate: async () => null,
    folderPrefsLoad: async () => ({ projectPath: PROJECT_PATH, projectName: 'operator', settingsFiles: [], mdFiles: [] }),
    folderPrefsLoadGlobal: async () => ({ projectPath: '~/.claude', projectName: 'Global', settingsFiles: [], mdFiles: [] }),
    getMcpServers: async () => ({ servers: [], error: null }),
    inspectRepo: async () => ({ isRepo: true, root: PROJECT_PATH, branch: 'main', dirty: false }),
    worktreeStatus: async () => ({ exists: false }),
    worktreeDiff: async () => ({ files: [], insertions: 0, deletions: 0 }),
    branchDiff: async () => ({ files: [], insertions: 0, deletions: 0 }),
    moodboardList: async () => [],
    projectAssetDir: async () => '/tmp/mock',
    pickFolder: async () => PROJECT_PATH,

    // --- writes: recorded so the harness can assert what the UI attempted --------
    terminalWrite: (id: string, data: string) => { calls.push({ fn: 'terminalWrite', id, data }) },
    // Spawns return a real-ish tab so launch flows (auto-launch dispatch, project
    // resume) actually add a session row the driver can assert on.
    terminalSpawn: async (cwd: string, opts?: unknown) => {
      calls.push({ fn: 'terminalSpawn', cwd, opts })
      return { terminalId: `tm${spawnN++}`, cwd }
    },
    runCheck: async () => ({ ok: true, output: 'mock: checks green' }),
    saveSessions: noop, saveProjects: noop, setActiveSession: noop, rendererHeartbeat: noop,
    showMainWindow: noop, startWindowDrag: noop, toggleWindowMaximize: noop, quitApp: noop,
    growWindowWidth: noop, openExternal: noop, setDockIcon: noop, terminalStart: noop,
    terminalResize: noop, terminalKill: async () => {}, shellSpawn: async () => 'sh0',
    gridtermAttach: noop, gridtermResize: noop, gridtermScroll: noop, gridtermSetTheme: noop, gridtermDetach: noop,
    previewInspectOpen: async () => {}, previewInspectMove: noop, previewInspectClose: noop,
    installUpdate: async () => {}, savePastedImage: async () => '/tmp/x.png',
  }

  // Anything not explicitly mocked resolves to a harmless no-op, so a newly added
  // bridge method can't crash the harness before it's been taught about it.
  const calls: Array<Record<string, unknown>> = []
  let spawnN = 0
  ;(window as unknown as { __calls: unknown[] }).__calls = calls
  ;(window as unknown as { __mockDispatch: unknown }).__mockDispatch = (d: unknown) => dispatchCb?.(d)
  ;(window as unknown as { operator: unknown }).operator = new Proxy(bridge, {
    get: (t, p: string) => (p in t ? t[p] : (...args: unknown[]) => { calls.push({ fn: p, args }); return Promise.resolve(undefined) }),
  })
}
