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
  // Vivid, saturated ANSI (Tailwind 600/500 weights) so output reads with punch +
  // contrast on the near-white field, not washed-out (the old yellow was muddy gold).
  black: '#1f2937',
  red: '#dc2626',
  green: '#0ca678',
  yellow: '#d97706',
  blue: '#2563eb',
  magenta: '#9333ea',
  cyan: '#0891b2',
  white: '#F6F8F7',
  brightBlack: '#6b7280',
  brightRed: '#ef4444',
  brightGreen: '#10b981',
  brightYellow: '#f59e0b',
  brightBlue: '#3b82f6',
  brightMagenta: '#a855f7',
  brightCyan: '#06b6d4',
  brightWhite: '#1f2937',
}

export const missionControlLightVars = {
  '--bg-terminal': '#F6F8F7',
  '--bg-sidebar': '#ECEFED',
  '--bg-surface': '#E2E6E4',
  '--fg': '#1f2937',
  '--fg-muted': '#6b7280',
  '--accent': '#0ca678',
  // Lane accents are user data (Project roster), all picked against the DARK canvas —
  // undimmed they collapse here (code #7ee787 = 1.44:1). Mixing 60% --fg into an
  // accent before drawing it as TEXT clears 4.5:1 for every default lane accent on the
  // DARKEST surface a title sits on (--bg-surface, and the sidebar's running-row tint —
  // once mixed toward --fg the dark backdrops are the hard case, not the light ones),
  // and keeps its hue. See lib/lane-color.
  '--lane-ink-blend': '70%',
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
  '--add-fg': '#04643f',
  '--del-fg': '#ad0d07',
  '--add-bg': 'color-mix(in srgb, #04643f 12%, transparent)',
  '--del-bg': 'color-mix(in srgb, #ad0d07 12%, transparent)',
} as const
