import { useEffect, useMemo, useRef, useState } from 'react'
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
 *  peak is the status hue at 0.95, and "ink over a cycle ≈ 0.51" falls out of that pair.
 *
 *  A busy orb is now PAINTED, not animated (see `OrbCanvas`), so these two numbers are read
 *  directly by the draw call rather than sampled into a stylesheet. That is the whole reason the
 *  canvas is worth the machinery: the colour law is written once, in one place, in the units the
 *  measurements are stated in. */
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
        return { ...d, style: { opacity: cfg.staticOp, fill: restFill } as React.CSSProperties, timing: null }
      }
      // Unison (your-turn pulse): every dot shares one period and phase so the
      // disc breathes as a single beacon. Otherwise each dot gets its own period
      // and a negative offset → the desynced "thinking" shimmer.
      const dur = cfg.unison
        ? cfg.durMin * tempo
        : (cfg.durMin + rand(i + 1 + s) * (cfg.durMax - cfg.durMin)) * tempo
      const delay = cfg.unison ? 0 : -rand(i + 7 + s * 1.7) * dur
      // A busy dot carries TIMING, not style: `OrbCanvas` paints it. The rhythm — a per-session
      // tempo, a per-dot period, a negative offset so nothing pulses in lockstep — is unchanged,
      // and it has to be: it is the seeded signature that makes two running lanes distinguishable
      // at a glance.
      return { ...d, style: null, timing: { dur, delay } }
    })
  }, [effective, seed, accent]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <span style={{
      // `relative` so the letter can sit ON the disc. Harmless when there is no letter.
      position: 'relative', flexShrink: 0, display: 'inline-flex', lineHeight: 0,
      // `--tw-fill` / `--tw-fill-peak` used to live here, for a keyframe to read. Nothing reads
      // them now: a busy orb is painted and takes its bloom colour as a prop, and a resting one
      // carries the accent directly on each dot's own fill. The lane accent still re-tints the
      // moving half — that is what makes a collapsed rail say WHICH agent — it just travels as
      // an argument instead of as a custom property.
    }}>
      {cfg.animate
        ? <OrbCanvas size={size} dots={dots} peak={(accent || cfg.fillPeak) ?? 'var(--fg)'} />
        : (
          // THE RESTING PATH IS UNTOUCHED, deliberately. Rest is most of the rail most of the
          // time and it costs nothing — it does not animate — so there is no reason to move it,
          // and every reason not to: its ink levels carry measured receipts (see `REST_OP`) that
          // a change of rasteriser would put back in question. `dev/drive-orb-rest.mjs` holds
          // these four states to byte-identical renders.
          <svg width={size} height={size} viewBox={`0 0 ${CELLS} ${CELLS}`} fill="none">
            <g fill="var(--fg)">
              {dots.map((d, i) => <circle key={i} cx={d.cx} cy={d.cy} r={R} style={d.style ?? undefined} />)}
            </g>
          </svg>
        )}
      {initial && <OrbInitial initial={initial} size={size} />}
    </span>
  )
}

/** A BUSY ORB IS PAINTED, NOT ANIMATED — pass 2, `dev/results/perf-pass-2-orbs.md`.
 *
 *  Pass 1 got the twinkle off `fill` and stopped there, because it had found the floor: Blink
 *  never composites SVG element animations, so 37 dots x 7 busy lanes is 518 elements whose style
 *  is recalculated every frame no matter what is animated on them. Measured, seven busy orbs:
 *  **33.2% renderer, 8.5% GPU**.
 *
 *  Both ways out were measured. HTML dots ARE promoted — Blink reports
 *  `ActiveTransformAnimation, ActiveOpacityAnimation` on them — and it changes nothing: 33.8%,
 *  because 518 compositor layers of three-and-a-half pixels each cost in bookkeeping what they
 *  save in style. One canvas per orb, drawn by a single shared rAF, measures **9.5% / 2.2%** — and
 *  8.1% at devicePixelRatio 2, where the SVG orb costs 39.6%.
 *
 *  IT IS ALSO MORE FAITHFUL THAN WHAT IT REPLACES, which was the surprise. Against the orb's own
 *  static geometry the canvas measures ΔE*ab 0.57 mean / 1.72 max, while both the shipped SVG and
 *  the pre-pass-1 original sit ~5.7 away from that same geometry: an animated SVG transform is
 *  rasterised and then scaled, which softens every dot's edge. Total ink lands 1.6% off the
 *  original against the shipped orb's 3.8%. The dots are the same size, colour, phase and
 *  rhythm — they are simply drawn at the size they are meant to be.
 *
 *  The trade this makes is that colours must be RESOLVED rather than referenced: a canvas cannot
 *  read `var(--fg-muted)`. `resolveColor` does it through the browser, once per value, and the
 *  cache is dropped when the theme changes. */
function OrbCanvas({ size, dots, peak }: {
  size: number
  dots: Array<{ cx: number; cy: number; timing: { dur: number; delay: number } | null }>
  peak: string
}) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const theme = useThemeEpoch()
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const unit = size / CELLS
    const trough = rgbOf(resolveColor('var(--fg-muted)'))
    const bloom = rgbOf(resolveColor(peak))
    let dpr = 0
    const t0 = performance.now()
    const draw = () => {
      // Re-read the ratio each frame rather than at mount: dragging the window to a second
      // display changes it, and a canvas sized for the old one is visibly soft afterwards. It is
      // a number comparison, and the resize only happens when it actually changed.
      const next = window.devicePixelRatio || 1
      if (next !== dpr) {
        dpr = next
        cv.width = Math.round(size * dpr)
        cv.height = Math.round(size * dpr)
      }
      const elapsed = (performance.now() - t0) / 1000
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size, size)
      for (const d of dots) {
        if (!d.timing) continue
        const p = twinkleProgress(elapsed, d.timing.dur, d.timing.delay)
        ctx.globalAlpha = TWINKLE_TROUGH_OP + (TWINKLE_PEAK_OP - TWINKLE_TROUGH_OP) * p
        ctx.fillStyle = `rgb(${trough[0] + (bloom[0] - trough[0]) * p | 0},${trough[1] + (bloom[1] - trough[1]) * p | 0},${trough[2] + (bloom[2] - trough[2]) * p | 0})`
        ctx.beginPath()
        ctx.arc(d.cx * unit, d.cy * unit, R * unit * (0.5 + 0.5 * p), 0, Math.PI * 2)
        ctx.fill()
      }
    }
    // OFF SCREEN, OFF THE LOOP. A rail scrolls, and a lane below the fold was still painting 37
    // dots sixty times a second at nobody. This is the cheap half of pass 2's win and it was
    // impossible before it: a CSS animation runs wherever it is declared, and there is no way to
    // tell one to stop because the element scrolled out. A paint loop can simply be left.
    //
    // `rootMargin` starts an orb a little before it arrives, so the first visible frame is
    // already the current phase rather than a stale one.
    //
    // THE PHASE CANNOT DRIFT while an orb is out, and that is what makes leaving safe: progress
    // is a pure function of elapsed time since mount (`twinkleProgress`), not an accumulator, so
    // an orb that stops for a minute and rejoins paints exactly where it would have been had it
    // never stopped. `the animation is a function of TIME, not of frames` in the tests holds that.
    let leave: (() => void) | null = null
    const run = () => { if (!leave) leave = joinFrameLoop(draw) }
    const halt = () => { leave?.(); leave = null }

    // One frame now regardless: an orb that is never observed to intersect (no observer, or a
    // parent that reveals it some way this cannot see) must still show the right pixels.
    draw()
    if (typeof IntersectionObserver === 'undefined') {
      run()
      return () => halt()
    }
    const io = new IntersectionObserver((entries) => {
      // The LAST entry wins: a burst of scroll can deliver several for one element and only the
      // most recent describes where it is now.
      const latest = entries[entries.length - 1]
      if (latest?.isIntersecting) run()
      else halt()
    }, { rootMargin: '48px' })
    io.observe(cv)
    return () => { io.disconnect(); halt() }
  }, [dots, size, peak, theme])
  return <canvas ref={ref} width={size} height={size} style={{ width: size, height: size, display: 'block' }} />
}

/** Where one dot is in its own breath: 0 at the trough, 1 at the peak, eased exactly as the
 *  keyframe's `ease-in-out` eased it. Pure, and exported because it IS the animation now — the
 *  thing a test can hold. */
export function twinkleProgress(elapsed: number, dur: number, delay: number): number {
  const cyc = ((((elapsed - delay) / dur) % 1) + 1) % 1
  // The cycle is a triangle: out to the peak by the halfway mark, back by the end. The keyframe
  // spelled that as `0%, 100%` against `50%`; here it is the fold.
  return easeInOut(cyc < 0.5 ? cyc / 0.5 : (1 - cyc) / 0.5)
}

/** CSS `ease-in-out` — `cubic-bezier(0.42, 0, 0.58, 1)`, solved for y at x. Bisection rather than
 *  Newton: 24 halvings is exact to 1e-7 and cannot diverge, and this runs 259 times a frame. */
function easeInOut(t: number): number {
  const bx = (u: number) => 3 * (1 - u) ** 2 * u * 0.42 + 3 * (1 - u) * u * u * 0.58 + u ** 3
  let lo = 0, hi = 1, u = t
  for (let i = 0; i < 24; i++) { u = (lo + hi) / 2; bx(u) < t ? lo = u : hi = u }
  return 3 * (1 - u) * u * u + u ** 3
}

/** ONE rAF FOR THE WHOLE RAIL. Seven busy lanes are seven canvases and ONE callback; a loop per
 *  orb would put the scheduler back in the position the 518 elements were in. Also stops itself
 *  when the last orb unmounts, so a rail with nothing running costs nothing. */
const frameClients = new Set<() => void>()
let frameHandle = 0
function joinFrameLoop(draw: () => void): () => void {
  frameClients.add(draw)
  if (!frameHandle) {
    const tick = () => {
      for (const c of frameClients) c()
      frameHandle = frameClients.size ? requestAnimationFrame(tick) : 0
    }
    frameHandle = requestAnimationFrame(tick)
  }
  return () => {
    frameClients.delete(draw)
    if (!frameClients.size && frameHandle) { cancelAnimationFrame(frameHandle); frameHandle = 0 }
  }
}

/** CSS says `var(--fg-muted)`; a canvas needs `rgb(138, 148, 160)`.
 *
 *  Resolved by the browser rather than by a colour parser here — the value can be a var chain, a
 *  `color-mix`, or anything else CSS grows next, and only the engine knows what those mean. A
 *  detached element would compute nothing, so the probe is in the document; it is one node for
 *  the whole app, `aria-hidden`, and never painted. */
let probe: HTMLSpanElement | null = null
const colorCache = new Map<string, string>()
function resolveColor(expr: string): string {
  const hit = colorCache.get(expr)
  if (hit) return hit
  if (typeof document === 'undefined') return expr
  if (!probe) {
    probe = document.createElement('span')
    probe.setAttribute('aria-hidden', 'true')
    probe.style.cssText = 'position:absolute;width:0;height:0;visibility:hidden;pointer-events:none'
    document.body.appendChild(probe)
  }
  probe.style.color = ''
  probe.style.color = expr
  const out = getComputedStyle(probe).color || expr
  colorCache.set(expr, out)
  return out
}

/** `rgb(r, g, b)` / `rgba(...)` → three numbers. Only ever fed `getComputedStyle().color`, which
 *  is why this can be a regex and not a parser. */
function rgbOf(css: string): [number, number, number] {
  const m = css.match(/-?[\d.]+/g)
  if (!m || m.length < 3) return [128, 128, 128]
  return [Number(m[0]), Number(m[1]), Number(m[2])]
}

/** A number that changes when the palette does, so every canvas re-resolves its colours.
 *
 *  Themes are applied by rewriting custom properties on `<html>`, and a canvas holds RESOLVED
 *  colours — so without this an orb keeps painting the old palette until it happens to remount.
 *  A CSS-var-based orb got this for free; a painted one has to ask. */
let themeEpoch = 0
let watchingTheme = false
const themeSubs = new Set<(n: number) => void>()
function useThemeEpoch(): number {
  const [epoch, setEpoch] = useState(themeEpoch)
  useEffect(() => {
    // ONE observer for the life of the app, and the flag is what makes that true. Keying it on
    // `themeSubs.size` instead would install a second one every time the rail emptied and
    // refilled — which is every project switch — and each survivor would keep firing.
    if (!watchingTheme && typeof MutationObserver !== 'undefined') {
      watchingTheme = true
      new MutationObserver(() => {
        colorCache.clear()
        themeEpoch += 1
        for (const s of themeSubs) s(themeEpoch)
      }).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] })
    }
    themeSubs.add(setEpoch)
    return () => { themeSubs.delete(setEpoch) }
  }, [])
  return epoch
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
