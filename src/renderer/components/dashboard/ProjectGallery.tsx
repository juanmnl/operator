import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSession, Project } from '../../../shared/types'
import { CardMenu } from '../CardMenu'
import { DragRegion } from '../DragRegion'
import { LogoMark } from '../LogoMark'
import { StatusWave } from '../sidebar/StatusWave'
import { ActivityDashboard } from './ActivityDashboard'
import type { RecentSession, RecentProject } from './RecentLists'
import { relativeTime, tildePath } from '../../lib/format'
import { sessionWaveStatus } from '../../lib/session-status'
import { projectActivity, projectActivityLabel, type ProjectActivity } from '../../lib/project-status'
import { FILTER_THRESHOLD, matchProject, partitionProjects, staleProjects } from '../../lib/project-shelf'

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
//
// Two SHELVES, not one list (lib/project-shelf): ACTIVE gets the cards, PREVIOUS gets compact
// rows in a collapsed section. Previous items are ROWS rather than dimmed cards on purpose —
// the house rule forbids receding a card with group opacity, so a "quiet card" would mean
// hand-tuning every child's ink across a dozen cards, which is the wall of grey this split
// exists to undo. A row recedes structurally. And a store with nothing shelved renders exactly
// the gallery it always did: no headers, no filter, no new chrome.

/** Orbs shown on a card before collapsing the rest into "+N". */
const MAX_ORBS = 8
/** One measure for the header row and the card grid — they must share a left edge. */
const GRID_MAX = 1100

interface ProjectGalleryProps {
  projects: Project[]
  /** Live, per-terminal sessions (DashboardView's allSidebarSessions). */
  sessions: AgentSession[]
  /** projectId → its rolled-up state, already computed once for the switcher. Drives the
   *  shelf split (a live project is active whatever its record says) and the ordering. */
  activities: Record<string, ProjectActivity>
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
  /** Shelve / un-shelve. Both are the user's decision, never derived — see lib/project-shelf. */
  onArchiveProject: (id: string) => void
  /** END this project's live agents, then shelve it. Distinct from Archive (which leaves them
   *  running) and from Forget (which destroys the roster, tasks and notes). */
  onCloseProject: (id: string) => void
  /** Shelve a whole batch under one timestamp, with one undo. The tidy pass. */
  onArchiveProjects: (ids: string[]) => void
  onRestoreProject: (id: string) => void
  onOpenFolderPrefs: (projectPath: string, projectName: string) => void
  onSelectSession: (s: AgentSession) => void
  // Continuity shelf, for the activity sub-view (passed straight through).
  restorableSessions: RecentSession[]
  recentProjects: RecentProject[]
  onRestore: (s: RecentSession, resume: boolean) => void
  onForget: (key: string) => void
  onOpenFolderPath: (path: string) => void
  /** Projects whose teardown is in flight. The card says so IMMEDIATELY — closing used to show
   *  nothing at all until every pty had been confirmed dead, which with several lanes is seconds
   *  of the project sitting there looking like the click was ignored. */
  closingIds?: Set<string>
}

export function ProjectGallery({
  projects, sessions, activities, tab, onSelectTab, accentOf, customNames,
  onOpenProject, onOpenFolder, onRenameProject, onSetProjectNotes, onForgetProject,
  onArchiveProject, onCloseProject, onArchiveProjects, onRestoreProject, onOpenFolderPrefs,
  onSelectSession, restorableSessions, recentProjects, onRestore, onForget, onOpenFolderPath,
  closingIds,
}: ProjectGalleryProps) {
  // Which card's ⋯ menu is open, and which card is being renamed or having its description
  // written (at most one of each — held here, not per card, so opening a second editor
  // closes the first instead of leaving two live inputs on screen).
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [editingNotes, setEditingNotes] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const live = useMemo(() => sessions.filter((s) => s.status !== 'ended'), [sessions])
  const liveCount = live.length

  // Which sessions are live in which project. The ORDERING job this map used to do moved out
  // to lib/project-shelf; this half stays, because each card still needs the real sessions to
  // give its lane orbs a real phase.
  const liveByProject = useMemo(() => {
    const m = new Map<string, AgentSession[]>()
    for (const s of live) {
      if (!s.projectId) continue
      const arr = m.get(s.projectId) ?? []
      arr.push(s)
      m.set(s.projectId, arr)
    }
    return m
  }, [live])

  const { active, previous } = useMemo(() => partitionProjects(projects, activities), [projects, activities])

  const q = query.trim()
  const filtering = q !== ''
  const activeShown = useMemo(() => active.filter((p) => matchProject(p, q)), [active, q])
  const previousShown = useMemo(() => previous.filter((p) => matchProject(p, q)), [previous, q])

  // Section headers exist only once something has been shelved. Nothing archived → the
  // gallery a user has always seen, down to the pixel.
  const sectioned = previous.length > 0
  const showFilter = active.length > FILTER_THRESHOLD
  // Seeded per MOUNT — and the gallery unmounts every time you enter a project — so arriving
  // at the launcher always looks the same, the same reasoning as the galleryTab reset.
  const [previousExpanded, setPreviousExpanded] = useState(() => active.length === 0)
  // A query searches BOTH shelves and forces Previous open, so a match can never hide inside
  // a collapsed section. That's what makes archiving liberally safe — no archive screen needed.
  const showPrevious = previousExpanded || filtering
  const nothingMatched = filtering && activeShown.length === 0 && previousShown.length === 0

  // The tidy prompt. Staleness is COMPUTED and never written — this bar is the only thing it
  // drives, and it only ever offers; nothing is shelved without the review sheet below.
  const stale = useMemo(() => staleProjects(active, activities), [active, activities])
  const [reviewing, setReviewing] = useState(false)
  const [dismissed, setDismissed] = useState<TidyDismissal>(readTidyDismissal)
  // Suppressed only for the projects you've already been asked about: a twelfth going quiet
  // brings the bar back, and so does one that ran since (its lastActiveAt now post-dates the
  // dismissal). An advisory that can't be silenced is a nag; one that can't ever return is a
  // feature you used once.
  const staleUnasked = stale.filter((p) => !dismissed.ids.includes(p.id) || p.lastActiveAt > dismissed.at)
  // Hidden while filtering: a query means you're looking for one thing, not tidying.
  const showTidy = staleUnasked.length > 0 && !filtering

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
        {/* The count is the ACTIVE shelf, not the store total: once you've shelved eleven
            things, "Projects · 19" is no longer the honest headline for what's on screen. */}
        {tab === 'activity' ? (
          <button onClick={() => onSelectTab('projects')} style={backBtn} title="Back to your projects">
            <span style={{ fontSize: 12 }}>‹</span> Projects · {active.length}
          </button>
        ) : (
          <h2 style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', margin: 0, letterSpacing: '-0.01em' }}>
            Projects · {active.length}
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
        {/* Past a shelf-full of projects, scanning stops working. Same threshold as the
            switcher popover (one definition now), and it searches both shelves.
            An <input> is exempt from DragRegion's own drag handler, so it stays typeable. */}
        {tab === 'projects' && showFilter && (
          <input
            data-gallery-filter
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter projects…"
            title="Search both shelves by name or path"
            style={{
              marginLeft: 'auto', width: 170, boxSizing: 'border-box', padding: '5px 9px',
              borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
              background: 'transparent', color: 'var(--fg)', outline: 'none',
              fontFamily: 'var(--font-body)', fontSize: 11.5,
            }}
          />
        )}
        <button
          onClick={onOpenFolder}
          style={{ ...backBtn, marginLeft: tab === 'projects' && showFilter ? 8 : 'auto' }}
          title="Open a folder as a project (⌘N)"
        >
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
          <div style={{ padding: '4px 24px 28px', maxWidth: GRID_MAX, margin: '0 auto' }}>
            {showTidy && (
              <TidyBar
                count={stale.length}
                onReview={() => setReviewing(true)}
                onDismiss={() => setDismissed(writeTidyDismissal(stale.map((p) => p.id)))}
              />
            )}
            {nothingMatched ? (
              <div style={{ padding: '8px 2px', fontSize: 11, color: 'var(--fg-muted)' }}>No match.</div>
            ) : (
              <>
                {sectioned && (
                  <SectionLabel>
                    Active{filtering ? ` · ${activeShown.length} of ${active.length}` : ''}
                  </SectionLabel>
                )}
                {activeShown.length > 0 ? (
                  <div style={{
                    // Wider track and a bigger gutter than the original 260/10: a description
                    // needs a comfortable measure, and cards packed 10px apart read as one
                    // grey mass.
                    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14,
                  }}>
                    {activeShown.map((project) => (
                      <ProjectCard
                        key={project.id}
                        project={project}
                        closing={closingIds?.has(project.id)}
                        live={liveByProject.get(project.id) ?? []}
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
                        onArchive={() => onArchiveProject(project.id)}
                        onCloseProject={() => onCloseProject(project.id)}
                        liveCount={activities[project.id]?.live ?? 0}
                        onRestore={() => onRestoreProject(project.id)}
                        onOpenFolderPrefs={() => onOpenFolderPrefs(project.path, project.name)}
                      />
                    ))}
                  </div>
                ) : !filtering ? (
                  <NothingActive onOpenFolder={onOpenFolder} />
                ) : null}

                {previous.length > 0 && (
                  <>
                    <SectionToggle
                      label={`Previous · ${filtering ? `${previousShown.length} of ${previous.length}` : previous.length}`}
                      expanded={showPrevious}
                      // While filtering the section is held open — a match must never hide —
                      // so the chevron goes away rather than lying about being clickable.
                      togglable={!filtering}
                      onToggle={() => setPreviousExpanded((v) => !v)}
                    />
                    {showPrevious && (
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        {previousShown.map((project) => (
                          <PreviousRow
                            key={project.id}
                            project={project}
                            menuOpen={menuFor === project.id}
                            onMenu={(open) => setMenuFor(open ? project.id : null)}
                            onOpen={() => onOpenProject(project.id)}
                            onRestore={() => onRestoreProject(project.id)}
                            onForget={() => onForgetProject(project.id)}
                            onOpenFolderPrefs={() => onOpenFolderPrefs(project.path, project.name)}
                          />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {reviewing && (
        <TidyReview
          projects={stale}
          onCancel={() => setReviewing(false)}
          onShelve={(ids) => {
            setReviewing(false)
            // Whatever you UNCHECKED you've just decided to keep, so don't ask about this
            // set again — the bar coming straight back with the leftovers would read as the
            // review not having worked.
            setDismissed(writeTidyDismissal(stale.map((p) => p.id)))
            onArchiveProjects(ids)
          }}
        />
      )}
    </div>
  )
}

function ProjectCard({
  project, live, accentOf, menuOpen, onMenu, renaming, onRenamingChange,
  editingNotes, onEditingNotesChange, onOpen, onRename, onSetNotes, onForget,
  onArchive, onCloseProject, liveCount, onRestore, onOpenFolderPrefs, closing,
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
  onArchive: () => void
  onCloseProject: () => void
  /** Live lanes right now — decides whether CLOSE is even a distinct verb here. */
  liveCount: number
  onRestore: () => void
  onOpenFolderPrefs: () => void
  /** Teardown in flight — see `closingIds`. */
  closing?: boolean
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
  const showOrbs = live.length > 0
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
        {/* CLOSING WINS OVER THE ACTIVITY LABEL while a teardown is in flight. It is the same
            slot, the same muted register and no fill — a state, not a badge — so the card does not
            reflow when it appears, and the answer to "did my click land" is on screen before the
            first pty has died. Replaces rather than joins: "3 live" beside "closing…" is two
            answers to one question. */}
        {closing ? (
          <span
            data-card-closing
            title="Ending this project’s agents, then moving it to Previous"
            style={{
              flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 10,
              color: 'var(--fg-muted)',
            }}
          >closing…</span>
        ) : activityLabel && (
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
        {/* `data-popmenu-trigger`: the menu now dismisses on outside POINTER-down (the shared
            contract), so without it the toggle would close on the way down and reopen on the
            click — a ⋯ that never closes. */}
        <button
          data-popmenu-trigger
          aria-expanded={menuOpen}
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
      {/* The orb strip earns its row only when something is RUNNING. Nearly every project
          carries the same six-lane roster, so at rest this was an identical dot strip on
          every card — a duplicate of the "6 lanes" the headline already says in words, and
          it differentiated nothing. Gone when idle, the dots mean what they should: something
          is working in here. */}
      {(showOrbs || queued > 0) && (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      }}>
        {showOrbs && (
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
        )}
        {queued > 0 && (
          <span data-card-queued style={{
            // marginLeft:auto rather than space-between alone: with the orbs suppressed this
            // is the row's only child and would otherwise jump to the left edge.
            flexShrink: 0, marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-muted)',
          }}>
            {queued} queued
          </span>
        )}
      </div>
      )}

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
            // A card can still be a SHELVED project — one with a live session is lifted back
            // onto the active shelf whatever its record says — so the verb reads off the
            // record, not off which list drew it.
            // CLOSE appears whenever there is something to close — including on an ALREADY
            // shelved project, which is precisely the state where a live lane pins it to Active
            // and the honest Shelve toast tells you to use this. Gating it on `!archivedAt` made
            // that advice point at a control that wasn't there. With no live lane it is omitted:
            // it would be a second button doing exactly what Archive does, and two verbs that
            // look different but act the same is its own kind of lie.
            ...(liveCount > 0
              ? [{
                  label: `Close project · end ${liveCount} agent${liveCount === 1 ? '' : 's'}`,
                  onClick: onCloseProject,
                  separator: true,
                }]
              : []),
            project.archivedAt
              ? { label: 'Restore to active', onClick: onRestore, separator: liveCount === 0 }
              : { label: 'Archive project', onClick: onArchive, separator: liveCount === 0 },
            // Forget stays LAST, danger-toned and confirm-gated. Close is reversible housekeeping
            // and Forget destroys rosters, tasks and notes — two verbs of different kind must not
            // look alike or sit adjacent without separation (feedback_two_verbs_one_glyph).
            { label: 'Forget project', onClick: onForget, danger: true, confirm: true, separator: true },
          ]}
        />
      )}
    </div>
  )
}

/** Which stale projects the user has already been offered, and when. Both halves matter: the
 *  ids so a NEW quiet project can still raise the bar, the timestamp so one that has run since
 *  (and gone quiet again) counts as un-asked rather than staying silenced forever. */
interface TidyDismissal { at: string; ids: string[] }
const TIDY_KEY = 'operator.tidyDismissed'

function readTidyDismissal(): TidyDismissal {
  try {
    const raw = localStorage.getItem(TIDY_KEY)
    const v = raw ? JSON.parse(raw) : null
    if (v && typeof v.at === 'string' && Array.isArray(v.ids)) return v
  } catch { /* malformed — treat as never dismissed */ }
  return { at: '', ids: [] }
}

function writeTidyDismissal(ids: string[]): TidyDismissal {
  const next = { at: new Date().toISOString(), ids }
  try { localStorage.setItem(TIDY_KEY, JSON.stringify(next)) } catch { /* quota */ }
  return next
}

/** The advisory. It states a fact and offers one way to act on it; it never shelves anything
 *  itself, and it can be silenced. Deliberately a quiet strip and not a banner — this is the
 *  launcher, and nothing here is wrong. */
function TidyBar({ count, onReview, onDismiss }: { count: number; onReview: () => void; onDismiss: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <div data-tidy-bar style={{
      display: 'flex', alignItems: 'center', gap: 8,
      margin: '0 0 14px', padding: '7px 8px 7px 10px', boxSizing: 'border-box',
      borderRadius: 'var(--radius-sm)', background: 'var(--overlay-subtle)',
      fontSize: 11.5, color: 'var(--fg-muted)',
    }}>
      {/* "two weeks" is STALE_DAYS in words — change one and change the other, here and in
          the review sheet's subtitle. */}
      <span>
        {count === 1
          ? "1 project hasn't run in over two weeks."
          : `${count} projects haven't run in over two weeks.`}
      </span>
      <button
        data-tidy-review
        onClick={onReview}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title="Pick which of them to shelve"
        style={{
          padding: '2px 7px', borderRadius: 'var(--radius-sm)',
          background: hover ? 'var(--overlay-medium)' : 'transparent',
          border: 'none', outline: 'none', cursor: 'pointer',
          fontFamily: 'inherit', fontSize: 11.5, color: 'var(--fg)',
        }}
      >
        Review →
      </button>
      <button
        aria-label="Dismiss"
        onClick={onDismiss}
        title="Don't offer this again for these projects"
        style={{
          marginLeft: 'auto', flexShrink: 0, width: 18, height: 18, padding: 0,
          display: 'grid', placeItems: 'center',
          background: 'transparent', border: 'none', borderRadius: 4, outline: 'none',
          color: 'var(--fg-muted)', cursor: 'pointer',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--fg)' }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--fg-muted)' }}
      >
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5" />
        </svg>
      </button>
    </div>
  )
}

/** The review sheet: every stale project, PRE-CHECKED. Opting out is how you keep one — the
 *  default is the thing you asked for by opening this, and a list of twelve empty boxes would
 *  make the assisted pass no faster than doing it by hand. Rows wear the Previous shelf's own
 *  treatment, so you can see where they're going. */
function TidyReview({ projects, onCancel, onShelve }: {
  projects: Project[]
  onCancel: () => void
  onShelve: (ids: string[]) => void
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(projects.map((p) => p.id)))
  useEffect(() => {
    // Capture phase, so a focused control can't swallow it first (same as the switcher).
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onCancel])
  const n = picked.size
  const toggle = (id: string) => setPicked((prev) => {
    const next = new Set(prev)
    if (!next.delete(id)) next.add(id)
    return next
  })
  return (
    <div
      data-tidy-review-sheet
      onClick={onCancel}
      style={{
        // Below the toasts (900), so the undo that follows a shelve is never behind the scrim.
        position: 'fixed', inset: 0, zIndex: 800, background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 90,
        fontFamily: 'var(--font-body)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560, maxWidth: 'calc(100vw - 80px)', maxHeight: '68vh',
          display: 'flex', flexDirection: 'column',
          background: 'var(--bg-sidebar)', border: '1px solid var(--border)',
          borderRadius: 10, boxShadow: '0 24px 60px rgba(0,0,0,0.5)', overflow: 'hidden',
        }}
      >
        <div style={{ flexShrink: 0, padding: '14px 16px 12px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', letterSpacing: '-0.01em' }}>
            Shelve the quiet ones
          </div>
          <p style={{ margin: '5px 0 0', fontSize: 11.5, lineHeight: 1.5, color: 'var(--fg-muted)' }}>
            Nothing has run in these for over two weeks. Shelving keeps everything — roster,
            tasks, notes — and launching an agent brings one straight back. Uncheck any you'd
            rather keep out here.
          </p>
        </div>

        <div className="scroll-hidden" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 0' }}>
          {projects.map((p) => {
            const on = picked.has(p.id)
            return (
              <button
                key={p.id}
                data-tidy-row={p.id}
                aria-pressed={on}
                onClick={() => toggle(p.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left',
                  padding: '6px 16px', background: 'transparent', border: 'none', outline: 'none',
                  cursor: 'pointer', fontFamily: 'inherit',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--overlay-subtle)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
              >
                <span style={{
                  flexShrink: 0, width: 11, height: 11, borderRadius: 2,
                  display: 'grid', placeItems: 'center',
                  background: on ? 'var(--accent)' : 'transparent',
                  border: on ? 'none' : '1px solid var(--fg-muted)',
                }}>
                  {on && <svg width="8" height="8" viewBox="0 0 10 10" fill="none"><path d="M2 5l2 2 4-4" stroke="var(--fg-on-accent)" strokeWidth="2" /></svg>}
                </span>
                <span style={{
                  flexShrink: 0, maxWidth: 190, fontSize: 11.5,
                  color: 'color-mix(in srgb, var(--fg) 80%, transparent)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {p.name}
                </span>
                <span style={{
                  flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-muted)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {p.path ? tildePath(p.path) : 'folder not on record'}
                </span>
                <span style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-muted)' }}>
                  last ran {relativeTime(p.lastActiveAt)}
                </span>
              </button>
            )
          })}
        </div>

        <div style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 16px', borderTop: '1px solid var(--border)',
        }}>
          <span data-tidy-count style={{
            fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-muted)',
            fontVariantNumeric: 'tabular-nums',
          }}>
            {n} of {projects.length} selected
          </span>
          <button onClick={onCancel} style={{ ...backBtn, marginLeft: 'auto' }}>Cancel</button>
          <button
            data-tidy-shelve
            disabled={n === 0}
            onClick={() => onShelve([...picked])}
            title={n === 0 ? 'Nothing selected' : `Move ${n} to Previous`}
            style={{
              // Surface button, never an accent fill — the affirmative action still isn't a
              // dangerous one, and this whole flow is undoable in one click.
              padding: '5px 13px', borderRadius: 'var(--radius-sm)',
              background: 'var(--btn-bg)', border: '1px solid var(--border)',
              color: 'var(--fg)', cursor: n === 0 ? 'default' : 'pointer', outline: 'none',
              opacity: n === 0 ? 0.4 : 1,
              fontFamily: 'var(--font-body)', fontSize: 11.5,
            }}
          >
            Shelve {n}
          </button>
        </div>
      </div>
    </div>
  )
}

/** The shared type treatment for a shelf header: mono, uppercase, quiet. Same vocabulary as
 *  the sidebar's AGENTS header, so a section reads as structure rather than as content. */
const SECTION_TYPE: React.CSSProperties = {
  fontFamily: 'var(--font-mono)', fontSize: 9.5, textTransform: 'uppercase',
  letterSpacing: '0.1em', color: 'var(--fg-muted)',
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div data-shelf-label style={{ ...SECTION_TYPE, padding: '2px 2px 9px' }}>{children}</div>
}

/** The Previous header — a section label that is also the collapse toggle. */
function SectionToggle({ label, expanded, togglable, onToggle }: {
  label: string
  expanded: boolean
  togglable: boolean
  onToggle: () => void
}) {
  return (
    <button
      data-shelf-toggle
      onClick={() => { if (togglable) onToggle() }}
      title={togglable ? (expanded ? 'Collapse' : 'Show previous projects') : 'Held open while you filter'}
      style={{
        ...SECTION_TYPE,
        display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
        // Right padding matches the rows' so the chevron lands on the same edge as their
        // "last ran" column; left stays at the grid's edge, with ACTIVE.
        margin: '22px 0 0', padding: '4px 10px 9px 2px',
        background: 'transparent', border: 'none', outline: 'none',
        cursor: togglable ? 'pointer' : 'default',
      }}
    >
      {label}
      {togglable && <span style={{ marginLeft: 'auto', fontSize: 11 }}>{expanded ? '⌄' : '›'}</span>}
    </button>
  )
}

/** A shelved project: a ROW, not a receded card. Everything a card says that only matters
 *  while you're working — description, orbs, backlog — is gone; what's left is the three
 *  facts you need to recognise it and decide whether to bring it back. */
function PreviousRow({ project, menuOpen, onMenu, onOpen, onRestore, onForget, onOpenFolderPrefs }: {
  project: Project
  menuOpen: boolean
  onMenu: (open: boolean) => void
  onOpen: () => void
  onRestore: () => void
  onForget: () => void
  onOpenFolderPrefs: () => void
}) {
  const [hover, setHover] = useState(false)
  const lost = !project.path
  const revealed = hover || menuOpen
  return (
    <div
      role="button"
      tabIndex={0}
      data-previous-row={project.id}
      onClick={() => { if (!menuOpen) onOpen() }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      onContextMenu={(e) => { e.preventDefault(); onMenu(true) }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={lost ? `${project.name} — its folder is no longer on record; opening still works` : project.path}
      style={{
        position: 'relative', display: 'flex', alignItems: 'center', gap: 10,
        height: 30, padding: '0 10px', boxSizing: 'border-box',
        // Background-only hover on a radiused element (the WKWebView freeze rule), and no
        // group opacity — the row recedes structurally, its ink is at full strength.
        borderRadius: 6, cursor: 'pointer', outline: 'none',
        background: revealed ? 'var(--overlay-subtle)' : 'transparent',
      }}
    >
      <span data-previous-name style={{
        // The LaneRow treatment: a title that is present but not competing with the cards
        // above it. 80% of --fg, never --fg-muted — this is a name, not metadata.
        flexShrink: 0, maxWidth: 210, fontSize: 11.5,
        color: 'color-mix(in srgb, var(--fg) 80%, transparent)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {project.name}
      </span>
      <span data-previous-path style={{
        flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-muted)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {lost ? 'folder not on record' : tildePath(project.path)}
      </span>
      <span data-previous-ran style={{
        flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-muted)',
      }}>
        {project.lastActiveAt ? `last ran ${relativeTime(project.lastActiveAt)}` : 'never opened'}
      </span>
      {/* Revealed on hover, but their boxes are always reserved: a control that appears by
          reflowing the row it's on is a control you miss. 0 → 1, never a partial fade. */}
      <button
        data-previous-restore
        onClick={(e) => { e.stopPropagation(); onRestore() }}
        title={`Bring ${project.name} back to Active`}
        style={{
          flexShrink: 0, padding: '2px 7px', borderRadius: 'var(--radius-sm)',
          background: 'transparent', border: '1px solid var(--border)', outline: 'none',
          color: 'var(--fg)', cursor: 'pointer',
          fontFamily: 'var(--font-body)', fontSize: 10.5,
          opacity: revealed ? 1 : 0, transition: 'opacity 120ms ease',
        }}
      >
        Restore
      </button>
      <button
        data-popmenu-trigger
        aria-expanded={menuOpen}
        onClick={(e) => { e.stopPropagation(); onMenu(!menuOpen) }}
        title="Project actions"
        aria-label={`${project.name} actions`}
        style={{
          flexShrink: 0, width: 18, height: 16, padding: 0, lineHeight: 1,
          display: 'grid', placeItems: 'center',
          background: 'transparent', border: 'none', borderRadius: 4, outline: 'none',
          color: 'var(--fg-muted)', cursor: 'pointer', fontSize: 12,
          opacity: revealed ? 1 : 0, transition: 'opacity 120ms ease',
        }}
      >⋯</button>

      {menuOpen && (
        <CardMenu
          onClose={() => onMenu(false)}
          items={[
            // No rename/description here: a 30px row has nowhere to host those editors, and
            // both verbs come back the moment the project does. Restore, then edit.
            { label: 'Reveal in Finder', onClick: () => { void window.operator.revealPath?.(project.path) }, disabled: lost },
            { label: 'Project Claude files', onClick: onOpenFolderPrefs, disabled: lost },
            { label: 'Restore to active', onClick: onRestore, separator: true },
            { label: 'Forget project', onClick: onForget, danger: true, confirm: true },
          ]}
        />
      )}
    </div>
  )
}

/** Everything is shelved. Not the first-run welcome (that's EmptyGallery) — this is a
 *  tidy store, so it says the two ways forward and gets out of the way. */
function NothingActive({ onOpenFolder }: { onOpenFolder: () => void }) {
  return (
    <div data-nothing-active style={{
      display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12,
      padding: '18px 2px 4px',
    }}>
      <p style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--fg-muted)', maxWidth: 420 }}>
        Nothing active right now. Open a folder to start something, or bring one back below.
      </p>
      <button
        onClick={onOpenFolder}
        style={{
          padding: '6px 16px', background: 'var(--bg-surface)', border: '1px solid var(--border)',
          borderRadius: 6, color: 'var(--fg)', fontSize: 12, fontFamily: 'inherit',
          cursor: 'pointer', outline: 'none',
        }}
      >
        Open a folder
      </button>
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
