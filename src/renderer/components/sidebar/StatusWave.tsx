import { useEffect, useMemo, useState } from 'react'

export type WaveStatus = 'running' | 'compacting' | 'error' | 'idle' | 'ended' | 'waiting'

// How long the your-turn pulse runs after a turn ends before it settles to the
// static idle look. The pulse is an attention beacon ("your turn"), not a
// permanent state — a fresh turn (running → waiting) re-arms it.
const PULSE_SETTLE_MS = 6000

// A circle of grid dots. Working states twinkle at random for a "thinking"
// shimmer; the your-turn state pulses in unison as a calm beacon; truly idle
// states show the grid as flat gray (no scale). See `config` below.
const CELLS = 7
const CENTER = (CELLS - 1) / 2 + 0.5 // grid centre in dot-centre coords
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
  // Waiting for the user's reply → slow unison pulse in the waiting hue. Claude
  // has stopped working, so it doesn't shimmer like the busy states — it gently
  // breathes to say "your turn".
  waiting:    { animate: true,  unison: true, durMin: 2.4, durMax: 2.4, maxOp: 0.8, staticOp: 0.5, fillPeak: 'var(--status-waiting, var(--fg))' },
  idle:       { animate: false, durMin: 0,   durMax: 0,   maxOp: 0,    staticOp: 0.42 },
  error:      { animate: false, durMin: 0,   durMax: 0,   maxOp: 0,    staticOp: 0.5 },
  ended:      { animate: false, durMin: 0,   durMax: 0,   maxOp: 0,    staticOp: 0.16 },
}

// Dots that fall inside the circle, computed once.
const DOTS: { cx: number; cy: number }[] = (() => {
  const out: { cx: number; cy: number }[] = []
  const max = RADIUS * RADIUS * 1.04
  for (let c = 0; c < CELLS; c++) {
    for (let r = 0; r < CELLS; r++) {
      const cx = c + 0.5, cy = r + 0.5
      const dx = cx - CENTER, dy = cy - CENTER
      if (dx * dx + dy * dy <= max) out.push({ cx, cy })
    }
  }
  return out
})()

// Deterministic pseudo-random in [0,1) so dot timings are stable per index.
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

// Fold a session id (or any string) into a stable numeric offset. Sessions with
// different ids land on different parts of the sine curve, so their dot timings
// diverge — each session's wave gets its own rhythm instead of marching in sync.
function hashSeed(seed: string | number): number {
  if (typeof seed === 'number') return seed
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 1000003
  return h
}

export function StatusWave({ status, size = 13, seed = 0 }: { status: WaveStatus; size?: number; seed?: string | number }) {
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
        return { ...d, style: { opacity: cfg.staticOp, fill: 'var(--fg-muted)' } as React.CSSProperties }
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
  }, [effective, seed]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <span style={{
      flexShrink: 0, display: 'inline-flex', lineHeight: 0,
      ['--tw-max' as string]: cfg.maxOp,
      // The twinkle keyframe reads fill from --tw-fill (resting) and --tw-fill-peak
      // (scaled-up). Set per state: resting tint only for waiting, peak tint for any
      // active state so the dots that grow take on the status colour.
      ...(cfg.fill ? { ['--tw-fill' as string]: cfg.fill } : null),
      ...(cfg.fillPeak ? { ['--tw-fill-peak' as string]: cfg.fillPeak } : null),
    }}>
      <svg width={size} height={size} viewBox={`0 0 ${CELLS} ${CELLS}`} fill="none">
        <g fill="var(--fg)">
          {dots.map((d, i) => <circle key={i} cx={d.cx} cy={d.cy} r={R} style={d.style} />)}
        </g>
      </svg>
    </span>
  )
}
