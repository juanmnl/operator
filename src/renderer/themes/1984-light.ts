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
  // Lane accents are user data (Project roster), all picked against the DARK canvas —
  // undimmed they collapse here (code #7ee787 = 1.44:1). Mixing 60% --fg into an
  // accent before drawing it as TEXT clears 4.5:1 for every default lane accent on the
  // DARKEST surface a title sits on (--bg-surface, and the sidebar's running-row tint —
  // once mixed toward --fg the dark backdrops are the hard case, not the light ones),
  // and keeps its hue. See lib/lane-color.
  '--lane-ink-blend': '70%',
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
  // NB: also tints the running session NAME in the sidebar (SessionItem) — the ANSI
  // '--green' (#00af4f) is too light to read as text on this lavender bg, so this is a
  // darker forest green (~4.3:1 on --bg-sidebar) that still blooms vividly as a dot.
  '--status-running': '#0a7333',
  '--status-compacting': '#FF8D01',
  '--status-waiting': '#0098fd',
  '--mcp-stdio': '#00af4f',
  '--mcp-http': '#0098fd',
  '--mcp-cloud': '#F806FA',
  '--fg-on-accent': '#ffffff',
  /* Panel elevation — see the dark themes. Light palettes take a SHORTER, softer shadow:
     the landing's 0.24 black at 34px blur reads as dirt on a white field, where the same
     depth cue only needs a hint. */
  '--shadow-panel': '0 6px 18px rgba(0,0,0,0.10)',
  '--panel-edge': 'color-mix(in srgb, var(--border) 85%, transparent)',
  '--overlay-subtle': 'rgba(0,0,0,0.05)',
  '--overlay-medium': 'rgba(0,0,0,0.10)',
  /* Diff ink, tuned for this light palette (see move 04). Dark greens/reds rather than the old
     shared dark-tuned pair, which drew at 1.3–1.5:1 here — a diff whose +/- lines were the least
     legible thing on screen. The row tint is 12% (not the dark palettes' 15%): the ink is dark,
     so the same alpha would wash the row grey instead of tinting it. */
  '--add-fg': '#045844',
  '--del-fg': '#960628',
  '--add-bg': 'color-mix(in srgb, #045844 12%, transparent)',
  '--del-bg': 'color-mix(in srgb, #960628 12%, transparent)',
} as const
