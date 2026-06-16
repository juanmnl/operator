import type { ITheme } from '@xterm/xterm'

// Mission Control — the palette of the Operator landing page (Operator-landing).
// A near-black control-room base with a single confident signal-green accent;
// model hues (haiku blue / opus violet / warn amber) used only for status.
export const missionControlXterm: ITheme = {
  background: '#0b0d10',
  foreground: '#eef1f3',
  cursor: '#2fe39a',
  cursorAccent: '#0b0d10',
  selectionBackground: '#ffffff2e',
  selectionForeground: undefined,
  black: '#07090b',
  red: '#ff5f56',
  green: '#2fe39a',
  yellow: '#ffb454',
  blue: '#58b2ff',
  magenta: '#c98bff',
  cyan: '#3fd9c9',
  white: '#eef1f3',
  brightBlack: '#5a626c',
  brightRed: '#ff7a72',
  brightGreen: '#56ecb1',
  brightYellow: '#ffc679',
  brightBlue: '#7cc3ff',
  brightMagenta: '#d6a6ff',
  brightCyan: '#63e6d8',
  brightWhite: '#ffffff',
}

export const missionControlVars = {
  '--bg-terminal': '#0b0d10',
  '--bg-sidebar': '#07090b',
  '--bg-surface': '#161b21',
  '--fg': '#eef1f3',
  '--fg-muted': '#8a94a0',
  '--accent': '#2fe39a',
  '--btn-bg': '#161b21',
  '--red': '#ff5f56',
  '--green': '#2fe39a',
  '--yellow': '#ffb454',
  '--blue': '#58b2ff',
  '--magenta': '#c98bff',
  '--cyan': '#3fd9c9',
  '--selection': '#ffffff2e',
  '--border': '#21272f',
  '--color-success': '#2fe39a',
  '--color-error': '#ff5f56',
  '--color-warning': '#ffb454',
  // Per-session status-dot bloom hues. Accent is the signal-green, so running
  // takes haiku-blue to stay distinct from the green "your turn" waiting hue.
  '--status-running': '#58b2ff',
  '--status-compacting': '#ffb454',
  '--status-waiting': '#2fe39a',
  '--mcp-stdio': '#2fe39a',
  '--mcp-http': '#58b2ff',
  '--mcp-cloud': '#c98bff',
  '--fg-on-accent': '#04130d',
  '--overlay-subtle': 'rgba(255,255,255,0.06)',
  '--overlay-medium': 'rgba(255,255,255,0.12)',
} as const
