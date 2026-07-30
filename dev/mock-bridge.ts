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
import type { AgentSession, Role } from '../src/shared/types'
import { deriveProjectId } from '../src/renderer/lib/project-id'
import { rolePresets } from '../src/renderer/lib/roster'

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
    // Deliberately longer than two lines, so the gallery card's clamp is exercised rather
    // than assumed — an unclamped note would set the height of every card in its grid row.
    contextNotes: 'Mission control for working agents — the Tauri desktop app that hosts Claude Code, shows every tool call live, and lets a roster of lanes work in parallel git worktrees. Ship signed releases from CI; never regenerate the updater key.',
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
      // STRANDED by a previous run: `t-dead` is a pty id from a backend run that is over, so
      // the completion matcher could never match it again. Startup reconciliation must close
      // it out (see lib/task-lifecycle) — without this fixture the harness can't see the bug.
      { id: 'task-4', text: 'Ship the release notes', roleId: 'code', status: 'running', terminalId: 't-dead', cwd: PROJECT_PATH, createdAt: earlier, startedAt: earlier },
      { id: 'task-5', text: 'Audit the colour tokens', roleId: 'design', status: 'running', terminalId: 't-dead', cwd: PROJECT_PATH, createdAt: earlier, startedAt: earlier },
      // Genuinely queued but UNASSIGNED — nothing routes these automatically; they must at
      // least be visible and assignable in the queue (brief defect 3).
      { id: 'task-6', text: 'Decide the pricing page copy', status: 'queued', createdAt: earlier },
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
    // A short one — the common case, and the check that a one-line note doesn't leave the
    // card's footer floating away from its neighbours'.
    contextNotes: 'Booking site for the restaurant. Astro + Sanity.',
    roster: [{ id: 'code', name: 'Code', model: 'opus', effort: 'high', accent: '#7ee787' }],
    tasks: [],
    dispatches: [],
  },
]

// ---- `?prune=1`: the one-time seeded-lane prune -----------------------------------------
//
// A separate project set, because the prune's whole question is "did the seeder write this, or
// did the user?" and MOCK_PROJECTS answers it by accident — its charters are shortened for
// readability, which reads as EDITED. A fixture that can only produce one verdict proves nothing,
// so this one carries the real charter strings (imported, not copied — a drifting copy would
// quietly stop matching) and spells out every case the predicate has to separate.
const stock = (id: string, over: Partial<Role> = {}): Role =>
  ({ ...(rolePresets().find((r) => r.id === id) as Role), ...over })

const PRUNE_PROJECT_ID = 'prune-demo-1'
const PRUNE_PROJECTS = [
  {
    id: PRUNE_PROJECT_ID,
    path: '/tmp/prune-demo',
    name: 'prune-demo',
    createdAt: earlier,
    lastActiveAt: earlier,
    // KEEP: launched once (a saved session names it). KEEP: a task, at any status. KEEP: the
    // user re-coloured it. KEEP: not a preset at all. DROP: the remaining two are untouched
    // and unused — one holding today's charter, one holding the retired pre-rename wording.
    roster: [
      stock('operator', { prompt: 'Coordinate — don’t implement. Break goals into small, verifiable tasks and hand each to the best-suited lane via OPERATOR-DISPATCH. Track what you delegated; when work comes back, check it against the goal and dispatch follow-ups for gaps. Prefer several precise dispatches over one vague one, and keep a running summary of who is doing what.' }),
      stock('research'),
      stock('code'),
      stock('review'),
      stock('design', { accent: '#00ffcc' }),
      { id: 'perf', name: 'Perf', model: 'sonnet', effort: 'high' } as Role,
    ],
    tasks: [{ id: 'pt-1', text: 'Read the diff', roleId: 'review', status: 'done', createdAt: earlier }],
    dispatches: [],
  },
]
// `?tz=1`: two dispatches whose UTC date and LOCAL date differ, for the timestamp fix
// (dev/briefs/channel-timestamps-utc.md). Fixed instants, because the whole bug is invisible in
// the afternoon: at UTC−5 both of these are the evening of the 30th locally while their UTC dates
// read the 30th and the 31st, so a slice files them under two different days.
const TZ_PROJECT_ID = 'tz-demo-1'
const TZ_PROJECTS = [
  {
    id: TZ_PROJECT_ID,
    path: '/tmp/tz-demo',
    name: 'tz-demo',
    createdAt: '2026-07-30T20:00:00.000Z',
    lastActiveAt: '2026-07-31T01:30:00.000Z',
    roster: rolePresets().filter((r) => r.id === 'operator' || r.id === 'code'),
    tasks: [],
    dispatches: [
      // 16:00 local on the 30th — UTC date still the 30th, so the old slice agreed by luck.
      { id: 'tz-a', at: '2026-07-30T21:00:00.000Z', fromRoleId: 'operator', toRoleId: 'code', task: 'Afternoon dispatch', outcome: 'sent' },
      // 20:30 local, still the 30th — but 01:30 UTC on the 31st. This is the one that broke.
      { id: 'tz-b', at: '2026-07-31T01:30:00.000Z', fromRoleId: 'operator', toRoleId: 'code', task: 'Evening dispatch', outcome: 'sent' },
    ],
  },
]

// `?solo=1`: a project exactly as one is BORN now — a single Operator lane (see
// DashboardView's upsertProject, and dev/briefs/operator-is-the-floor.md). It exists so the
// one-row AGENTS section can be looked at rather than assumed: that section is the user's whole
// view of their team, and "one row plus + Add agent" has to read as deliberate, not as broken.
const SOLO_PROJECTS = [
  {
    id: 'solo-demo-1',
    path: '/tmp/solo-demo',
    name: 'solo-demo',
    createdAt: now,
    lastActiveAt: now,
    roster: rolePresets().filter((r) => r.id === 'operator'),
    tasks: [],
    dispatches: [],
  },
]

const PRUNE_SAVED = [
  { key: 'key-prune-1', cwd: '/tmp/prune-demo', projectName: 'prune-demo', projectId: PRUNE_PROJECT_ID, roleId: 'code', claudeSessionId: 'prune-1', lastActiveAt: earlier },
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
  // Carries effortLevel + permissionMode so the SessionToolbar's right cluster renders in
  // full (MCP badge · effort · permission · panel toggle) — the alignment of those four is
  // otherwise unverifiable in the harness.
  session({ id: 's-code', terminalId: 't1', roleId: 'code', model: 'opus', phase: 'running', summary: 'Extract the dispatch router',
    effortLevel: 'high', permissionMode: 'bypassPermissions',
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

// Claude-file fixtures for the FolderPreferences tabs. Both scopes are present so the
// per-file SettingsFileTabBar has something to switch between, and each section has real
// rows to render rather than an empty state.
const MOCK_MD_FILES = [
  { path: '~/.claude/CLAUDE.md', label: 'CLAUDE.md', scope: 'global' as const, exists: true,
    content: '# Global notes\n\nPrefer small, reviewable diffs.\n' },
  { path: `${PROJECT_PATH}/CLAUDE.md`, label: 'CLAUDE.md', scope: 'project' as const, exists: true,
    content: '# operator\n\nTranscript-driven; no hook. Read the Obsidian hub before starting.\n' },
]

const MOCK_SETTINGS_FILES = [
  {
    path: '~/.claude/settings.json', label: 'settings.json', scope: 'global' as const,
    readOnly: false, exists: true,
    settings: {
      permissions: { allow: ['Bash(npm test)', 'Read(**)'], deny: ['Bash(rm -rf *)'], ask: [] },
      effortLevel: 'high' as const,
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }] },
      enabledPlugins: { 'some-plugin@marketplace': true },
    },
  },
  {
    path: `${PROJECT_PATH}/.claude/settings.json`, label: 'settings.json', scope: 'project' as const,
    readOnly: false, exists: true,
    settings: {
      permissions: { allow: ['Bash(cargo build)'], deny: [], ask: ['Bash(git push)'] },
      effortLevel: 'normal' as const,
    },
  },
]

const MOCK_AGENTS = [
  {
    name: 'code-reviewer', description: 'Review a diff for correctness and risk before it lands.',
    model: 'opus', tools: [], scope: 'user' as const, path: '~/.claude/agents/code-reviewer.md',
    prompt: 'Review the diff. Report only defects you can demonstrate.',
  },
  {
    name: 'doc-writer', description: 'Draft and update project documentation from the code.',
    model: 'sonnet', tools: [], scope: 'project' as const, projectPath: PROJECT_PATH,
    path: `${PROJECT_PATH}/.claude/agents/doc-writer.md`,
    prompt: 'Write docs that match what the code actually does.',
  },
]

// A transcript with the shapes that actually stress the reading surface: a long prose answer,
// fenced code, a bullet list, back-to-back short turns, and `thinking` blocks between them.
//
// THE THINKING ENTRIES ARE EMPTY ON PURPOSE — do not "fix" them by adding prose. Claude Code
// emits thinking blocks carrying a `signature` and no text; the reasoning is redacted at
// source. Measured across 326 real transcripts in ~/.claude/projects: 17,682 thinking blocks,
// 17,682 of them empty, zero with text. A fixture with prose in them is more generous than
// reality, and it validated a collapsible Thought block that could never open — which is
// exactly how that shipped. Fixtures must match what the pipeline really produces.
const t = (min: number) => new Date(Date.parse(now) - min * 60_000).toISOString()
const MOCK_CHAT = [
  { kind: 'user' as const, text: 'Extract the dispatch router out of DashboardView — it is 200 lines of routing inside a 2400-line component.', timestamp: t(42) },
  { kind: 'thinking' as const, text: '', timestamp: t(41) },
  { kind: 'text' as const, text: "I'll pull the routing into `lib/dispatch.ts`. The seam is the callback boundary: the effect stays in the view (it owns the subscription), but the decision — *which lane does this directive belong to* — becomes a pure function that takes the roster and the directive and returns a target.\n\nThat keeps the side effects where they already are and makes the interesting half testable.", timestamp: t(40) },
  { kind: 'user' as const, text: 'Does that cover the case where the named lane is not live yet?', timestamp: t(38) },
  { kind: 'thinking' as const, text: '', timestamp: t(37) },
  { kind: 'text' as const, text: "Not today — it silently drops them. Here's the shape I'd give it:\n\n```ts\nexport function routeDispatch(d: Directive, roster: Role[], live: Set<string>): Target {\n  const role = roster.find((r) => r.id === d.role)\n  if (!role) return { kind: 'unknown', role: d.role }\n  return live.has(role.id)\n    ? { kind: 'send', roleId: role.id }\n    : { kind: 'queue', roleId: role.id }\n}\n```\n\nSo a directive for a dormant lane becomes a **queued task** on that lane instead of vanishing. Three reasons that beats auto-launching:\n\n- launching is expensive and surprising — it spawns a pty and a worktree\n- the task board is already the place work waits\n- it is reversible: you can reassign a queued task, but you cannot un-spawn a session\n\nThe `unknown` case still needs a decision — drop it, or surface it as an unassigned task?", timestamp: t(36) },
  { kind: 'user' as const, text: 'Surface it. Unassigned.', timestamp: t(30) },
  { kind: 'text' as const, text: 'Done. `routeDispatch` now returns `{ kind: "queue", roleId: undefined }` for an unknown lane, and the queue renders it in the unassigned group.', timestamp: t(29) },
  { kind: 'user' as const, text: 'ok', timestamp: t(28) },
  { kind: 'user' as const, text: 'and add tests', timestamp: t(27) },
  { kind: 'text' as const, text: 'Added `lib/dispatch.test.ts` — six cases: known+live, known+dormant, unknown, empty roster, duplicate role ids, and a directive whose role name differs only by case.', timestamp: t(26) },
  // The four turns from the injected-turns report, verbatim (dev/briefs/chat-injected-turns.md).
  // The first three carry role "user" but nobody typed them — Claude Code's own plumbing —
  // and one of them ships raw SGR codes. Only 'hi' may render as a user turn. These stay in the
  // fixture on purpose: they are what chat.db ALREADY holds, so they exercise the renderer-side
  // guard that the backend fix can't reach.
  { kind: 'user' as const, text: '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages as the user did not type them.</local-command-caveat>', timestamp: t(3) },
  { kind: 'user' as const, text: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>', timestamp: t(3) },
  { kind: 'user' as const, text: '<local-command-stdout>Set model to \x1b[1mSonnet 5\x1b[22m and saved as your default.</local-command-stdout>', timestamp: t(2) },
  { kind: 'user' as const, text: 'hi', timestamp: t(1) },
  // Real tool_use/tool_result shapes (dev/briefs/structured-transcript-build.md). Measured over
  // 300 transcripts: `caller` is present on 100% of 30,699 calls, results are median 365 chars
  // with a 3.5MB max — so `output` here is ALREADY CAPPED at 2000, exactly as transcript.rs
  // stores it, and `outputChars` keeps the original length. Do not paste a full result in.
  { kind: 'tool' as const, text: 'Read src/renderer/lib/dispatch.ts', timestamp: t(20),
    tool: { name: 'Read', target: 'src/renderer/lib/dispatch.ts', caller: 'lead', id: 'tu_1', output: 'export function routeDispatch…', outputChars: 812 } },
  { kind: 'tool' as const, text: 'Read src/renderer/views/DashboardView.tsx', timestamp: t(20),
    tool: { name: 'Read', target: 'src/renderer/views/DashboardView.tsx', caller: 'lead', id: 'tu_2', output: 'import { useEffect }…', outputChars: 2400 } },
  { kind: 'tool' as const, text: 'Read src/shared/types.ts', timestamp: t(20),
    tool: { name: 'Read', target: 'src/shared/types.ts', caller: 'lead', id: 'tu_3', output: 'export interface AgentSession…', outputChars: 1200 } },
  // A different caller must NOT fold into the run above — this is the subagent mechanism.
  { kind: 'tool' as const, text: 'Grep useEffect', timestamp: t(19),
    tool: { name: 'Grep', target: 'useEffect', caller: 'subagent-research', id: 'tu_4', output: '42 matches', outputChars: 10 } },
  // An oversized result, stored the way the parser stores it: capped + marked.
  { kind: 'tool' as const, text: 'Bash npm test', timestamp: t(18),
    tool: { name: 'Bash', target: 'npm test', caller: 'lead', id: 'tu_5',
      output: 'x'.repeat(2000), outputChars: 71194, truncated: true } },
]

/** `?chat=long` synthesizes a REAL-LENGTH transcript (300 turns) on top of the fixture.
 *  A three-turn fixture answers none of the questions the feed animation raises: whether the
 *  virtualized canvas still paints smoothly per frame, and whether stick survives an animation
 *  on a document tall enough to have somewhere to scroll from. Shapes are the fixture's own. */
function longChat(base: typeof MOCK_CHAT) {
  const out = [...base]
  for (let i = 0; i < 300; i++) {
    out.push(i % 2 === 0
      ? { kind: 'user' as const, text: `Follow-up ${i}: what about the ${i % 3 === 0 ? 'worktree' : 'queue'} case?`, timestamp: t(300 - i) }
      : { kind: 'text' as const, text: `Answer ${i}. ${'The routing stays in the view; the decision becomes a pure function. '.repeat(1 + (i % 4))}`, timestamp: t(300 - i) })
  }
  return out
}

export function installMockBridge() {
  // `?empty=1` boots a VIRGIN app — no projects, no saved sessions, no live ptys — which is
  // the only way to see first-run states (the gallery's welcome splash) in the harness.
  const empty = new URLSearchParams(location.search).get('empty') === '1'
  // `?lost=1` strips the dormant project's path, which is the ONLY thing the gallery's
  // "folder not on record" card variant keys on (`lost = !project.path`). Without a flag
  // that state is unreachable in the harness — nothing in the UI can clear a path.
  const lost = new URLSearchParams(location.search).get('lost') === '1'
  if (lost) {
    const p = MOCK_PROJECTS.find((x) => x.id === DORMANT_ID)
    if (p) (p as { path: string }).path = ''
  }
  // `?prune=` swaps in PRUNE_PROJECTS, the fixture for the one-time seeded-lane migration.
  // `?prune=1` also CLEARS the flag saying it already ran, so the migration fires; any other
  // value keeps the flag, which is how a driver reloads the same fixture to prove the prune
  // does not run twice. Every boot WITHOUT the param marks the flag done, and that is the
  // point — the fixtures the rest of the harness relies on contain lanes the prune would
  // legitimately remove, so otherwise the first driver run of the day would quietly empty a
  // roster the next assertion expects to find.
  const pruneParam = new URLSearchParams(location.search).get('prune')
  const prune = pruneParam !== null
  // `?solo=1` — a project with exactly one Operator lane, the shape a new project now has.
  const solo = new URLSearchParams(location.search).get('solo') === '1'
  // `?tz=1` — fixed evening dispatches for the local-time fix.
  const tz = new URLSearchParams(location.search).get('tz') === '1'
  // `?worktree=` loads the role-defaults store as it stood BEFORE operator/research flipped on —
  // verbatim the six entries the real `~/.operator/role-defaults.json` held. `?worktree=1` also
  // clears the one-shot flag so the seed migration runs; any other value keeps it, which is how a
  // driver proves the migration does not fire twice. Boots without the param leave the store
  // EMPTY, which is the pre-existing behaviour every other driver was written against.
  const worktreeParam = new URLSearchParams(location.search).get('worktree')
  // `?empty=1` wins: a virgin install has no store, which is the case §6 of the driver checks.
  let roleDefaults: Record<string, unknown> = worktreeParam === null || empty ? {} : {
    code: { useWorktree: true },
    design: { useWorktree: true },
    operator: { useWorktree: false },
    qa: { useWorktree: false },
    research: { useWorktree: false },
    review: { useWorktree: false },
  }
  // Seed the stores the renderer reads at boot so it lands on a populated UI.
  try {
    if (empty) localStorage.clear()
    else {
      localStorage.setItem('operator.projects', JSON.stringify(tz ? TZ_PROJECTS : solo ? SOLO_PROJECTS : prune ? PRUNE_PROJECTS : MOCK_PROJECTS))
      localStorage.setItem('operator.savedSessions', JSON.stringify(solo || tz ? [] : prune ? PRUNE_SAVED : [...MOCK_SAVED, ...MOCK_DORMANT]))
      localStorage.setItem('operator.customNames', JSON.stringify({ 's-op': 'Coordinator' }))
    }
    if (pruneParam === '1') localStorage.removeItem('operator.seededLanePrunedAt')
    else if (!prune) localStorage.setItem('operator.seededLanePrunedAt', now)
    if (worktreeParam === '1') localStorage.removeItem('operator.worktreeSeedMigratedAt')
    else localStorage.setItem('operator.worktreeSeedMigratedAt', now)
  } catch { /* ignore */ }

  // The dispatch subscription is capturable so a driver can fire directives as if the
  // transcript tailer parsed them: `window.__mockDispatch({ id, terminalId, role, task })`.
  let dispatchCb: ((d: unknown) => void) | null = null
  // The reply half, same shape: `window.__mockReply({ id, sessionId, terminalId, projectId, to, text })`.
  let replyCb: ((r: unknown) => void) | null = null
  // chat.db's `replies` table, as the frontend sees it: read-only, project-scoped, and written
  // ONLY by the tailer. `__mockReply` mirrors the real ordering — the backend persists the row and
  // THEN emits (transcript.rs) — so a listener that re-reads the store can't race ahead of it.
  // Keyed by project rather than carrying a projectId field, because the real rows don't have one
  // (the store filters on a column the frontend never sees) — a fixture with an extra field is how
  // a consumer quietly starts depending on something reality won't give it.
  const replyRows = new Map<string, Array<Record<string, unknown>>>()
  // Declared before `bridge` so explicitly-mocked methods can record into it too.
  const calls: Array<Record<string, unknown>> = []

  const bridge: Record<string, unknown> = {
    // --- subscriptions: push the fixture once, then stay quiet -------------------
    // Capturable so a driver can push PHASE changes as the transcript tailer would:
    //   window.__mockPhase('s-code', { phase: 'waiting', lastToolName: null })
    // The chat liveness signals are a pure read of these fields, so this is the only lever a
    // harness needs to drive running / compacting / waiting / idle / ended.
    onSessionUpdate: (cb: (s: AgentSession[]) => void) => {
      setTimeout(() => cb(empty || solo || tz ? [] : MOCK_SESSIONS), 0)
      ;(window as unknown as { __mockPhase: unknown }).__mockPhase = (id: string, patch: Partial<AgentSession>) => {
        cb(MOCK_SESSIONS.map((x) => (x.id === id ? { ...x, ...patch } : x)))
      }
      // Append a turn the way the transcript tailer does, so a driver can watch the feed.
      const extra: unknown[] = []
      ;(window as unknown as { __mockAppend: unknown }).__mockAppend = (id: string, text: string) => {
        extra.push({ kind: 'text', text, timestamp: new Date().toISOString() })
        cb(MOCK_SESSIONS.map((x) => (x.id === id ? { ...x, messages: [...extra] } as AgentSession : x)))
      }
      // The USER half — what `transcript.rs` `apply_user` pushes when a real prompt commits, and
      // the only evidence the delivery loop accepts that a dispatch became a turn. Without it the
      // harness could watch a message go out but never watch it ARRIVE, which is the half that
      // was broken. Timestamped now, so it lands inside the submission's window.
      ;(window as unknown as { __mockUserTurn: unknown }).__mockUserTurn = (id: string, text: string) => {
        extra.push({ kind: 'user', text, timestamp: new Date().toISOString() })
        cb(MOCK_SESSIONS.map((x) => (x.id === id ? { ...x, messages: [...extra] } as AgentSession : x)))
      }
      return () => {}
    },
    onOrchestratorDispatch: (cb: (d: unknown) => void) => { dispatchCb = cb; return () => { dispatchCb = null } },
    onOrchestratorReply: (cb: (r: unknown) => void) => { replyCb = cb; return () => { replyCb = null } },
    onTerminalData: sub, onTerminalExit: sub,
    onGridUpdate: sub, onWindowResize: sub, onFileDrop: sub, onPreviewPick: sub,

    // --- reads ------------------------------------------------------------------
    getSessions: async () => (empty || solo || tz ? [] : MOCK_SESSIONS),
    // A real-shaped transcript so the chat view can be READ, not just compiled: alternating
    // turns, a long answer, code, a list, and signature-only (empty) `thinking` entries —
    // which is what Claude Code actually emits. See MOCK_CHAT's note: this fixture once
    // carried invented thinking PROSE, and that is what validated a disclosure control whose
    // body could never open.
    chatHistory: async (id: string) => {
      if (id !== 's-code') return []
      return new URLSearchParams(location.search).get('chat') === 'long' ? longChat(MOCK_CHAT) : MOCK_CHAT
    },
    imageDataUrl: async () => '',
    // Shape-exact with ChatStore::replies — including `id`, the content-hash PK a delivery
    // outcome is keyed to. A fixture missing it would let the feed's fold silently no-op.
    projectReplies: async (projectId: string) => replyRows.get(projectId) ?? [],
    terminalList: async () => (empty || solo || tz ? [] : MOCK_TERMINALS),
    terminalHistory: async () => '',
    getDevPorts: async () => ({ t1: 1421 }),
    // Two servers on the Code lane so the multi-server picker is exercised.
    sessionPorts: async (id: string) => (id === 't1' ? [1421, 5173] : []),
    loadSessions: async () => (empty || solo || tz ? [] : prune ? PRUNE_SAVED : [...MOCK_SAVED, ...MOCK_DORMANT]),
    loadProjects: async () => (empty ? [] : tz ? TZ_PROJECTS : solo ? SOLO_PROJECTS : prune ? PRUNE_PROJECTS : MOCK_PROJECTS),
    // The prune refuses to write without a backup, so the harness has to answer this or the
    // migration silently declines to run — the exact failure it is meant to demonstrate.
    backupProjects: async (stamp: string) => `projects.${stamp}.json`,
    // `~/.operator/role-defaults.json`, which the mock did not model at all — so the whole global
    // layer (and the seed that writes it) was unreachable from the harness, and `?worktree=`'s
    // migration could not be driven. Backed by a live object so a driver can read back what the
    // app persisted, exactly as `loadProjects`/`saveProjects` behave.
    loadRoleDefaults: async () => roleDefaults,
    saveRoleDefaults: (next: unknown) => {
      roleDefaults = next as Record<string, unknown>
      ;(window as unknown as { __roleDefaults?: unknown }).__roleDefaults = roleDefaults
    },
    // Two subagents so the library renders its list AND its editor pane (the Field labels
    // there are a second de-facto field-label style — an empty list hides them entirely).
    agentsList: async () => MOCK_AGENTS,
    getUsageStats: async () => ({ totalCost: 0, totalTokens: 0, days: [], projects: [], models: [] }),
    getUsageInsights: async () => ({ busiestHour: 0, streakDays: 0, topProject: null, hourly: [], weekday: [] }),
    // Shape-exact with `plan_limits`, values verbatim from this machine's `claude -p "/usage"`.
    // `?usage=` swaps the case: `none` = an account the CLI can't report on (which must render as
    // ABSENT, never 0%), `high` = past both colour thresholds.
    planLimits: async (force?: boolean) => {
      calls.push({ fn: 'planLimits', force })
      const mode = new URLSearchParams(location.search).get('usage')
      if (mode === 'none') {
        return { fetchedAt: new Date().toISOString(), note: "Couldn't find usage lines in the CLI's reply: You are using the Anthropic API with pay-as-you-go billing." }
      }
      const high = mode === 'high'
      // `?usage=expired` — THE REPORTED BUG (dev/briefs/plan-usage-stale.md): a reading whose own
      // reset clause has already passed. Built relative to now so it is always in the past, and
      // phrased the way the CLI phrases it. `?usage=aging` is merely past the TTL, which must
      // still SHOW its numbers — the two states have to be distinguishable on screen.
      const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
      // The reset clause has to be a real FUTURE time, phrased exactly as the CLI phrases it
      // ("Jul 30 at 8:30pm (America/Guayaquil)"). Hardcoding one was fine until the meter learned
      // to read it: a fixed date goes into the past overnight and every fixture then renders as a
      // closed window — a fixture more stale than reality, which validates nothing.
      const resetsIn = (hours: number) => {
        const d = new Date(Date.now() + hours * 3_600_000)
        const mon = d.toLocaleString('en-US', { month: 'short' })
        const hr = d.getHours() % 12 || 12
        const ampm = d.getHours() < 12 ? 'am' : 'pm'
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
        return `${mon} ${d.getDate()} at ${hr}:${String(d.getMinutes()).padStart(2, '0')}${ampm} (${zone})`
      }
      if (mode === 'expired') {
        return {
          sessionPct: 12,
          // Read 90 minutes ago, and the window it named closed an hour ago.
          sessionResets: 'in 30 minutes',
          weekPct: 40,
          weekResets: resetsIn(96),
          modelLabel: 'Fable', modelPct: 0, modelResets: resetsIn(96),
          plan: 'You are currently using your subscription to power your Claude Code usage',
          fetchedAt: ago(90 * 60_000),
        }
      }
      return {
        sessionPct: high ? 93 : 66,
        sessionResets: resetsIn(4),
        weekPct: high ? 78 : 39,
        weekResets: resetsIn(96),
        modelLabel: 'Fable',
        modelPct: 0,
        modelResets: resetsIn(96),
        plan: 'You are currently using your subscription to power your Claude Code usage',
        fetchedAt: mode === 'aging' ? ago(12 * 60_000) : new Date().toISOString(),
      }
    },
    getVersion: async () => '0.8.8-mock',
    checkUpdate: async () => null,
    // Populated, not empty: with `settingsFiles: []` every FolderPreferences tab renders its
    // "no settings file" empty state, so a theme/contrast sweep would measure blank pages and
    // report a false pass. These exercise the real editors (md cards, permission lists,
    // General's field labels, hook rows, plugin rows).
    folderPrefsLoad: async () => ({ projectPath: PROJECT_PATH, projectName: 'operator', settingsFiles: MOCK_SETTINGS_FILES, mdFiles: MOCK_MD_FILES }),
    folderPrefsLoadGlobal: async () => ({ projectPath: '~/.claude', projectName: 'Global', settingsFiles: MOCK_SETTINGS_FILES.filter((f) => f.scope.startsWith('global')), mdFiles: MOCK_MD_FILES.filter((f) => f.scope === 'global') }),
    getMcpServers: async () => ({
      servers: [
        { name: 'chrome-devtools', type: 'stdio', source: 'user' },
        { name: 'figma', type: 'http', source: 'project' },
      ],
      error: null,
    }),
    inspectRepo: async () => ({ isRepo: true, root: PROJECT_PATH, branch: 'main', dirty: false }),
    // Shape-exact with the real command's success branch: `{ path, branch, baseBranch }`. It used
    // to fall through the Proxy to `undefined`, and the launch path's `'error' in result` THREW on
    // that — so the moment worktrees became a global default, every launch in the harness aborted.
    worktreeCreate: async (cwd: string) => {
      calls.push({ fn: 'worktreeCreate', cwd })
      return { path: `${cwd}/.worktrees/mock`, branch: 'operator/mock', baseBranch: 'main' }
    },
    worktreeRemove: async (cwd: string, sourceCwd: string) => {
      calls.push({ fn: 'worktreeRemove', cwd, sourceCwd })
      return { ok: true }
    },
    worktreeStatus: async () => ({ exists: false }),
    worktreeDiff: async () => ({ files: [], insertions: 0, deletions: 0 }),
    branchDiff: async () => ({ files: [], insertions: 0, deletions: 0 }),
    moodboardList: async () => [],
    projectAssetDir: async () => '/tmp/mock',
    pickFolder: async () => PROJECT_PATH,

    // --- writes: recorded so the harness can assert what the UI attempted --------
    // `at` timestamps let a driver measure the SUBMIT TIMELINE (paste → watchdog CR),
    // which is what the long-message split in dev/briefs/ is diagnosed from.
    terminalWrite: (id: string, data: string) => { calls.push({ fn: 'terminalWrite', id, data, at: Date.now() }) },
    // Spawns return a real-ish tab so launch flows (auto-launch dispatch, project
    // resume) actually add a session row the driver can assert on.
    terminalSpawn: async (cwd: string, opts?: unknown) => {
      calls.push({ fn: 'terminalSpawn', cwd, opts })
      return { terminalId: `tm${spawnN++}`, cwd }
    },
    runCheck: async () => ({ ok: true, output: 'mock: checks green' }),
    saveSessions: noop, saveProjects: noop, setActiveSession: noop, rendererHeartbeat: noop,
    showMainWindow: noop, startWindowDrag: noop, toggleWindowMaximize: noop, quitApp: noop,
    growWindowWidth: noop, openExternal: noop, revealPath: async () => {}, setDockIcon: noop, terminalStart: noop,
    terminalResize: noop,
    // Recorded, not just no-op'd: __calls only captures methods that AREN'T explicitly mocked
    // (the Proxy fallback below), so an explicitly-mocked kill was invisible to drivers — a
    // close that worked read as a close that never fired. Anything a driver needs to assert
    // on must push to `calls` itself.
    terminalKill: async (id: string) => { calls.push({ fn: 'terminalKill', args: [id] }) },
    shellSpawn: async () => 'sh0',
    gridtermAttach: noop, gridtermResize: noop, gridtermScroll: noop, gridtermSetTheme: noop, gridtermDetach: noop,
    previewInspectOpen: async () => {}, previewInspectMove: noop, previewInspectClose: noop,
    installUpdate: async () => {}, savePastedImage: async () => '/tmp/x.png',
  }

  // Anything not explicitly mocked resolves to a harmless no-op, so a newly added
  // bridge method can't crash the harness before it's been taught about it.
  let spawnN = 0
  ;(window as unknown as { __calls: unknown[] }).__calls = calls
  ;(window as unknown as { __mockDispatch: unknown }).__mockDispatch = (d: unknown) => dispatchCb?.(d)
  ;(window as unknown as { __mockReply: unknown }).__mockReply = (r: Record<string, unknown>) => {
    // PERSIST, then emit — the order the tailer guarantees, and what the channel's re-read relies on.
    const pid = String(r.projectId ?? '')
    const rows = replyRows.get(pid) ?? []
    rows.push({
      id: r.id, sessionId: r.sessionId, to: r.to, text: r.text,
      timestamp: (r.timestamp as string) ?? new Date().toISOString(),
    })
    replyRows.set(pid, rows)
    replyCb?.(r)
  }
  ;(window as unknown as { operator: unknown }).operator = new Proxy(bridge, {
    get: (t, p: string) => (p in t ? t[p] : (...args: unknown[]) => { calls.push({ fn: p, args }); return Promise.resolve(undefined) }),
  })
}
