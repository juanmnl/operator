import { useMemo } from 'react'
import type { AgentSession, Project } from '../../../shared/types'
import type { FolderPrefsTab } from '../preferences/FolderPreferencesView'
import { summarizeOverview, formatBytes, type OverviewCounts, type OverviewProjectRow, type Overview } from '../../../shared/worktree-overview'
import { useOverviewData, type OverviewData } from '../../lib/worktree-overview-data'
import { tildePath } from '../../lib/format'

// THE HOME OVERVIEW: every project with its lanes and worktrees, the folders that match no project,
// and the machine total. A tab of the project gallery (the launch surface), not a screen of its own.
//
// READ-ONLY. Nothing here removes anything. Each row links to the Worktrees tab, where removal lives
// with its confirmations.
//
// IT NEVER WAITS. The first paint comes from files (`worktreeQuickList`); git's flags fill in a
// moment later and the header says which of the two is on screen. See `lib/worktree-overview-data`.

/** Warning text: the tone mixed halfway into `--fg`, the plan meter's construction. Never an
 *  opacity, never `--fg-muted` for something that has to be read to act. */
const WARN_INK = 'color-mix(in srgb, var(--color-warning) 50%, var(--fg))'
const ERROR_INK = 'color-mix(in srgb, var(--color-error) 50%, var(--fg))'
const CONTROL_INK = 'color-mix(in srgb, var(--fg) 72%, transparent)'
/** Measure shared with the gallery header, so the table and the title share a left edge. */
const GRID_MAX = 1100

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** `a b c` → `a b c`: the last two words never split, so no line ends with one word alone. */
const bindLast = (s: string) => s.replace(/ (\S+)$/, ' $1')

export function useOverview(projects: Project[], sessions: AgentSession[], suspended: ReadonlyArray<{ cwd: string; projectId?: string }>): { overview: Overview; data: OverviewData & { refresh: () => void } } {
  const data = useOverviewData()
  const overview = useMemo(() => summarizeOverview({
    projects,
    worktrees: data.worktrees,
    sessions,
    suspended,
    detailed: data.phase === 'detailed',
  }), [projects, data.worktrees, data.phase, sessions, suspended])
  return { overview, data }
}

/** The one-line machine total for the gallery header. Opens the overview. */
export function OverviewChip({ overview, data, active, onClick }: {
  overview: Overview; data: OverviewData; active: boolean; onClick: () => void
}) {
  if (data.phase === 'idle' && !data.worktrees.length) return null
  const t = overview.total
  if (t.worktrees === 0 && !data.loading) return null
  const flagged = overview.detailed && t.unsaved > 0
  return (
    <button
      data-overview-chip
      onClick={onClick}
      title={active ? 'Back to your projects' : 'Projects and their worktrees on this machine'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px',
        borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
        background: active ? 'var(--overlay-medium)' : 'var(--overlay-subtle)',
        cursor: 'pointer', outline: 'none', fontFamily: 'inherit', whiteSpace: 'nowrap',
      }}
    >
      {/* A filled dot, never a ring: its colour is fixed, and a changing border on a radius is the
          WKWebView freeze rule. */}
      {flagged && <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--color-warning)' }} />}
      <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>
        {t.worktrees}
      </span>
      <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {t.worktrees === 1 ? 'worktree' : 'worktrees'}
      </span>
      {t.bytes > 0 && (
        <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)', fontVariantNumeric: 'tabular-nums' }}>
          · {t.bytesPartial ? '≥ ' : ''}{formatBytes(t.bytes)}
        </span>
      )}
    </button>
  )
}

export function WorktreeOverview({ overview, data, onOpenProject, onOpenSettings, onOpenGlobalWorktrees }: {
  overview: Overview
  data: OverviewData & { refresh: () => void }
  onOpenProject: (projectId: string) => void
  onOpenSettings: (projectPath: string, projectName: string, tab?: FolderPrefsTab) => void
  /** The Worktrees tab outside any project, for folders that match no project. */
  onOpenGlobalWorktrees: () => void
}) {
  const { rows, unknown, total, detailed } = overview
  const firstLoad = data.phase === 'idle' || (data.loading && data.worktrees.length === 0 && data.phase !== 'detailed')
  const withContent = rows.filter((r) => r.worktrees > 0 || r.running > 0 || r.suspended > 0)
  const quiet = rows.length - withContent.length

  return (
    <div className="scroll-hidden" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      <div data-overview style={{ padding: '4px 24px 28px', maxWidth: GRID_MAX, margin: '0 auto', boxSizing: 'border-box' }}>
        <TotalLine total={total} unknown={unknown.worktrees} detailed={detailed} data={data} />

        {data.phase === 'error' && (
          <p style={{ ...note, color: 'var(--fg)' }}>
            Couldn’t read the worktree folders. {data.error}
          </p>
        )}

        {firstLoad ? (
          <SkeletonRows />
        ) : withContent.length === 0 && unknown.worktrees === 0 ? (
          <p data-overview-empty style={note}>
            {rows.length === 0
              ? bindLast('No projects and no worktrees on this machine yet.')
              : bindLast('No worktrees and no lanes in any project right now.')}
          </p>
        ) : (
          <div role="table" aria-label="Projects and their worktrees" style={{ display: 'flex', flexDirection: 'column', marginTop: 10 }}>
            {withContent.map((row) => (
              <ProjectRow
                key={row.projectId}
                row={row}
                detailed={detailed}
                onOpen={() => onOpenProject(row.projectId)}
                onSettings={row.path ? () => onOpenSettings(row.path, row.name) : undefined}
                onWorktrees={row.path ? () => onOpenSettings(row.path, row.name, 'Worktrees') : undefined}
              />
            ))}
            {unknown.worktrees > 0 && (
              <UnknownRow counts={unknown} repos={unknown.repos} detailed={detailed} onWorktrees={onOpenGlobalWorktrees} />
            )}
            {quiet > 0 && (
              <p style={{ ...note, marginTop: 10 }}>
                {bindLast(`${plural(quiet, 'other project has', 'other projects have')} no worktrees and no lanes.`)}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function TotalLine({ total, unknown, detailed, data }: { total: OverviewCounts; unknown: number; detailed: boolean; data: OverviewData & { refresh: () => void } }) {
  const parts = [
    plural(total.worktrees, 'worktree', 'worktrees'),
    total.bytes > 0 || !total.bytesPartial ? `${total.bytesPartial ? 'at least ' : ''}${formatBytes(total.bytes)}` : null,
    unknown > 0 ? `${unknown} outside any project` : null,
  ].filter(Boolean)
  const status = data.loading
    ? (detailed || data.phase === 'quick' ? 'Checking git in each folder…' : 'Reading folders…')
    : detailed
      ? null
      : 'Sizes are from the last measurement.'
  return (
    <div data-overview-total style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 12, rowGap: 4, padding: '6px 0 8px', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg)' }}>
        {bindLast(`On this machine: ${parts.join(' · ')}`)}
      </span>
      {detailed && <Flags counts={total} />}
      {status && <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{bindLast(status)}</span>}
      <button
        data-overview-refresh
        onClick={data.refresh}
        disabled={data.loading}
        title="Read the folders and ask git again. Sizes are re-measured only for folders that changed."
        style={{ ...actionBtn, marginLeft: 'auto', color: data.loading ? 'var(--fg-muted)' : CONTROL_INK, cursor: data.loading ? 'default' : 'pointer' }}
      >{data.loading ? 'Refreshing…' : 'Refresh'}</button>
    </div>
  )
}

/** The flags, as transparent bordered chips with the colour on the text. Only what is non-zero. */
function Flags({ counts, compact }: { counts: OverviewCounts; compact?: boolean }) {
  const chips: Array<{ key: string; text: string; ink: string; title: string }> = []
  if (counts.unsaved > 0) chips.push({ key: 'unsaved', ink: WARN_INK, text: `${counts.unsaved} unsaved`, title: plural(counts.unsaved, 'folder has uncommitted files or commits no branch or remote has', 'folders have uncommitted files or commits no branch or remote has') })
  if (counts.unsavedUnknown > 0) chips.push({ key: 'unknown', ink: CONTROL_INK, text: `${counts.unsavedUnknown} unreadable`, title: plural(counts.unsavedUnknown, 'folder git could not read, so its unsaved work is unknown', 'folders git could not read, so their unsaved work is unknown') })
  if (counts.wouldRemove > 0) chips.push({ key: 'auto', ink: CONTROL_INK, text: compact ? `${counts.wouldRemove} auto` : `${counts.wouldRemove} would be removed automatically`, title: 'Clean, no unsaved commits, unused for a day. Nothing is removed from here.' })
  if (counts.deadRepo > 0) chips.push({ key: 'dead', ink: ERROR_INK, text: `${counts.deadRepo} source repo gone`, title: plural(counts.deadRepo, 'folder whose source repository is no longer on disk', 'folders whose source repository is no longer on disk') })
  if (!chips.length) return null
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6 }}>
      {chips.map((c) => (
        <span key={c.key} data-overview-flag={c.key} title={c.title} style={{
          display: 'inline-flex', alignItems: 'center', height: 18, padding: '0 6px', boxSizing: 'border-box',
          border: '1px solid var(--border)', borderRadius: 4, background: 'transparent',
          color: c.ink, fontSize: 10.5, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
        }}>{c.text}</span>
      ))}
    </span>
  )
}

function ProjectRow({ row, detailed, onOpen, onSettings, onWorktrees }: {
  row: OverviewProjectRow; detailed: boolean
  onOpen: () => void; onSettings?: () => void; onWorktrees?: () => void
}) {
  const lanes = [
    row.running > 0 ? `${row.running} running` : null,
    row.suspended > 0 ? `${row.suspended} suspended` : null,
  ].filter(Boolean).join(' · ') || 'No lanes'
  return (
    <div role="row" data-overview-row={row.projectId} style={rowStyle}>
      <div role="cell" style={{ flex: '1 1 220px', minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</div>
        <div style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {row.path ? tildePath(row.path) : 'folder not on record'}
        </div>
      </div>
      <div role="cell" style={{ ...stat, flex: '0 0 150px' }}>{lanes}</div>
      <div role="cell" style={{ ...stat, flex: '0 0 150px' }}>
        {row.worktrees === 0 ? 'No worktrees' : `${plural(row.worktrees, 'worktree', 'worktrees')} · ${row.bytesPartial && row.bytes === 0 ? 'size pending' : `${row.bytesPartial ? '≥ ' : ''}${formatBytes(row.bytes)}`}`}
      </div>
      <div role="cell" style={{ flex: '1 1 160px', minWidth: 0 }}>
        {detailed ? <Flags counts={row} compact /> : row.deadRepo > 0 ? <Flags counts={{ ...row, unsaved: 0, unsavedUnknown: 0, wouldRemove: 0 }} compact /> : null}
      </div>
      <div role="cell" style={{ display: 'flex', gap: 2, marginLeft: 'auto', flexShrink: 0 }}>
        <RowAction label="Open" title={`Open ${row.name}`} onClick={onOpen} />
        <RowAction label="Settings" title={`Project settings · ${row.name}`} onClick={onSettings} />
        <RowAction label="Worktrees" title={`${row.name}: the Worktrees tab, where folders can be removed`} onClick={row.worktrees > 0 ? onWorktrees : undefined} />
      </div>
    </div>
  )
}

function UnknownRow({ counts, repos, detailed, onWorktrees }: { counts: OverviewCounts; repos: string[]; detailed: boolean; onWorktrees: () => void }) {
  return (
    <div role="row" data-overview-row="unknown" style={rowStyle}>
      <div role="cell" style={{ flex: '1 1 220px', minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg)' }}>Outside any project</div>
        <div title={repos.join('\n')} style={{ fontSize: 10.5, color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {repos.length
            ? bindLast(`From ${plural(repos.length, 'repository', 'repositories')} Operator has no project for`)
            : bindLast('Folders that name no source repository')}
        </div>
      </div>
      <div role="cell" style={{ ...stat, flex: '0 0 150px' }}>—</div>
      <div role="cell" style={{ ...stat, flex: '0 0 150px' }}>
        {`${plural(counts.worktrees, 'folder', 'folders')} · ${counts.bytesPartial && counts.bytes === 0 ? 'size pending' : `${counts.bytesPartial ? '≥ ' : ''}${formatBytes(counts.bytes)}`}`}
      </div>
      <div role="cell" style={{ flex: '1 1 160px', minWidth: 0 }}>
        {detailed ? <Flags counts={counts} compact /> : counts.deadRepo > 0 ? <Flags counts={{ ...counts, unsaved: 0, unsavedUnknown: 0, wouldRemove: 0 }} compact /> : null}
      </div>
      <div role="cell" style={{ display: 'flex', gap: 2, marginLeft: 'auto', flexShrink: 0 }}>
        <RowAction label="Worktrees" title="The Worktrees tab, where folders can be removed" onClick={onWorktrees} />
      </div>
    </div>
  )
}

function RowAction({ label, title, onClick }: { label: string; title: string; onClick?: () => void }) {
  const off = !onClick
  return (
    <button
      onClick={onClick}
      disabled={off}
      title={title}
      style={{ ...actionBtn, color: off ? 'color-mix(in srgb, var(--fg-muted) 65%, var(--bg-surface))' : CONTROL_INK, cursor: off ? 'default' : 'pointer' }}
      onMouseEnter={(e) => { if (!off) e.currentTarget.style.background = 'var(--overlay-subtle)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >{label}</button>
  )
}

/** Three placeholder rows while the first reading is on its way. Static: motion in this app means
 *  an agent is busy. */
function SkeletonRows() {
  return (
    <div data-overview-loading aria-label="Reading worktrees" style={{ display: 'flex', flexDirection: 'column', marginTop: 10 }}>
      {[0, 1, 2].map((i) => (
        <div key={i} style={rowStyle}>
          <span style={{ width: 160, height: 10, borderRadius: 3, background: 'var(--overlay-subtle)' }} />
          <span style={{ width: 90, height: 10, borderRadius: 3, background: 'var(--overlay-subtle)' }} />
          <span style={{ width: 110, height: 10, borderRadius: 3, background: 'var(--overlay-subtle)' }} />
        </div>
      ))}
    </div>
  )
}

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 16, rowGap: 6,
  padding: '10px 0', borderBottom: '1px solid var(--border)', minHeight: 52, boxSizing: 'border-box',
}

const stat: React.CSSProperties = {
  fontSize: 11.5, color: 'var(--fg)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
}

const note: React.CSSProperties = { fontSize: 11.5, color: 'var(--fg-muted)', margin: '14px 0 0' }

const actionBtn: React.CSSProperties = {
  border: 'none', background: 'transparent', outline: 'none', borderRadius: 5,
  padding: '4px 8px', fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 600,
}
