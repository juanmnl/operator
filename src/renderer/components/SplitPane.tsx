import type { ReactNode } from 'react'

// LIST AND DETAIL — the house layout, extracted.
//
// Three independent signals landed on the same shape before it had a name: the Codex reference's
// conversation-plus-detail, the PR tool's list-plus-context, and the user pointing at the Subagent
// library — *"the subagent view is the layout i'd want everywhere"*. `PageShell` already knew about
// it too; its `fullBleed` note says "required by a split pane like the agent library, whose two
// columns each scroll independently". The split was hand-rolled inside `AgentLibraryView`.
//
// TWO INDEPENDENT SCROLLERS is the load-bearing part, and it is why an ancestor must not cap the
// width: a capped ancestor parks both scrollbars at its edge instead of the window's. The measure
// belongs INSIDE — the index is a fixed width, and the detail caps its own content.
//
// The index width is a FIXED 240 and does not resize. That is the literal `AgentLibraryView` has
// always used, and nothing has asked for more: an index of names has a natural width, and a
// draggable divider is state to persist, a hit target to place, and a second thing that can
// disagree between two consumers. Add it when something actually needs it.
export function SplitPane({ index, detail, empty, indexWidth = 240 }: {
  /** The list column. Scrolls on its own. */
  index: ReactNode
  /** The detail column. `undefined`/`null` shows `empty` instead. */
  detail?: ReactNode
  /** Shown centred when there is no detail. A pane with nothing in it should say what to do, not
   *  sit blank — so this is required rather than optional. */
  empty: ReactNode
  indexWidth?: number
}) {
  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0, width: '100%', boxSizing: 'border-box' }}>
      <div style={{
        width: indexWidth, flexShrink: 0, borderRight: '1px solid var(--border)',
        overflow: 'auto', padding: '12px 10px',
      }}>
        {index}
      </div>
      <div style={{ flex: 1, overflow: 'auto', minWidth: 0 }}>
        {detail ?? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
            {empty}
          </div>
        )}
      </div>
    </div>
  )
}
