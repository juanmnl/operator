import type { ITheme } from '@xterm/xterm'
import { GhosttyTerminalPane } from './GhosttyTerminalPane'

// The terminal. Operator renders every terminal — session panes and the scratch sheet —
// with ghostty-web: the real Ghostty VT engine (WASM, Canvas-2D), which renders Claude
// cleanly inside WKWebView where xterm corrupted. (The legacy xterm + DOM-grid renderers
// are still in the tree but no longer wired — ghostty is the one true surface now.)
export function TerminalSurface({ terminalId, theme, active }: {
  terminalId: string
  theme: ITheme
  active: boolean
}) {
  return <GhosttyTerminalPane terminalId={terminalId} theme={theme} active={active} />
}
