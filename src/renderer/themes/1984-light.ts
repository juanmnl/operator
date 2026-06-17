import type { ITheme } from '@xterm/xterm'

// 1984 — LIGHT. Authentic palette from the user's published VS Code theme
// (juanmnl.vscode-theme-1984, themes/1984-light-color-theme.json): lavender-tinted
// near-white base, deep-navy ink, with 1984's electric-blue / hot-pink / lime
// personality deepened for legibility on light. Accent is the authentic light-mode
// blue (#0098fd), a touch deeper than the dark theme's #46BDFF so it reads on the
// pale bg; the signature pink (#FF16B0) drives the cursor as in the source theme.
export const nineteen84LightXterm: ITheme = {
  background: '#e4e5f5',
  foreground: '#19152c',
  cursor: '#FF16B0',
  cursorAccent: '#e4e5f5',
  selectionBackground: '#0098fd2e',
  selectionForeground: undefined,
  black: '#19152c',
  red: '#FF16B0',
  green: '#00af4f',
  yellow: '#FF8D01',
  blue: '#0098fd',
  magenta: '#F806FA',
  cyan: '#00b2be',
  white: '#e4e5f5',
  brightBlack: '#6b6786',
  brightRed: '#FF16B0',
  brightGreen: '#00af4f',
  brightYellow: '#FF8D01',
  brightBlue: '#0098fd',
  brightMagenta: '#F806FA',
  brightCyan: '#00b2be',
  brightWhite: '#19152c',
}

export const nineteen84LightVars = {
  '--bg-terminal': '#e4e5f5',
  '--bg-sidebar': '#dadbef',
  '--bg-surface': '#d0d1e8',
  '--fg': '#19152c',
  '--fg-muted': '#6b6786',
  '--accent': '#0098fd',
  '--btn-bg': '#d0d1e8',
  '--red': '#FF16B0',
  '--green': '#00af4f',
  '--yellow': '#FF8D01',
  '--blue': '#0098fd',
  '--magenta': '#F806FA',
  '--cyan': '#00b2be',
  '--selection': '#0098fd2e',
  '--border': '#c4c5dd',
  '--color-success': '#00af4f',
  '--color-error': '#FF16B0',
  '--color-warning': '#FF8D01',
  // Per-session status-dot bloom hues (the colour the dots take as they scale up).
  '--status-running': '#00af4f',
  '--status-compacting': '#FF8D01',
  '--status-waiting': '#0098fd',
  '--mcp-stdio': '#00af4f',
  '--mcp-http': '#0098fd',
  '--mcp-cloud': '#F806FA',
  '--fg-on-accent': '#ffffff',
  '--overlay-subtle': 'rgba(0,0,0,0.05)',
  '--overlay-medium': 'rgba(0,0,0,0.10)',
} as const
