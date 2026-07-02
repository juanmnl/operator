import type { ITheme } from '@xterm/xterm'
import { TerminalPane } from './TerminalPane'

// The terminal surface — xterm.js with the WebGL renderer.
//
// History: we moved off xterm to ghostty-web because xterm's WebGL/canvas renderers
// corrupted in WKWebView. Re-tested 2026-07 on current WebKit (Darwin 25): xterm + WebGL
// renders Claude's TUI CLEAN — no tofu, no duplicated rows, under sustained output and
// multiple sessions. So the corruption was a WebKit bug that's since been fixed, ghostty-web
// (and its WASM resize-hang) is gone, and this settled the "should we go Electron?" question:
// no — Electron's only terminal advantage was "xterm renders in Chromium," which now holds
// in WKWebView too. WebGL falls back to xterm's DOM renderer if the GPU context is lost.
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
      webgl
    />
  )
}
