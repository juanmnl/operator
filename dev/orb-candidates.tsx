import { useEffect, useMemo, useRef } from 'react'
import { rand, hashSeed, gridPointsInDisc } from '../src/renderer/lib/random'

// PASS 2's TWO CANDIDATES, kept in `dev/` until one of them earns its way into the component.
//
// Pass 1 established the ceiling: Blink never composites SVG element animations, so 259 animated
// `<circle>`s are 259 style recalcs a frame no matter what is animated on them. Only two things
// can move that by an order of magnitude — change the element TYPE to one Blink will promote, or
// stop having 259 of them.
//
// Both candidates reproduce `StatusWave`'s geometry and seeding EXACTLY (same `gridPointsInDisc`,
// same tempo/duration/delay derivation), because a candidate that draws a different orb is not a
// measurement of anything. The duplication is deliberate and lives here rather than in the
// component: the loser gets deleted, and the winner gets written into `StatusWave` properly.

const CELLS = 7
const RADIUS = 3.4
const R = 0.5
const TROUGH_OP = 0.3
const PEAK_OP = 0.95
const DOTS = gridPointsInDisc(CELLS, RADIUS)

/** `StatusWave`'s own per-dot rhythm, reproduced. */
export function dotTiming(seed: string | number, durMin = 1.4, durMax = 2.6) {
  const s = hashSeed(seed)
  const tempo = 0.82 + rand(s + 0.5) * 0.42
  return DOTS.map((d, i) => {
    const dur = (durMin + rand(i + 1 + s) * (durMax - durMin)) * tempo
    return { ...d, dur, delay: -rand(i + 7 + s * 1.7) * dur }
  })
}

// ─── CANDIDATE A — HTML dots ──────────────────────────────────────────────────────────────────
//
// Same two stacked layers as the shipped SVG orb, same keyframes (they animate only `opacity` and
// `transform`, which are element-type-agnostic), but as `<div>`s — which Blink CAN promote to
// compositor layers, taking the per-frame work off the main thread entirely.
//
// The geometry is the SVG viewBox arithmetic done by hand: the box is `CELLS` units wide, so one
// unit is `size / CELLS` px and a dot of radius `R` is `2R` units across.
export function HtmlOrb({ size, seed, accent, force = false }: { size: number; seed: string; accent: string; force?: boolean }) {
  const unit = size / CELLS
  const d = 2 * R * unit
  const dots = useMemo(() => dotTiming(seed), [seed])
  return (
    <span style={{ position: 'relative', flexShrink: 0, display: 'inline-block', width: size, height: size }}>
      {dots.map((dot, i) => (
        <span key={i} style={{ position: 'absolute', left: dot.cx * unit - d / 2, top: dot.cy * unit - d / 2, width: d, height: d }}>
          {(['base', 'peak'] as const).map((kind) => (
            <span
              key={kind}
              data-dot
              style={{
                position: 'absolute', inset: 0, borderRadius: '50%',
                background: kind === 'base' ? 'var(--fg-muted)' : accent,
                animation: `twinkle-${kind} ${dot.dur.toFixed(2)}s linear ${dot.delay.toFixed(2)}s infinite`,
                // `?impl=html-wc` — ask Blink for a compositor layer per dot explicitly, to tell
                // "it won't promote these" apart from "it can't".
                ...(force ? { willChange: 'transform, opacity' } : null),
              }}
            />
          ))}
        </span>
      ))}
    </span>
  )
}

// ─── CANDIDATE B — one canvas per orb ─────────────────────────────────────────────────────────
//
// 37 dots become one element. Nothing is CSS-animated at all: a single shared rAF loop paints
// every orb on the page, so seven busy lanes are seven elements and one callback rather than 518
// elements and 518 style recalcs a frame.
//
// It also paints the ORIGINAL colour law directly — `lerp(muted, peak, p)` at alpha `O(p)` — with
// no two-layer compositing, so it has no rim artifact to answer for and is exact by construction
// rather than by algebra.
const clients = new Set<() => void>()
let raf = 0
function join(draw: () => void) {
  clients.add(draw)
  if (!raf) {
    const tick = () => { for (const c of clients) c(); raf = clients.size ? requestAnimationFrame(tick) : 0 }
    raf = requestAnimationFrame(tick)
  }
  return () => { clients.delete(draw); if (!clients.size && raf) { cancelAnimationFrame(raf); raf = 0 } }
}

/** CSS `ease-in-out`, which is what the keyframes ran on. */
function easeInOut(t: number): number {
  const bx = (u: number) => 3 * (1 - u) ** 2 * u * 0.42 + 3 * (1 - u) * u * u * 0.58 + u ** 3
  const by = (u: number) => 3 * (1 - u) * u * u + u ** 3
  let lo = 0, hi = 1, u = t
  for (let i = 0; i < 24; i++) { u = (lo + hi) / 2; bx(u) < t ? lo = u : hi = u }
  return by(u)
}
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

export function CanvasOrb({ size, seed, accent, muted = '#8a94a0', at }: { size: number; seed: string; accent: string; muted?: string; at?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const dots = useMemo(() => dotTiming(seed), [seed])
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.round(size * dpr); cv.height = Math.round(size * dpr)
    const ctx = cv.getContext('2d')!
    const unit = size / CELLS
    const A = rgb(accent), M = rgb(muted)
    const t0 = performance.now()
    const draw = () => {
      const now = at != null ? at : (performance.now() - t0) / 1000
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size, size)
      for (const dot of dots) {
        // Where this dot is in its own breath: 0 at the trough, 1 at the peak, eased exactly as
        // the keyframe's `ease-in-out` eased it.
        const cyc = (((now - dot.delay) / dot.dur) % 1 + 1) % 1
        const p = easeInOut(cyc < 0.5 ? cyc / 0.5 : (1 - cyc) / 0.5)
        const o = TROUGH_OP + (PEAK_OP - TROUGH_OP) * p
        const s = 0.5 + 0.5 * p
        ctx.globalAlpha = o
        ctx.fillStyle = `rgb(${M.map((m, k) => Math.round(m + (A[k] - m) * p)).join(',')})`
        ctx.beginPath()
        ctx.arc(dot.cx * unit, dot.cy * unit, R * unit * s, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    draw()
    return join(draw)
  }, [dots, size, accent, muted, at])
  return <canvas ref={ref} style={{ width: size, height: size, display: 'block', flexShrink: 0 }} />
}

// ─── THE REFERENCE — the orb as it was BEFORE pass 1 ──────────────────────────────────────────
//
// One circle per dot, `fill` animated from the muted trough to the status hue. This is what the
// design was measured against and what pass 1 promised to preserve, so it — not the current
// two-layer SVG — is the honest reference for "does this still look like the orb". It carries no
// rim artifact, because there is only ever one shape.
//
// Its keyframe lives here rather than in `styles.css`: the app deleted it, and a bench that
// re-added it to the shipped stylesheet would be measuring a file nobody ships.
const ORIGINAL_KEYFRAMES = `@keyframes twinkle-original {
  0%, 100% { opacity: ${TROUGH_OP}; transform: scale(0.5); fill: var(--tw-fill, var(--fg-muted)); }
  50%      { opacity: ${PEAK_OP}; transform: scale(1); fill: var(--tw-fill-peak, var(--fg)); }
}`

export function OriginalOrb({ size, seed, accent }: { size: number; seed: string; accent: string }) {
  const dots = useMemo(() => dotTiming(seed), [seed])
  useEffect(() => {
    const st = document.createElement('style')
    st.textContent = ORIGINAL_KEYFRAMES
    document.head.appendChild(st)
    return () => { st.remove() }
  }, [])
  return (
    <span style={{
      position: 'relative', flexShrink: 0, display: 'inline-flex', lineHeight: 0,
      ['--tw-fill-peak' as string]: accent,
    }}>
      <svg width={size} height={size} viewBox={`0 0 ${CELLS} ${CELLS}`} fill="none">
        <g fill="var(--fg)">
          {dots.map((d, i) => (
            <circle key={i} cx={d.cx} cy={d.cy} r={R} style={{
              transformBox: 'fill-box', transformOrigin: 'center',
              animation: `twinkle-original ${d.dur.toFixed(2)}s ease-in-out ${d.delay.toFixed(2)}s infinite`,
            }} />
          ))}
        </g>
      </svg>
    </span>
  )
}

// ─── THE GEOMETRY, WITH NO ANIMATION AT ALL ───────────────────────────────────────────────────
//
// The same dots at the same instant, baked into plain SVG attributes: no keyframes, no animated
// transform, nothing for the compositor to rasterise-then-scale. This is what the orb's geometry
// says it should look like, and it exists to tell "canvas draws it differently" apart from "an
// animated SVG transform draws it differently from its own geometry".
export function StaticOrb({ size, seed, accent, at = 0, muted = '#8a94a0' }: { size: number; seed: string; accent: string; at?: number; muted?: string }) {
  const dots = useMemo(() => dotTiming(seed), [seed])
  const A = rgb(accent), M = rgb(muted)
  return (
    <span style={{ position: 'relative', flexShrink: 0, display: 'inline-flex', lineHeight: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${CELLS} ${CELLS}`} fill="none">
        {dots.map((d, i) => {
          const cyc = (((at - d.delay) / d.dur) % 1 + 1) % 1
          const p = easeInOut(cyc < 0.5 ? cyc / 0.5 : (1 - cyc) / 0.5)
          const o = TROUGH_OP + (PEAK_OP - TROUGH_OP) * p
          const fill = `rgb(${M.map((m, k) => Math.round(m + (A[k] - m) * p)).join(',')})`
          return <circle key={i} cx={d.cx} cy={d.cy} r={R * (0.5 + 0.5 * p)} fill={fill} opacity={o} />
        })}
      </svg>
    </span>
  )
}
