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
  // Lane accents are user data (Project roster) chosen against this dark canvas —
  // they already read at 10-13:1 here, so text draws them unmixed. See lib/lane-color.
  '--lane-ink-blend': '0%',
  '--btn-bg': '#161b21',
  '--red': '#ff5f56',
  '--green': '#2fe39a',
  '--yellow': '#ffb454',
  '--blue': '#58b2ff',
  '--magenta': '#c98bff',
  '--cyan': '#3fd9c9',
  /* SYNTAX INK — the code viewer's six roles, per palette.
     They exist because the ANSI tokens they used to borrow FAIL as small text on the light
     palettes. Measured against each palette's own `--bg-terminal` before the change:
     green 2.92 / 2.67 / 2.32:1, yellow 3.05 / 3.03 / 1.86:1, and on 1984-light every role
     failed — keyword 2.63, type 2.44, attr 2.07, and `--fg-muted` for comments 4.30.
     Every value below clears 4.5:1 on its own ground; the dark palettes' are the ANSI tokens
     unchanged, because those already did.
     Hue and saturation are held and only lightness moves, so a palette still reads as itself.
     NOT opacity on `--fg-muted` for comments — the token IS the recede, and stacking is the
     documented way this ink has failed before. */
  '--syn-keyword': '#c98bff',
  '--syn-string': '#2fe39a',
  '--syn-number': '#ffb454',
  '--syn-type': '#58b2ff',
  '--syn-attr': '#3fd9c9',
  '--syn-comment': '#8a94a0',
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
  /* Panel elevation — the landing kit's `.panel` depth, ported. A drop shadow plus a
     defined edge is what makes a content card read as an object ON the field rather than
     as the field; ours were flat and borderless by comparison. Per-theme because a shadow
     that reads on near-black is a smudge on white. */
  '--shadow-panel': '0 12px 34px rgba(0,0,0,0.24)',
  '--panel-edge': 'color-mix(in srgb, var(--border) 70%, transparent)',
  '--overlay-subtle': 'rgba(255,255,255,0.06)',
  '--overlay-medium': 'rgba(255,255,255,0.12)',
  /* Diff ink. Per-theme since move 04 — they were ONE hardcoded pair shared by every palette,
     which measured 1.30–1.64:1 on the three light identities and, less obviously, under 4.5:1
     for `--del-fg` on two of the three DARK ones too (3.56:1 on mr-pink, 4.44:1 on mission
     control; 1984 scraped 4.55:1). Solved against the worst
     backdrop a diff ink actually sits on in this app: --bg-terminal, --bg-surface, and a card's
     --overlay-subtle, each also carrying the row's own --add-bg/--del-bg tint.
     The green is unchanged from the old shared value — it already cleared the floor on dark. */
  '--add-fg': '#4ec9a0',
  '--del-fg': '#e47572',
  '--add-bg': 'color-mix(in srgb, #4ec9a0 15%, transparent)',
  '--del-bg': 'color-mix(in srgb, #e47572 15%, transparent)',
} as const
