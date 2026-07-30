// QA-ONLY bridge for dev/qa-chat-regression.md: same shape as dev/mock-bridge.ts (lets the
// REAL App render in Playwright/WebKit), but wired to REAL data — the actual "operator"
// project's roster (from ~/.operator/projects.json) and two REAL chat.db histories (862
// genuine messages from a past operator-project session; a 114-message Research-lane
// session containing a real 10,268-char answer) — instead of the authored MOCK_* fixtures.
// Never bundled into the app; DEV-ONLY, throwaway, not committed.
import type { AgentSession } from '../src/shared/types'
import { deriveProjectId } from '../src/renderer/lib/project-id'
import realFixture from './qa-real-fixture.json'

const now = new Date().toISOString()
const noop = () => {}
const sub = (..._args: unknown[]) => () => {}

const PROJECT_PATH = realFixture.project.path
const PROJECT_ID = deriveProjectId(PROJECT_PATH)
if (PROJECT_ID !== realFixture.project.id) {
  console.warn('qa-real-bridge: derived project id does not match the real one', PROJECT_ID, realFixture.project.id)
}

const REAL_PROJECT = {
  ...realFixture.project,
  id: PROJECT_ID,
  tasks: [],
  dispatches: [],
}

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

// Two real sessions: the long real history, and the real big-message session (used as the
// LIVE one for orb/interrupt driving since it has a real roleId/model/effort).
const [LONG, BIG] = realFixture.sessions
export const MOCK_SESSIONS: AgentSession[] = [
  session({ id: LONG.id, terminalId: LONG.terminalId, phase: 'idle', summary: LONG.summary }),
  session({
    id: BIG.id, terminalId: BIG.terminalId, roleId: BIG.roleId, model: BIG.model,
    effortLevel: BIG.effortLevel as 'high' | 'normal' | 'low' | undefined,
    phase: 'idle', summary: BIG.summary,
  }),
]

const MOCK_TERMINALS = MOCK_SESSIONS.map((s) => ({
  id: s.terminalId!, pid: 0, cwd: s.workingDirectory, command: 'claude', alive: true,
}))

const MOCK_SAVED = MOCK_SESSIONS.map((s) => ({
  key: `key-${s.terminalId}`,
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

const CHAT_BY_ID: Record<string, unknown[]> = Object.fromEntries(
  realFixture.sessions.map((s) => [s.id, s.messages]),
)

export function installRealBridge() {
  try {
    localStorage.setItem('operator.projects', JSON.stringify([REAL_PROJECT]))
    localStorage.setItem('operator.savedSessions', JSON.stringify(MOCK_SAVED))
  } catch { /* quota */ }

  let dispatchCb: ((d: unknown) => void) | null = null
  const calls: Array<Record<string, unknown>> = []

  const bridge: Record<string, unknown> = {
    onSessionUpdate: (cb: (s: AgentSession[]) => void) => {
      setTimeout(() => cb(MOCK_SESSIONS), 0)
      ;(window as unknown as { __mockPhase: unknown }).__mockPhase = (id: string, patch: Partial<AgentSession>) => {
        cb(MOCK_SESSIONS.map((x) => (x.id === id ? { ...x, ...patch } : x)))
      }
      return () => {}
    },
    onOrchestratorDispatch: (cb: (d: unknown) => void) => { dispatchCb = cb; return () => { dispatchCb = null } },
    onTerminalData: sub, onTerminalExit: sub,
    onGridUpdate: sub, onWindowResize: sub, onFileDrop: sub, onPreviewPick: sub,

    getSessions: async () => MOCK_SESSIONS,
    chatHistory: async (id: string) => CHAT_BY_ID[id] ?? [],
    imageDataUrl: async () => '',
    terminalList: async () => MOCK_TERMINALS,
    terminalHistory: async () => '',
    getDevPorts: async () => ({}),
    sessionPorts: async () => [],
    loadSessions: async () => MOCK_SAVED,
    loadProjects: async () => [REAL_PROJECT],
    agentsList: async () => [],
    getUsageStats: async () => ({ totalCost: 0, totalTokens: 0, days: [], projects: [], models: [] }),
    getUsageInsights: async () => ({ busiestHour: 0, streakDays: 0, topProject: null, hourly: [], weekday: [] }),
    getVersion: async () => '0.9.1-qa-real',
    checkUpdate: async () => null,
    folderPrefsLoad: async () => ({ projectPath: PROJECT_PATH, projectName: 'operator', settingsFiles: [], mdFiles: [] }),
    folderPrefsLoadGlobal: async () => ({ projectPath: '~/.claude', projectName: 'Global', settingsFiles: [], mdFiles: [] }),
    getMcpServers: async () => ({ servers: [], error: null }),
    inspectRepo: async () => ({ isRepo: true, root: PROJECT_PATH, branch: 'main', dirty: false }),
    worktreeStatus: async () => ({ exists: false }),
    worktreeDiff: async () => ({ files: [], insertions: 0, deletions: 0 }),
    branchDiff: async () => ({ files: [], insertions: 0, deletions: 0 }),
    moodboardList: async () => [],
    projectAssetDir: async () => '/tmp/qa-real',
    pickFolder: async () => PROJECT_PATH,

    terminalWrite: (id: string, data: string) => { calls.push({ fn: 'terminalWrite', id, data, at: Date.now() }) },
    terminalSpawn: async (cwd: string, opts?: unknown) => {
      calls.push({ fn: 'terminalSpawn', cwd, opts })
      return { terminalId: `tm${Math.random()}`, cwd }
    },
    runCheck: async () => ({ ok: true, output: 'qa-real: checks green' }),
    saveSessions: noop, saveProjects: noop, setActiveSession: noop, rendererHeartbeat: noop,
    showMainWindow: noop, startWindowDrag: noop, toggleWindowMaximize: noop, quitApp: noop,
    growWindowWidth: noop, openExternal: noop, revealPath: async () => {}, setDockIcon: noop, terminalStart: noop,
    terminalResize: noop, terminalKill: async () => {}, shellSpawn: async () => 'sh0',
    gridtermAttach: noop, gridtermResize: noop, gridtermScroll: noop, gridtermSetTheme: noop, gridtermDetach: noop,
    previewInspectOpen: async () => {}, previewInspectMove: noop, previewInspectClose: noop,
    installUpdate: async () => {}, savePastedImage: async () => '/tmp/x.png',
  }

  ;(window as unknown as { __calls: unknown[] }).__calls = calls
  ;(window as unknown as { __mockDispatch: unknown }).__mockDispatch = (d: unknown) => dispatchCb?.(d)
  ;(window as unknown as { operator: unknown }).operator = new Proxy(bridge, {
    get: (t, p: string) => (p in t ? t[p] : (...args: unknown[]) => { calls.push({ fn: p, args }); return Promise.resolve(undefined) }),
  })
}
