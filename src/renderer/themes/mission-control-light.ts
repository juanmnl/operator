import type { ITheme } from '@xterm/xterm'

// Mission Control (Light) — the signal-green control-room identity inverted onto
// a near-white field. The green is deepened (#0ca678) so it reads as accent/text
// on white; running takes blue, waiting keeps the green accent, compacting amber.
export const missionControlLightXterm: ITheme = {
  background: '#F6F8F7',
  foreground: '#1f2937',
  cursor: '#0ca678',
  cursorAccent: '#F6F8F7',
  selectionBackground: '#0ca67822',
  selectionForeground: undefined,
  black: '#1f2937',
  red: '#c0392b',
  green: '#0ca678',
  yellow: '#b8860b',
  blue: '#2563eb',
  magenta: '#8e44ad',
  cyan: '#0e7490',
  white: '#F6F8F7',
  brightBlack: '#6b7280',
  brightRed: '#e74c3c',
  brightGreen: '#10b981',
  brightYellow: '#d4a017',
  brightBlue: '#3b82f6',
  brightMagenta: '#a855f7',
  brightCyan: '#0891b2',
  brightWhite: '#1f2937',
}

export const missionControlLightVars = {
  '--bg-terminal': '#F6F8F7',
  '--bg-sidebar': '#ECEFED',
  '--bg-surface': '#E2E6E4',
  '--fg': '#1f2937',
  '--fg-muted': '#6b7280',
  '--accent': '#0ca678',
  '--btn-bg': '#DEE2E0',
  '--red': '#c0392b',
  '--green': '#0ca678',
  '--yellow': '#b8860b',
  '--blue': '#2563eb',
  '--magenta': '#8e44ad',
  '--cyan': '#0e7490',
  '--selection': '#0ca67822',
  '--border': '#cdd2cf',
  '--color-success': '#0ca678',
  '--color-error': '#c0392b',
  '--color-warning': '#b8860b',
  // Accent is the signal-green, so running takes blue to stay distinct from the
  // green "your turn" waiting hue.
  '--status-running': '#2563eb',
  '--status-compacting': '#b8860b',
  '--status-waiting': '#0ca678',
  '--mcp-stdio': '#0ca678',
  '--mcp-http': '#2563eb',
  '--mcp-cloud': '#8e44ad',
  '--fg-on-accent': '#F6F8F7',
  '--overlay-subtle': 'rgba(0,0,0,0.05)',
  '--overlay-medium': 'rgba(0,0,0,0.10)',
} as const
