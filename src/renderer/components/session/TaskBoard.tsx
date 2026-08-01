import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentSession, DispatchRecord, ProjectTask, Role } from '../../../shared/types'
import { isClosed, statusOf } from '../../lib/task-lifecycle'
import { taskHasDiffSource } from '../../lib/task-diff'
import { chipForOutcome } from '../../lib/project-channel'
import { toolVerb } from '../../lib/chat-signal'
import { fmtDuration, relativeTime } from '../../lib/format'
import { laneTextColor } from '../../lib/lane-color'
import { StatusWave } from '../sidebar/StatusWave'
import { TaskDiffCard } from './TaskDiffCard'

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

/** The dispatch outcomes that mean NOTHING WAS DELIVERED and nothing retries on its own — i.e.
 *  the work is stopped until a human does something. That is exactly the Waiting column.
 *
 *  `pending-approval` is the only one a button can resolve (it routes to the existing approval
 *  gate). The three brakes are released by time, a human message, or the kill switch — never by
 *  an Approve, so their cards carry the reason and no approve verb.
 *
 *  `undelivered` is included even though the channel's own `held` set excludes it: it was SENT
 *  and then observed never to start, so the task is sitting in a lane's composer right now. That
 *  is the most stranded a task can be, and with the channel going away (move 03) this board is
 *  the only surface left that could say so. */
const WAITING_OUTCOMES = new Set<DispatchRecord['outcome']>([
  'pending-approval', 'hop-limit', 'pair-brake', 'paused', 'undelivered',
])

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
}

export type BoardColumnKey = 'backlog' | 'running' | 'waiting' | 'done'

export interface BoardPartition {
  backlog: ProjectTask[]
  running: ProjectTask[]
  waiting: DispatchRecord[]
  done: ProjectTask[]
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
    // `replyId` records are excluded, and this is not a detail: in the real store EVERY held
    // record but one carries a replyId. Such a record is the DELIVERY of a lane's OPERATOR-REPLY,
    // not a dispatch of work — the reply itself already lives in chat.db, and the record only
    // says what happened when we tried to hand it over. Rendering them as work would have filled
    // the Waiting column with three chat messages and one actual approval.
    waiting: (dispatches ?? []).filter((d) => !d.replyId && WAITING_OUTCOMES.has(d.outcome))
      .sort((a, b) => b.at.localeCompare(a.at)),
    done: done.sort((a, b) => closedAt(b).localeCompare(closedAt(a))),
    unconfirmed: done.filter((t) => t.status === 'abandoned' || !!t.reconciledAt).length,
  }
}

// Column widths below which four side-by-side columns stop being a board and start being four
// gutters. Measured on the container, not the window: the board sits inside a shell whose
// sidebar and right panel both resize independently of it.
const FOUR_COL = 980
const TWO_COL = 660
const TICK_MS = 30_000 // how often the elapsed/relative times refresh

export function TaskBoard(props: TaskBoardProps) {
  const { tasks, roles, liveRoles, dispatches, laneSignals } = props
  const shellRef = useRef<HTMLDivElement>(null)
  const cols = useResponsiveColumns(shellRef)
  const now = useTicking(TICK_MS)
  const [composing, setComposing] = useState(false)
  const [openDiff, setOpenDiff] = useState<Set<string>>(new Set())

  const board = useMemo(() => partitionBoard(tasks, dispatches), [tasks, dispatches])
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
                onAssign={props.onAssignTask}
                onSend={props.onSendTask}
                onRemove={props.onRemoveTask}
              />
            ))}
            {board.backlog.length === 0 && !composing && (
              <EmptyColumn text="Nothing queued." action={{ label: '+ Add a task', run: () => setComposing(true) }} />
            )}
          </>
        )
      case 'running':
        return board.running.length === 0
          ? <EmptyColumn text="No agent is working right now." />
          : board.running.map((task) => (
            <RunningCard
              key={task.id}
              task={task}
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
            />
          ))
      case 'done':
        return board.done.length === 0
          ? <EmptyColumn text="Nothing finished yet." />
          : board.done.map((task) => (
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
          ))
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
              <header style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 2px 8px', flexShrink: 0 }}>
                <Pip
                  tone={
                    c.key === 'running' ? (n > 0 ? 'running' : 'idle')
                      : c.key === 'waiting' ? (n > 0 ? 'waiting' : 'idle')
                        : c.key === 'done' ? 'done' : 'idle'
                  }
                />
                <span style={LABEL}>{c.title}</span>
                <span
                  data-board-count={c.key}
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, fontVariantNumeric: 'tabular-nums', color: n > 0 ? 'var(--fg)' : 'var(--fg-muted)' }}
                >{n}</span>
                {c.key === 'done' && board.unconfirmed > 0 && (
                  // Named, not folded into the count: an abandoned task is not a finished one.
                  <span data-board-unconfirmed style={{ ...LABEL, letterSpacing: '0.06em' }}>
                    · {board.unconfirmed} unconfirmed
                  </span>
                )}
                {c.key === 'backlog' && (
                  <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
                    {dispatchable > 0 && props.onStartAll && (
                      <button
                        data-board-start-all
                        className="tb-btn"
                        onClick={props.onStartAll}
                        title={`Dispatch ${dispatchable} assigned task${dispatchable > 1 ? 's' : ''} to their agents`}
                      >Start all →</button>
                    )}
                    <button
                      data-board-add
                      className="tb-btn tb-btn-icon"
                      onClick={() => setComposing((v) => !v)}
                      title="Add a task"
                      aria-expanded={composing}
                    >+</button>
                  </span>
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

const SHELL: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
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

function BacklogCard({ task, role, roles, liveRoles, onAssign, onSend, onRemove }: {
  task: ProjectTask
  role?: Role
  roles: Role[]
  liveRoles?: Record<string, string>
  onAssign: (taskId: string, roleId?: string) => void
  onSend: (task: ProjectTask) => void
  onRemove: (taskId: string) => void
}) {
  return (
    <article className="tb-card" data-task-card={task.id} style={cardStyle()}>
      <DeleteButton title="Delete task" onClick={() => onRemove(task.id)} />
      <p className="tb-title" data-card-title>{task.text}</p>
      <div style={META_ROW}>
        <AssigneePicker
          roles={roles}
          value={task.roleId ?? ''}
          liveRoles={liveRoles}
          onChange={(id) => onAssign(task.id, id || undefined)}
        />
        <span data-card-time style={TIME}>{relativeTime(task.createdAt)}</span>
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

function RunningCard({ task, role, signal, now, laneLive, diffOpen, onToggleDiff, onDone, onOpenLane }: {
  task: ProjectTask
  role?: Role
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
  return (
    <div>
      <article
        className="tb-card"
        data-task-card={task.id}
        style={cardStyle({
          background: `color-mix(in srgb, ${accent} 5%, var(--overlay-subtle))`,
          borderColor: `color-mix(in srgb, ${accent} 30%, var(--border))`,
        })}
      >
        <p className="tb-title" data-card-title>{task.text}</p>
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
          <AgentChip role={role} live={laneLive} />
          <span data-card-time style={TIME} title={`Started ${relativeTime(started)}`}>{elapsed}</span>
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
  if (signal.phase === 'waiting') {
    // Your turn. MOTION MEANS BUSY is the app-wide rule and waiting is not busy — so this rests
    // static and carries its meaning in the words, drawn in the lane's ink so it catches the eye
    // without a pulse.
    return (
      <p data-lane-line style={{ ...ACTIVITY, color: laneTextColor(accent) }}>Your turn</p>
    )
  }
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
function WaitingCard({ record, from, to, onApprove, onReject, onOpenLane }: {
  record: DispatchRecord
  from?: Role
  to?: Role
  onApprove?: (id: string) => void
  onReject?: (id: string) => void
  onOpenLane?: (roleId: string) => void
}) {
  const chip = chipForOutcome(record.outcome)
  const approvable = record.outcome === 'pending-approval'
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
      <p className="tb-title" data-card-title>{record.task}</p>
      {/* The held reason, in the warning hue put through the same palette correction as accent
          ink — raw `--color-warning` is #FF8D01 on 1984-light and measured 1.6:1 there, i.e. the
          one line on the board whose entire job is to be read was the least readable thing on it. */}
      <p data-waiting-reason style={{ ...ACTIVITY, color: laneTextColor('var(--color-warning)') }}>{chip.label}</p>
      <div style={{ ...META_ROW, marginTop: 8 }}>
        {approvable ? (
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
            {/* Not approvable, and saying so is the point: a brake is released by time, a human
                message, or the kill switch, and `undelivered` needs the stranded composer cleared
                by hand. An Approve button here would promise a recovery it can't perform. */}
            <span style={{ ...TIME, fontSize: 10 }}>
              {record.outcome === 'undelivered' ? 'Sitting in the lane’s composer' : 'Nothing retries on its own'}
            </span>
            {record.toRoleId && onOpenLane && (
              <button
                className="tb-btn"
                data-open-lane={record.toRoleId}
                style={{ marginLeft: 'auto' }}
                onClick={() => onOpenLane(record.toRoleId!)}
              >Open lane →</button>
            )}
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
        <p className="tb-title tb-title-closed" data-card-title>
          <span
            data-card-tick
            style={{ color: unconfirmed ? 'var(--fg-muted)' : ACCENT_INK }}
            title={unconfirmed ? 'Closed automatically: the session running it ended before it reported back' : 'Finished'}
          >{unconfirmed ? '⋯' : '✓'}</span>{' '}
          {task.text}
        </p>
        <div style={META_ROW}>
          <AgentChip role={role} live={false} />
          <span data-card-time style={TIME}>{relativeTime(closedAt)}</span>
          {unconfirmed && (
            <span data-card-unconfirmed style={{ ...LABEL, fontSize: 8.5, letterSpacing: '0.06em' }}>
              {task.status === 'abandoned' ? 'abandoned' : 'unconfirmed'}
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
 *  colour-changing border on a radiused element re-rasterizes and freezes WKWebView. */
function AgentChip({ role, live, fallback = 'Unassigned' }: { role?: Role; live: boolean; fallback?: string }) {
  const accent = role?.accent || 'var(--accent)'
  const fill = !role
    ? 'color-mix(in srgb, var(--fg-muted) 45%, transparent)'
    : live ? accent : `color-mix(in srgb, ${accent} 45%, transparent)`
  return (
    <span
      data-card-agent={role?.id ?? ''}
      title={role ? (live ? `${role.name} — live` : role.name) : fallback}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0, flexShrink: 1 }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: fill }} />
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 9.5, whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis',
        color: role ? laneTextColor(role.accent) : 'var(--fg-muted)',
      }}>{role?.name ?? fallback}</span>
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

function EmptyColumn({ text, action }: { text: string; action?: { label: string; run: () => void } }) {
  return (
    <div data-column-empty style={{
      border: '1px dashed var(--border)', borderRadius: 'var(--radius-md)',
      padding: '18px 12px', textAlign: 'center',
    }}>
      <p style={{ fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.5 }}>{text}</p>
      {action && (
        <button className="tb-btn" onClick={action.run} style={{ marginTop: 8 }}>{action.label}</button>
      )}
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
  return (
    <span className="tb-assignee" data-card-assignee={value}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: fill }} />
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 9.5, maxWidth: 88,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        color: role ? laneTextColor(role.accent) : 'var(--fg-muted)',
      }}>{role ? role.name : placeholder}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Assign an agent"
        style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' }}
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

/** A slow clock, so "12m" on a running card doesn't sit frozen at whatever it said when the
 *  board mounted. Thirty seconds: the finest granularity anything here prints is a minute. */
function useTicking(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}
