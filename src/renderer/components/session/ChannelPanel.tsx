import { memo, useEffect, useRef, useState } from 'react'
import type { Project } from '../../../shared/types'
import { MoodboardPanel } from './MoodboardPanel'
import type { ChannelEntry } from '../../lib/project-channel'
import { parseInline } from '../../lib/canvas-md'

// The channel's right panel — the app shell's `rightPanel` slot, filled.
//
// TABBED, and that resolves a conflict rather than splitting the difference. Two requests competed
// for the same space: "the channel needs a right panel — the moodboard and project-wide info", and
// "the subagent view is the layout I'd want everywhere" (index + detail). Naively that is three
// columns beside the rail and the sidebar. The detail pane IS the right panel, and it carries tabs
// — the PR-tool pattern already recorded in dev/design-references.md.
//
//   digest rows in the feed = the INDEX
//   [ Message ]  the selected entry, in full
//   [ Project ]  the moodboard and the project's notes
//
// It rests on PROJECT with nothing selected, so the panel is never empty and the moodboard is what
// you see by default. Selecting a row fills Message and switches to it.
//
// ⚠️ MEMOISED, and that is not decoration. This sits beside a LIVE feed: `session:update` arrives
// about every second, and the reading-panel freeze (project_chat_markdown_freeze) came from
// re-parsing markup on every one of those. `memo` means a channel message that changes nothing
// here re-renders nothing here — the moodboard does not re-decode its images, and the selected
// entry is not re-tokenised.
export const ChannelPanel = memo(function ChannelPanel({ project, selected, onClearSelection }: {
  project: Project
  /** The digest row the reader picked, or undefined. */
  selected?: ChannelEntry
  onClearSelection?: () => void
}) {
  const [tab, setTab] = useState<'message' | 'project'>('project')
  // Picking a row SWITCHES to Message — otherwise the selection lands in a tab you are not looking
  // at, which reads as the click having done nothing. Keyed on the id so it fires per selection and
  // not on every render, and so returning to a row you had open still brings the tab forward.
  const lastId = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (selected && selected.id !== lastId.current) setTab('message')
    lastId.current = selected?.id
  }, [selected])
  // A selection takes you to Message; clearing it falls back to Project rather than to an empty
  // pane. `effective` rather than a `setTab` effect: deriving avoids a render where the tab and the
  // selection disagree.
  const effective = selected ? tab : 'project'

  return (
    <aside
      data-channel-panel
      style={{
        width: 340, flexShrink: 0, minWidth: 0,
        borderLeft: '1px solid color-mix(in srgb, var(--border) 70%, transparent)',
        display: 'flex', flexDirection: 'column', minHeight: 0,
        background: 'var(--bg-terminal)',
      }}
    >
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 2,
        padding: '0 8px', height: 36,
        borderBottom: '1px solid color-mix(in srgb, var(--border) 70%, transparent)',
      }}>
        <PanelTab label="Message" active={effective === 'message'} disabled={!selected} onClick={() => setTab('message')} />
        <PanelTab label="Project" active={effective === 'project'} onClick={() => setTab('project')} />
        {selected && (
          <button
            data-channel-panel-clear
            onClick={onClearSelection}
            title="Clear the selection"
            aria-label="Clear the selection"
            style={{
              marginLeft: 'auto', padding: '2px 6px', border: 'none', background: 'transparent',
              color: 'var(--fg-muted)', cursor: 'pointer', outline: 'none',
              fontFamily: 'var(--font-mono)', fontSize: 9,
            }}
          >clear</button>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {effective === 'project'
          ? <ProjectTab project={project} />
          : <MessageTab entry={selected!} />}
      </div>
    </aside>
  )
})

function PanelTab({ label, active, disabled, onClick }: { label: string; active: boolean; disabled?: boolean; onClick: () => void }) {
  const [focused, setFocused] = useState(false)
  return (
    <button
      data-channel-panel-tab={label.toLowerCase()}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        padding: '3px 9px', borderRadius: 'var(--radius-sm)', border: 'none',
        // Faint surface tint plus normal ink — never an accent fill.
        background: active ? 'var(--overlay-subtle)' : 'transparent',
        color: disabled ? 'color-mix(in srgb, var(--fg-muted) 65%, var(--bg-terminal))' : active ? 'var(--fg)' : 'var(--fg-muted)',
        boxShadow: focused ? 'inset 0 0 0 1px color-mix(in srgb, var(--accent) 55%, var(--fg))' : 'none',
        cursor: disabled ? 'default' : 'pointer', outline: 'none',
        fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.04em',
      }}
    >{label}</button>
  )
}

/** Project-wide context: the moodboard, and whatever the project says about itself. */
function ProjectTab({ project }: { project: Project }) {
  const notes = project.contextNotes?.trim()
  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>
      <section>
        <Caption>About</Caption>
        {notes
          ? <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.6, color: 'color-mix(in srgb, var(--fg) 82%, transparent)', whiteSpace: 'pre-wrap' }}>{notes}</p>
          : <Blank>No description yet. Add one from the project card&rsquo;s ⋯ menu.</Blank>}
      </section>
      <section style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <Caption>Moodboard</Caption>
        {/* REUSED, not reimplemented — it already owns the on-disk store via moodboardAdd /
            moodboardList, and it is also reached from ProjectView. Two entry points is fine; two
            implementations is not. Its own empty state covers "no images". */}
        <MoodboardPanel projectId={project.id} />
      </section>
    </div>
  )
}

/** The selected entry, in full — the panel is for reading one thing properly, which is why the
 *  digest row keeps its own expand-in-place rather than delegating to this. */
function MessageTab({ entry }: { entry: ChannelEntry }) {
  const spans = entry.text.length > 8192 ? null : parseInline(entry.text)
  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--fg)' }}>{entry.authorLabel}</span>
        {entry.targetLabel && <span style={{ fontSize: 10.5, color: 'var(--fg-muted)' }}>→ {entry.targetLabel}</span>}
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--fg-muted)' }}>{entry.chip.label}</span>
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--fg)', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
        {spans
          ? spans.map((s, i) => (s.code
            ? <code key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--overlay-medium)', padding: '0.5px 4px', borderRadius: 3 }}>{s.text}</code>
            : <span key={i} style={{ fontWeight: s.bold ? 600 : undefined, fontStyle: s.italic ? 'italic' : undefined }}>{s.text}</span>))
          : entry.text}
      </div>
    </div>
  )
}

function Caption({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontFamily: 'var(--font-mono)', fontSize: 8.5, textTransform: 'uppercase',
      letterSpacing: '0.12em', color: 'var(--fg-muted)', marginBottom: 6,
    }}>{children}</div>
  )
}
function Blank({ children }: { children: React.ReactNode }) {
  return <p style={{ margin: 0, fontSize: 11, lineHeight: 1.6, color: 'var(--fg-muted)' }}>{children}</p>
}
