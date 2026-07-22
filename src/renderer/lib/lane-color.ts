// A lane's accent, made legible when it's used as TEXT.
//
// Role accents live on the Project roster — they're USER DATA, not theme tokens, so no
// theme can compensate for one that's unreadable. They were all picked against the
// near-black dark canvas, and on a light canvas they collapse: measured on the dashboard's
// lane titles, `code` (#7ee787) hit 1.44:1 and `qa` (#ffd43b) 1.34:1 against
// mission-control-light — invisible, where a plain --fg row read 13.76:1.
//
// The fix has to happen at render time. Each theme carries `--lane-ink-blend`, the amount
// of --fg to mix into an accent before drawing it as text: 0% on dark themes (accents are
// already correct there — 10-13:1), 60% on light ones, which is the smallest step that
// clears 4.5:1 for EVERY default lane accent on the lightest surface a title can sit on,
// in all three light identities. Hue survives the mix, so a lane still reads as its colour.
//
// Use this for accent TEXT only. Accent borders, dots and background tints are unaffected —
// they aren't held to a text contrast ratio, and they carry the identity at full strength.
export function laneTextColor(accent?: string): string {
  const base = accent?.trim() || 'var(--accent)'
  return `color-mix(in srgb, ${base}, var(--fg) var(--lane-ink-blend, 0%))`
}
