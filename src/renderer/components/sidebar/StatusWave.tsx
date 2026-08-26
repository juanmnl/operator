import { useEffect, useMemo, useState } from 'react'
import { rand, hashSeed, gridPointsInDisc } from '../../lib/random'
import { isWideGrapheme } from '../../lib/lane-initial'

export type WaveStatus = 'running' | 'compacting' | 'error' | 'idle' | 'ended' | 'waiting'

// How long the your-turn pulse runs after a turn ends before it settles to the
// static idle look. The pulse is an attention beacon ("your turn"), not a
// permanent state — a fresh turn (running → waiting) re-arms it.
//
// IT CURRENTLY SETTLES NOTHING. `waiting.animate` is false — the pulse was retired when motion
// became the only busy signal — and since rest is one level, `waiting` and `idle` now paint
// identically, so this timer changes no pixel. It is kept, not deleted, because it is the correct
// behaviour the moment the pulse comes back: a beacon that never stops is nagging, and re-arming
// on `running → waiting` is the part that would be easy to get wrong a second time.
const PULSE_SETTLE_MS = 6000

// A circle of grid dots. Working states twinkle at random for a "thinking"
// shimmer; the your-turn state pulses in unison as a calm beacon; truly idle
// states show the grid as flat gray (no scale). See `config` below.
const CELLS = 7
const RADIUS = 3.4 // circle radius in cell units
const R = 0.5 // dot radius in cell units

/** REST IS ONE LEVEL — waiting, idle and error all sit here. Derived twice, and the two
 *  derivations agree; the numbers are in `~/.operator/briefs/OUT-rail-idle-orbs-muted.md` and
 *  `dev/drive-orb-initial.mjs` measures them.
 *
 *  IT WAS 0.42 (idle) AND THE RUNNING ORB DID NOT POP. The reason is not that rest was bright, it
 *  is that a resting dot is FULL SIZE and constant while a running dot spends most of its cycle
 *  small and dim — the twinkle runs `opacity 0.3 · scale 0.5` → `opacity 0.95 · scale 1`, so its
 *  ink over a cycle averages ≈0.51 of a full-strength dot against a resting orb's flat 0.42. That
 *  is 1.2×, and 1.2× is not "unmistakable"; the busy orb was the brightest thing in the column only
 *  at the top of each dot's breath.
 *
 *    1. INK. A busy orb should carry at least TWICE the ink of a quiet one: 0.51 / 2 ≈ 0.25.
 *    2. THE TROUGH. A resting orb must never out-shine the running one at ANY point in its cycle,
 *       or the claim inverts mid-breath. Measured in CIELAB against the running dot's trough
 *       (`--fg-muted` at 0.3), rest crosses below it at 0.27 (mc·D), 0.28 (pink·D), 0.24 (1984·D).
 *       The dark palettes bind: ≤ 0.25. The LIGHT palettes cannot satisfy this test at any opacity
 *       and do not need to — there, dimming a light accent toward a light strip makes it LIGHTER,
 *       so lightness runs backwards and the separation is chroma (ΔE*ab 23.2–29.2 bloom-to-rest,
 *       plainly different) plus the motion, which is the rule anyway.
 *
 *  THE FLOOR is that the orb must still read as a coloured object — it is how the collapsed strip
 *  says WHICH lane. At 0.25 a resting dot measures ΔE*ab 9.3–22.0 from the strip across all six
 *  palettes, comfortably above the ~5 where a colour stops being distinguishable.
 *
 *  WCAG RATIOS ARE THE WRONG TOOL HERE and the first pass of this measurement used them: on the
 *  light palettes every lane accent is itself light, so a luminance ratio reports ~1.1:1 for two
 *  discs the eye reads as plainly different. The difference there is CHROMA. Rest-versus-running is
 *  a "how different do these look" question, so it is measured in CIELAB; the letter's legibility
 *  is a contrast question and stays WCAG. */
const REST_OP = 0.25
/** ENDED is not resting, it is gone — half the ink of a quiet lane, the same ratio it had to idle
 *  before (0.16 against 0.42). Measured ΔE*ab 4.8–11.4 below rest and 4.5–10.5 from the strip: a
 *  clear step down on the dark palettes, and thin-but-present on 1984 Light, which compresses
 *  everything. Lower would take it off the strip entirely, and the rail still has to show that the
 *  lane exists. */
const ENDED_OP = 0.12

/** THE TWINKLE'S TWO ANCHORS, and the reason they are constants rather than config.
 *
 *  Every measurement in this file is stated against them — the trough is `--fg-muted` at 0.3, the
 *  peak is the status hue at 0.95, and "ink over a cycle ≈ 0.51" falls out of that pair. They are
 *  now also baked into `@keyframes twinkle-base` / `twinkle-peak`, whose eleven sampled stops are
 *  DERIVED from them (see styles.css): the tint is composited from two stacked circles instead of
 *  animated on one, because animating `fill` cost 34.7% renderer + 6.0% GPU on seven busy orbs.
 *
 *  So a state that wanted a different ceiling would need its own regenerated keyframes, and the
 *  old `--tw-max` variable — which every animated state set to the same 0.95 — hid exactly that.
 *  `the animated states agree with the keyframes` in StatusWave.test.ts fails if they drift. */
export const TWINKLE_TROUGH_OP = 0.3
export const TWINKLE_PEAK_OP = 0.95

// `fill` tints the resting dots; `fillPeak` tints the dots as they scale up (the
// twinkle's bright half). Leaving them unset keeps the neutral gray→white default.
const config: Record<WaveStatus, { animate: boolean; unison?: boolean; durMin: number; durMax: number; maxOp: number; staticOp: number; fill?: string; fillPeak?: string }> = {
  // Two animated languages, mirroring the menu-bar tray (src-tauri/tray_anim.rs):
  //  • working states SHIMMER — each dot twinkles on its own desynced cycle, the
  //    peak tinted by the status hue (green = running, amber = compacting).
  //  • your-turn PULSED — the whole disc breathing in unison, a calm beacon. RETIRED:
  //    `waiting.animate` is false and motion is the only busy signal. `unison` and
  //    `PULSE_SETTLE_MS` are the machinery it left behind, kept for its return.
  running:    { animate: true,  durMin: 1.4, durMax: 2.6, maxOp: TWINKLE_PEAK_OP, staticOp: 0.5, fillPeak: 'var(--status-running, var(--green))' },
  compacting: { animate: true,  durMin: 0.9, durMax: 1.8, maxOp: TWINKLE_PEAK_OP, staticOp: 0.5, fillPeak: 'var(--status-compacting, var(--yellow))' },
  // Motion is the ONLY busy signal: the shimmer/pulse belongs to states where the
  // agent is actively working. Waiting means it has stopped and handed the turn
  // back — not busy — so it rests STATIC like idle.
  waiting:    { animate: false, durMin: 0,   durMax: 0,   maxOp: 0,    staticOp: REST_OP },
  idle:       { animate: false, durMin: 0,   durMax: 0,   maxOp: 0,    staticOp: REST_OP },
  error:      { animate: false, durMin: 0,   durMax: 0,   maxOp: 0,    staticOp: REST_OP },
  ended:      { animate: false, durMin: 0,   durMax: 0,   maxOp: 0,    staticOp: ENDED_OP },
}

// Dots that fall inside the circle, computed once (see lib/random).
const DOTS = gridPointsInDisc(CELLS, RADIUS)

export function StatusWave({ status, size = 13, seed = 0, accent, initial }: { status: WaveStatus; size?: number; seed?: string | number; accent?: string; initial?: string }) {
  // The your-turn pulse is a transient beacon: once a session has been waiting
  // for PULSE_SETTLE_MS we let the dot settle to the static idle look so a
  // long-untouched session doesn't pulse forever. Entering 'waiting' (incl. a
  // new turn after running) re-arms it.
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    if (status !== 'waiting') { setSettled(false); return }
    setSettled(false)
    const t = setTimeout(() => setSettled(true), PULSE_SETTLE_MS)
    return () => clearTimeout(t)
  }, [status])

  // "WAITING ON YOU" IS NOT CARRIED BY BRIGHTNESS, and that is a decision (2026-08-23), not an
  // omission. It used to be a notch — `waiting` 0.58 against `idle` 0.42 — and the notch had two
  // problems. It was not reliably visible: ΔE*ab 5.3 on 1984 Light against 12.3 on Mission Control
  // Dark, so it read on some palettes and not others. And a notch big enough to be a real notch on
  // the worst palette needs ≈ +0.22 of opacity, which is nearly double the rest level — so most of
  // the column (a rail full of lanes blocked on the user IS mostly `waiting`) would stop receding,
  // which is the exact complaint this change answers.
  //
  // Brightness is already carrying "busy versus quiet" and the palettes have no headroom for it to
  // carry a second thing. If "your turn" needs to be visible on the board — and it probably does,
  // it is the most actionable state in the app — the lever is a MARKER or the restored unison
  // pulse, never ±0.08 of opacity. Same for `error`, whose 0.5-against-0.42 measured ΔE*ab 2.7–6.2
  // and was therefore never a signal either. House rule: a state gets a marker, never a dimmer.
  const effective: WaveStatus = status === 'waiting' && settled ? 'idle' : status
  const cfg = config[effective]

  const dots = useMemo(() => {
    const s = hashSeed(seed)
    // A gentle per-session tempo so two running sessions don't pulse in lockstep:
    // some breathe a touch faster, some slower.
    const tempo = 0.82 + rand(s + 0.5) * 0.42 // ~[0.82, 1.24]
    return DOTS.map((d, i) => {
      if (!cfg.animate) {
        // A resting orb still says WHICH lane: fill with the lane accent, slightly
        // desaturated toward the muted ink and dimmed by the state's staticOp so a
        // quiet lane recedes without going colourless. No accent (a non-lane
        // session) → the neutral muted gray. Motion stays the only busy signal.
        const restFill = accent
          ? `color-mix(in srgb, ${accent} 82%, var(--fg-muted))`
          : 'var(--fg-muted)'
        return { ...d, style: { opacity: cfg.staticOp, fill: restFill } as React.CSSProperties, layers: null }
      }
      // Unison (your-turn pulse): every dot shares one period and phase so the
      // disc breathes as a single beacon. Otherwise each dot gets its own period
      // and a negative offset → the desynced "thinking" shimmer.
      const dur = cfg.unison
        ? cfg.durMin * tempo
        : (cfg.durMin + rand(i + 1 + s) * (cfg.durMax - cfg.durMin)) * tempo
      const delay = cfg.unison ? 0 : -rand(i + 7 + s * 1.7) * dur
      // TWO CIRCLES, ONE DOT. The trough ink and the status hue are separate elements stacked in
      // the same place, so the bloom between them is COMPOSITED rather than animated through
      // `fill` — see the keyframes in styles.css for the algebra and the measurement.
      //
      // The scale is its own animation, sharing this dot's duration and delay, so both layers
      // breathe as one object and the motion is bit-for-bit what it always was. `linear` on the
      // opacity tracks is not a style choice: the easing already lives in the sampled stops, and
      // easing them a second time would bend a curve that is already the right shape.
      const layer = (kind: 'base' | 'peak'): React.CSSProperties => ({
        transformBox: 'fill-box',
        transformOrigin: 'center',
        fill: kind === 'base' ? 'var(--tw-fill, var(--fg-muted))' : 'var(--tw-fill-peak, var(--fg))',
        animation: `twinkle-${kind} ${dur.toFixed(2)}s linear ${delay.toFixed(2)}s infinite`,
      })
      return { ...d, layers: { base: layer('base'), peak: layer('peak') } }
    })
  }, [effective, seed, accent]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <span style={{
      // `relative` so the letter can sit ON the disc. Harmless when there is no letter.
      position: 'relative', flexShrink: 0, display: 'inline-flex', lineHeight: 0,

      // The twinkle keyframe reads fill from --tw-fill (resting) and --tw-fill-peak
      // (scaled-up). Only the animated (busy) states set these; `accent` (an
      // orchestration lane's colour) re-tints the moving half so a collapsed rail
      // reads as "which agent" at a glance. The resting/static states (waiting,
      // idle, error, ended) don't animate — they carry the lane accent directly on
      // each dot's fill (dimmed by staticOp, see the memo above), so a quiet lane
      // keeps its colour while still receding.
      ...(cfg.fill ? { ['--tw-fill' as string]: (cfg.animate && accent) || cfg.fill } : null),
      ...(cfg.fillPeak ? { ['--tw-fill-peak' as string]: (cfg.animate && accent) || cfg.fillPeak } : null),
    }}>
      <svg width={size} height={size} viewBox={`0 0 ${CELLS} ${CELLS}`} fill="none">
        <g fill="var(--fg)">
          {dots.map((d, i) => (d.layers
            ? (
              // Base UNDER peak: the stacking order is the compositing order the derivation
              // assumes, and swapping them paints the trough ink over the status hue.
              <g key={i}>
                <circle cx={d.cx} cy={d.cy} r={R} style={d.layers.base} />
                <circle cx={d.cx} cy={d.cy} r={R} style={d.layers.peak} />
              </g>
            )
            : <circle key={i} cx={d.cx} cy={d.cy} r={R} style={d.style} />))}
        </g>
      </svg>
      {initial && <OrbInitial initial={initial} size={size} />}
    </span>
  )
}

/** WHICH LANE, in the disc that already says how it is doing. Static — the dots twinkle beneath it
 *  and only `running` animates, so the letter never becomes a second motion channel.
 *
 *  Drawn by the COLLAPSED strip only (see ProjectRail): at 264 the row spells the lane's name out
 *  beside the disc, and a letter there repeats what the row already says. The disc is identical in
 *  both states — same size, same x, same box — so this is ink appearing inside a fixed object, not
 *  a mark that moves anything.
 *
 *  THE HALO IS LOAD-BEARING. It looks like a flourish and it is the only reason this treatment is
 *  legible: `--fg` against the dots alone measures **1.39–1.47:1** on the three dark palettes,
 *  which is a failure — against its own halo it holds **11.84–17.58:1** on all six. Delete the
 *  text-shadow and the glyph drops below 1.5:1 on half the themes. (Measured across every default
 *  lane accent with a running dot at its 0.95 peak; see dev/drive-orb-initial.mjs.)
 *
 *  Two things this must never become, both with receipts:
 *    • `laneTextColor(accent)` — accent ink on accent dots, which is what the pre-D1 orb did, and
 *      its own comment admitted the collision was unsolved.
 *    • a knockout in `--bg-sidebar` — measured 1.04 / 1.20 / 1.22:1 on the three light palettes.
 *
 *  (`--fg-on-accent` exists in every theme and is the token meant for ink on an accent; it is the
 *  first place to look IF the halo is ever questioned, but it is not needed while the halo clears
 *  the floor everywhere.) */
function OrbInitial({ initial, size }: { initial: string; size: number }) {
  const two = Array.from(initial).length > 1
  // A CJK / full-width grapheme is far denser than a Latin capital and paints PAST the disc at
  // 11px — caught by drawing it, not by reasoning about it.
  const wide = isWideGrapheme(initial)
  return (
    <span
      data-orb-initial={initial}
      aria-hidden
      style={{
        position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
        pointerEvents: 'none',
        fontFamily: 'var(--font-mono)', fontWeight: 700, lineHeight: 1,
        // Scaled off the orb's own size, so a 24px disc gets 11/9.5/9 and nothing has to be
        // re-tuned if the orb ever changes.
        fontSize: (wide ? 9 : two ? 9.5 : 11) * (size / 24),
        color: 'var(--fg)',
        textShadow: '0 0 3px var(--bg-sidebar), 0 0 3px var(--bg-sidebar), 0 0 2px var(--bg-sidebar)',
        // A centred TRACKED pair carries its trailing letter-space on the right and nowhere else,
        // which pushes the ink off the axis the whole strip is aligned to. Same cancel as
        // `.ink-centred`; asserted by dev/drive-rail-invariant.mjs.
        ...(two ? { letterSpacing: '-0.02em', marginRight: '-0.02em' } : null),
      }}
    >{initial}</span>
  )
}
