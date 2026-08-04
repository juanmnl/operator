import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TaskBoard, LaneSignal } from '../src/renderer/components/session/TaskBoard'
import { DispatchLog } from '../src/renderer/components/session/DispatchLog'
import { canDismissDispatch } from '../src/renderer/lib/dispatch-outcome'
import type { DispatchRecord, Project, ProjectTask, Role } from '../src/shared/types'
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
//   • every dispatch record is a shape the delivery path writes — see the block above DISPATCHES.
//   • `q6` is assigned to `infra`, a lane NOT on the roster, because a task outliving its lane is
//     ordinary (RosterPanel can delete one) and the board must say "gone", not "Unassigned".
//   • `q5` + the `un1` record are the real PAIR a failed route produces: `addProjectTask` and
//     `record('unassigned')` are called in the same breath with the same text.
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
  // Filed by the `un1` dispatch above — same text, no roleId, exactly as `addProjectTask` writes
  // it when a dispatch names a lane the project doesn't have.
  { id: 'q5', createdAt: ago(15), text: 'Check whether the release gate still blocks on the notarization step.' },
  // Assigned to a lane that is NO LONGER on the roster — must read "gone", never "Unassigned".
  { id: 'q6', createdAt: ago(70), roleId: 'infra', text: 'Rotate the updater signing key — blocked, see release process notes.' },

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
  // Closed, on a lane that has since been deleted. Deleting a lane does not delete its tasks, so
  // this is the ordinary end state of a removed lane — and it must not read "Unassigned".
  {
    id: 'd5', status: 'done', roleId: 'infra',
    createdAt: ago(1800), doneAt: ago(500),
    text: 'Pin the notarization step to a specific Xcode version.',
  },
]

// EVERY RECORD BELOW IS A SHAPE THE DELIVERY PATH WRITES. An earlier version of this file
// contained a braked DISPATCH (`pair-brake` with no `replyId`) and called it "real shape, minus
// the replyId" — naming the deviation and then building on it. That record is impossible: the
// three brakes are written in one literal that always sets `replyId` (an invariant stated in
// shared/types.ts), so the fixture was testing the board against something the app cannot produce.
const DISPATCHES: DispatchRecord[] = [
  // Real, copied from the store: a non-coordinator lane (design) commissioning work from code,
  // held by the authority gate. The only Waiting card the real store can render today.
  {
    id: 'cf5497448fb9d8e2', at: ago(26), fromRoleId: 'design', toRoleId: 'code',
    outcome: 'pending-approval',
    task: 'Build dev/briefs/composer-controls-impl.md — composer Send/Steer/Stop, drafts, two pills; result to dev/briefs/composer-controls-impl-RESULT.md',
  },
  // A real `sent` record from the store with ONLY its outcome changed — which is exactly what
  // `reportUndelivered` → `setDispatchOutcome` does when bytes reach the pty and no turn follows.
  // No such record exists in the store yet (the reclassification has never fired), but every
  // field here is real and the mutation is the one the code performs.
  {
    id: '11e8ab119beac2a4', at: ago(88), fromRoleId: 'operator', toRoleId: 'code',
    outcome: 'undelivered',
    task: 'Read /Users/juanmnl/.operator/briefs/2026-08-01-simplify/code-fixes-and-move-05.md and execute it fully.',
  },
  // Delivered: history, and the board must NOT show it.
  {
    id: 'c03784cc314c1b59', at: ago(200), fromRoleId: 'operator', toRoleId: 'design', outcome: 'sent',
    task: 'Read /Users/juanmnl/.operator/briefs/2026-08-01-simplify/design-board-fixes.md and execute it fully.',
  },
  // A real braked REPLY delivery, replyId and all — the shape all three brakes actually have.
  // It must not reach Waiting: a brake on a chat message is not stopped work.
  {
    id: 'f6d81e05-728d-4b42-a435-ad718cc44db1', at: ago(210), fromRoleId: 'operator', toRoleId: 'design',
    outcome: 'paused', replyId: 'd2a58751d134590a',
    task: 'Heads-up for your agents-hub task: Code is pruning 49 never-launched seeded lanes from existing projects.',
  },
  // An unroutable dispatch. The handler ALSO filed `q5` into the backlog (below) with this exact
  // text — that pairing is real, and it is why this belongs in Backlog with a reason rather than
  // as a second card in Waiting.
  {
    id: 'un1', at: ago(15), fromRoleId: 'operator', outcome: 'unassigned',
    task: 'Check whether the release gate still blocks on the notarization step.',
  },
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

// The real store's worst project holds 214 closed tasks. Synthesised in COUNT only — each one is
// a copy of a real done record — because the number is the point: the board must not mount them.
const BULK_DONE: ProjectTask[] = Array.from({ length: 214 }, (_, i) => ({
  id: `bulk${i}`,
  status: i % 3 === 0 ? ('abandoned' as const) : ('done' as const),
  roleId: 'code',
  createdAt: ago(2000 + i),
  doneAt: ago(300 + i),
  ...(i % 3 === 0 ? { reconciledAt: ago(300 + i) } : {}),
  text: `Closed task #${i} — a real project accumulates these and never clears them.`,
}))

// `running-only` exists for ONE assertion: it is the only shape that puts BACKLOG's empty state
// on screen beside its neighbours'. That box carried an `+ Add a task` button no other column had
// and was 28px taller for it — a difference invisible in every other scenario, because a board
// with an empty backlog and a populated anything-else is not otherwise fixtured.
type Scenario = 'full' | 'empty' | 'no-waiting' | 'backlog-only' | 'running-only' | 'done-heavy'

function Harness() {
  const [identity, setIdentity] = useState('mission-control')
  const [mode, setMode] = useState<ThemeMode>('dark')
  const [scenario, setScenario] = useState<Scenario>('full')
  const [width, setWidth] = useState<number | null>(null) // null = fill
  // The dispatch records are STATE, not a constant, because dismissing one is a state transition
  // and a harness that logged `reject` to the console could only ever prove the button exists.
  // The transition below is the two lines `rejectDispatch` runs — guard included, from the shared
  // predicate — so what this exercises is the app's rule, not a copy of it.
  const [records, setRecords] = useState<DispatchRecord[]>(DISPATCHES)
  const reject = (id: string) => setRecords((rs) => rs.map((r) => (
    r.id === id && canDismissDispatch(r.outcome) ? { ...r, outcome: 'rejected' as const } : r
  )))

  const apply = (id: string, m: ThemeMode) => {
    setIdentity(id); setMode(m)
    applyTheme(themes[themeKey(id, m)])
  }

  const tasks = scenario === 'empty' ? []
    : scenario === 'backlog-only' ? TASKS.filter((t) => (t.status ?? 'queued') === 'queued')
      : scenario === 'running-only' ? TASKS.filter((t) => t.status === 'running')
        : scenario === 'done-heavy' ? [...TASKS, ...BULK_DONE]
          : TASKS
  const dispatches = scenario === 'empty' || scenario === 'no-waiting' || scenario === 'backlog-only' || scenario === 'running-only'
    ? records.filter((d) => d.outcome === 'sent')
    : records
  // Enough of a Project for `DispatchLog`, which reads only these three fields. It is mounted
  // beside the board — on the Team screen it lives elsewhere, but the pairing is the point: a
  // dismissed record must LEAVE the column and still be READABLE, and one screenshot has to be
  // able to show both halves of that.
  const project: Project = {
    id: 'operator', path: '/Users/juanmnl/Developer/operator', name: 'operator',
    createdAt: ago(9000), lastActiveAt: ago(1), roster: ROLES, dispatches,
  }

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
        {(['full', 'empty', 'no-waiting', 'backlog-only', 'running-only', 'done-heavy'] as Scenario[]).map((s) => (
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
          onRejectDispatch={reject}
          onOpenLane={(r) => console.log('openLane', r)}
        />
      </div>
      {/* The audit trail, mounted from the same records the board reads. Dismissing is not
          deleting: the row has to still be here afterwards, saying `declined`. */}
      <div data-dispatch-log-host style={{ flexShrink: 0, maxHeight: 190, overflowY: 'auto', padding: '0 14px 12px', borderTop: '1px solid var(--border)' }}>
        <DispatchLog project={project} />
      </div>
    </div>
  )
}

applyTheme(themes['mission-control-dark'])
createRoot(document.getElementById('root')!).render(<Harness />)
