import type { ITheme } from '@xterm/xterm'
import { TerminalPane } from './TerminalPane'

// The terminal surface — xterm.js with the DOM renderer.
//
// History: xterm's WebGL/canvas renderers corrupt in WKWebView (tofu + duplicated/garbled
// rows). A 2026-07 re-test on Darwin 25 looked clean and we shipped WebGL in v0.8.0 — but
// real, long/interactive sessions still corrupt WHOLESALE (near-total glyph garble, atlas
// producing garbage for most cells), so the WebKit GPU bug is NOT fixed here. WebGL's
// texture-atlas failure has no reliable software mitigation (periodic atlas clears can't keep
// up), so the console renders via xterm's built-in DOM renderer: correct, no GPU atlas, a bit
// slower on heavy scroll. The overprint that the DOM renderer can show under Claude's
// cursor-up rewrites is handled by TerminalPane's repaint/heal loop. Flip `webgl` back on only
// if a future WebKit genuinely fixes the atlas.
export function TerminalSurface({ terminalId, theme, active, suspendFit }: {
  terminalId: string
  theme: ITheme
  active: boolean
  // Held true while a panel divider is being dragged — the terminal pauses its
  // per-resize fit (no reflow mid-drag) and fits once on release.
  suspendFit?: boolean
}) {
  return (
    <TerminalPane
      terminalId={terminalId}
      theme={theme}
      active={active}
      suspendFit={suspendFit}
      replayHistory
    />
  )
}
