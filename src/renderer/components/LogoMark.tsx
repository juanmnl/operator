import { useMemo } from 'react'

// Operator brand mark — the status-indicator dot-circle as the logo. A "frozen
// twinkle" (each dot a different base size) that breathes with a very slow,
// subtle shimmer. Fill is --fg, so it's positive on light themes and negative
// on dark, matching how the old logo was inverted per theme.
//
// Geometry mirrors StatusWave (sidebar/StatusWave.tsx).
const CELLS = 7
const CENTER = (CELLS - 1) / 2 + 0.5
const RADIUS = 3.4
const R = 0.5
const MAXD = RADIUS * RADIUS * 1.04

const DOTS: { cx: number; cy: number }[] = (() => {
  const out: { cx: number; cy: number }[] = []
  for (let c = 0; c < CELLS; c++) {
    for (let r = 0; r < CELLS; r++) {
      const cx = c + 0.5, cy = r + 0.5
      const dx = cx - CENTER, dy = cy - CENTER
      if (dx * dx + dy * dy <= MAXD) out.push({ cx, cy })
    }
  }
  return out
})()

// Deterministic pseudo-random so each dot's size/timing is stable.
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

export function LogoMark({ size = 64, animated = true }: { size?: number; animated?: boolean }) {
  const dots = useMemo(() => DOTS.map((d, i) => {
    const v = rand(i + 11) // frozen-twinkle: varied dot sizes (bigger = more opaque)
    if (!animated) {
      // Static mark — matches the app icon's dot weighting (see assets/logos/icon-source.svg).
      return { ...d, r: (R * (0.62 + 0.38 * v)).toFixed(3), style: { opacity: 0.62 + 0.38 * v, fill: 'var(--fg)' } as React.CSSProperties }
    }
    const r = (R * (0.5 + 0.5 * v)).toFixed(3)
    const dur = 3.0 + rand(i + 1) * 2.0      // 3–5s — slow & smooth
    const delay = -rand(i + 7) * dur         // desync, start mid-cycle
    return {
      ...d,
      r,
      style: {
        transformBox: 'fill-box',
        transformOrigin: 'center',
        animation: `twinkle ${dur.toFixed(2)}s ease-in-out ${delay.toFixed(2)}s infinite`,
      } as React.CSSProperties,
    }
  }), [animated])

  return (
    <span style={{ display: 'inline-flex', lineHeight: 0, ['--tw-max' as string]: 0.85 }}>
      <svg width={size} height={size} viewBox={`0 0 ${CELLS} ${CELLS}`} fill="none">
        <g fill="var(--fg)">
          {dots.map((d, i) => <circle key={i} cx={d.cx} cy={d.cy} r={d.r} style={d.style} />)}
        </g>
      </svg>
    </span>
  )
}
