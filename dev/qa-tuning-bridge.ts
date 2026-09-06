// QA-ONLY bridge for dev/briefs/qa-2-simplify-batch.md item 2 — the Tuning page, driven with
// FULLY SYNTHETIC project/roster/usage data (never real chat.db or ~/.operator content, unlike
// dev/qa-real-bridge.ts — pass-1 QA leaked a real fixture into branch history once already, and
// this page needs no real data to exercise its four card cases). Same bridge shape as
// dev/mock-bridge.ts / dev/qa-real-bridge.ts so the real App renders in Playwright/WebKit.
// Never bundled into the app; DEV-ONLY, throwaway.
import type { Project, SavedSession, TuningData } from '../src/shared/types'

const noop = () => {}
const sub = (..._args: unknown[]) => () => {}

export const SYN_PROJECT: Project = {
  id: 'proj-qa-tuning',
  name: 'Acme',
  path: '/Users/qa/acme',
  createdAt: '2026-08-01T00:00:00.000Z',
  lastActiveAt: '2026-09-06T00:00:00.000Z',
  railOrder: 0,
  roster: [
    { id: 'code', name: 'Code', model: 'opus', effort: 'high', useWorktree: true, accent: '#7ee787', prompt: '' },
    { id: 'review', name: 'Review', model: 'opus', effort: 'medium', useWorktree: false, accent: '#ff9f45', prompt: '' },
  ],
  tasks: [],
  dispatches: [],
} as unknown as Project

const SAVED: SavedSession[] = [
  { key: 'k-code', cwd: '/Users/qa/acme', projectName: 'Acme', projectId: SYN_PROJECT.id, roleId: 'code', model: 'opus', effortLevel: 'high', claudeSessionId: 'sess-code-1', terminalId: 't-code-1', lastActiveAt: '2026-09-06T00:00:00.000Z' },
  { key: 'k-review', cwd: '/Users/qa/acme-review', projectName: 'Acme', projectId: SYN_PROJECT.id, roleId: 'review', model: 'opus', effortLevel: 'medium', claudeSessionId: 'sess-review-1', terminalId: 't-review-1', lastActiveAt: '2026-09-06T00:00:00.000Z' },
] as unknown as SavedSession[]

function session(o: Partial<TuningData['bySession'][number]> & { session: string; tokens: number }): TuningData['bySession'][number] {
  return {
    slug: '-Users-qa-unknown-project', model: 'sonnet', turns: 1, cost: o.tokens! / 20000,
    highContextTurns: 0, medianContext: 0, compactions: 0, reReadTokens: 0, droppedTokens: 0,
    firstTsMs: Date.parse('2026-09-01T00:00:00Z'), lastTsMs: Date.parse('2026-09-05T00:00:00Z'),
    ...o,
  }
}

const PLAN_LIMITS_WITH_DATA = { sessionPct: 12, weekPct: 42, weekResets: 'in 3 days', modelPct: 8, fetchedAt: new Date().toISOString() }

/** Case (a): top lane (Code, effort high) at 80% — above DOMINANT_SHARE with a step available
 *  (high -> medium). Includes a Not-attributed row and a lane with compactions/re-read/median
 *  context populated, so the Context pressure table has something other than dashes. */
const CASE_A: TuningData = {
  days: 7, totalTokens: 1_000_000, totalCost: 120, generatedAt: new Date().toISOString(),
  bySession: [
    session({ session: 'sess-code-1', slug: '-Users-qa-acme', model: 'opus', effort: 'high', tokens: 800_000, turns: 10, compactions: 3, reReadTokens: 50_000, highContextTurns: 2, medianContext: 120_000 }),
    session({ session: 'sess-review-1', slug: '-Users-qa-acme-review', model: 'opus', effort: 'medium', tokens: 150_000, turns: 5 }),
    session({ session: 'sess-unknown-1', slug: '-Users-someone-else-project', model: 'sonnet', effort: 'medium', tokens: 50_000, turns: 2 }),
  ],
  byEffort: [], toolOutput: [],
  byProject: [{ slug: '-Users-qa-acme', name: 'Acme', cost: 115, tokens: 950_000, messages: 15 }, { slug: '-Users-someone-else-project', name: 'someone-else-project', cost: 5, tokens: 50_000, messages: 2 }],
  byModel: [{ model: 'opus', inputTokens: 700_000, outputTokens: 200_000, cacheWriteTokens: 50_000, cacheReadTokens: 30_000, cost: 110, messages: 15 }],
}

/** Case (b): top lane (Code, 24%) is BELOW DOMINANT_SHARE — three attributed lanes close together
 *  plus a not-attributed slice, so no single lane dominates. */
const CASE_B: TuningData = {
  days: 7, totalTokens: 1_000_000, totalCost: 90, generatedAt: new Date().toISOString(),
  bySession: [
    session({ session: 'sess-code-1', slug: '-Users-qa-acme', model: 'opus', effort: 'medium', tokens: 240_000, turns: 8 }),
    session({ session: 'sess-review-1', slug: '-Users-qa-acme-review', model: 'opus', effort: 'medium', tokens: 230_000, turns: 7 }),
    session({ session: 'sess-third-1', slug: '-Users-qa-acme-third', model: 'sonnet', effort: 'medium', tokens: 230_000, turns: 7 }),
    session({ session: 'sess-unknown-1', slug: '-Users-someone-else-project', model: 'sonnet', effort: 'medium', tokens: 300_000, turns: 6 }),
  ],
  byEffort: [], toolOutput: [],
  byProject: [{ slug: '-Users-qa-acme', name: 'Acme', cost: 85, tokens: 700_000, messages: 22 }],
  byModel: [{ model: 'opus', inputTokens: 400_000, outputTokens: 60_000, cacheWriteTokens: 5_000, cacheReadTokens: 5_000, cost: 60, messages: 15 }],
}

/** Case (c): top lane (Code, 70%) is already at the bottom of the effort ladder (`low`) — no step
 *  down exists, so the card must say "already at Low effort" rather than a plain percentage. */
const CASE_C: TuningData = {
  days: 7, totalTokens: 1_000_000, totalCost: 60, generatedAt: new Date().toISOString(),
  bySession: [
    session({ session: 'sess-code-1', slug: '-Users-qa-acme', model: 'opus', effort: 'low', tokens: 700_000, turns: 12 }),
    session({ session: 'sess-review-1', slug: '-Users-qa-acme-review', model: 'opus', effort: 'medium', tokens: 200_000, turns: 4 }),
    session({ session: 'sess-unknown-1', slug: '-Users-someone-else-project', model: 'sonnet', effort: 'medium', tokens: 100_000, turns: 2 }),
  ],
  byEffort: [], toolOutput: [],
  byProject: [{ slug: '-Users-qa-acme', name: 'Acme', cost: 58, tokens: 900_000, messages: 16 }],
  byModel: [{ model: 'opus', inputTokens: 600_000, outputTokens: 80_000, cacheWriteTokens: 10_000, cacheReadTokens: 10_000, cost: 55, messages: 16 }],
}
// Code's roster pin is 'high' but the transcript ran at 'low' — override the pin for this case so
// the card's "already at Low" reasoning isn't muddied by an unrelated pin-vs-transcript mismatch.
const PROJECT_FOR_C: Project = { ...SYN_PROJECT, roster: SYN_PROJECT.roster.map((r) => (r.id === 'code' ? { ...r, effort: 'low' } : r)) } as Project

export const CASES: Record<string, { data: TuningData; project: Project; limits: unknown }> = {
  a: { data: CASE_A, project: SYN_PROJECT, limits: PLAN_LIMITS_WITH_DATA },
  b: { data: CASE_B, project: SYN_PROJECT, limits: PLAN_LIMITS_WITH_DATA },
  c: { data: CASE_C, project: PROJECT_FOR_C, limits: PLAN_LIMITS_WITH_DATA },
  // Case (d): plan reading absent — reuse (a)'s usage shape; the point of this case is the
  // ProjectShare section's "no reading" state, not the biggest-change card.
  d: { data: CASE_A, project: SYN_PROJECT, limits: {} },
}

export function installTuningBridge() {
  const params = new URLSearchParams(location.search)
  const which = params.get('case') || 'a'
  const chosen = CASES[which] ?? CASES.a

  try {
    localStorage.setItem('operator.projects', JSON.stringify([chosen.project]))
    localStorage.setItem('operator.savedSessions', JSON.stringify(SAVED))
  } catch { /* quota */ }

  const calls: Array<Record<string, unknown>> = []
  const bridge: Record<string, unknown> = {
    onSessionUpdate: (cb: (s: unknown[]) => void) => { setTimeout(() => cb([]), 0); return () => {} },
    onOrchestratorDispatch: sub, onTerminalData: sub, onTerminalExit: sub,
    onGridUpdate: sub, onWindowResize: sub, onFileDrop: sub, onPreviewPick: sub,

    getSessions: async () => [],
    terminalList: async () => [],
    terminalHistory: async () => '',
    getDevPorts: async () => ({}),
    sessionPorts: async () => [],
    loadSessions: async () => SAVED,
    loadProjects: async () => [chosen.project],
    agentsList: async () => [],
    getUsageStats: async () => ({ totalCost: 0, totalTokens: 0, apiMs: 0, wallMs: 0, byModel: [], byProject: [], byDay: [], generatedAt: new Date().toISOString() }),
    getUsageInsights: async () => ({ busiestHour: 0, streakDays: 0, topProject: null, hourly: [], weekday: [] }),
    getTuning: async (_days: number) => chosen.data,
    planLimits: async (_force?: boolean) => chosen.limits,
    getVersion: async () => '0.9.1-qa-tuning',
    checkUpdate: async () => null,
    folderPrefsLoad: async () => ({ projectPath: chosen.project.path, projectName: chosen.project.name, settingsFiles: [], mdFiles: [] }),
    folderPrefsLoadGlobal: async () => ({ projectPath: '~/.claude', projectName: 'Global', settingsFiles: [], mdFiles: [] }),
    getMcpServers: async () => ({ servers: [], error: null }),
    inspectRepo: async () => ({ isRepo: true, root: chosen.project.path, branch: 'main', dirty: false }),
    worktreeStatus: async () => ({ exists: false }),
    worktreeDiff: async () => ({ files: [], insertions: 0, deletions: 0 }),
    branchDiff: async () => ({ files: [], insertions: 0, deletions: 0 }),
    moodboardList: async () => [],
    projectAssetDir: async () => '/tmp/qa-tuning',
    pickFolder: async () => chosen.project.path,

    terminalWrite: (id: string, data: string) => { calls.push({ fn: 'terminalWrite', id, data, at: Date.now() }) },
    terminalSpawn: async (cwd: string, opts?: unknown) => { calls.push({ fn: 'terminalSpawn', cwd, opts }); return { terminalId: `tm${Math.random()}`, cwd } },
    runCheck: async () => ({ ok: true, output: 'qa-tuning: checks green' }),
    saveSessions: noop, saveProjects: noop, setActiveSession: noop, rendererHeartbeat: noop,
    showMainWindow: noop, startWindowDrag: noop, toggleWindowMaximize: noop, quitApp: noop,
    growWindowWidth: noop, openExternal: noop, revealPath: async () => {}, setDockIcon: noop, terminalStart: noop,
    terminalResize: noop, terminalKill: async () => {}, shellSpawn: async () => 'sh0',
    gridtermAttach: noop, gridtermResize: noop, gridtermScroll: noop, gridtermSetTheme: noop, gridtermDetach: noop,
    previewInspectOpen: async () => {}, previewInspectMove: noop, previewInspectClose: noop,
    installUpdate: async () => {}, savePastedImage: async () => '/tmp/x.png',
  }

  ;(window as unknown as { __calls: unknown[] }).__calls = calls
  ;(window as unknown as { operator: unknown }).operator = new Proxy(bridge, {
    get: (t, p: string) => (p in t ? t[p] : (...args: unknown[]) => { calls.push({ fn: p, args }); return Promise.resolve(undefined) }),
  })
}
