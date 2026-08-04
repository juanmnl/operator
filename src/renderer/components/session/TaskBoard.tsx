import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentSession, DispatchRecord, ProjectTask, Role } from '../../../shared/types'
import { isClosed, statusOf } from '../../lib/task-lifecycle'
import { taskHasDiffSource } from '../../lib/task-diff'
import { chipForOutcome } from '../../lib/dispatch-outcome'
import { toolVerb } from '../../lib/chat-signal'
import { fmtDuration, relativeTime } from '../../lib/format'
import { laneTextColor } from '../../lib/lane-color'
import { headlineOf } from '../../lib/task-headline'
import { StatusWave } from '../sidebar/StatusWave'
import { TaskDiffCard } from './TaskDiffCard'
import { isStaleTask, taskAgeDays } from '../../lib/task-staleness'

// THE BOARD. Project home as a board of WORK — Backlog · Running · Waiting · Done — where the
// card is the task and the agent is a chip on it. The inversion of the roster, which put the
// agent first and left the work below the fold.
//
// This is largely a re-rendering of what `TaskQueue` already owns: the same store, the same
// lifecycle (lib/task-lifecycle), the same per-task verbs, the same inline diff card. Nothing
// here invents state — every column is a partition of data some other path already wrote, which
// is the property that keeps the board honest about what actually happened.
//
// SELF-CONTAINED AND PROPS-DRIVEN on purpose: it imports nothing from DashboardView and holds no
// store of its own, so wiring it in is mechanical (see partitionBoard + TaskBoardProps).

/** A lane's live runtime, as the board reads it. Deliberately a `Pick` of the session the
 *  transcript observer already produces — the board must not become a second definition of what
 *  a lane is doing. */
export type LaneSignal = Pick<AgentSession, 'status' | 'phase' | 'lastToolName' | 'activeSubagents'>

/** ONE RULE, TWO CLAUSES: a Waiting card is a record that (a) is WORK rather than chat, and
 *  (b) is stopped until a human acts.
 *
 *  Clause (a) is `!replyId` (applied in partitionBoard). A `replyId` record is the delivery of a
 *  lane's OPERATOR-REPLY — a message ABOUT work, never work — so nothing about how it failed can
 *  make it belong here. That is the whole answer to "why is an `undelivered` dispatch in Waiting
 *  but an `undelivered` reply not?", and it is the only answer: the discriminator is what the
 *  record IS, never where its text ended up. An earlier version of this comment justified
 *  `undelivered` by "the task is sitting in a lane's composer", which is a symptom — and, applied
 *  honestly, would have dragged stranded replies in with it.
 *
 *  Clause (b) is this set, and it is short for a reason:
 *  • `pending-approval` — the only one a button can resolve; it routes to the existing gate.
 *  • `undelivered` — bytes went to the pty, no turn ever followed. Reclassified from `sent` by
 *    `reportUndelivered`, which deliberately does not retry, so a human is the only way out.
 *
 *  DELIBERATELY ABSENT — the three agent↔agent brakes (`hop-limit`, `pair-brake`, `paused`).
 *  Not a judgement call: they are written in exactly one place (DashboardView's reply-delivery
 *  `record()`) and that literal always sets `replyId`, so clause (a) excludes every one of them
 *  unconditionally. `shared/types.ts` states it as an invariant — "the last three are agent→agent
 *  delivery brakes, and only ever appear with `replyId`" — not as an observation. Listing them
 *  here made three-fifths of the column unreachable UI and made a hard invariant read as an
 *  empirical coincidence, which invites someone to relax it later.
 *
 *  • `unassigned` — the role token matched no lane, so nothing was delivered anywhere.
 *
 *  THAT LAST ONE REVERSES WHAT THIS COMMENT USED TO SAY. The old argument was that an
 *  `unassigned` dispatch is not stranded, because the same handler called `addProjectTask` first
 *  and the work was therefore already a real queued task in Backlog — so a Waiting card would
 *  show it twice. **The handler no longer creates that task**, and the premise went with it. It
 *  was also the wrong trade: a `ProjectTask` is durable and indistinguishable from something a
 *  human queued, so eight lane STATUS REPORTS filed this way in July were later assigned and
 *  dispatched as if they were work. A delivery failure belongs in the column for things stopped
 *  until a human acts, not in the queue of things to do.
 *  The card's missing affordance — the old note that `toRoleId: undefined` left nothing to press
 *  — is answered rather than inherited: an unassigned card carries a lane picker (route it now)
 *  and a dismiss. */
const WAITING_OUTCOMES = new Set<DispatchRecord['outcome']>(['pending-approval', 'undelivered', 'unassigned'])

export interface TaskBoardProps {
  /** The project's whole task list — `project.tasks ?? []`. Partitioned here, never mutated. */
  tasks: ProjectTask[]
  /** The project's roster, for resolving a task's lane chip. */
  roles: Role[]
  /** roleId → terminalId for the lanes live right now. Same shape DashboardView already builds
   *  for `TaskQueue`/`RosterPanel` (`liveRoles`). */
  liveRoles?: Record<string, string>
  /** The project's dispatch log — `project.dispatches`. Only the held/stranded records are
   *  rendered (see WAITING_OUTCOMES); the delivered ones are history and belong nowhere here. */
  dispatches?: DispatchRecord[]
  /** roleId → what that lane is doing right now. Drives the running card's activity line and its
   *  child-threads row. Absent lanes simply render without one. */
  laneSignals?: Record<string, LaneSignal>

  onAddTask: (text: string, roleId?: string) => void
  onAssignTask: (taskId: string, roleId?: string) => void
  onRemoveTask: (taskId: string) => void
  onSendTask: (task: ProjectTask) => void
  onSetTaskStatus: (taskId: string, status: ProjectTask['status']) => void
  /** Dispatch every queued task to its assigned lane. Absent = the verb isn't offered. */
  onStartAll?: () => void
  /** The EXISTING approval gate, by dispatch id. Absent = the held cards are read-only, which is
   *  a silent drop — wire both or neither. */
  onApproveDispatch?: (dispatchId: string) => void
  onRejectDispatch?: (dispatchId: string) => void
  /** Bring a lane's session forward. The board never opens a second view of a lane; it points at
   *  the one that exists. */
  onOpenLane?: (roleId: string) => void
  /** Route a dispatch that named no lane to a real one. Absent = the picker is inert (read-only
   *  board), never missing — a card with no affordance is what this column just stopped being. */
  onAssignDispatch?: (id: string, roleId: string) => void
}

export type BoardColumnKey = 'backlog' | 'running' | 'waiting' | 'done'

/** Backlog tasks that exist because a dispatch named a lane this project does not have.
 *
 *  The handler files the task (`addProjectTask`) and records `unassigned` in the same breath, and
 *  the two are never linked by id — the task gets a fresh one. They ARE linked by text: one call
 *  passes `d.task` to both. So the join is on the string, which is exact for the only thing that
 *  produces the pair, and whose worst failure is cosmetic (two identical task texts both get the
 *  note; nothing is hidden or mis-sent).
 *
 *  HISTORICAL NOW. New dispatches no longer create the task at all (see WAITING_OUTCOMES), so
 *  this join only ever matches rows minted before that change — and those are the user's to
 *  clear, not ours to migrate. It stays for exactly that: an old row still explains itself.
 *  Its second job is the dedupe in `partitionBoard`: a legacy pair already has a backlog row, so
 *  it must NOT also raise a Waiting card, or the change would show that work twice. */
function unassignedByText(dispatches: DispatchRecord[] | undefined): Set<string> {
  const out = new Set<string>()
  for (const d of dispatches ?? []) if (!d.replyId && d.outcome === 'unassigned') out.add(d.task)
  return out
}

export interface BoardPartition {
  backlog: ProjectTask[]
  running: ProjectTask[]
  waiting: DispatchRecord[]
  done: ProjectTask[]
  /** Task text → "this landed in the backlog because no lane matched the name it was sent to".
   *  Empty unless a dispatch actually failed to route. */
  unassignedReasons: Set<string>
  /** Of `done`, how many were closed without anyone seeing them finish (abandoned, or a `done`
   *  written by startup reconciliation). Counted separately because "68 done" when 50 of them
   *  were closed by reconciliation is the same lie in aggregate that `status: 'done'` was per
   *  task — see TaskQueue's closed header. */
  unconfirmed: number
}

/** Split the project's work into the four columns. Pure, exported, and the whole of the board's
 *  data model — a wiring step or a test can check the partition without a DOM.
 *
 *  Ordering differs per column because what you want to see first differs:
 *  • backlog — oldest first: it is a queue, and the top of it is what runs next.
 *  • running — LONGEST-RUNNING first. The real store has had ~200 tasks stuck `running`; the one
 *    that has been going for three days is the one worth looking at, not the one just started.
 *  • waiting / done — newest first: both are things that just happened to you.
 *
 *  `done` is done ∪ abandoned. An abandoned task belongs in the closed column, not in limbo:
 *  filtering only `done` once made 50 reconciled tasks vanish from the UI entirely. */
export function partitionBoard(
  tasks: ProjectTask[] | undefined,
  dispatches: DispatchRecord[] | undefined,
): BoardPartition {
  const all = tasks ?? []
  const done = all.filter(isClosed)
  const closedAt = (t: ProjectTask) => t.doneAt ?? t.reconciledAt ?? t.createdAt
  return {
    backlog: all.filter((t) => statusOf(t) === 'queued')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    running: all.filter((t) => statusOf(t) === 'running')
      .sort((a, b) => (a.startedAt ?? a.createdAt).localeCompare(b.startedAt ?? b.createdAt)),
    // Clause (a) of the Waiting rule — see WAITING_OUTCOMES. A `replyId` record is a chat
    // delivery, not work, whatever happened to it.
    // …minus any `unassigned` record that ALREADY has a backlog task carrying its text. That
    // pair can only exist for rows minted before the handler stopped creating them; showing both
    // would be the duplication the old rule rightly warned about.
    waiting: (dispatches ?? []).filter((d) => !d.replyId && WAITING_OUTCOMES.has(d.outcome))
      .filter((d) => d.outcome !== 'unassigned' || !all.some((t) => t.text === d.task))
      .sort((a, b) => b.at.localeCompare(a.at)),
    done: done.sort((a, b) => closedAt(b).localeCompare(closedAt(a))),
    unassignedReasons: unassignedByText(dispatches),
    unconfirmed: done.filter((t) => t.status === 'abandoned' || !!t.reconciledAt).length,
  }
}

// Column widths below which four side-by-side columns stop being a board and start being four
// gutters. Measured on the container, not the window: the board sits inside a shell whose
// sidebar and right panel both resize independently of it.
const FOUR_COL = 980
const TWO_COL = 660
const TICK_MS = 30_000 // how often the elapsed/relative times refresh
/** Closed tasks mounted per page. Deep enough that a normal project's whole history is one page,
 *  small enough that the worst real project (214 closed) costs 20 articles on first paint. */
const DONE_PAGE = 20
/** How long a card that has just arrived in Running stays marked. Long enough to catch out of
 *  the corner of your eye after clicking `Send →` in the next column, short enough that it is
 *  gone before it reads as a state the card is IN. */
const LANDED_MS = 1400

export function TaskBoard(props: TaskBoardProps) {
  const { tasks, roles, liveRoles, dispatches, laneSignals } = props
  const shellRef = useRef<HTMLDivElement>(null)
  const cols = useResponsiveColumns(shellRef)
  const [composing, setComposing] = useState(false)
  const [openDiff, setOpenDiff] = useState<Set<string>>(new Set())
  const [doneShown, setDoneShown] = useState(DONE_PAGE)
  const [clearing, setClearing] = useState(false)

  const board = useMemo(() => partitionBoard(tasks, dispatches), [tasks, dispatches])
  const landed = useJustLanded(board.running)
  // The clock is reset by the running set changing, not only by its own interval. A card that
  // lands between ticks is stamped `startedAt: now`, which is NEWER than the cached clock, so its
  // elapsed came out negative and `fmtDuration` printed an em dash — for up to 30 seconds, on the
  // card you were watching land. Invisible until `Send →` stopped navigating away; the first
  // thing the fix made visible was this.
  const now = useTicking(TICK_MS, board.running.length)
  const roleOf = (id?: string) => roles.find((r) => r.id === id)
  const laneLive = (t: ProjectTask) => !!(t.roleId && liveRoles?.[t.roleId])
  const toggleDiff = (id: string) =>
    setOpenDiff((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  // Only tasks assigned to a lane the roster still holds are dispatchable — Start all skips a
  // stale roleId, so offering it for one would promise something that silently does nothing.
  const dispatchable = board.backlog.filter((t) => t.roleId && roles.some((r) => r.id === t.roleId)).length
  const totally = board.backlog.length + board.running.length + board.waiting.length + board.done.length

  // ── The empty board ───────────────────────────────────────────────────────────────────────
  // The first thing a new project shows. Four empty columns would be a correct rendering of
  // nothing and would read as broken, so an empty board is a different composition: one field
  // asking for the first task, with the four column names beneath it as a ghost so the shape
  // you're about to fill is legible before anything is in it.
  if (totally === 0) {
    return (
      <div ref={shellRef} data-board data-board-empty style={SHELL}>
        <div style={{ margin: 'auto', width: '100%', maxWidth: 480, padding: '0 16px 8vh', textAlign: 'center' }}>
          <h2 style={{ fontFamily: 'var(--font-disp)', fontSize: 19, fontWeight: 550, letterSpacing: '-0.01em', color: 'var(--fg)', marginBottom: 6 }}>
            What do you want done?
          </h2>
          <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--fg-muted)', marginBottom: 16, textWrap: 'balance' }}>
            Write the first task. Assign it to an agent now, or leave it for whichever lane picks it up.
          </p>
          <TaskComposer roles={roles} liveRoles={liveRoles} onAdd={props.onAddTask} hero autoFocus />
          <div aria-hidden style={{ display: 'flex', justifyContent: 'center', gap: 14, marginTop: 26 }}>
            {COLUMNS.map((c) => (
              <span key={c.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Pip tone="idle" />
                <span style={LABEL}>{c.title}</span>
              </span>
            ))}
          </div>
          <p style={{ fontSize: 10.5, color: 'var(--fg-muted)', marginTop: 10 }}>
            Tasks move left to right as your agents pick them up.
          </p>
        </div>
      </div>
    )
  }

  // ── The board ─────────────────────────────────────────────────────────────────────────────
  // One column stacks: the whole board scrolls and each column is its natural height. Two or
  // four: the board is fixed and each column scrolls on its own, so a long Done list can never
  // push Backlog off the screen.
  const stacked = cols === 1

  const columnBody = (key: BoardColumnKey) => {
    switch (key) {
      case 'backlog':
        return (
          <>
            {composing && (
              <TaskComposer
                roles={roles}
                liveRoles={liveRoles}
                autoFocus
                onAdd={(text, roleId) => { props.onAddTask(text, roleId); setComposing(false) }}
                onCancel={() => setComposing(false)}
              />
            )}
            {board.backlog.map((task) => (
              <BacklogCard
                key={task.id}
                task={task}
                role={roleOf(task.roleId)}
                roles={roles}
                liveRoles={liveRoles}
                unroutedReason={board.unassignedReasons.has(task.text)}
                now={now}
                onAssign={props.onAssignTask}
                onSend={props.onSendTask}
                onRemove={props.onRemoveTask}
              />
            ))}
            {board.backlog.length === 0 && !composing && <EmptyColumn text="Nothing queued." />}
          </>
        )
      case 'running':
        return board.running.length === 0
          ? <EmptyColumn text="No agent is working." />
          : board.running.map((task) => (
            <RunningCard
              key={task.id}
              task={task}
              landed={landed.has(task.id)}
              role={roleOf(task.roleId)}
              signal={task.roleId ? laneSignals?.[task.roleId] : undefined}
              now={now}
              laneLive={laneLive(task)}
              diffOpen={openDiff.has(task.id)}
              onToggleDiff={() => toggleDiff(task.id)}
              onDone={() => props.onSetTaskStatus(task.id, 'done')}
              onOpenLane={props.onOpenLane}
            />
          ))
      case 'waiting':
        return board.waiting.length === 0
          ? <EmptyColumn text="Nothing needs you." />
          : board.waiting.map((d) => (
            <WaitingCard
              key={d.id}
              record={d}
              from={roleOf(d.fromRoleId)}
              to={roleOf(d.toRoleId)}
              onApprove={props.onApproveDispatch}
              onReject={props.onRejectDispatch}
              onOpenLane={props.onOpenLane}
              roles={roles}
              onAssign={props.onAssignDispatch}
            />
          ))
      case 'done': {
        if (board.done.length === 0) return <EmptyColumn text="Nothing finished yet." />
        // MOUNT ONLY A PAGE OF HISTORY. `board.done` is done ∪ abandoned and the real store holds
        // 214 of them in one project — 214 articles on first paint, each running
        // `taskHasDiffSource`, a timestamp format and a diff toggle, on a codebase with a
        // documented WebContent-freeze history. TaskQueue rendered ZERO at rest (collapsed behind
        // `showDone`); a board can't collapse its own column, so it pages instead. Newest first,
        // so the page you get is the one you'd have scrolled to anyway.
        const shown = board.done.slice(0, doneShown)
        const rest = board.done.length - shown.length
        return (
          <>
            {shown.map((task) => (
              <DoneCard
                key={task.id}
                task={task}
                role={roleOf(task.roleId)}
                laneLive={laneLive(task)}
                diffOpen={openDiff.has(task.id)}
                onToggleDiff={() => toggleDiff(task.id)}
                onRequeue={() => props.onSetTaskStatus(task.id, 'queued')}
                onRemove={() => props.onRemoveTask(task.id)}
              />
            ))}
            {rest > 0 && (
              <button
                className="tb-btn"
                data-board-done-more
                onClick={() => setDoneShown((n) => n + DONE_PAGE)}
                title={`${rest} older closed task${rest > 1 ? 's' : ''} not rendered`}
              >Show {Math.min(rest, DONE_PAGE)} more · {rest} older</button>
            )}
          </>
        )
      }
    }
  }

  const countFor = (key: BoardColumnKey) =>
    key === 'waiting' ? board.waiting.length : board[key].length

  return (
    <div ref={shellRef} data-board style={SHELL}>
      <div
        style={{
          flex: 1, minHeight: 0, display: 'grid', gap: 12, padding: '12px 16px 16px',
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          // Stacked: rows size to their CONTENT and the whole board scrolls. `min-content` is
          // load-bearing — with plain `auto` rows plus `min-height: 0` on the sections (needed in
          // the side-by-side case so each column can scroll inside a fixed row) the items' minimum
          // contribution resolves to 0, `align-content: stretch` then split the container's height
          // four equal ways, and every column drew ~198px of a ~370px section straight over the
          // next one. Side-by-side: equal rows, each column scrolling on its own, so a long Done
          // list can never push Backlog off the screen.
          ...(stacked
            ? { gridAutoRows: 'min-content', overflowY: 'auto' }
            : { gridAutoRows: 'minmax(0, 1fr)', overflow: 'hidden' }),
        }}
      >
        {COLUMNS.map((c) => {
          const n = countFor(c.key)
          return (
            <section
              key={c.key}
              data-board-column={c.key}
              style={{ display: 'flex', flexDirection: 'column', minWidth: 0, ...(stacked ? null : { minHeight: 0 }) }}
            >
              {/* A FIXED BAND, not a box sized by whatever control it happens to carry. At
                  `alignItems: center` with no height, Backlog's 20px `+` made its header ~9px
                  taller than Running's bare label and centring split the difference — so the four
                  column names sat on two different baselines, and would drift again the next time
                  a column gained a button. */}
              <header style={{ display: 'flex', alignItems: 'center', gap: 6, height: 24, boxSizing: 'border-box', padding: '0 2px', marginBottom: 8, flexShrink: 0 }}>
                <Pip
                  tone={
                    c.key === 'running' ? (n > 0 ? 'running' : 'idle')
                      : c.key === 'waiting' ? (n > 0 ? 'waiting' : 'idle')
                        : c.key === 'done' ? 'done' : 'idle'
                  }
                />
                <span data-board-label={c.key} style={LABEL}>{c.title}</span>
                <span
                  data-board-count={c.key}
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, fontVariantNumeric: 'tabular-nums', color: n > 0 ? 'var(--fg)' : 'var(--fg-muted)' }}
                >{n}</span>
                {/* INSIDE THE COLUMN'S OWN NAME. At `marginLeft: auto` this sat on Backlog's
                    right edge, 6px from a 12px grid gap — very nearly equidistant from two
                    columns, and it read as belonging to neither because geometrically it belonged
                    to neither. The bulk verbs below keep the far edge: they operate on the whole
                    column, which is what the far edge means here. */}
                {c.key === 'backlog' && (
                  <button
                    data-board-add
                    className="tb-btn tb-btn-icon"
                    onClick={() => setComposing((v) => !v)}
                    title="Add a task"
                    aria-expanded={composing}
                  >+</button>
                )}
                {c.key === 'done' && board.unconfirmed > 0 && (
                  // Named, not folded into the count: an abandoned task is not a finished one.
                  <span data-board-unconfirmed style={{ ...LABEL, letterSpacing: '0.06em' }}>
                    · {board.unconfirmed} unconfirmed
                  </span>
                )}
                {c.key === 'done' && board.done.length > 0 && props.onRemoveTask && (
                  <span style={{ marginLeft: 'auto' }}>
                    {/* Restored from TaskQueue. Clearing 214 closed tasks one ✕ at a time is not
                        the same capability moved, it is a capability removed. Two-step because it
                        is bulk and irreversible — and the confirm STATES THE COUNT, since the
                        column only ever shows a page of it. */}
                    {clearing ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <button
                          className="tb-btn tb-btn-danger"
                          data-board-clear-confirm
                          onClick={() => { board.done.forEach((t) => props.onRemoveTask(t.id)); setClearing(false) }}
                        >Delete {board.done.length}</button>
                        <button className="tb-btn" onClick={() => setClearing(false)}>Cancel</button>
                      </span>
                    ) : (
                      <button
                        className="tb-btn"
                        data-board-clear
                        onClick={() => setClearing(true)}
                        title={`Delete all ${board.done.length} closed tasks`}
                      >Clear</button>
                    )}
                  </span>
                )}
                {c.key === 'backlog' && dispatchable > 0 && props.onStartAll && (
                  <button
                    data-board-start-all
                    className="tb-btn"
                    style={{ marginLeft: 'auto' }}
                    onClick={props.onStartAll}
                    title={`Dispatch ${dispatchable} assigned task${dispatchable > 1 ? 's' : ''} to their agents`}
                  >Start all →</button>
                )}
              </header>
              <div
                className="scroll-hidden"
                style={{
                  display: 'flex', flexDirection: 'column', gap: 8,
                  ...(stacked ? {} : { flex: 1, minHeight: 0, overflowY: 'auto' }),
                }}
              >
                {columnBody(c.key)}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

const COLUMNS: { key: BoardColumnKey; title: string }[] = [
  { key: 'backlog', title: 'Backlog' },
  { key: 'running', title: 'Running' },
  { key: 'waiting', title: 'Waiting' },
  { key: 'done', title: 'Done' },
]

/** Safe in the prescribed placement, but nothing in the component defended it: an auto-height
 *  parent renders an invisible board (`height: 100%` of nothing), and a shrink-to-fit parent
 *  makes the width content-driven — which is the precondition for a ResizeObserver feedback loop,
 *  since the observer sets a column count that changes the content that sets the width. Two
 *  declarations make both impossible regardless of who mounts it. */
const SHELL: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
  width: '100%', minWidth: 0,
  fontFamily: 'var(--font-body)',
}

/** Accent drawn as TEXT, corrected for the palette. `--accent` is a theme token, but on the
 *  three light identities it is still a saturated colour on a light field — measured, the raw
 *  token gave 2.1:1 at 10px on 1984-light. `laneTextColor` is the app's existing answer to
 *  exactly that (mix `--lane-ink-blend` of `--fg` in; 0% on dark, 70% on light), and it takes any
 *  CSS colour, not only a lane's. Use this for accent ink; dots, borders and tints stay unmixed. */
const ACCENT_INK = laneTextColor('var(--accent)')

const LABEL: React.CSSProperties = {
  fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.12em',
  textTransform: 'uppercase', color: 'var(--fg-muted)',
}

// ── Cards ───────────────────────────────────────────────────────────────────────────────────

function BacklogCard({ task, role, roles, liveRoles, unroutedReason, now, onAssign, onSend, onRemove }: {
  task: ProjectTask
  role?: Role
  roles: Role[]
  /** The board's ticking clock — shared so every card ages on the same beat. */
  now: number
  liveRoles?: Record<string, string>
  /** True when this task is in the backlog because a dispatch named a lane that doesn't exist. */
  unroutedReason?: boolean
  onAssign: (taskId: string, roleId?: string) => void
  onSend: (task: ProjectTask) => void
  onRemove: (taskId: string) => void
}) {
  return (
    <article className="tb-card" data-task-card={task.id} style={cardStyle()}>
      <DeleteButton title="Delete task" onClick={() => onRemove(task.id)} />
      <p className="tb-title" data-card-title title={task.text}>{headlineOf(task.text).title}</p>
      {/* Why this is sitting unassigned. An agent asked for a lane this project doesn't have, so
          the task was filed here instead — which without a word looks like a backlog item nobody
          got round to assigning. Today the dispatch log says it; after move 03 nothing would. */}
      {unroutedReason && !task.roleId && (
        <p data-card-unrouted style={{ ...ACTIVITY, color: 'var(--fg-muted)' }}>
          Filed here — an agent sent it to a lane this project doesn’t have.
        </p>
      )}
      <div style={META_ROW}>
        <AssigneePicker
          roles={roles}
          value={task.roleId ?? ''}
          liveRoles={liveRoles}
          onChange={(id) => onAssign(task.id, id || undefined)}
        />
        {/* A twelve-day-old task should LOOK twelve days old before you press anything. The
            relative time beside it already says "12 days ago", but a timestamp reads as
            provenance; this reads as a state, which is what it now is — `Send →` will hold it
            back and ask. Coloured text and no fill, like every other state marker here. */}
        {isStaleTask(task, now) ? (
          <span
            data-card-stale={taskAgeDays(task, now)}
            title={`Queued ${taskAgeDays(task, now)} days ago — sending will ask first`}
            style={{ ...TIME, color: laneTextColor('var(--color-warning)') }}
          >{taskAgeDays(task, now)}d old</span>
        ) : (
          <span data-card-time style={TIME}>{relativeTime(task.createdAt)}</span>
        )}
        <button
          className="tb-btn"
          data-card-send
          onClick={() => onSend(task)}
          disabled={!role}
          title={role ? `Send to ${role.name}` : 'Assign an agent first'}
          style={{ marginLeft: 'auto', color: role ? ACCENT_INK : 'var(--fg-muted)' }}
        >Send →</button>
      </div>
    </article>
  )
}

function RunningCard({ task, role, signal, now, laneLive, landed, diffOpen, onToggleDiff, onDone, onOpenLane }: {
  task: ProjectTask
  role?: Role
  /** Just arrived from Backlog — mark it briefly so the move is catchable. */
  landed?: boolean
  signal?: LaneSignal
  now: number
  laneLive: boolean
  diffOpen: boolean
  onToggleDiff: () => void
  onDone: () => void
  onOpenLane?: (roleId: string) => void
}) {
  const accent = role?.accent || 'var(--accent)'
  const started = task.startedAt ?? task.createdAt
  const elapsed = fmtDuration(now - new Date(started).getTime())
  const subagents = signal?.activeSubagents ?? 0
  // The lane is parked on you rather than working. Owned here so the state slot and the activity
  // line cannot disagree about it.
  const awaitingYou = signal?.status !== 'ended' && signal?.phase === 'waiting'
  return (
    <div>
      {/* NO LANE TINT ON THE CARD. It was doing the same job as the lane chip 40px below it, and
          a whole column of tinted cards is loud — with 23 running, that tint IS the wall the
          board reads as. The chip carries the lane; the card carries the work. (It is also the
          house rule: no accent fills for state.) `--overlay-subtle` alone keeps a running card
          lifted off the column without claiming a second identity channel. */}
      <article
        className={landed ? 'tb-card is-landed' : 'tb-card'}
        data-task-card={task.id}
        data-task-landed={landed || undefined}
        style={cardStyle({ background: 'var(--overlay-subtle)' })}
      >
        <p className="tb-title" data-card-title title={task.text}>{headlineOf(task.text).title}</p>
        <LaneLine signal={signal} accent={accent} />
        {/* Delegation reads as a COLLAPSED ROW INSIDE the parent, never a nested board — the
            children belong to the lane's own session, and that is where the row takes you.
            Deliberately not expandable: `activeSubagents` is a count and nothing more, so an
            expander here would have to invent the child list it promised. */}
        {subagents > 0 && (
          <button
            className="tb-child"
            data-child-threads={subagents}
            onClick={() => task.roleId && onOpenLane?.(task.roleId)}
            disabled={!task.roleId || !onOpenLane}
            title={onOpenLane ? 'Open the lane to see them' : undefined}
          >
            <span style={{ color: 'var(--fg-muted)' }}>⤷</span>
            {subagents} active child thread{subagents > 1 ? 's' : ''}
          </button>
        )}
        <div style={META_ROW}>
          {/* THE ROUTE TO THE AGENT, and it has to be here rather than only on the child-threads
              row: that row needs `activeSubagents > 0`, so the common case — a lane working
              alone — had no way to reach the session at all. The board replaces the roster as
              project home, and the roster's `View →` was that route. The chip itself is the
              control: the lane's name is the most obvious thing to click to get to the lane, and
              it needs no width the row was not already spending. */}
          {task.roleId && laneLive && onOpenLane ? (
            <button
              className="tb-lane-open"
              data-card-open-lane={task.roleId}
              onClick={() => onOpenLane(task.roleId!)}
              title={`Open ${role?.name ?? 'this lane'}'s session`}
            >
              <AgentChip role={role} live={laneLive} lostRoleId={role ? undefined : task.roleId} />
              <span style={{ color: 'var(--fg-muted)', fontSize: 9.5 }}>→</span>
            </button>
          ) : (
            <AgentChip role={role} live={laneLive} lostRoleId={role ? undefined : task.roleId} />
          )}
          {/* ONE STATE FACT, NEVER TWO. A card that says it is RUNNING while also saying "Your
              turn" contradicts itself — and on the real board every running card said both,
              because the lane was idle awaiting input while its task still claimed to be
              running. The slot carries whichever is true: `your turn · 4h 4m` in the lane's ink
              when the agent is waiting on you, or the bare elapsed when it is working. */}
          <span
            data-card-time
            data-card-turn={awaitingYou || undefined}
            style={awaitingYou ? { ...TIME, color: laneTextColor(accent) } : TIME}
            title={`Started ${relativeTime(started)}`}
          >{awaitingYou ? `your turn · ${elapsed}` : elapsed}</span>
          <CheckChip task={task} />
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
            <DiffToggle task={task} open={diffOpen} onToggle={onToggleDiff} />
            <button className="tb-btn" data-card-done onClick={onDone} title="Mark this task done">Done ✓</button>
          </span>
        </div>
      </article>
      {diffOpen && <TaskDiffCard task={task} laneLive={laneLive} />}
    </div>
  )
}

/** What the lane is doing right now, one muted line.
 *
 *  The verb comes from `toolVerb` — the shared translation of Claude Code's tool name into what a
 *  waiting human wants to read. The assembly is local rather than `chatSignal` for one reason:
 *  chatSignal folds the subagent count into its label, and on a card the subagents are their own
 *  row (above), so using it would print the same fact twice. Same vocabulary, same source fields. */
function LaneLine({ signal, accent }: { signal?: LaneSignal; accent: string }) {
  if (!signal) return null
  if (signal.status === 'ended') return <p style={ACTIVITY}>Session ended</p>
  if (signal.phase === 'compacting') return <p style={ACTIVITY} data-lane-line>Compacting context</p>
  // `waiting` is deliberately NOT drawn here any more. The card's state slot says `your turn`
  // beside the elapsed time, and printing it twice is what made a running card contradict
  // itself. MOTION MEANS BUSY still holds either way: waiting is not busy, so nothing animates.
  if (signal.phase === 'waiting') return null
  if (signal.phase !== 'running') return null
  return (
    <p data-lane-line style={{ ...ACTIVITY, display: 'flex', alignItems: 'center', gap: 5 }}>
      <StatusWave status="running" size={11} seed={accent} accent={accent} />
      {toolVerb(signal.lastToolName) ?? 'Thinking'}
    </p>
  )
}

/** A held dispatch. The Waiting column's reason to exist: a lane asked for work to be
 *  commissioned, the authority gate stopped it, and nothing will happen until you say so.
 *
 *  The card leads with WHO ASKED WHOM, because that is the decision — approving is not "run this
 *  task", it is "let Research put this into Code". The state line is `chipForOutcome`, so every
 *  word here is one the dispatch log already writes; no state is invented for the board. */
function WaitingCard({ record, from, to, onApprove, onReject, onOpenLane, roles, onAssign }: {
  record: DispatchRecord
  from?: Role
  to?: Role
  onApprove?: (id: string) => void
  onReject?: (id: string) => void
  onOpenLane?: (roleId: string) => void
  /** Lanes this project actually has — the recovery path for a dispatch that named none. */
  roles?: Role[]
  onAssign?: (id: string, roleId: string) => void
}) {
  const chip = chipForOutcome(record.outcome)
  const approvable = record.outcome === 'pending-approval'
  // A dispatch that matched no lane. It creates no backlog row any more, so this card is the
  // only representation of that work — and a card with nothing to press would be exactly the
  // dead control this app has fixed three times. Route it, or close it.
  const unrouted = record.outcome === 'unassigned'
  return (
    <article
      className="tb-card"
      data-waiting-card={record.id}
      style={cardStyle({
        background: 'color-mix(in srgb, var(--color-warning) 6%, var(--overlay-subtle))',
        borderColor: 'color-mix(in srgb, var(--color-warning) 32%, var(--border))',
      })}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 5, minWidth: 0 }}>
        <AgentChip role={from} live={false} fallback={record.fromHuman ? 'You' : 'unknown lane'} />
        <span style={{ color: 'var(--fg-muted)', fontSize: 10, flexShrink: 0 }}>→</span>
        <AgentChip role={to} live={false} fallback={record.toRoleId ?? 'no matching lane'} />
        <span style={{ ...TIME, marginLeft: 'auto' }}>{relativeTime(record.at)}</span>
      </div>
      <p className="tb-title" data-card-title title={record.task}>{headlineOf(record.task).title}</p>
      {/* The held reason, in the warning hue put through the same palette correction as accent
          ink — raw `--color-warning` is #FF8D01 on 1984-light and measured 1.6:1 there, i.e. the
          one line on the board whose entire job is to be read was the least readable thing on it. */}
      <p data-waiting-reason style={{ ...ACTIVITY, color: laneTextColor('var(--color-warning)') }}>{chip.label}</p>
      {/* Where the bytes ended up — its own line, not a cell in the button row. Sharing that row
          with `Open lane →` and `Dismiss` truncated it to "Sitting in the lane's comp…" at the
          four-column width, which is where the board is read from. */}
      {record.outcome === 'undelivered' && (
        <p data-undelivered-where style={{ ...ACTIVITY, color: 'var(--fg-muted)' }}>Sitting in the lane’s composer</p>
      )}
      <div style={{ ...META_ROW, marginTop: 8 }}>
        {unrouted ? (
          <>
            {/* The rescue the backlog row used to provide: assign to a real lane and send. It
                re-enters the same delivery path an approval uses, so an idle lane launches and
                an unknown template is created exactly as for any other dispatch. */}
            <label className="tb-assignee" style={{ cursor: 'pointer' }}>
              <span style={{ ...TIME, fontSize: 10 }}>Route to</span>
              <select
                data-route-dispatch={record.id}
                defaultValue=""
                onChange={(e) => { if (e.target.value) onAssign?.(record.id, e.target.value) }}
                disabled={!onAssign || !(roles ?? []).length}
                style={{
                  font: 'inherit', fontSize: 10.5, color: 'var(--fg)', background: 'transparent',
                  border: 'none', outline: 'none', cursor: 'pointer', maxWidth: 120,
                }}
              >
                <option value="" disabled>a lane…</option>
                {(roles ?? []).map((r) => (<option key={r.id} value={r.id}>{r.name}</option>))}
              </select>
            </label>
            <button
              className="tb-btn"
              data-dismiss={record.id}
              style={{ marginLeft: 'auto' }}
              onClick={() => onReject?.(record.id)}
              disabled={!onReject}
              title="Dismiss — this dispatch is never delivered"
            >Dismiss</button>
          </>
        ) : approvable ? (
          <>
            {/* Explicit and PER CARD. No approve-all and no timeout: a timeout that approves is
                not a guardrail, and one button that approves eleven things is how you commission
                work you never read. */}
            <button
              className="tb-btn tb-btn-primary"
              data-approve={record.id}
              onClick={() => onApprove?.(record.id)}
              disabled={!onApprove}
              title={`Deliver this task to ${to?.name ?? 'the target lane'} now`}
            >Approve →</button>
            <button
              className="tb-btn"
              data-decline={record.id}
              onClick={() => onReject?.(record.id)}
              disabled={!onReject}
              title="Decline — this task is never delivered"
            >Decline</button>
          </>
        ) : (
          <>
            {/* `undelivered` is the only non-approvable outcome that reaches Waiting, so this is
                a statement rather than a ternary — the other half was dead code the moment the
                brakes left WAITING_OUTCOMES. Approve is deliberately absent: the bytes already
                went, so there is nothing to approve, and `reportUndelivered` does not retry.
                Dismiss is NOT a retry: it is the acknowledgement that this one is dead. Without
                it this branch was the only card on the board with no way out at all, and seven of
                them piled up in Waiting over three days with hand-editing projects.json as the
                only cure. The word, not a `✕` — a `✕` on a live card has meant "delete the lane"
                in this app, and cost real data.
                Open lane first, Dismiss last: the same order as the two branches above, where the
                thing that MOVES the work forward leads and the thing that closes it sits at the
                far right. They sit at the LEFT edge, where `Approve →`/`Decline` sit one card up
                in the same column — `Open lane →` kept `marginLeft: auto` only because it used to
                be alone in the row opposite a sentence, and holding onto that would have given
                the Waiting column two footer edges. */}
            {record.toRoleId && onOpenLane && (
              <button
                className="tb-btn"
                data-open-lane={record.toRoleId}
                onClick={() => onOpenLane(record.toRoleId!)}
              >Open lane →</button>
            )}
            <button
              className="tb-btn"
              data-dismiss={record.id}
              onClick={() => onReject?.(record.id)}
              disabled={!onReject}
              title="Dismiss — it stays in the dispatch log as declined"
            >Dismiss</button>
          </>
        )}
      </div>
    </article>
  )
}

function DoneCard({ task, role, laneLive, diffOpen, onToggleDiff, onRequeue, onRemove }: {
  task: ProjectTask
  role?: Role
  laneLive: boolean
  diffOpen: boolean
  onToggleDiff: () => void
  onRequeue: () => void
  onRemove: () => void
}) {
  // A reconciled task was closed because its RUN ended, not because it was seen to finish — so
  // it never gets the completion tick. Marking ~200 stranded tasks with a plain ✓ would claim
  // work was verified that nobody verified.
  const unconfirmed = task.status === 'abandoned' || !!task.reconciledAt
  const closedAt = task.doneAt ?? task.reconciledAt ?? task.createdAt
  return (
    <div>
      <article className="tb-card" data-task-card={task.id} style={cardStyle()}>
        <DeleteButton title="Delete task" onClick={onRemove} />
        {/* NO GLYPH PREFIX. Every closed card used to open with `⋯` or `✓`, so the column read
            as a list of marks rather than of work, and on a board where everything closed
            unwatched it was 20 identical `⋯` down the left edge. The distinction survives where
            it belongs: the column header carries the honest split, and an unwatched card greys
            its own headline. */}
        <p
          className="tb-title tb-title-closed"
          data-card-title
          title={task.text}
          data-card-unseen={unconfirmed || undefined}
          // Receded, but NOT to bare `--fg-muted`: measured 4.06 / 3.73 / 3.86:1 on the three
          // light palettes at 12.5px, i.e. under the 4.5 floor for body text — the driver caught
          // it. Mixed 45% toward `--fg` it still reads as demoted next to a confirmed card while
          // staying legible, the same correction the sidebar's project name uses.
          style={unconfirmed ? { color: 'color-mix(in srgb, var(--fg-muted) 55%, var(--fg))' } : undefined}
        >
          {headlineOf(task.text).title}
        </p>
        <div style={META_ROW}>
          <AgentChip role={role} live={false} lostRoleId={role ? undefined : task.roleId} />
          <span data-card-time style={TIME}>{relativeTime(closedAt)}</span>
          {/* One word, not two shapes. `abandoned` on every card in a column where every card is
              abandoned is noise that says nothing about THIS task; `unseen` states the only fact
              that differs from its neighbours — nobody watched it finish. */}
          {unconfirmed && (
            <span data-card-unconfirmed title="Closed automatically: nobody saw this one finish" style={{ ...LABEL, fontSize: 8.5, letterSpacing: '0.06em' }}>
              unseen
            </span>
          )}
          <CheckChip task={task} />
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
            <DiffToggle task={task} open={diffOpen} onToggle={onToggleDiff} />
            <button className="tb-btn tb-btn-icon" data-card-requeue onClick={onRequeue} title="Put this back in the backlog">↩</button>
          </span>
        </div>
      </article>
      {diffOpen && <TaskDiffCard task={task} laneLive={laneLive} />}
    </div>
  )
}

// ── Card parts ──────────────────────────────────────────────────────────────────────────────

/** The agent, reduced to a chip: the lane's colour on a dot, its name in ink that survives a
 *  light palette (`laneTextColor`). Liveness rides the dot's FILL, never its border — a
 *  colour-changing border on a radiused element re-rasterizes and freezes WKWebView.
 *
 *  `lostRoleId` is the case that must never collapse into `fallback`: the task names a lane the
 *  roster no longer has. "Unassigned" would say NEVER ASSIGNED when the truth is ASSIGNED TO A
 *  LANE THAT IS GONE — the opposite — and it hides why nothing sends. WaitingCard already got
 *  this right; this is the same treatment for the task cards and the picker. */
function AgentChip({ role, live, fallback = 'Unassigned', lostRoleId }: {
  role?: Role
  live: boolean
  fallback?: string
  lostRoleId?: string
}) {
  const accent = role?.accent || 'var(--accent)'
  const fill = !role
    ? 'color-mix(in srgb, var(--fg-muted) 45%, transparent)'
    : live ? accent : `color-mix(in srgb, ${accent} 45%, transparent)`
  const label = role?.name ?? (lostRoleId ? `${lostRoleId} — lane gone` : fallback)
  return (
    <span
      data-card-agent={role?.id ?? ''}
      data-card-agent-lost={lostRoleId || undefined}
      title={role
        ? (live ? `${role.name} — live` : role.name)
        : lostRoleId ? `This task was assigned to "${lostRoleId}", which is no longer on the roster. Reassign it to send it.` : fallback}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0, flexShrink: 1 }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: fill }} />
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 9.5, whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis',
        color: role ? laneTextColor(role.accent) : 'var(--fg-muted)',
      }}>{label}</span>
    </span>
  )
}

/** The task's change, inline on the card: `+142 −38 · 3 files` when the stat was captured at
 *  completion, a plain `Diff` when there is a source to resolve one from but no summary yet. */
function DiffToggle({ task, open, onToggle }: { task: ProjectTask; open: boolean; onToggle: () => void }) {
  if (!taskHasDiffSource(task)) return null
  const stat = task.diffStat
  return (
    <button
      className="tb-btn"
      data-card-diff
      onClick={onToggle}
      title="View this task's code change"
      style={{ color: open ? ACCENT_INK : 'var(--fg-muted)' }}
    >
      {stat ? (
        <>
          <span style={{ color: 'var(--add-fg)' }}>+{stat.added}</span>{' '}
          <span style={{ color: 'var(--del-fg)' }}>−{stat.removed}</span>
          {stat.files > 0 && <span> · {stat.files} file{stat.files > 1 ? 's' : ''}</span>}
        </>
      ) : 'Diff'} {open ? '▾' : '▸'}
    </button>
  )
}

/** The verification gate: the project's check command run in the lane's dir at completion.
 *  Coloured text only — no fill — per the UI rules. */
function CheckChip({ task }: { task: ProjectTask }) {
  if (!task.check) return null
  const s = task.check.status
  return (
    <span
      data-card-check={s}
      title={s === 'running' ? 'Check running…' : (task.check.output || 'no output')}
      style={{
        flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9.5,
        color: s === 'pass' ? 'var(--add-fg)' : s === 'fail' ? 'var(--del-fg)' : 'var(--fg-muted)',
      }}
    >{s === 'running' ? '⋯ check' : s === 'pass' ? '✓ check' : '✗ check'}</span>
  )
}

/** Delete, and only delete. Corner-anchored and hover-revealed so it reserves no space at rest
 *  and can never be the thing your eye lands on. `✕` means exactly one verb on this board —
 *  remove this task — and it is never offered on a running card. */
function DeleteButton({ title, onClick }: { title: string; onClick: () => void }) {
  return <button className="tb-del" data-card-delete onClick={onClick} title={title} aria-label={title}>✕</button>
}

/** Column state pip. Motion only where something is genuinely busy: the Running pip is the real
 *  StatusWave, every other state rests as a flat dot. */
function Pip({ tone }: { tone: 'idle' | 'running' | 'waiting' | 'done' }) {
  if (tone === 'running') return <StatusWave status="running" size={11} seed="board-running" />
  const bg = tone === 'waiting' ? 'var(--color-warning)'
    : tone === 'done' ? 'color-mix(in srgb, var(--accent) 60%, transparent)'
      : 'color-mix(in srgb, var(--fg-muted) 45%, transparent)'
  return <span style={{ width: 6, height: 6, borderRadius: '50%', background: bg, flexShrink: 0 }} />
}

/** An empty column. The dashed box stays; what changed is that the four of them are now the
 *  SAME box.
 *
 *  They were 80.5px in Backlog against 52.5px everywhere else, and the whole difference was one
 *  control: an `+ Add a task` button at `marginTop: 8` that only this column had. Three empty
 *  states of one height beside a fourth of another reads as a layout fault, not as a column that
 *  can be acted on — the asymmetry is real, but it belongs in the header beside the column's own
 *  name, which is where the `+` now lives (30px away, and unambiguously Backlog's). One verb,
 *  one control, and four identical boxes by construction rather than by tuning. */
function EmptyColumn({ text }: { text: string }) {
  return (
    <div data-column-empty style={{
      border: '1px dashed var(--border)', borderRadius: 'var(--radius-md)',
      padding: '18px 12px', textAlign: 'center',
    }}>
      <p style={{ fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.5 }}>{text}</p>
    </div>
  )
}

// ── Composer ────────────────────────────────────────────────────────────────────────────────

const MAX_H = 160

/** Add a task. Same behaviours as the queue's input, because they were the requirements: the
 *  field grows with its content up to a cap, Enter adds, Shift+Enter is a newline, and the
 *  assignee is optional — an unassigned task is a legitimate thing to file. */
function TaskComposer({ roles, liveRoles, onAdd, onCancel, hero, autoFocus }: {
  roles: Role[]
  liveRoles?: Record<string, string>
  onAdd: (text: string, roleId?: string) => void
  onCancel?: () => void
  hero?: boolean
  autoFocus?: boolean
}) {
  const [draft, setDraft] = useState('')
  const [assignee, setAssignee] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`
    el.style.overflowY = el.scrollHeight > MAX_H ? 'auto' : 'hidden'
  }, [draft])

  useEffect(() => { if (autoFocus) ref.current?.focus() }, [autoFocus])

  const add = () => { if (draft.trim()) { onAdd(draft, assignee || undefined); setDraft('') } }

  return (
    <div data-board-composer style={{
      borderRadius: 'var(--radius-md)', background: 'var(--overlay-subtle)',
      border: '1px solid var(--border)', padding: '2px 2px 6px', textAlign: 'left',
    }}>
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add() }
          if (e.key === 'Escape' && onCancel) { e.preventDefault(); onCancel() }
        }}
        placeholder={hero ? 'e.g. Make the preview URL bar accept a path' : 'Add a task…'}
        rows={1}
        style={{
          width: '100%', boxSizing: 'border-box', resize: 'none', overflowY: 'hidden',
          fontFamily: 'var(--font-body)', fontSize: hero ? 13 : 12.5, lineHeight: 1.45,
          background: 'transparent', color: 'var(--fg)', border: 'none', outline: 'none',
          padding: '8px 10px 2px', margin: 0,
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 6px' }}>
        <AssigneePicker roles={roles} value={assignee} liveRoles={liveRoles} onChange={setAssignee} placeholder="Unassigned" />
        {onCancel && <button className="tb-btn" onClick={onCancel} style={{ marginLeft: 'auto' }}>Cancel</button>}
        <button
          className="tb-btn tb-btn-primary"
          data-board-add-submit
          onClick={add}
          disabled={!draft.trim()}
          style={onCancel ? undefined : { marginLeft: 'auto' }}
        >Add</button>
      </div>
    </div>
  )
}

/** Lane picker: the same coloured-dot + native-select control the queue uses, so assigning a
 *  task means the same thing and looks the same wherever you do it. */
function AssigneePicker({ roles, value, onChange, liveRoles, placeholder = 'Assign…' }: {
  roles: Role[]
  value: string
  onChange: (roleId: string) => void
  liveRoles?: Record<string, string>
  placeholder?: string
}) {
  const role = roles.find((r) => r.id === value)
  const live = value ? !!liveRoles?.[value] : false
  const accent = role?.accent || 'var(--accent)'
  const fill = !role
    ? 'color-mix(in srgb, var(--fg-muted) 45%, transparent)'
    : live ? accent : `color-mix(in srgb, ${accent} 45%, transparent)`
  // A value the roster can't resolve is a lane that was DELETED, not an empty assignment. Saying
  // "Assign…" there claims the task was never assigned and leaves the user with no explanation
  // for why Send does nothing.
  const lost = !!value && !role
  return (
    <span className="tb-assignee" data-card-assignee={value} title={lost ? `Assigned to "${value}", which is no longer on the roster — pick a lane to send it.` : undefined}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: fill }} />
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 9.5, maxWidth: 88,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        color: role ? laneTextColor(role.accent) : 'var(--fg-muted)',
      }}>{role ? role.name : lost ? `${value} — gone` : placeholder}</span>
      {/* The select is invisible (the chip beside it is the visible control), but macOS draws the
          native popup at the SELECT's own font — and a `<select>` does not inherit type, so with
          nothing set here it fell back to the UA default and opened a menu far larger than any
          text on the board. Setting the font on the hidden element is what sizes the popup; the
          menu's own colours stay the system's, which is not ours to theme. */}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Assign an agent"
        style={{
          position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%',
          fontFamily: 'var(--font-mono)', fontSize: 11,
        }}
      >
        <option value="">Unassigned</option>
        {roles.map((r) => (
          <option key={r.id} value={r.id}>{r.name}{liveRoles?.[r.id] ? ' · live' : ''}</option>
        ))}
      </select>
    </span>
  )
}

// ── Shared style bits ───────────────────────────────────────────────────────────────────────

const META_ROW: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, minWidth: 0,
}

const TIME: React.CSSProperties = {
  flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9.5,
  fontVariantNumeric: 'tabular-nums', color: 'var(--fg-muted)',
}

const ACTIVITY: React.CSSProperties = {
  marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)',
}

/** A card is an OBJECT on the field: a defined edge and a tinted surface, never a group opacity
 *  (which compounds, halves every child's contrast, and can't be overridden per child) and never
 *  a coloured left-edge stripe. State rides the tint and the border. */
function cardStyle(over?: { background?: string; borderColor?: string }): React.CSSProperties {
  return {
    position: 'relative',
    border: `1px solid ${over?.borderColor ?? 'var(--border)'}`,
    borderRadius: 'var(--radius-md)',
    background: over?.background ?? 'var(--overlay-subtle)',
    padding: '9px 10px',
  }
}

// ── Hooks ───────────────────────────────────────────────────────────────────────────────────

/** How many columns fit. Measured on the CONTAINER, not the window: the board sits between a
 *  collapsible sidebar and a resizable right panel, either of which can take its width without
 *  the window changing size at all. */
function useResponsiveColumns(ref: React.RefObject<HTMLDivElement | null>): number {
  const [cols, setCols] = useState(4)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const w = el.clientWidth
      setCols(w >= FOUR_COL ? 4 : w >= TWO_COL ? 2 : 1)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return cols
}

/** Task ids that have just MOVED INTO Running, so the card can be marked for a moment.
 *
 *  `Send →` used to navigate you into the lane's terminal, so the one piece of feedback the board
 *  already had — the card moving Backlog → Running — was something you were never present to see.
 *  Now that the verb leaves you on the board, the move is the feedback; this only makes it
 *  catchable when your eyes are on the column you clicked in, one over.
 *
 *  The first render is deliberately skipped: on mount every running task is "new" to this hook
 *  and none of it just happened, so flashing them would make an ordinary page load look like six
 *  things had landed at once. */
function useJustLanded(running: ProjectTask[]): Set<string> {
  const seen = useRef<Set<string> | null>(null)
  const timers = useRef<number[]>([])
  const [landed, setLanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    const ids = new Set(running.map((t) => t.id))
    const prev = seen.current
    seen.current = ids
    if (!prev) return
    const fresh = [...ids].filter((id) => !prev.has(id))
    if (!fresh.length) return
    setLanded((s) => new Set([...s, ...fresh]))
    // One timer per batch, tracked rather than cancelled on the next change: a second card
    // landing must not cancel the first one's clear, which is how a mark gets stuck on forever.
    const t = window.setTimeout(() => {
      setLanded((s) => {
        const n = new Set(s)
        for (const id of fresh) n.delete(id)
        return n
      })
    }, LANDED_MS)
    timers.current.push(t)
  }, [running])

  useEffect(() => () => { for (const t of timers.current) clearTimeout(t) }, [])
  return landed
}

/** A slow clock, so "12m" on a running card doesn't sit frozen at whatever it said when the
 *  board mounted. Thirty seconds: the finest granularity anything here prints is a minute.
 *
 *  `resetKey` re-reads the clock immediately when it changes, and restarts the interval from
 *  there. A coarse cached clock is fine for ageing a card that was already on screen and wrong
 *  for one that has just appeared — which is now the common case, since a task lands in Running
 *  while you are looking at it. */
function useTicking(intervalMs: number, resetKey?: unknown): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs, resetKey])
  return now
}
