import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSession, Project } from '../../../shared/types'
import { DragRegion } from '../DragRegion'
import { LogoMark } from '../LogoMark'
import { StatusWave } from '../sidebar/StatusWave'
import { ActivityDashboard } from './ActivityDashboard'
import type { RecentSession, RecentProject } from './RecentLists'
import { relativeTime, tildePath } from '../../lib/format'
import { sessionWaveStatus } from '../../lib/session-status'
import { projectActivity, projectActivityLabel } from '../../lib/project-status'

// The launcher — where you are when you're inside no project. Full-bleed inside the content
// card, with NO sidebar and no rail beside it, which is what makes "outside a project"
// unmistakable. A bare drag strip up top holds the macOS traffic lights, so the header and
// the grid can share one centred container and therefore one left edge.
//
// One project = one card, in three blocks: IDENTITY (name + path), the DESCRIPTION the user
// wrote (`contextNotes` — the thing a folder name can't tell you), and a FOOTER pairing the
// team's orbs with the backlog. Clicking a card enters the project; everything else here is
// launcher-level — including the one legitimate cross-project read, the ActivityDashboard,
// which hangs off the rollup chip rather than living inside any project.

/** Orbs shown on a card before collapsing the rest into "+N". */
const MAX_ORBS = 8
/** One measure for the header row and the card grid — they must share a left edge. */
const GRID_MAX = 1100

interface ProjectGalleryProps {
  projects: Project[]
  /** Live, per-terminal sessions (DashboardView's allSidebarSessions). */
  sessions: AgentSession[]
  tab: 'projects' | 'activity'
  onSelectTab: (t: 'projects' | 'activity') => void
  accentOf: (s: AgentSession) => string | undefined
  customNames: Record<string, string>
  onOpenProject: (projectId: string) => void
  /** Pick a folder → register it as a project → enter it. */
  onOpenFolder: () => void
  onRenameProject: (id: string, name: string) => void
  /** Persist a project's description (`contextNotes`); '' clears it. */
  onSetProjectNotes: (id: string, notes: string) => void
  onForgetProject: (id: string) => void
  onOpenFolderPrefs: (projectPath: string, projectName: string) => void
  onSelectSession: (s: AgentSession) => void
  // Continuity shelf, for the activity sub-view (passed straight through).
  restorableSessions: RecentSession[]
  recentProjects: RecentProject[]
  onRestore: (s: RecentSession, resume: boolean) => void
  onForget: (key: string) => void
  onOpenFolderPath: (path: string) => void
}

export function ProjectGallery({
  projects, sessions, tab, onSelectTab, accentOf, customNames,
  onOpenProject, onOpenFolder, onRenameProject, onSetProjectNotes, onForgetProject, onOpenFolderPrefs,
  onSelectSession, restorableSessions, recentProjects, onRestore, onForget, onOpenFolderPath,
}: ProjectGalleryProps) {
  // Which card's ⋯ menu is open, and which card is being renamed or having its description
  // written (at most one of each — held here, not per card, so opening a second editor
  // closes the first instead of leaving two live inputs on screen).
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [editingNotes, setEditingNotes] = useState<string | null>(null)

  const live = useMemo(() => sessions.filter((s) => s.status !== 'ended'), [sessions])
  const liveCount = live.length

  // Live sessions first (a project you're working in outranks one you aren't), then most
  // recently active. Sorting by a derived count — not by mutating `projects` — keeps the
  // store's own order untouched.
  const ordered = useMemo(() => {
    const liveByProject = new Map<string, AgentSession[]>()
    for (const s of live) {
      if (!s.projectId) continue
      const arr = liveByProject.get(s.projectId) ?? []
      arr.push(s)
      liveByProject.set(s.projectId, arr)
    }
    return [...projects]
      .map((p) => ({ project: p, live: liveByProject.get(p.id) ?? [] }))
      .sort((a, b) =>
        (b.live.length > 0 ? 1 : 0) - (a.live.length > 0 ? 1 : 0)
        || b.project.lastActiveAt.localeCompare(a.project.lastActiveAt))
  }, [projects, live])

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, fontFamily: 'var(--font-body)' }}>
      {/* A bare strip for the traffic lights, exactly as every other non-terminal content mode
          gets one. The header used to reserve that space itself with paddingLeft:84, which
          left the title 100px inboard of the centred grid below it — the two never lined up. */}
      <DragRegion style={{ height: 40, flexShrink: 0 }} />

      {/* Header — same centred container as the grid, so title, chip and cards share one
          left edge at every width. */}
      <DragRegion style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12,
        height: 44, padding: '0 24px', boxSizing: 'border-box',
        width: '100%', maxWidth: GRID_MAX, margin: '0 auto',
      }}>
        {tab === 'activity' ? (
          <button onClick={() => onSelectTab('projects')} style={backBtn} title="Back to your projects">
            <span style={{ fontSize: 12 }}>‹</span> Projects · {projects.length}
          </button>
        ) : (
          <h2 style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', margin: 0, letterSpacing: '-0.01em' }}>
            Projects · {projects.length}
          </h2>
        )}
        {liveCount > 0 && (
          <RollupChip
            n={liveCount}
            label={liveCount === 1 ? 'agent at work' : 'agents at work'}
            active={tab === 'activity'}
            onClick={() => onSelectTab(tab === 'activity' ? 'projects' : 'activity')}
          />
        )}
        <button onClick={onOpenFolder} style={{ ...backBtn, marginLeft: 'auto' }} title="Open a folder as a project (⌘N)">
          + Open folder
        </button>
      </DragRegion>

      {tab === 'activity' ? (
        // Unchanged component — the cross-project read, at launcher level only.
        <ActivityDashboard
          sessions={sessions}
          projects={projects}
          customNames={customNames}
          onSelectSession={onSelectSession}
          onNewSession={onOpenFolder}
          restorableSessions={restorableSessions}
          recentProjects={recentProjects}
          onRestore={onRestore}
          onForget={onForget}
          onOpenFolder={onOpenFolderPath}
        />
      ) : projects.length === 0 ? (
        <EmptyGallery onOpenFolder={onOpenFolder} />
      ) : (
        <div className="scroll-hidden" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <div style={{
            // Wider track and a bigger gutter than the original 260/10: a description needs
            // a comfortable measure, and cards packed 10px apart read as one grey mass.
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14,
            padding: '4px 24px 28px', maxWidth: GRID_MAX, margin: '0 auto',
          }}>
            {ordered.map(({ project, live: liveHere }) => (
              <ProjectCard
                key={project.id}
                project={project}
                live={liveHere}
                accentOf={accentOf}
                menuOpen={menuFor === project.id}
                onMenu={(open) => setMenuFor(open ? project.id : null)}
                renaming={renaming === project.id}
                onRenamingChange={(on) => setRenaming(on ? project.id : null)}
                editingNotes={editingNotes === project.id}
                onEditingNotesChange={(on) => setEditingNotes(on ? project.id : null)}
                onOpen={() => onOpenProject(project.id)}
                onRename={(name) => onRenameProject(project.id, name)}
                onSetNotes={(notes) => onSetProjectNotes(project.id, notes)}
                onForget={() => onForgetProject(project.id)}
                onOpenFolderPrefs={() => onOpenFolderPrefs(project.path, project.name)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ProjectCard({
  project, live, accentOf, menuOpen, onMenu, renaming, onRenamingChange,
  editingNotes, onEditingNotesChange, onOpen, onRename, onSetNotes, onForget, onOpenFolderPrefs,
}: {
  project: Project
  live: AgentSession[]
  accentOf: (s: AgentSession) => string | undefined
  menuOpen: boolean
  onMenu: (open: boolean) => void
  renaming: boolean
  onRenamingChange: (on: boolean) => void
  editingNotes: boolean
  onEditingNotesChange: (on: boolean) => void
  onOpen: () => void
  onRename: (name: string) => void
  onSetNotes: (notes: string) => void
  onForget: () => void
  onOpenFolderPrefs: () => void
}) {
  const [hover, setHover] = useState(false)
  const [draft, setDraft] = useState(project.name)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (renaming) { setDraft(project.name); inputRef.current?.focus(); inputRef.current?.select() } }, [renaming, project.name])

  const notes = (project.contextNotes ?? '').trim()
  const [notesDraft, setNotesDraft] = useState(notes)
  const notesRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (editingNotes) { setNotesDraft(project.contextNotes ?? ''); notesRef.current?.focus(); notesRef.current?.select() }
  }, [editingNotes, project.contextNotes])

  const roster = project.roster ?? []
  // roleId → its live session, so a lane's orb carries the real phase and the rest rest idle.
  const liveByRole = new Map(live.filter((s) => s.roleId).map((s) => [s.roleId!, s]))
  const shownLanes = roster.slice(0, MAX_ORBS)
  const overflow = roster.length - shownLanes.length
  const queued = (project.tasks ?? []).filter((t) => (t.status ?? 'queued') === 'queued').length
  // One rolled-up read of the project, shared with the switcher popover (lib/project-status).
  const activity = projectActivity(live, roster.length)
  const activityLabel = projectActivityLabel(activity)
  // A project whose folder we no longer know recedes in MUTED INK — never group opacity,
  // which would halve the contrast of every child at once — and stays openable.
  const lost = !project.path

  const commitRename = () => {
    const name = draft.trim()
    if (name && name !== project.name) onRename(name)
    onRenamingChange(false)
  }

  // Trimmed on the way in, so a note of pure whitespace clears the row rather than
  // reserving two blank lines on the card forever.
  const commitNotes = () => {
    const next = notesDraft.trim()
    if (next !== notes) onSetNotes(next)
    onEditingNotesChange(false)
  }

  return (
    <div
      role="button"
      tabIndex={0}
      data-project-card={project.id}
      onClick={() => { if (!renaming && !editingNotes && !menuOpen) onOpen() }}
      onKeyDown={(e) => { if (!renaming && !editingNotes && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen() } }}
      onContextMenu={(e) => { e.preventDefault(); onMenu(true) }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={lost ? `${project.name} — its folder is no longer on record; opening still works` : project.path}
      style={{
        position: 'relative',
        // Room to breathe: the card now carries a description as well, and the old
        // 12/14 + gap 7 packed five near-equal rows into one block. The gap here separates
        // the three BLOCKS; within the identity block the rows sit at 3.
        display: 'flex', flexDirection: 'column', gap: 12,
        padding: '15px 17px', textAlign: 'left', cursor: 'pointer', outline: 'none',
        borderRadius: 'var(--radius-md)',
        // Constant border colour: hover changes the BACKGROUND only. A colour-changing
        // border on a radiused element re-rasterizes in WKWebView (the freeze rule).
        border: '1px solid var(--border)',
        background: hover || menuOpen ? 'var(--overlay-medium)' : 'var(--overlay-subtle)',
        transition: 'background 120ms ease',
      }}
    >
      {/* BLOCK 1 — the headline: what it's called, and what it's doing. Nothing else, so the
          eye lands on the name when scanning a grid of these. The PATH used to sit directly
          under the name and is now down in the footer meta: `~/operator` under `operator`
          restated the title in mono and spent the card's best row on it. */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
        {renaming ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commitRename}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') { setDraft(project.name); onRenamingChange(false) }
            }}
            style={{
              flex: 1, minWidth: 0, boxSizing: 'border-box', padding: '1px 5px',
              fontFamily: 'inherit', fontSize: 13, fontWeight: 600, color: 'var(--fg)',
              background: 'var(--bg-terminal)', border: '1px solid var(--border)',
              borderRadius: 4, outline: 'none',
            }}
          />
        ) : (
          <span data-card-name style={{
            // 14px: the card is the primary object in this view, so its name outranks the
            // page title. Stays --fg even when the folder is lost — it's the card's identity
            // and the row you read first, and --fg-muted at this size measured 3.7–4.1:1 on light.
            flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: 'var(--fg)',
            letterSpacing: '-0.01em',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {project.name}
          </span>
        )}
        {/* State in WORDS, not a bare count — "1 needs you" is the thing you'd act on, and
            `3 ●` couldn't say it. Transparent badge, accent ink, no fill; accent is reserved
            for activity, so a merely-existing roster ("6 lanes") stays muted. */}
        {activityLabel && (
          <span
            data-card-state
            title={activity.waiting > 0
              ? `${activity.waiting} lane${activity.waiting === 1 ? '' : 's'} waiting on you`
              : `${activity.live} live · ${activity.lanes} lane${activity.lanes === 1 ? '' : 's'} on the roster`}
            style={{
              flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 10,
              color: activityLabel.accent ? 'var(--accent)' : 'var(--fg-muted)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {activityLabel.text}
          </span>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onMenu(!menuOpen) }}
          title="Project actions"
          aria-label={`${project.name} actions`}
          style={{
            flexShrink: 0, width: 18, height: 16, padding: 0, lineHeight: 1,
            display: 'grid', placeItems: 'center',
            background: 'transparent', border: 'none', borderRadius: 4, outline: 'none',
            color: 'var(--fg-muted)', cursor: 'pointer',
            opacity: hover || menuOpen ? 1 : 0, transition: 'opacity 120ms ease',
            fontSize: 12,
          }}
        >⋯</button>
      </div>

      {/* BLOCK 2 — what this project actually IS. The folder name rarely says, so this is
          the row worth the space; it's in the body face (not mono) at a readable 11.5/1.5
          because it's prose, and clamped to two lines so one long note can't set the height
          of every card in its grid row. */}
      {editingNotes ? (
        <textarea
          ref={notesRef}
          value={notesDraft}
          onChange={(e) => setNotesDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={commitNotes}
          onKeyDown={(e) => {
            e.stopPropagation()
            // ⌘/Ctrl+Enter commits; a bare Enter stays a newline, since this is prose.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commitNotes()
            if (e.key === 'Escape') { setNotesDraft(project.contextNotes ?? ''); onEditingNotesChange(false) }
          }}
          rows={3}
          placeholder="What is this project? Who's it for? Anything you'd want to remember next time."
          style={{
            width: '100%', boxSizing: 'border-box', padding: '6px 8px', resize: 'none',
            fontFamily: 'var(--font-body)', fontSize: 11.5, lineHeight: 1.5, color: 'var(--fg)',
            background: 'var(--bg-terminal)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)', outline: 'none',
          }}
        />
      ) : !notes ? (
        // No description yet. The slot's height is already reserved (the footer is pushed
        // down to match neighbouring cards), so offering the prompt on hover costs nothing
        // in layout and turns a conspicuous void into an invitation. Invisible at rest —
        // a gallery of "Add a description" placeholders would be noise, not guidance.
        <button
          data-card-add-notes
          onClick={(e) => { e.stopPropagation(); onEditingNotesChange(true) }}
          title="Describe this project"
          style={{
            alignSelf: 'flex-start', padding: 0, background: 'transparent', border: 'none',
            outline: 'none', cursor: 'pointer', textAlign: 'left',
            fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--fg-muted)',
            opacity: hover ? 1 : 0, transition: 'opacity 120ms ease',
          }}
        >
          + Add a description
        </button>
      ) : (
        <div data-card-notes style={{
          // Prose, so it's held to the 4.5:1 body bar, not the 3:1 meta one — and plain
          // --fg-muted measured 3.7–4.1:1 on the light palettes. Stepping down from --fg
          // instead keeps it clearly secondary to the name while staying readable.
          fontSize: 11.5, lineHeight: 1.5, color: 'color-mix(in srgb, var(--fg) 72%, transparent)',
          display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2,
          overflow: 'hidden',
        }}>
          {notes}
        </div>
      )}

      {/* BLOCK 3 — the footer, pushed to the bottom (marginTop:auto) so every card in a grid
          row lines its status up with its neighbours' even when one carries a description and
          the next doesn't. Two tiers: the TEAM (orbs + backlog), then the quiet reference
          line (where it lives, when it last moved) that nobody scans but everybody
          occasionally needs. A hairline separates them from the prose above. */}
      <div style={{
        marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 7,
        paddingTop: 11, borderTop: '1px solid var(--border)',
      }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, minWidth: 0 }}>
          {shownLanes.map((role) => {
            const session = liveByRole.get(role.id)
            return (
              <span key={role.id} title={session ? `${role.name} — ${sessionWaveStatus(session)}` : `${role.name} — idle`} style={{ display: 'flex' }}>
                <StatusWave
                  status={session ? sessionWaveStatus(session) : 'idle'}
                  seed={role.id}
                  size={14}
                  accent={session ? accentOf(session) : role.accent}
                />
              </span>
            )
          })}
          {overflow > 0 && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--fg-muted)', marginLeft: 2 }}>
              +{overflow}
            </span>
          )}
        </div>
        {queued > 0 && (
          <span data-card-queued style={{
            flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-muted)',
          }}>
            {queued} queued
          </span>
        )}
      </div>

      {/* Reference line: where it lives · when it last moved. The "lost" chip takes the
          path's place here — it's a STATE, so it gets a marker rather than a dimmer card
          (fading the whole thing read as "slightly faded", not "can't find this"). */}
      <div data-card-meta style={{
        display: 'flex', alignItems: 'center', gap: 6, minWidth: 0,
        fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-muted)',
      }}>
        {lost ? (
          <span data-card-chip style={{
            flexShrink: 0, display: 'inline-block', padding: '1px 6px',
            fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.1em',
            background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
          }}>
            folder not on record
          </span>
        ) : (
          <span data-card-path style={{
            flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {tildePath(project.path)}
          </span>
        )}
        <span style={{ flexShrink: 0, marginLeft: lost ? 'auto' : 0 }}>
          {project.lastActiveAt ? relativeTime(project.lastActiveAt) : 'never opened'}
        </span>
      </div>
      </div>

      {menuOpen && (
        <CardMenu
          onClose={() => onMenu(false)}
          items={[
            { label: notes ? 'Edit description' : 'Add description', onClick: () => onEditingNotesChange(true) },
            { label: 'Rename', onClick: () => onRenamingChange(true) },
            { label: 'Reveal in Finder', onClick: () => { void window.operator.revealPath?.(project.path) }, disabled: lost },
            { label: 'Project Claude files', onClick: onOpenFolderPrefs, disabled: lost },
            { label: 'Forget project', onClick: onForget, danger: true },
          ]}
        />
      )}
    </div>
  )
}

/** Small popover inside a card. Closes on any outside press or Esc; each item closes it
 *  after running, so the card's own click handler never also fires (stopPropagation). */
function CardMenu({ items, onClose }: {
  items: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean }[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [onClose])
  return (
    <div
      ref={ref}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'absolute', top: 30, right: 10, zIndex: 30, minWidth: 150,
        borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
        background: 'var(--bg-surface)', boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        overflow: 'hidden', padding: '3px 0',
      }}
    >
      {items.map((it) => (
        <button
          key={it.label}
          disabled={it.disabled}
          onClick={(e) => { e.stopPropagation(); it.onClick(); onClose() }}
          style={{
            display: 'block', width: '100%', textAlign: 'left', padding: '6px 11px',
            background: 'transparent', border: 'none', outline: 'none',
            cursor: it.disabled ? 'default' : 'pointer', opacity: it.disabled ? 0.4 : 1,
            fontFamily: 'var(--font-body)', fontSize: 11.5,
            color: it.danger ? 'var(--color-error, #f85149)' : 'var(--fg)',
          }}
          onMouseEnter={(e) => { if (!it.disabled) e.currentTarget.style.background = 'var(--overlay-subtle)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}

/** First run — the welcome copy the splash used to carry, with the CTA pointed at a folder
 *  (a project) rather than a bare session, which is now the unit you start from. */
function EmptyGallery({ onOpenFolder }: { onOpenFolder: () => void }) {
  return (
    // Scroller full-width, measure inside — the same split the grid above uses, so the
    // scrollbar tracks the window's edge and not the 480px column's.
    <div className="scroll-hidden" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
    <div
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'flex-start', padding: '40px', boxSizing: 'border-box',
        // minHeight lets the auto margins below still centre the block vertically.
        minHeight: '100%', maxWidth: 480, margin: '0 auto',
      }}
    >
      {/* margin-top:auto here + margin-bottom:auto on the last child centers the block when
          it fits, but keeps the top reachable when it overflows. */}
      <div style={{ marginTop: 'auto', marginBottom: 20 }}><LogoMark size={96} cells={11} /></div>
      <div style={{ textAlign: 'center', marginBottom: 32 }}>
        <p style={{ fontSize: 13, color: 'var(--fg)', fontWeight: 500, lineHeight: 1.7, margin: 0 }}>
          Welcome to your mission control.
        </p>
        <p style={{ fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.7, margin: '12px 0 0' }}>
          Open a folder to make it a project, give it a team of agents on the models that
          suit the work, and let each one work in its own git worktree. You'll see every
          tool call and subagent as it happens.
        </p>
        <p style={{ fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.7, margin: '10px 0 0' }}>
          Got a big job? Fan it out across as many agents as you like —
          and keep an eye on what each one's doing, and what it costs.
        </p>
      </div>

      <button
        onClick={onOpenFolder}
        style={{
          padding: '7px 20px', background: 'var(--bg-surface)', border: '1px solid var(--border)',
          borderRadius: 6, color: 'var(--fg)', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer',
          outline: 'none',
        }}
      >
        Open a folder
      </button>
      <p style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 8 }}>
        Cmd+N · Cmd+K for command palette
      </p>
      <div style={{ marginBottom: 'auto' }} />
    </div>
    </div>
  )
}

function RollupChip({ n, label, active, onClick }: { n: number; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={active ? 'Back to your projects' : "See what every agent is doing, across all projects"}
      style={{
        display: 'inline-flex', alignItems: 'baseline', gap: 6, padding: '5px 11px',
        borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
        background: active ? 'var(--overlay-medium)' : 'var(--overlay-subtle)',
        cursor: 'pointer', outline: 'none', fontFamily: 'inherit',
      }}
    >
      <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>{n}</span>
      <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
    </button>
  )
}

const backBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px',
  borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'transparent',
  color: 'var(--fg-muted)', cursor: 'pointer', outline: 'none',
  fontFamily: 'var(--font-body)', fontSize: 11.5,
}
