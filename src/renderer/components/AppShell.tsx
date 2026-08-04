import type { ReactNode } from 'react'
import { DragRegion } from './DragRegion'
import { SidebarToggle } from './SidebarToggle'
import { TOOLBAR_BAND_H } from '../lib/chrome'

// THE FRAME. Every content mode sits in this; the rail and the sidebar sit outside it.
//
// It exists because there wasn't one. The right panel and the status bar were rendered inline
// inside DashboardView's SESSION branch, so they existed for exactly one content mode and every
// other mode got whatever frame its own branch happened to build. That is the same root cause
// behind three symptoms already fixed one at a time: the header alignment drifting between views,
// the sidebar toggle being absent from six modes, and the channel having to invent its own header.
//
// ┌──────────────────────────────────────────────────────────┐
// │ HEADER      [left] ......... [centre] ......... [right]  │  44px, 16px inset
// ├───────────────────────────────┬──────────────────────────┤
// │ CONTENT                       │ RIGHT PANEL (optional)   │
// ├───────────────────────────────┴──────────────────────────┤
// │ STATUS BAR (optional)                                    │
// └──────────────────────────────────────────────────────────┘
//
// WHERE CONTROLS LIVE — the rule, and the audit that placed every existing control:
//
//   LEFT    where you are and how you got here — back, project/session name, branch.
//   CENTRE  switching what this pane SHOWS. Console/Chat/Preview is the example.
//   RIGHT   chrome and config for the current view — MCP count, effort, mode, panel toggle,
//           the agent↔agent kill switch.
//
// The SIDEBAR TOGGLE is none of those: it is shell furniture, so the shell renders it and no mode
// passes it. It had been added to three separate toolbars, which is the copy-per-surface pattern
// this component exists to stop.
//
// Per-message actions are NOT a header zone and are governed at the row: incidental ones (copy)
// hover at the row's right edge; decisions (Approve & send) stay persistent in the row body,
// because a decision you must make cannot hide behind a hover.
//
// SLOTS ARE DECLARED, NOT EMERGENT. A mode says what it puts in the right panel and the status
// bar, or says it has none — `undefined` collapses the slot entirely. An empty-but-present bar is
// worse than no bar, which is why there is no "always render it, mode fills it" variant.
export function AppShell({
  header, children, rightPanel, statusBar, onToggleSidebar, sidebarCollapsed, headerless,
}: {
  header?: { left?: ReactNode; centre?: ReactNode; right?: ReactNode }
  children: ReactNode
  /** A mode's own panel, about ITS subject — a session's is PLAN·DIFF·CHAT, the channel's is the
   *  project. Same slot, same geometry; the mode supplies the contents rather than the shell
   *  owning one panel that modes toggle. Absent = no panel. */
  rightPanel?: ReactNode
  /** Absent = the shell collapses it. */
  statusBar?: ReactNode
  onToggleSidebar?: () => void
  sidebarCollapsed?: boolean
  /** The gallery draws its own full-bleed chrome and the sidebar is width 0 there, so a 44px bar
   *  with a lone toggle would be furniture for a surface that has none. */
  headerless?: boolean
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, minHeight: 0 }}>
      {!headerless && (
        // The canonical toolbar box — 44 tall, 16 inset — established across the three toolbars in
        // the header-alignment pass and now owned in one place instead of restated in each.
        <DragRegion
          data-toolbar-header="shell"
          style={{
            flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
            height: TOOLBAR_BAND_H, padding: '0 16px', boxSizing: 'border-box',
            borderBottom: '1px solid color-mix(in srgb, var(--border) 70%, transparent)',
          }}
        >
          {onToggleSidebar && (
            <SidebarToggle collapsed={sidebarCollapsed} onToggle={onToggleSidebar} />
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexShrink: 1 }}>
            {header?.left}
          </div>
          {/* The centre zone is genuinely centred when present, and costs nothing when absent. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '0 auto' }}>
            {header?.centre}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {header?.right}
          </div>
        </DragRegion>
      )}

      <div style={{ flex: 1, minHeight: 0, display: 'flex', minWidth: 0 }}>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {children}
        </div>
        {rightPanel}
      </div>

      {statusBar}
    </div>
  )
}
