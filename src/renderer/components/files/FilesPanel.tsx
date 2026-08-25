import { useEffect, useRef, useState } from 'react'
import { FileTree } from './FileTree'
import { FileViewer } from './FileViewer'
import { SURFACE_FILL, PANEL_SUBHEAD_H } from '../../lib/chrome'
import { panelForm, pushRecent, type FilesNav, type PanelForm } from '../../lib/code-nav'

// PLACEMENT B — the right-panel tab (§3). The SAME `FileViewer`; everything placement-specific is
// a prop, which is the point of having one viewer.
//
// THREE FORMS BY MEASURED WIDTH, and the thresholds are derived rather than picked: JetBrains
// Mono at 11px is ≈6.6px/char, so 80 columns ≈ 528px of text. They live in `lib/code-nav.ts`
// (`panelForm`) so the routing rule and this component cannot disagree about what "too narrow"
// means.
//
//   ≥ 560  wide    breadcrumb + viewer, tree behind a ▤ disclosure that overlays as a 200px sheet
//   340+   medium  breadcrumb + viewer; tree only via the disclosure    ← THE DEFAULT (460)
//   < 340  narrow  file only; the breadcrumb collapses to the file name
//
// Line numbers stay in every form. They are the addressing scheme — dropping them is what makes a
// deep link unverifiable.

export interface FilesPanelProps {
  laneRoot: string
  projectRoot?: string
  nav: FilesNav
  onNav: (next: FilesNav) => void
  changed?: Record<string, string>
  onAsk?: (path: string, range?: [number, number]) => void
}

export function FilesPanel({ laneRoot, projectRoot, nav, onNav, changed, onAsk }: FilesPanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [form, setForm] = useState<PanelForm>('medium')
  const [treeOpen, setTreeOpen] = useState(false)
  const root = nav.root === 'project' && projectRoot ? projectRoot : laneRoot

  // MEASURE THE ELEMENT, not the window. The panel is resizable and the sidebar is collapsible,
  // so a form chosen from `window.innerWidth` would be wrong in exactly the layouts that matter.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const ro = new ResizeObserver(([entry]) => setForm(panelForm(entry.contentRect.width)))
    ro.observe(host)
    setForm(panelForm(host.getBoundingClientRect().width))
    return () => ro.disconnect()
  }, [])

  // The disclosure is a sheet, not a column — at these widths a permanent tree would leave the
  // viewer under 340px, which is the narrow form's whole problem.
  useEffect(() => { if (form === 'narrow') setTreeOpen(false) }, [form])

  const select = (path: string) => {
    onNav({ ...nav, path, line: undefined, range: undefined, recent: pushRecent(nav.recent, path) })
    setTreeOpen(false)
  }

  if (!root) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', fontSize: 11, color: 'var(--fg-muted)' }}>
        No lane open. Files reads the worktree of the lane you're in.
      </div>
    )
  }

  const label = form === 'narrow'
    ? (nav.path?.split('/').pop() ?? 'Files')
    // Medium and wide show a shortened path — the tail is what identifies the file, so the HEAD
    // is what gets dropped.
    : shortenPath(nav.path ?? '', form === 'wide' ? 48 : 36)

  return (
    // Same `SURFACE_FILL` as the main-view placement, for the same reason: the panel body this
    // lands in is a `flex: 1` BLOCK, so `flex: 1` here sized the column to its content and the
    // viewer below the fold could not be scrolled to.
    <div ref={hostRef} data-files-panel style={{ ...SURFACE_FILL, display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
        height: PANEL_SUBHEAD_H, padding: '0 10px', boxSizing: 'border-box',
        borderBottom: '1px solid var(--border)',
        fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)',
      }}>
        {form !== 'narrow' && (
          <button onClick={() => setTreeOpen((v) => !v)} style={{ ...chipBtn, color: treeOpen ? 'var(--accent)' : 'var(--fg-muted)' }} title="Show the tree">▤</button>
        )}
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={nav.path}>
          {label || 'Files'}
        </span>
        {projectRoot && projectRoot !== laneRoot && (
          <button
            onClick={() => onNav({ ...nav, root: nav.root === 'lane' ? 'project' : 'lane' })}
            style={chipBtn}
            title={nav.root === 'lane' ? 'Read the project checkout instead' : 'Read the lane worktree instead'}
          >{nav.root === 'lane' ? 'lane' : 'project'}</button>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex' }}>
        <FileViewer
          root={root}
          path={nav.path}
          highlight={nav.range ?? (nav.line != null ? [nav.line, nav.line] : undefined)}
          form={form}
          onAsk={onAsk}
        />
      </div>

      {treeOpen && form !== 'narrow' && (
        <div style={{
          position: 'absolute', top: PANEL_SUBHEAD_H, left: 0, bottom: 0, width: 200,
          background: 'var(--bg-surface)', borderRight: '1px solid var(--border)',
          overflow: 'auto', zIndex: 2,
        }}>
          <FileTree
            root={root}
            expanded={nav.expanded}
            onToggle={(dir, open) => onNav({
              ...nav,
              expanded: open ? [...new Set([...nav.expanded, dir])] : nav.expanded.filter((d) => d !== dir),
            })}
            selected={nav.path}
            onSelect={select}
            changed={changed}
          />
        </div>
      )}
    </div>
  )
}

/** Drop leading segments until the path fits, keeping the tail — the tail identifies the file.
 *  Pure; exported for the test alongside the routing rule. */
export function shortenPath(path: string, max: number): string {
  if (path.length <= max) return path
  const parts = path.split('/')
  let out = parts[parts.length - 1]
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = `${parts[i]}/${out}`
    if (next.length + 2 > max) return `…/${out}`
    out = next
  }
  return out
}

const chipBtn: React.CSSProperties = {
  background: 'none', border: 'none', outline: 'none', cursor: 'pointer',
  color: 'var(--fg-muted)', font: 'inherit', padding: 0, flexShrink: 0,
}
