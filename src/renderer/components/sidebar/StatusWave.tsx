import { useMemo } from 'react'

export type WaveStatus = 'running' | 'compacting' | 'error' | 'idle' | 'ended' | 'waiting'

// A circle of grid dots. Active states twinkle — each dot scaling up and
// brightening from a muted gray to the status colour at its peak — for a subtle
// "thinking" shimmer; resting states show the same grid as a flat gray (no
// scale). The shimmer is seeded per session (and given a per-session tempo) so
// no two sessions pulse in lockstep.
const CELLS = 7
const CENTER = (CELLS - 1) / 2 + 0.5 // grid centre in dot-centre coords
const RADIUS = 3.4 // circle radius in cell units
const R = 0.5 // dot radius in cell units

// `peak` is the colour a dot brightens to when it scales up. Activity reads as
// green (running) / cyan (compacting) / accent (your turn). Resting states never
// animate, so they have no peak.
const config: Record<WaveStatus, { animate: boolean; durMin: number; durMax: number; maxOp: number; staticOp: number; peak?: string }> = {
  running:    { animate: true,  durMin: 1.4, durMax: 2.6, maxOp: 0.95, staticOp: 0.5, peak: 'var(--green)' },
  compacting: { animate: true,  durMin: 0.9, durMax: 1.8, maxOp: 0.95, staticOp: 0.5, peak: 'var(--cyan)' },
  // Waiting for the user's reply → twinkle in the accent colour so it reads as
  // "your turn" rather than the neutral working shimmer.
  waiting:    { animate: true,  durMin: 1.1, durMax: 2.0, maxOp: 1,    staticOp: 0.5, peak: 'var(--accent)' },
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
      // The twinkle keyframe reads the scaled-up colour from --tw-fill-peak; set
      // it to the status colour so dots brighten gray → green/cyan/accent. The
      // base (--tw-fill) stays the default muted gray.
      ...(cfg.peak ? { ['--tw-fill-peak' as string]: cfg.peak } : null),
    }}>
      <svg width={size} height={size} viewBox={`0 0 ${CELLS} ${CELLS}`} fill="none">
        <g fill="var(--fg)">
          {dots.map((d, i) => <circle key={i} cx={d.cx} cy={d.cy} r={R} style={d.style} />)}
        </g>
      </svg>
    </span>
  )
}
