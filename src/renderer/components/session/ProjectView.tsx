import type { Project, ProjectPatch, Role, ProjectTask } from '../../../shared/types'
import { DragRegion } from '../DragRegion'
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
  project, tab, onSelectTab, onBack,
  onUpdateProject, onLaunchRole, liveRoles, laneSessions, onFocusTerminal, onCloseTerminal,
  onAddTask, onAssignTask, onRemoveTask, onSendTask, onStartAll, onSetTaskStatus,
  resumableCount, onResumeProject,
}: {
  project: Project
  tab: ProjectTab
  onSelectTab: (t: ProjectTab) => void
  /** Back to the gallery — the drill-in needs a visible way out even with the sidebar collapsed. */
  onBack?: () => void
  onUpdateProject?: (id: string, patch: ProjectPatch) => void
  onLaunchRole?: (project: Project, role: Role, launchDevServer?: boolean) => void
  liveRoles?: Record<string, string>
  /** roleId → live session runtime (phase/usage), for the mission-control read. */
  laneSessions?: Record<string, LaneSession>
  onFocusTerminal?: (terminalId: string) => void
  onCloseTerminal?: (terminalId: string) => void
  onAddTask: (text: string, roleId?: string) => void
  onAssignTask: (taskId: string, roleId?: string) => void
  onRemoveTask: (taskId: string) => void
  onSendTask: (task: ProjectTask) => void
  onStartAll: () => void
  onSetTaskStatus: (taskId: string, status: ProjectTask['status']) => void
  /** Saved-but-not-live agents of this project — resumable as a group. */
  resumableCount?: number
  onResumeProject?: () => void
}) {
  const tabs: ProjectTab[] = ['roster', 'moodboard']
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, background: 'var(--bg-terminal)' }}>
      <DragRegion style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, height: 44, padding: '0 16px', boxSizing: 'border-box', borderBottom: '1px solid var(--border)' }}>
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
      <div style={{ flex: 1, minHeight: 0, overflowY: tab === 'roster' ? 'auto' : undefined }}>
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
            <DispatchLog project={project} />
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
