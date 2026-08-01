import type { Project, ProjectPatch, Role, ProjectTask } from '../../../shared/types'
import type { GlobalRoleDefaults } from '../../lib/model-config'
import { DragRegion } from '../DragRegion'
import { SidebarToggle } from '../SidebarToggle'
import { RosterPanel, type LaneSession } from './RosterPanel'
import { MoodboardPanel } from './MoodboardPanel'
import { TaskQueue } from './TaskQueue'
import { DispatchLog } from './DispatchLog'

// The project-level workspace, opened from a project's title in the sidebar. Home for the
// things that belong to the PROJECT (not a single session): its Agents roster (launch new
// agents / view live ones / delegate) and its Moodboard. Per the naming model, a Project owns
// Agents; each Agent runs a Session (its live Claude Code conversation).

type ProjectTab = 'roster' | 'moodboard'
const LABELS: Record<ProjectTab, string> = { roster: 'Agents', moodboard: 'Moodboard' }

export function ProjectView({
  project, tab, onSelectTab, onBack, onToggleSidebar, sidebarCollapsed,
  onUpdateProject, onLaunchRole, liveRoles, laneSessions, onFocusTerminal, onCloseTerminal,
  onAddTask, onAssignTask, onRemoveTask, onSendTask, onStartAll, onSetTaskStatus,
  onApproveDispatch, onRejectDispatch,
  resumableCount, onResumeProject, roleDefaults,
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
  /** roleId → live session runtime (phase/usage), for the mission-control read. */
  laneSessions?: Record<string, LaneSession>
  onFocusTerminal?: (terminalId: string) => void
  onCloseTerminal?: (terminalId: string) => void
  /** GLOBAL per-role launch defaults, so each card can say which of its settings is inherited. */
  roleDefaults?: GlobalRoleDefaults
  onAddTask: (text: string, roleId?: string) => void
  onAssignTask: (taskId: string, roleId?: string) => void
  onRemoveTask: (taskId: string) => void
  onSendTask: (task: ProjectTask) => void
  onStartAll: () => void
  onSetTaskStatus: (taskId: string, status: ProjectTask['status']) => void
  /** Approve / decline a dispatch a NON-coordinator lane asked for. Absent = read-only log. */
  onApproveDispatch?: (projectId: string, id: string) => void
  onRejectDispatch?: (projectId: string, id: string) => void
  /** Saved-but-not-live agents of this project — resumable as a group. */
  resumableCount?: number
  onResumeProject?: () => void
}) {
  const tabs: ProjectTab[] = ['roster', 'moodboard']
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
      <div style={{ flex: 1, minHeight: 0, overflowY: tab === 'roster' ? 'scroll' : undefined }}>
        {tab === 'roster' && (
          <div style={{ maxWidth: 760, margin: '0 auto', padding: '10px 16px 28px' }}>
            <RosterPanel
              project={project}
              onUpdateProject={onUpdateProject}
              onLaunchRole={onLaunchRole}
              liveRoles={liveRoles}
              laneSessions={laneSessions}
              onFocusTerminal={onFocusTerminal}
              onCloseTerminal={onCloseTerminal}
              roleDefaults={roleDefaults}
            />
            <TaskQueue
              project={project}
              roles={project.roster ?? []}
              liveRoles={liveRoles}
              onAddTask={onAddTask}
              onAssignTask={onAssignTask}
              onRemoveTask={onRemoveTask}
              onSendTask={onSendTask}
              onStartAll={onStartAll}
              onSetTaskStatus={onSetTaskStatus}
            />
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
