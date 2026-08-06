// Lane-switch resize harness — the receipt for "switching agents wakes every lane".
//
// It mounts the REAL `TerminalPane` (not a copy) LANES times in the layout
// DashboardView uses: every pane is an absolutely-positioned sibling inside one
// shared `flex: 1` container, hidden with `visibility` rather than unmounted, and
// the per-session Plan/Diff panel is a flex SIBLING of that container. Switching
// to a lane whose `panelOpen` differs therefore changes the container's real
// width, which is what makes every hidden pane's ResizeObserver fire.
//
// `window.operator` is a counting stub, so what it measures is precisely what
// would have reached the pty: one `terminalResize` call per lane per switch.
import '@xterm/xterm/css/xterm.css'
import '../../src/renderer/styles.css'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TerminalPane } from '../../src/renderer/components/terminal/TerminalPane'

const LANES = 5
const ids = Array.from({ length: LANES }, (_, i) => `t${i}`)

/** Every terminalResize the panes make, in order. The whole measurement. */
const calls: { id: string; cols: number; rows: number; at: number }[] = []

const w = window as unknown as Record<string, unknown>
w.operator = {
  terminalResize: (id: string, cols: number, rows: number) => { calls.push({ id, cols, rows, at: Date.now() }) },
  terminalStart: () => {},
  terminalWrite: () => {},
  savePastedImage: async () => '',
  openExternal: () => {},
  // No pty behind this harness: subscribing is enough, nothing ever arrives.
  onTerminalData: () => () => {},
  terminalHistory: async () => '',
}

const THEME = { background: '#0b0d10', foreground: '#d7d7de' }

function Harness() {
  const [active, setActive] = useState(ids[0])
  // Starts OPEN, and the switch below closes it: the trigger is the incoming
  // lane's panel state DIFFERING from the outgoing lane's, not the switch itself.
  const [panelOpen, setPanelOpen] = useState(true)
  // `?panel=keep` is the CONTROL: switch lane with the panel state unchanged, which
  // moves no pixels and must therefore resize nothing.
  const keepPanel = new URLSearchParams(location.search).get('panel') === 'keep'
  w.__switchLane = () => { setActive(ids[1]); if (!keepPanel) setPanelOpen(false) }
  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
        {ids.map((id) => (
          <div key={id} style={{ position: 'absolute', inset: 0, visibility: id === active ? 'visible' : 'hidden' }}>
            <TerminalPane terminalId={id} theme={THEME} active={id === active} />
          </div>
        ))}
      </div>
      {panelOpen && <div style={{ width: 360, flexShrink: 0, background: '#111418' }} />}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Harness />)

/** Distinct terminals resized, and the raw calls, since the last reset. */
const report = () => ({ lanes: LANES, terminals: [...new Set(calls.map((c) => c.id))].sort(), calls: calls.length })
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))
// Driven from capture.mjs for the OS-window-resize check, which only Playwright can cause.
w.__reset = () => { calls.length = 0 }
w.__report = report

;(async () => {
  // Mount + initial fits (ensureInitialFit, then the 250/800ms kicks) must all be
  // spent before the counter means anything.
  await settle(2500)
  // What every pane got at MOUNT, guard or no guard: `ensureInitialFit` sizes each pty directly,
  // so a lane launched in the background (how a dispatch launches one) must still start at the
  // right width. If this drops below the lane count, the guard has been put in the wrong place.
  w.__mountReport = report()
  calls.length = 0
  w.__switchLane?.()
  // Generous: a deferred fit retries at FIT_QUIET_MS and the observer is async.
  await settle(2000)
  w.__resizeReport = report()
  w.__resizeDone = true
})()
