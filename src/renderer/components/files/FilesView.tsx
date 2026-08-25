import { useCallback, useState } from 'react'
import { FileTree } from './FileTree'
import { FileViewer } from './FileViewer'
import { SURFACE_FILL, PANEL_SUBHEAD_H } from '../../lib/chrome'
import { navigateTo, pushRecent, type FilesNav } from '../../lib/code-nav'

// PLACEMENT A — the main view (§2). Tree at 240 on the left, viewer on the right, each scrolling
// on its own.
//
// `SplitPane` is deliberately NOT used here even though it is exactly this shape: it pads its
// index column (`12px 10px`) for a list of names, and a file tree's rows are full-bleed hit
// targets whose indentation carries the hierarchy. Padding them insets every row by the same
// amount, which reads as a margin error rather than as structure. The two-independent-scrollers
// part — the load-bearing half — is reproduced directly.

export interface FilesViewProps {
  /** The lane's worktree. */
  laneRoot: string
  /** The project's main checkout, for the root switch. Absent when the lane is not a worktree. */
  projectRoot?: string
  nav: FilesNav
  onNav: (next: FilesNav) => void
  /** Status letters per path, from the same `worktreeDiff` the Diff tab reads. */
  changed?: Record<string, string>
  onAsk?: (path: string, range?: [number, number]) => void
}

export function FilesView({ laneRoot, projectRoot, nav, onNav, changed, onAsk }: FilesViewProps) {
  const [showIgnored, setShowIgnored] = useState(false)
  const root = nav.root === 'project' && projectRoot ? projectRoot : laneRoot

  const select = useCallback((path: string) => {
    onNav({ ...nav, path, line: undefined, range: undefined, recent: pushRecent(nav.recent, path) })
  }, [nav, onNav])

  const toggle = useCallback((dir: string, open: boolean) => {
    onNav({
      ...nav,
      expanded: open ? [...new Set([...nav.expanded, dir])] : nav.expanded.filter((d) => d !== dir),
    })
  }, [nav, onNav])

  if (!root) {
    return (
      <div style={centred}>
        <div>No lane open. Files reads the worktree of the lane you're in.</div>
      </div>
    )
  }

  return (
    // An EXPLICIT height, because the main view's overlay is a plain block where `flex` means
    // nothing. See `SURFACE_FILL` — sizing this by `flex: 1` alone is what made Files
    // unscrollable in 0.18.0.
    <div data-files-view style={{ ...SURFACE_FILL, display: 'flex', flexDirection: 'column' }}>
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10,
        height: PANEL_SUBHEAD_H, padding: '0 12px', boxSizing: 'border-box',
        borderBottom: '1px solid var(--border)',
        fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)',
      }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={nav.path ?? root}>
          {nav.path ?? root}
        </span>
        {/* A source SELECTOR, not a setting — it names a checkout, so it is two labelled choices
            rather than a Segmented control. Only offered when there is a second root to pick. */}
        {projectRoot && projectRoot !== laneRoot && (
          <button
            onClick={() => onNav({ ...nav, root: nav.root === 'lane' ? 'project' : 'lane' })}
            style={chipBtn}
            title={nav.root === 'lane' ? 'Read the project checkout instead' : 'Read the lane worktree instead'}
          >{nav.root === 'lane' ? 'lane worktree' : 'project'}</button>
        )}
        <button
          onClick={() => setShowIgnored((v) => !v)}
          style={{ ...chipBtn, color: showIgnored ? 'var(--accent)' : 'var(--fg-muted)' }}
          title="Show node_modules, target, dist and friends"
        >ignored</button>
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0, minWidth: 0 }}>
        {/* `tabIndex={-1}` so a click FOCUSES the column and PageDown/arrows scroll it — a plain
            div takes no focus, so the tree could be wheeled but never scrolled from the keyboard.
            -1 rather than 0 keeps it out of the tab order (CodeMirror's own scroller does exactly
            this), and `outline: none` keeps the app's no-focus-ring rule. */}
        <div
          data-files-tree
          tabIndex={-1}
          style={{ width: 240, flexShrink: 0, borderRight: '1px solid var(--border)', overflow: 'auto', outline: 'none' }}
        >
          <FileTree
            root={root}
            expanded={nav.expanded}
            onToggle={toggle}
            selected={nav.path}
            onSelect={select}
            changed={changed}
            showIgnored={showIgnored}
          />
        </div>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
          <FileViewer
            root={root}
            path={nav.path}
            highlight={nav.range ?? (nav.line != null ? [nav.line, nav.line] : undefined)}
            form="wide"
            onAsk={onAsk}
          />
        </div>
      </div>
    </div>
  )
}

/** Re-exported so a caller following a deep link does not have to import two modules. */
export { navigateTo }

const centred: React.CSSProperties = {
  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 40, textAlign: 'center', fontSize: 11, color: 'var(--fg-muted)',
}

const chipBtn: React.CSSProperties = {
  background: 'none', border: 'none', outline: 'none', cursor: 'pointer',
  color: 'var(--fg-muted)', font: 'inherit', padding: 0, flexShrink: 0,
}
