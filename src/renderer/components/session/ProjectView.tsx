import type { Project, ProjectPatch, Role, ProjectTask } from '../../../shared/types'
import { DragRegion } from '../DragRegion'
import { SidebarToggle } from '../SidebarToggle'
import { RosterPanel, type LaneSession } from './RosterPanel'
import { MoodboardPanel } from './MoodboardPanel'
import { TaskBoard, type LaneSignal } from './TaskBoard'
import { DispatchLog } from './DispatchLog'

// The project-level workspace. Home for the things that belong to the PROJECT (not a single
// session).
//
// THE BOARD IS PROJECT HOME. It used to be the roster: entering a project landed you on six
// agent cards with model/effort/worktree controls, and the actual work — the task queue — sat
// below the fold. That inversion is what made the app read as an org chart rather than a place
// where work happens. The primary object is the WORK now; the agent is a chip on a card.
//
// The roster keeps everything it had, one tab across, as Team. Six lanes, same names, same
// charters — this is a demotion of the roster's PROMINENCE, never of its cast.

type ProjectTab = 'board' | 'team' | 'moodboard'
const LABELS: Record<ProjectTab, string> = { board: 'Board', team: 'Team', moodboard: 'Moodboard' }

export function ProjectView({
  project, tab, onSelectTab, onBack, onToggleSidebar, sidebarCollapsed,
  onUpdateProject, onLaunchRole, liveRoles, laneSessions, laneSignals, onFocusTerminal, onCloseTerminal,
  onAddTask, onAssignTask, onRemoveTask, onSendTask, onStartAll, onSetTaskStatus,
  onApproveDispatch, onRejectDispatch, onAssignDispatch,
  resumableCount, onResumeProject, chatterPaused, onToggleChatter,
  addLaneRequest, onAddLaneRequestHandled,
}: {
  project: Project
  tab: ProjectTab
  onSelectTab: (t: ProjectTab) => void
  /** Back to the gallery — the drill-in needs a visible way out even with the sidebar collapsed. */
  onBack?: () => void
  /** Collapse/expand the sidebar — the same control the session toolbar and the channel carry.
   *  `SessionToolbar` is not rendered in this content mode, so without it there is no toggle here. */
  onToggleSidebar?: () => void
  sidebarCollapsed?: boolean
  onUpdateProject?: (id: string, patch: ProjectPatch) => void
  /** `brief` is the launch row's "what do you want done?" — the agent's opening message.
   *  `launchDevServer` is required (an optional one silently launched with it off), and the
   *  result is reported back so the roster can tell a failed spawn from a successful one. */
  onLaunchRole?: (project: Project, role: Role, opts: { brief?: string; launchDevServer: boolean }) => Promise<{ id: string } | undefined> | void
  liveRoles?: Record<string, string>
  /** roleId → live session runtime (phase/usage), for the Team card's mission-control read. */
  laneSessions?: Record<string, LaneSession>
  /** roleId → what that lane is DOING right now, for the board's running cards. Same source
   *  object as `laneSessions` — two narrower views of one map, so the two surfaces can't
   *  disagree about which lane is busy. */
  laneSignals?: Record<string, LaneSignal>
  onFocusTerminal?: (terminalId: string) => void
  onCloseTerminal?: (terminalId: string) => void
  onAddTask: (text: string, roleId?: string) => void
  onAssignTask: (taskId: string, roleId?: string) => void
  onRemoveTask: (taskId: string) => void
  onSendTask: (task: ProjectTask) => void
  onStartAll: () => void
  onSetTaskStatus: (taskId: string, status: ProjectTask['status']) => void
  /** Approve / decline a dispatch a NON-coordinator lane asked for. Absent = read-only log. */
  onApproveDispatch?: (projectId: string, id: string) => void
  onRejectDispatch?: (projectId: string, id: string) => void
  /** Route an unassigned dispatch to a real lane — the Waiting card's recovery path. */
  onAssignDispatch?: (projectId: string, id: string, roleId: string) => void
  /** Saved-but-not-live agents of this project — resumable as a group. */
  resumableCount?: number
  onResumeProject?: () => void
  /** The agent→agent delivery kill switch. It lived in the channel header, which is gone; a
   *  switch that exists for incidents has to stay reachable during one, so it sits on Team —
   *  next to the lanes whose chatter it stops. */
  chatterPaused?: boolean
  onToggleChatter?: () => void
  /** A lane was asked for from outside — the sidebar's `+`. Forwarded to the roster, which is
   *  the surface that owns adding one; see `RosterPanel`'s prop doc for why it's consume-once. */
  addLaneRequest?: boolean
  onAddLaneRequestHandled?: () => void
}) {
  const tabs: ProjectTab[] = ['board', 'team', 'moodboard']
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, background: 'var(--bg-terminal)' }}>
      <DragRegion data-toolbar-header="project" style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, height: 44, padding: '0 16px', boxSizing: 'border-box', borderBottom: '1px solid var(--border)' }}>
        {/* Same control, same position as the other two toolbar headers. */}
        {onToggleSidebar && (
          <SidebarToggle collapsed={sidebarCollapsed} onToggle={onToggleSidebar} />
        )}
        {/* Leading back-chevron: the way out of the drill-in, present even when the sidebar
            (with its logo) is collapsed. */}
        {onBack && (
          <button
            onClick={onBack}
            title="All projects (⌘⇧O)"
            aria-label="All projects"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 16, height: 16, padding: 0, marginRight: -6, flexShrink: 0,
              background: 'none', border: 'none', outline: 'none', cursor: 'pointer',
              color: 'var(--fg-muted)', fontSize: 12, lineHeight: 1,
            }}
          >‹</button>
        )}
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {project.name}
        </span>
        <span style={{ display: 'flex', gap: 2 }}>
          {tabs.map((id) => (
            <button
              key={id}
              // Test hooks: which tab you LAND on is the whole point of several navigation
              // verbs (the sidebar's `+` says roster and must reach TEAM), and the only other
              // signal is the accent colour — which a driver can't read as intent.
              data-project-tab={id}
              data-project-tab-active={tab === id ? 'true' : undefined}
              onClick={() => onSelectTab(id)}
              style={{
                fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 500,
                textTransform: 'uppercase', letterSpacing: '0.14em', cursor: 'pointer', outline: 'none',
                padding: '3px 10px', borderRadius: 6, border: 'none', background: 'transparent',
                color: tab === id ? 'var(--accent)' : 'var(--fg-muted)',
              }}
            >
              {LABELS[id]}
            </button>
          ))}
        </span>
        {/* Group resume: bring back every previously open agent of this project. */}
        {(resumableCount ?? 0) > 0 && onResumeProject && (
          <button
            onClick={onResumeProject}
            title="Re-open every previously open agent of this project, continuing its conversation"
            style={{
              marginLeft: 'auto', cursor: 'pointer', outline: 'none',
              fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 500,
              textTransform: 'uppercase', letterSpacing: '0.14em',
              padding: '3px 10px', borderRadius: 6,
              border: '1px solid var(--border)', background: 'transparent',
              color: 'var(--fg-muted)',
            }}
          >
            Resume {resumableCount} agent{resumableCount! > 1 ? 's' : ''}
          </button>
        )}
      </DragRegion>
      {/* `scroll`, not `auto`, because the roster below is a CENTRED measure box. styles.css
          gives ::-webkit-scrollbar an explicit width, which makes it a classic scrollbar that
          eats 6px of the content box — so a centred child re-centred 3px to the left the
          moment the roster grew past the fold (measured: 374 → 371). Always-on reserves that
          6px in both states; the track is transparent and a short roster draws no thumb, so
          nothing about it is visible.
          The toolbar header above is full-width and NOT centred, so it never moved: this view
          needs the reservation, not PageShell's move-the-header-inside restructure. */}
      <div style={{ flex: 1, minHeight: 0, overflowY: tab === 'team' ? 'scroll' : undefined }}>
        {/* THE BOARD gets a BOUNDED box and the full width — no centred measure column. The
            760px column is exactly why the roster reads as a form, and the board is a board:
            it measures its OWN width with a ResizeObserver to choose 4 / 2×2 / stacked columns,
            so a parent that shrinks to fit its content would feed the measurement back into
            itself. `height: 100%` + `minHeight: 0` gives it the definite height its inner
            `flex: 1` grid resolves against; an auto-height parent renders it invisible. */}
        {tab === 'board' && (
          <div style={{ height: '100%', minHeight: 0, width: '100%' }}>
            <TaskBoard
              tasks={project.tasks ?? []}
              roles={project.roster ?? []}
              liveRoles={liveRoles}
              dispatches={project.dispatches}
              laneSignals={laneSignals}
              onAddTask={onAddTask}
              onAssignTask={onAssignTask}
              onRemoveTask={onRemoveTask}
              onSendTask={onSendTask}
              onStartAll={onStartAll}
              onSetTaskStatus={onSetTaskStatus}
              onApproveDispatch={onApproveDispatch && ((id) => onApproveDispatch(project.id, id))}
              onAssignDispatch={onAssignDispatch && ((id, roleId) => onAssignDispatch(project.id, id, roleId))}
              onRejectDispatch={onRejectDispatch && ((id) => onRejectDispatch(project.id, id))}
              onOpenLane={(roleId) => {
                // A lane that ISN'T running has no terminal to focus, and this guard used to end
                // there — so on the one card that most needs it (a task sitting unread in a lane
                // that never started) the button silently did nothing. That is the state the card
                // is ABOUT: `never started` is printed two lines above it. Fall through to the
                // roster, where a lane that isn't running is launched, so the control always
                // moves you somewhere instead of dying on the exact case it exists for.
                const tid = liveRoles?.[roleId]
                if (tid) onFocusTerminal?.(tid)
                else onSelectTab('team')
              }}
            />
          </div>
        )}
        {tab === 'team' && (
          <div style={{ maxWidth: 760, margin: '0 auto', padding: '10px 16px 28px' }}>
            <RosterPanel
              project={project}
              onUpdateProject={onUpdateProject}
              onLaunchRole={onLaunchRole}
              liveRoles={liveRoles}
              laneSessions={laneSessions}
              onFocusTerminal={onFocusTerminal}
              onCloseTerminal={onCloseTerminal}
              chatterPaused={chatterPaused}
              onToggleChatter={onToggleChatter}
              addLaneRequest={addLaneRequest}
              onAddLaneRequestHandled={onAddLaneRequestHandled}
            />
            {/* The dispatch LOG, not the board's Waiting column: the board deliberately shows
                only the records a human can act on, and this is the history — who routed what
                to whom, and how it landed. It is also the only surviving surface for the
                agent↔agent brake outcomes once the channel is gone (they carry a `replyId`, so
                the board excludes every one of them by rule). */}
            <DispatchLog project={project} onApprove={onApproveDispatch && ((id) => onApproveDispatch(project.id, id))} onReject={onRejectDispatch && ((id) => onRejectDispatch(project.id, id))} />
          </div>
        )}
        {tab === 'moodboard' && (
          <div style={{ maxWidth: 960, margin: '0 auto', height: '100%', width: '100%' }}>
            <MoodboardPanel projectId={project.id} />
          </div>
        )}
      </div>
    </div>
  )
}
