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
  // Activity → twinkle. Everything at rest (idle/error/ended) → static dots.
  // Each active state owns a colour for the dots that scale up, so a glance at
  // the sidebar reads the state: green = Claude working, amber = compacting,
  // accent = your turn. Resting dots stay neutral gray; only the peak is tinted.
  running:    { animate: true,  durMin: 1.4, durMax: 2.6, maxOp: 0.95, staticOp: 0.5, fillPeak: 'var(--status-running, var(--green))' },
  compacting: { animate: true,  durMin: 0.9, durMax: 1.8, maxOp: 0.95, staticOp: 0.5, fillPeak: 'var(--status-compacting, var(--yellow))' },
  // Waiting for the user's reply → twinkle in the waiting hue (both resting and
  // peak) so it reads as "your turn" and stands apart from Claude's working shimmer.
  waiting:    { animate: true,  durMin: 1.1, durMax: 2.0, maxOp: 1,    staticOp: 0.5, fill: 'var(--status-waiting, var(--accent))', fillPeak: 'var(--status-waiting, var(--accent))' },
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

// Fold a session id into a stable per-session offset in [0,1) so each session's
// dots twinkle on their own timing/phase instead of every sidebar row pulsing in
// lockstep. Same id → same shimmer (stable across re-renders).
function seedFrom(id?: string): number {
  if (!id) return 0
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return (Math.abs(h) % 1000) / 1000
}

export function StatusWave({ status, size = 13, seedId }: { status: WaveStatus; size?: number; seedId?: string }) {
  const cfg = config[status]
  const seed = seedFrom(seedId)

  const dots = useMemo(() => DOTS.map((d, i) => {
    if (!cfg.animate) {
      return { ...d, style: { opacity: cfg.staticOp, fill: 'var(--fg-muted)' } as React.CSSProperties }
    }
    // The seed shifts both the duration and the start phase per session, so two
    // sessions in the same state shimmer independently rather than in sync.
    const dur = cfg.durMin + rand(i + 1 + seed * 13) * (cfg.durMax - cfg.durMin)
    const delay = -rand(i + 7 + seed * 29) * dur // negative → start mid-cycle, desynced
    return {
      ...d,
      style: {
        transformBox: 'fill-box',
        transformOrigin: 'center',
        animation: `twinkle ${dur.toFixed(2)}s ease-in-out ${delay.toFixed(2)}s infinite`,
      } as React.CSSProperties,
    }
  }), [status, seed]) // eslint-disable-line react-hooks/exhaustive-deps

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
