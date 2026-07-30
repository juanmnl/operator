import { laneTextColor } from '../lib/lane-color'

// ONE segmented control, for every place the app asks "which of these, and did you choose it?"
//
// It exists because that question was being answered in three different dialects on a single
// roster card — the model row said "selected" with weight, the effort row said it with a tinted
// pill, and the worktree control said it with a 9px box whose BORDER-STYLE carried the whole
// pinned/inherited distinction. Three dialects for one concept is the bug; a fourth would be
// worse, so this is shared with AgentDefaultsView rather than copied into it.
//
// TWO CHANNELS, DELIBERATELY SEPARATE — the previous versions fused them, which is why neither
// could be read:
//
//   WHICH ONE IS CHOSEN  →  the CHIP. A tinted wash behind the selected option, always, whatever
//                           its origin. This never varies; it is the answer to the question the
//                           row asks.
//   WHERE IT CAME FROM   →  the RING. A hairline inset around the chip when the value is pinned
//                           here; nothing when it is inherited.
//
// The ring marks the EXCEPTION, not the norm. Most lanes inherit most settings — and once the
// worktree default flips on for four of six lanes, inherited becomes the common case outright —
// so decorating inherited would put a marker on almost every control and mark nothing.
//
// A ring rather than a border: a colour-changing border on a radiused element re-rasterizes in
// WKWebView. This is the same `box-shadow` dodge `ProjectTile` uses for its "you are here" ring.
// It is also inset, so it can never overflow the track.

/** Unselected option ink.
 *
 *  An unselected radio option is still an OPTION — body text, held to 4.5:1, not the 3:1 meta
 *  bar. It has been raised twice: `--fg-muted × 0.4` (1.8–2.9:1, invisible on the light three),
 *  then 72% of `--fg`. At 72% it measures 4.97–7.50 across the six palettes, i.e. it already
 *  clears the bar — which is the evidence that CONTRAST was never the thing failing here. The
 *  user could read the words and still could not tell the row was a control. That is what the
 *  TRACK below fixes.
 *
 *  Raised again anyway, to 85%, because the track now carries selection: with the chip doing that
 *  job, the unselected labels no longer have to stay dim to keep the selected one legible. The
 *  two channels stopped competing, so both can be turned up.
 *
 *  Token-level step, never an opacity over `--fg-muted` — that is the stacked-fade rule, and this
 *  control is where it keeps recurring. */
export const CONTROL_OFF = 'color-mix(in srgb, var(--fg) 85%, transparent)'

export type SegmentOrigin = 'pinned' | 'inherited'

export function Segmented({
  options, value, onChange, onClear, accent, origin = 'inherited', inheritedFrom, label, name,
}: {
  options: Array<{ id: string; label: string; hint?: string }>
  value: string
  onChange: (id: string) => void
  /** Clear the pin and go back to inheriting. Absent = no route home. */
  onClear?: () => void
  accent?: string
  /** `pinned` = set here; `inherited` = coming from a default further up the cascade. */
  origin?: SegmentOrigin
  /** Human-readable source, for the title of an inherited value. */
  inheritedFrom?: string
  /** Optional caption. The roster card omits it — model names identify themselves and the card is
   *  tight — but a two-option row like `worktree On/Off` is meaningless without one. */
  label?: string
  /** Disambiguates the test hook when a surface has several of these. */
  name?: string
}) {
  // laneTextColor, never the raw accent: a raw lane accent as 9.5px text measured 1.07–1.22:1 on
  // the three light palettes. This folds in each theme's --lane-ink-blend.
  const tint = accent ? laneTextColor(accent) : 'var(--accent)'
  // …and then HALF WAY to --fg again for the chip's TEXT. The chip sits on a wash on top of the
  // track, and that extra layer costs contrast: at full tint the selected label measured 3.15 on
  // Mr Pink dark and 3.77 on 1984 dark, i.e. under the 4.5 body floor a selected option is held
  // to. Mixed 50/50 it measures 4.84–6.87 across all six while still reading as the lane's
  // colour — the same trick, and roughly the same ratio, as the channel's ACCENT_INK. The wash
  // and the ring keep the raw tint, where there is no text to fail a floor.
  const inkTint = `color-mix(in srgb, ${tint} 50%, var(--fg))`
  const pinned = origin === 'pinned'
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      {label && (
        <span style={{
          flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 8.5, textTransform: 'uppercase',
          letterSpacing: '0.1em', color: 'var(--fg-muted)',
        }}>
          {label}
        </span>
      )}
      {/* THE TRACK — the resting affordance, and the actual answer to "nothing says these rows are
          interactive". Four words in a row with one brighter is a sentence; the same four words in
          a recessed track is a control. A FILL rather than an outline, because a bordered box
          inside a card inside a list was the nesting the previous pass removed for good reason —
          a track adds the affordance back without adding another edge. */}
      <div
        data-segmented={name ?? label ?? ''}
        data-segmented-origin={origin}
        role="radiogroup"
        style={{
          display: 'inline-flex', gap: 1, minWidth: 0,
          padding: 2, borderRadius: 7, background: 'var(--overlay-subtle)',
        }}
      >
        {options.map((o) => {
          const active = o.id === value
          return (
            <button
              key={o.id}
              data-segment={o.id}
              data-segment-state={active ? origin : 'off'}
              role="radio"
              aria-checked={active}
              onClick={() => { if (!active) onChange(o.id); else if (pinned) onClear?.() }}
              title={!active
                ? `Switch to ${o.label}${o.hint ? ` — ${o.hint}` : ''}`
                : pinned
                  ? `${o.label} — pinned on this lane. Click to clear it and inherit instead.`
                  : `${o.label} — inherited from ${inheritedFrom ?? 'the default'}. Change it there and every lane that hasn't pinned its own follows.`}
              style={{
                fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.03em',
                padding: '2px 7px', borderRadius: 5, cursor: 'pointer', outline: 'none', border: 'none',
                color: active ? inkTint : CONTROL_OFF,
                // ONE selected language, in every row and at every origin.
                background: active ? `color-mix(in srgb, ${tint} 14%, transparent)` : 'transparent',
                // …and the origin on its own channel, marking only the exception.
                boxShadow: active && pinned ? `inset 0 0 0 1px color-mix(in srgb, ${tint} 45%, transparent)` : 'none',
                transition: 'color 120ms ease, background 120ms ease',
              }}
              onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--overlay-medium)' }}
              onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent' }}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
