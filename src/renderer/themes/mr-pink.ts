import type { ITheme } from '@xterm/xterm'

export const mrPinkXterm: ITheme = {
  background: '#22222A',
  foreground: '#F6F8F7',
  cursor: '#D58FDB',
  cursorAccent: '#22222A',
  selectionBackground: '#ffffff3b',
  selectionForeground: undefined,
  black: '#1E1E25',
  red: '#ff6057',
  green: '#84eea7',
  yellow: '#FAD481',
  blue: '#4095ff',
  magenta: '#F859CA',
  cyan: '#8FC8FF',
  white: '#F6F8F7',
  brightBlack: '#6f6f78',
  brightRed: '#ff6057',
  brightGreen: '#84eea7',
  brightYellow: '#FAD481',
  brightBlue: '#4095ff',
  brightMagenta: '#F859CA',
  brightCyan: '#8FC8FF',
  brightWhite: '#ffffff',
}

export const mrPinkVars = {
  '--bg-terminal': '#22222A',
  '--bg-sidebar': '#1E1E25',
  '--bg-surface': '#2b2b37',
  '--fg': '#F6F8F7',
  '--fg-muted': '#adadad',
  '--accent': '#D58FDB',
  // Lane accents are user data (Project roster) chosen against this dark canvas —
  // they already read at 10-13:1 here, so text draws them unmixed. See lib/lane-color.
  '--lane-ink-blend': '0%',
  '--btn-bg': '#1E1E25',
  '--red': '#ff6057',
  '--green': '#84eea7',
  '--yellow': '#FAD481',
  '--blue': '#4095ff',
  '--magenta': '#F859CA',
  '--cyan': '#8FC8FF',
  '--selection': '#ffffff3b',
  '--border': '#2a2a35',
  '--color-success': '#84eea7',
  '--color-error': '#ff6057',
  '--color-warning': '#FAD481',
  // Per-session status-dot bloom hues (the colour the dots take as they scale up).
  '--status-running': '#84eea7',
  '--status-compacting': '#FAD481',
  '--status-waiting': '#D58FDB',
  '--mcp-stdio': '#84eea7',
  '--mcp-http': '#4095ff',
  '--mcp-cloud': '#D58FDB',
  '--fg-on-accent': '#1E1E25',
  /* Panel elevation — the landing kit's `.panel` depth, ported. A drop shadow plus a
     defined edge is what makes a content card read as an object ON the field rather than
     as the field; ours were flat and borderless by comparison. Per-theme because a shadow
     that reads on near-black is a smudge on white. */
  '--shadow-panel': '0 12px 34px rgba(0,0,0,0.24)',
  '--panel-edge': 'color-mix(in srgb, var(--border) 70%, transparent)',
  '--overlay-subtle': 'rgba(255,255,255,0.06)',
  '--overlay-medium': 'rgba(255,255,255,0.12)',
} as const
