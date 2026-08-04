import { useEffect, useMemo, useState } from 'react'
import { rand, hashSeed, gridPointsInDisc } from '../../lib/random'
import { isWideGrapheme } from '../../lib/lane-initial'

export type WaveStatus = 'running' | 'compacting' | 'error' | 'idle' | 'ended' | 'waiting'

// How long the your-turn pulse runs after a turn ends before it settles to the
// static idle look. The pulse is an attention beacon ("your turn"), not a
// permanent state — a fresh turn (running → waiting) re-arms it.
const PULSE_SETTLE_MS = 6000

// A circle of grid dots. Working states twinkle at random for a "thinking"
// shimmer; the your-turn state pulses in unison as a calm beacon; truly idle
// states show the grid as flat gray (no scale). See `config` below.
const CELLS = 7
const RADIUS = 3.4 // circle radius in cell units
const R = 0.5 // dot radius in cell units

// `fill` tints the resting dots; `fillPeak` tints the dots as they scale up (the
// twinkle's bright half). Leaving them unset keeps the neutral gray→white default.
const config: Record<WaveStatus, { animate: boolean; unison?: boolean; durMin: number; durMax: number; maxOp: number; staticOp: number; fill?: string; fillPeak?: string }> = {
  // Two animated languages, mirroring the menu-bar tray (src-tauri/tray_anim.rs):
  //  • working states SHIMMER — each dot twinkles on its own desynced cycle, the
  //    peak tinted by the status hue (green = running, amber = compacting).
  //  • your-turn PULSES — the whole disc breathes in unison (a calm beacon),
  //    blooming into the theme's waiting hue. Unison vs shimmer keeps "your turn"
  //    legibly distinct from "busy" even before the colour registers.
  running:    { animate: true,  durMin: 1.4, durMax: 2.6, maxOp: 0.95, staticOp: 0.5, fillPeak: 'var(--status-running, var(--green))' },
  compacting: { animate: true,  durMin: 0.9, durMax: 1.8, maxOp: 0.95, staticOp: 0.5, fillPeak: 'var(--status-compacting, var(--yellow))' },
  // Motion is the ONLY busy signal: the shimmer/pulse belongs to states where the
  // agent is actively working. Waiting means it has stopped and handed the turn
  // back — not busy — so it rests STATIC like idle, distinguished only by carrying
  // the lane accent a touch brighter (staticOp) than a truly-idle orb.
  waiting:    { animate: false, durMin: 0,   durMax: 0,   maxOp: 0,    staticOp: 0.58 },
  idle:       { animate: false, durMin: 0,   durMax: 0,   maxOp: 0,    staticOp: 0.42 },
  error:      { animate: false, durMin: 0,   durMax: 0,   maxOp: 0,    staticOp: 0.5 },
  ended:      { animate: false, durMin: 0,   durMax: 0,   maxOp: 0,    staticOp: 0.16 },
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
        return { ...d, style: { opacity: cfg.staticOp, fill: restFill } as React.CSSProperties }
      }
      // Unison (your-turn pulse): every dot shares one period and phase so the
      // disc breathes as a single beacon. Otherwise each dot gets its own period
      // and a negative offset → the desynced "thinking" shimmer.
      const dur = cfg.unison
        ? cfg.durMin * tempo
        : (cfg.durMin + rand(i + 1 + s) * (cfg.durMax - cfg.durMin)) * tempo
      const delay = cfg.unison ? 0 : -rand(i + 7 + s * 1.7) * dur
      return {
        ...d,
        style: {
          transformBox: 'fill-box',
          transformOrigin: 'center',
          animation: `twinkle ${dur.toFixed(2)}s ease-in-out ${delay.toFixed(2)}s infinite`,
        } as React.CSSProperties,
      }
    })
  }, [effective, seed, accent]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <span style={{
      // `relative` so the letter can sit ON the disc. Harmless when there is no letter.
      position: 'relative', flexShrink: 0, display: 'inline-flex', lineHeight: 0,
      ['--tw-max' as string]: cfg.maxOp,
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
          {dots.map((d, i) => <circle key={i} cx={d.cx} cy={d.cy} r={R} style={d.style} />)}
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
