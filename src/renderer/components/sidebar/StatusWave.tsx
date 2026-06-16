import { useMemo } from 'react'

export type WaveStatus = 'running' | 'compacting' | 'error' | 'idle' | 'ended' | 'waiting'

// A circle of grid dots. Active states twinkle at random — scaling and shifting
// gray→white — for a subtle "thinking" shimmer; resting states show the same
// grid as a flat gray (no scale). Palette stays gray→white throughout.
const CELLS = 7
const CENTER = (CELLS - 1) / 2 + 0.5 // grid centre in dot-centre coords
const RADIUS = 3.4 // circle radius in cell units
const R = 0.5 // dot radius in cell units

// `fill` tints the resting dots; `fillPeak` tints the dots as they scale up (the
// twinkle's bright half). Leaving them unset keeps the neutral gray→white default.
const config: Record<WaveStatus, { animate: boolean; durMin: number; durMax: number; maxOp: number; staticOp: number; fill?: string; fillPeak?: string }> = {
  // Colour rides the ACTIVE states so a glance reads "this one is working":
  // running = green, compacting = amber — both resting and peak tinted, so they
  // read as colour rather than a faint flicker. The quiet states (waiting for
  // your reply, idle) stay neutral gray, so colour means "Claude is busy", not
  // "done / your turn".
  running:    { animate: true,  durMin: 1.4, durMax: 2.6, maxOp: 0.95, staticOp: 0.5, fill: 'var(--status-running, var(--green))', fillPeak: 'var(--status-running, var(--green))' },
  compacting: { animate: true,  durMin: 0.9, durMax: 1.8, maxOp: 0.95, staticOp: 0.5, fill: 'var(--status-compacting, var(--yellow))', fillPeak: 'var(--status-compacting, var(--yellow))' },
  // Waiting for the user → gentle gray twinkle: still alive, but not coloured.
  waiting:    { animate: true,  durMin: 1.1, durMax: 2.0, maxOp: 0.85, staticOp: 0.5 },
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
  const cfg = config[status]

  const dots = useMemo(() => {
    const s = hashSeed(seed)
    // A gentle per-session tempo so two running sessions don't pulse in lockstep:
    // some breathe a touch faster, some slower.
    const tempo = 0.82 + rand(s + 0.5) * 0.42 // ~[0.82, 1.24]
    return DOTS.map((d, i) => {
      if (!cfg.animate) {
        return { ...d, style: { opacity: cfg.staticOp, fill: 'var(--fg-muted)' } as React.CSSProperties }
      }
      const dur = (cfg.durMin + rand(i + 1 + s) * (cfg.durMax - cfg.durMin)) * tempo
      const delay = -rand(i + 7 + s * 1.7) * dur // negative → start mid-cycle, desynced
      return {
        ...d,
        style: {
          transformBox: 'fill-box',
          transformOrigin: 'center',
          animation: `twinkle ${dur.toFixed(2)}s ease-in-out ${delay.toFixed(2)}s infinite`,
        } as React.CSSProperties,
      }
    })
  }, [status, seed]) // eslint-disable-line react-hooks/exhaustive-deps

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
