import { useMemo } from 'react'

// Operator brand mark — the status-indicator dot-circle as the logo. A "frozen
// twinkle" (each dot a different base size) that breathes with a very slow,
// subtle shimmer. Fill is --fg, so it's positive on light themes and negative
// on dark, matching how the old logo was inverted per theme.
//
// Geometry mirrors StatusWave (sidebar/StatusWave.tsx). The grid is `cells`
// wide/tall; dots fill a disc of `RADIUS` (in cell units) inside it. `cells`
// scales the disc to keep the same circular proportions, so a 7-cell mark and
// an 11-cell mark read as the same logo at different densities.
const R = 0.5

// Deterministic pseudo-random so each dot's size/timing is stable.
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

function buildDots(cells: number): { cx: number; cy: number }[] {
  const center = (cells - 1) / 2 + 0.5
  const radius = (cells / 7) * 3.4 // 3.4 at 7 cells, scaled to keep the disc proportion
  const maxd = radius * radius * 1.04
  const out: { cx: number; cy: number }[] = []
  for (let c = 0; c < cells; c++) {
    for (let r = 0; r < cells; r++) {
      const cx = c + 0.5, cy = r + 0.5
      const dx = cx - center, dy = cy - center
      if (dx * dx + dy * dy <= maxd) out.push({ cx, cy })
    }
  }
  return out
}

export function LogoMark({ size = 64, animated = true, cells = 7 }: { size?: number; animated?: boolean; cells?: number }) {
  const dots = useMemo(() => buildDots(cells).map((d, i) => {
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
        animation: `twinkle-logo ${dur.toFixed(2)}s ease-in-out ${delay.toFixed(2)}s infinite`,
      } as React.CSSProperties,
    }
  }), [animated, cells])

  return (
    // `--tw-max` used to ride here for the shared keyframe to read. `twinkle-logo` is this
    // component's own rule and carries the 0.85 ceiling itself, so there is nothing to pass.
    <span style={{ display: 'inline-flex', lineHeight: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${cells} ${cells}`} fill="none">
        <g fill="var(--fg)">
          {dots.map((d, i) => <circle key={i} cx={d.cx} cy={d.cy} r={d.r} style={d.style} />)}
        </g>
      </svg>
    </span>
  )
}
