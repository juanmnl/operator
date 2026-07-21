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

const now = new Date().toISOString()
const noop = () => {}
const unsub = () => () => {}

const PROJECT_ID = 'proj-operator'
const PROJECT_PATH = '/Users/dev/operator'

export const MOCK_PROJECTS = [
  {
    id: PROJECT_ID,
    path: PROJECT_PATH,
    name: 'operator',
    createdAt: now,
    lastActiveAt: now,
    checkCommand: 'npm test',
    roster: [
      { id: 'operator', name: 'Operator', model: 'fable', effort: 'normal', accent: '#c98bff', prompt: 'You are Operator, this project’s coordinator. Route each task to the best-suited lane.' },
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
]

const MOCK_TERMINALS = MOCK_SESSIONS.map((s) => ({
  id: s.terminalId!, pid: 0, cwd: PROJECT_PATH, command: 'claude', alive: true,
  devPort: s.terminalId === 't1' ? 1421 : undefined,
}))

// The re-attach path builds each TerminalTab from terminalList() joined against the
// SAVED sessions by terminal id — projectId/roleId come from here, not from the
// terminal. Without these the lanes lose their role, so the sidebar falls back to the
// summary and none of the lane colouring/coordinator behaviour can be exercised.
const MOCK_SAVED = MOCK_SESSIONS.map((s) => ({
  key: `key-${s.terminalId}`,
  cwd: PROJECT_PATH,
  projectName: 'operator',
  projectId: PROJECT_ID,
  roleId: s.roleId,
  model: s.model,
  effortLevel: s.effortLevel,
  claudeSessionId: s.id,
  terminalId: s.terminalId,
  lastActiveAt: now,
}))

export function installMockBridge() {
  // Seed the stores the renderer reads at boot so it lands on a populated UI.
  try {
    localStorage.setItem('operator.projects', JSON.stringify(MOCK_PROJECTS))
    localStorage.setItem('operator.savedSessions', JSON.stringify(MOCK_SAVED))
    localStorage.setItem('operator.customNames', JSON.stringify({ 's-op': 'Coordinator' }))
  } catch { /* ignore */ }

  const bridge: Record<string, unknown> = {
    // --- subscriptions: push the fixture once, then stay quiet -------------------
    onSessionUpdate: (cb: (s: AgentSession[]) => void) => { setTimeout(() => cb(MOCK_SESSIONS), 0); return () => {} },
    onOrchestratorDispatch: unsub(), onTerminalData: unsub(), onTerminalExit: unsub(),
    onGridUpdate: unsub(), onWindowResize: unsub(), onFileDrop: unsub(), onPreviewPick: unsub(),

    // --- reads ------------------------------------------------------------------
    getSessions: async () => MOCK_SESSIONS,
    chatHistory: async () => [],
    imageDataUrl: async () => '',
    terminalList: async () => MOCK_TERMINALS,
    terminalHistory: async () => '',
    getDevPorts: async () => ({ t1: 1421 }),
    // Two servers on the Code lane so the multi-server picker is exercised.
    sessionPorts: async (id: string) => (id === 't1' ? [1421, 5173] : []),
    loadSessions: async () => MOCK_SAVED,
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
    terminalSpawn: async () => { calls.push({ fn: 'terminalSpawn' }); return null },
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
  ;(window as unknown as { __calls: unknown[] }).__calls = calls
  ;(window as unknown as { operator: unknown }).operator = new Proxy(bridge, {
    get: (t, p: string) => (p in t ? t[p] : (...args: unknown[]) => { calls.push({ fn: p, args }); return Promise.resolve(undefined) }),
  })
}
