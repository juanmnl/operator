import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TaskBoard, LaneSignal } from '../src/renderer/components/session/TaskBoard'
import type { DispatchRecord, ProjectTask, Role } from '../src/shared/types'
import { applyTheme, themes, identities, themeKey, ThemeMode } from '../src/renderer/themes'
import '../src/renderer/styles.css'

// DEV-ONLY board harness. Mounts the REAL <TaskBoard> (not a copy) so what you see here is
// exactly what ships, across every theme identity × light/dark and every state the board has:
// full, empty, and the width breakpoints.
//
// FIXTURES ARE LIFTED FROM `~/.operator/projects.json`, NOT INVENTED. A mock more generous than
// reality has previously validated a feature that could not work, so every shape below is a real
// one from the `operator` project's store:
//   • task text runs to whole paragraphs (the longest queued task is ~700 chars) — that is why
//     the card clamps at three lines. A one-line fixture would have hidden it.
//   • roster ids/names/accents are the real six lanes.
//   • diffStat {added:479, files:7, removed:2} is a real captured stat.
//   • the held dispatch is the real `pending-approval` record, and the `paused` ones really do
//     carry a `replyId` (which is why the board filters those out — see partitionBoard).
//   • `check` is the ONE exception and is flagged as such: NO task in the real store has a
//     check object, so that chip is an unexercised path. It is included once, deliberately
//     marked, so the styling can be eyeballed — not to suggest the data flows today.

const ROLES: Role[] = [
  { id: 'operator', name: 'Operator', accent: '#c98bff' },
  { id: 'research', name: 'Research', accent: '#5ac8fa' },
  { id: 'design', name: 'Design', accent: '#ff7ac6' },
  { id: 'code', name: 'Code', accent: '#7ee787' },
  { id: 'review', name: 'Review', accent: '#ff9f45' },
  { id: 'qa', name: 'QA', accent: '#ffd43b' },
]

const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString()

const TASKS: ProjectTask[] = [
  // ── Backlog. Real queued text: a lane's report filed as a task, hundreds of chars long.
  {
    id: 'q1',
    createdAt: ago(31),
    text: 'review blocked: no review scope was ever dispatched to me — only task received was "start the dev server" (done: 1429 is up, pid 24527, another lane\'s process that won the race; my launch failed with EADDRINUSE and I left theirs alone). One real finding from that: the server is bound IPv6-only ([::1]:1429 per lsof), so 127.0.0.1:1429 returns connection-refused while localhost/[::1] returns 200 — anything hard-coding 127.0.0.1 will either see a dead port or think 1429 is free and collide.',
  },
  { id: 'q2', createdAt: ago(18), roleId: 'code', text: 'Delete the project channel — ~1,970 lines. Delegation becomes a row on the parent card.' },
  { id: 'q3', createdAt: ago(9), roleId: 'qa', text: 'Soak the terminal heal loop against a real garble sighting; dump the buffer per dev/garble-triage.md.' },
  { id: 'q4', createdAt: ago(4), text: 'One diff surface, rendered on the work item.' },

  // ── Running. The three lanes actually running right now, with real worktree provenance.
  {
    id: 'r1', status: 'running', roleId: 'code', terminalId: 't1',
    createdAt: ago(214), startedAt: ago(214),
    cwd: '/Users/juanmnl/.operator/worktrees/operator-bdd5c8',
    sourceCwd: '/Users/juanmnl/Developer/operator',
    worktreeBase: 'main', worktreeBranch: 'operator/bdd5c8',
    text: 'Read /Users/juanmnl/.operator/briefs/2026-08-01-simplify/code-move-01-launch-brief.md and execute it fully.',
  },
  {
    id: 'r2', status: 'running', roleId: 'design', terminalId: 't2',
    createdAt: ago(46), startedAt: ago(46),
    cwd: '/Users/juanmnl/.operator/worktrees/operator-ded278',
    sourceCwd: '/Users/juanmnl/Developer/operator',
    worktreeBase: 'main', worktreeBranch: 'operator/ded278',
    text: 'Read /Users/juanmnl/.operator/briefs/2026-08-01-simplify/design-move-02-board.md and execute it fully.',
  },
  {
    id: 'r3', status: 'running', roleId: 'research', terminalId: 't3',
    createdAt: ago(12), startedAt: ago(12),
    cwd: '/Users/juanmnl/.operator/worktrees/operator-79a6e0',
    sourceCwd: '/Users/juanmnl/Developer/operator',
    worktreeBase: 'main', worktreeBranch: 'operator/79a6e0',
    text: 'Read /Users/juanmnl/.operator/briefs/2026-08-01-simplify/research-move-03-channel-map.md and execute it fully.',
  },

  // ── Done ∪ abandoned. The real store is 126 done / 88 abandoned in this project.
  {
    id: 'd1', status: 'done', roleId: 'code', terminalId: 't11',
    createdAt: ago(900), startedAt: ago(900), doneAt: ago(160),
    cwd: '/Users/juanmnl/Developer/operator',
    diffStat: { added: 479, files: 7, removed: 2 },
    text: 'Remove the roster "top-up" migration in DashboardView.tsx (the one-time effect diffing every project\'s roster against defaultRoster()\'s ids and appending missing lanes, guarded by the global localStorage flag \'operator.rosterDefaults.v2\') — delete the effect and all references to that flag; do NOT touch RosterPanel\'s seed-if-roster-absent.',
  },
  {
    id: 'd2', status: 'done', roleId: 'design',
    createdAt: ago(600), doneAt: ago(220),
    cwd: '/Users/juanmnl/Developer/operator',
    diffStat: { added: 118, files: 3, removed: 41 },
    // NOTE: no task in the real store carries a `check`. This one is fabricated ON PURPOSE and
    // ONLY so the chip's styling can be eyeballed — the gate does not populate this today.
    check: { status: 'pass', output: '184 tests passed', at: ago(220) },
    text: 'Scope the channel author list to the active project.',
  },
  {
    id: 'd3', status: 'abandoned', roleId: 'code', terminalId: 't2',
    claudeSessionId: '80dcb9dc-dbe2-443a-9828-312ab432aa5d',
    createdAt: ago(1300), startedAt: ago(1300), reconciledAt: ago(70),
    cwd: '/Users/juanmnl/.operator/worktrees/operator-62aea8',
    sourceCwd: '/Users/juanmnl/Developer/operator',
    worktreeBase: 'main', worktreeBranch: 'operator/62aea8',
    text: 'Read dev/briefs/preview-url-navigate-to-a-page.md and fix it; write your result to dev/briefs/preview-url-navigate-to-a-page-RESULT.md',
  },
  {
    id: 'd4', status: 'done', roleId: 'review',
    createdAt: ago(1500), doneAt: ago(400), reconciledAt: ago(400),
    text: 'Audit the working tree before the v0.12.0 tag.',
  },
]

const DISPATCHES: DispatchRecord[] = [
  // The real held record — a non-coordinator lane (design) commissioning work from code.
  {
    id: 'cf5497448fb9d8e2', at: ago(26), fromRoleId: 'design', toRoleId: 'code',
    outcome: 'pending-approval',
    task: 'Build dev/briefs/composer-controls-impl.md — composer Send/Steer/Stop, drafts, two pills; result to dev/briefs/composer-controls-impl-RESULT.md',
  },
  // A brake. Real shape, minus the replyId — the real ones are reply deliveries and the board
  // filters those; this is what a braked DISPATCH of work would look like.
  {
    id: 'brk1', at: ago(52), fromRoleId: 'research', toRoleId: 'qa',
    outcome: 'pair-brake',
    task: 'Re-run the channel driver against the shipped default and report the delta.',
  },
  // Sent, then observed never to start: the task is sitting in a lane's composer right now.
  {
    id: 'und1', at: ago(88), fromRoleId: 'operator', toRoleId: 'review',
    outcome: 'undelivered',
    task: 'Review the working tree for the v0.12.0 tag — flag anything that must not ship.',
  },
  // Delivered records: history, and the board must NOT show them.
  { id: 'ok1', at: ago(200), fromRoleId: 'operator', toRoleId: 'code', outcome: 'sent', task: 'A delivered dispatch — must not appear on the board.' },
  // A reply delivery that got braked. Carries a replyId, so it is a chat message and not work:
  // the board filters it out, and this fixture exists to prove that it does.
  { id: 'rep1', at: ago(210), fromRoleId: 'operator', toRoleId: 'design', outcome: 'paused', replyId: 'd2a58751d134590a', task: 'Heads-up for your agents-hub task: Code is pruning 49 never-launched seeded lanes.' },
]

const LANE_SIGNALS: Record<string, LaneSignal> = {
  // Working, with subagents fanned out — the Moss-style child row.
  code: { status: 'active', phase: 'running', lastToolName: 'Edit', activeSubagents: 2 },
  // Working, no children.
  design: { status: 'active', phase: 'running', lastToolName: 'Bash', activeSubagents: 0 },
  // Handed the turn back. Static, per MOTION MEANS BUSY.
  research: { status: 'active', phase: 'waiting', lastToolName: null, activeSubagents: 0 },
}

const LIVE_ROLES: Record<string, string> = { code: 't1', design: 't2', research: 't3' }

type Scenario = 'full' | 'empty' | 'no-waiting' | 'backlog-only'

function Harness() {
  const [identity, setIdentity] = useState('mission-control')
  const [mode, setMode] = useState<ThemeMode>('dark')
  const [scenario, setScenario] = useState<Scenario>('full')
  const [width, setWidth] = useState<number | null>(null) // null = fill

  const apply = (id: string, m: ThemeMode) => {
    setIdentity(id); setMode(m)
    applyTheme(themes[themeKey(id, m)])
  }

  const tasks = scenario === 'empty' ? []
    : scenario === 'backlog-only' ? TASKS.filter((t) => (t.status ?? 'queued') === 'queued')
      : TASKS
  const dispatches = scenario === 'empty' || scenario === 'no-waiting' || scenario === 'backlog-only'
    ? DISPATCHES.filter((d) => d.outcome === 'sent')
    : DISPATCHES

  const chip = (active: boolean): React.CSSProperties => ({
    padding: '4px 10px', fontFamily: 'var(--font-mono)', fontSize: 10.5, cursor: 'pointer',
    borderRadius: 'var(--radius-sm)', outline: 'none',
    background: active ? 'var(--overlay-medium)' : 'var(--btn-bg)',
    color: active ? 'var(--fg)' : 'var(--fg-muted)',
    border: '1px solid var(--border)',
  })

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-terminal)', color: 'var(--fg)', fontFamily: 'var(--font-body)' }}>
      <div data-harness-controls style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {identities.map((idn) => (
          <button key={idn.id} data-theme-btn={idn.id} style={chip(identity === idn.id)} onClick={() => apply(idn.id, mode)}>{idn.name}</button>
        ))}
        <span style={{ width: 10 }} />
        {(['dark', 'light'] as ThemeMode[]).map((m) => (
          <button key={m} data-mode-btn={m} style={chip(mode === m)} onClick={() => apply(identity, m)}>{m}</button>
        ))}
        <span style={{ width: 10 }} />
        {(['full', 'empty', 'no-waiting', 'backlog-only'] as Scenario[]).map((s) => (
          <button key={s} data-scenario-btn={s} style={chip(scenario === s)} onClick={() => setScenario(s)}>{s}</button>
        ))}
        <span style={{ width: 10 }} />
        {([null, 900, 560] as (number | null)[]).map((w) => (
          <button key={String(w)} data-width-btn={w ?? 'fill'} style={chip(width === w)} onClick={() => setWidth(w)}>{w ? `${w}px` : 'fill'}</button>
        ))}
      </div>
      {/* The board is given a bounded box, exactly as the app's shell gives it one. */}
      <div data-board-host style={{ flex: 1, minHeight: 0, width: width ?? '100%', borderRight: width ? '1px solid var(--border)' : undefined }}>
        <TaskBoard
          tasks={tasks}
          roles={ROLES}
          liveRoles={LIVE_ROLES}
          dispatches={dispatches}
          laneSignals={LANE_SIGNALS}
          onAddTask={(t, r) => console.log('addTask', t, r)}
          onAssignTask={(id, r) => console.log('assign', id, r)}
          onRemoveTask={(id) => console.log('remove', id)}
          onSendTask={(t) => console.log('send', t.id)}
          onSetTaskStatus={(id, s) => console.log('status', id, s)}
          onStartAll={() => console.log('startAll')}
          onApproveDispatch={(id) => console.log('approve', id)}
          onRejectDispatch={(id) => console.log('reject', id)}
          onOpenLane={(r) => console.log('openLane', r)}
        />
      </div>
    </div>
  )
}

applyTheme(themes['mission-control-dark'])
createRoot(document.getElementById('root')!).render(<Harness />)
