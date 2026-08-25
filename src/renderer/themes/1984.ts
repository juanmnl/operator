import type { ITheme } from '@xterm/xterm'

export const nineteen84Xterm: ITheme = {
  background: '#0d0f31',
  foreground: '#f1f1f1',
  cursor: '#B3F361',
  cursorAccent: '#0d0f31',
  selectionBackground: '#ffffff3b',
  selectionForeground: undefined,
  black: '#070825',
  red: '#FF16B0',
  green: '#B3F361',
  yellow: '#FFEA16',
  blue: '#46BDFF',
  magenta: '#F806FA',
  cyan: '#59E1E3',
  white: '#f1f1f1',
  brightBlack: '#5a5a82',
  brightRed: '#FF16B0',
  brightGreen: '#B3F361',
  brightYellow: '#FFEA16',
  brightBlue: '#46BDFF',
  brightMagenta: '#F806FA',
  brightCyan: '#59E1E3',
  brightWhite: '#ffffff',
}

export const nineteen84Vars = {
  '--bg-terminal': '#0d0f31',
  '--bg-sidebar': '#070825',
  '--bg-surface': '#12143f',
  '--fg': '#f1f1f1',
  '--fg-muted': '#8888aa',
  '--accent': '#46BDFF',
  // Lane accents are user data (Project roster) chosen against this dark canvas —
  // they already read at 10-13:1 here, so text draws them unmixed. See lib/lane-color.
  '--lane-ink-blend': '0%',
  // A raised dark-blue surface (not the bright accent) — buttons use white --fg
  // text, which was unreadable on the cyan accent. Matches the other dark themes.
  '--btn-bg': '#1c1f54',
  '--red': '#FF16B0',
  '--green': '#B3F361',
  '--yellow': '#FFEA16',
  '--blue': '#46BDFF',
  '--magenta': '#F806FA',
  '--cyan': '#59E1E3',
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
  '--syn-keyword': '#F806FA',
  '--syn-string': '#B3F361',
  '--syn-number': '#FFEA16',
  '--syn-type': '#46BDFF',
  '--syn-attr': '#59E1E3',
  '--syn-comment': '#8888aa',
  '--selection': '#ffffff3b',
  '--border': '#1a1c50',
  '--color-success': '#B3F361',
  '--color-error': '#FF16B0',
  '--color-warning': '#FFEA16',
  // Per-session status-dot bloom hues (the colour the dots take as they scale up).
  '--status-running': '#B3F361',
  '--status-compacting': '#FFEA16',
  '--status-waiting': '#46BDFF',
  '--mcp-stdio': '#B3F361',
  '--mcp-http': '#46BDFF',
  '--mcp-cloud': '#F806FA',
  '--fg-on-accent': '#070825',
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
  '--del-fg': '#e67a93',
  '--add-bg': 'color-mix(in srgb, #4ec9a0 15%, transparent)',
  '--del-bg': 'color-mix(in srgb, #e67a93 15%, transparent)',
} as const
