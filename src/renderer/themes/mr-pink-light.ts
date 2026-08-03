import type { ITheme } from '@xterm/xterm'

// Mr Pink (Light) — the orchid/magenta identity on a near-white field. The pink
// is deepened (#a21caf) for legibility on light bg; running = green, waiting
// keeps the pink accent, compacting = amber.
export const mrPinkLightXterm: ITheme = {
  background: '#F8F6F8',
  foreground: '#2c2c2c',
  cursor: '#a21caf',
  cursorAccent: '#F8F6F8',
  selectionBackground: '#a21caf22',
  selectionForeground: undefined,
  black: '#2c2c2c',
  red: '#c0392b',
  green: '#27ae60',
  yellow: '#b8860b',
  blue: '#2563eb',
  magenta: '#be185d',
  cyan: '#0e7490',
  white: '#F8F6F8',
  brightBlack: '#6f6f78',
  brightRed: '#e74c3c',
  brightGreen: '#2ecc71',
  brightYellow: '#d4a017',
  brightBlue: '#3b82f6',
  brightMagenta: '#d6249f',
  brightCyan: '#0891b2',
  brightWhite: '#2c2c2c',
}

export const mrPinkLightVars = {
  '--bg-terminal': '#F8F6F8',
  '--bg-sidebar': '#EFEBEF',
  '--bg-surface': '#E7E1E7',
  '--fg': '#2c2c2c',
  '--fg-muted': '#777777',
  '--accent': '#a21caf',
  // Lane accents are user data (Project roster), all picked against the DARK canvas —
  // undimmed they collapse here (code #7ee787 = 1.44:1). Mixing 60% --fg into an
  // accent before drawing it as TEXT clears 4.5:1 for every default lane accent on the
  // DARKEST surface a title sits on (--bg-surface, and the sidebar's running-row tint —
  // once mixed toward --fg the dark backdrops are the hard case, not the light ones),
  // and keeps its hue. See lib/lane-color.
  '--lane-ink-blend': '70%',
  '--btn-bg': '#E1DBE1',
  '--red': '#c0392b',
  '--green': '#27ae60',
  '--yellow': '#b8860b',
  '--blue': '#2563eb',
  '--magenta': '#be185d',
  '--cyan': '#0e7490',
  '--selection': '#a21caf22',
  '--border': '#d3ccd3',
  '--color-success': '#27ae60',
  '--color-error': '#c0392b',
  '--color-warning': '#b8860b',
  // Per-session status-dot bloom hues.
  '--status-running': '#27ae60',
  '--status-compacting': '#b8860b',
  '--status-waiting': '#a21caf',
  '--mcp-stdio': '#27ae60',
  '--mcp-http': '#2563eb',
  '--mcp-cloud': '#a21caf',
  '--fg-on-accent': '#F8F6F8',
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
  '--add-fg': '#046434',
  '--del-fg': '#aa071d',
  '--add-bg': 'color-mix(in srgb, #046434 12%, transparent)',
  '--del-bg': 'color-mix(in srgb, #aa071d 12%, transparent)',
} as const
