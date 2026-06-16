import { useMemo } from 'react'

export type WaveStatus = 'running' | 'compacting' | 'error' | 'idle' | 'ended' | 'waiting'

// A circle of grid dots. Active states twinkle at random — scaling and shifting
// gray→white — for a subtle "thinking" shimmer; resting states show the same
// grid as a flat gray (no scale). Palette stays gray→white throughout.
const CELLS = 7
const CENTER = (CELLS - 1) / 2 + 0.5 // grid centre in dot-centre coords
const RADIUS = 3.4 // circle radius in cell units
const R = 0.5 // dot radius in cell units

// `peak` is the colour the dots bloom into at the top of the twinkle (the ones
// that scale up). The resting trough stays muted gray, so the scaled-up dots
// read as a coloured glow in the session's status hue. Driven by per-theme
// --status-* tokens so each theme controls its own status palette.
const config: Record<WaveStatus, { animate: boolean; durMin: number; durMax: number; maxOp: number; staticOp: number; peak?: string }> = {
  // Activity → twinkle. Everything at rest (idle/error/ended) → static dots.
  running:    { animate: true,  durMin: 1.4, durMax: 2.6, maxOp: 0.95, staticOp: 0.5, peak: 'var(--status-running)' },
  compacting: { animate: true,  durMin: 0.9, durMax: 1.8, maxOp: 0.95, staticOp: 0.5, peak: 'var(--status-compacting)' },
  // Waiting for the user's reply → bloom in the accent colour so it reads as
  // "your turn" rather than the neutral shimmer of Claude working.
  waiting:    { animate: true,  durMin: 1.1, durMax: 2.0, maxOp: 1,    staticOp: 0.5, peak: 'var(--status-waiting)' },
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

// Deterministic pseudo-random in [0,1). The seed folds in a per-session offset
// so every session's shimmer is its own — same status, different rhythm.
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

// Hash an arbitrary string (session id) into a stable numeric seed offset.
function hashSeed(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  // Spread into a fractional offset large enough to fully decorrelate sessions.
  return (Math.abs(h) % 997) * 0.61803398875
}

export function StatusWave({ status, seed = '', size = 13 }: { status: WaveStatus; seed?: string; size?: number }) {
  const cfg = config[status]

  const dots = useMemo(() => {
    const off = hashSeed(seed)
    return DOTS.map((d, i) => {
      if (!cfg.animate) {
        return { ...d, style: { opacity: cfg.staticOp, fill: 'var(--fg-muted)' } as React.CSSProperties }
      }
      const dur = cfg.durMin + rand(off + i + 1) * (cfg.durMax - cfg.durMin)
      const delay = -rand(off + i + 7) * dur // negative → start mid-cycle, desynced
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
      // The twinkle keyframe blooms from --tw-fill (muted trough) to --tw-fill-peak.
      // Only the peak is tinted, so the dots that scale up glow in the status hue
      // while the resting grid stays a neutral gray.
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
