// The tray icon ANIMATES. Ported from `src-tauri/src/tray_anim.rs`.
//
// The icon IS the brand mark — the dot-circle "twinkle" (src/renderer/components/LogoMark.tsx,
// sidebar/StatusWave.tsx): a 7×7 disc of dots that breathe on an eased, desynced cycle. It is
// rasterized here to a macOS TEMPLATE image (black + alpha; the system tints it) and cycled from
// the aggregate lane signal:
//
//   busy      (any live lane "running")  → lively desynced twinkle   ("working")
//   your-turn (else any live "waiting")  → slow unison pulse         ("your turn")
//   idle      (neither)                  → the static mark, no timer
//
// MOTION IS THE BUSY SIGNAL — the house rule the sidebar follows too. Idle does not tick, it
// rests: a menu bar that animates forever is a menu bar you stop reading.
import { nativeImage } from 'electron'

export type TrayPhase = 'idle' | 'busy' | 'your-turn'

/** The aggregate signal, ported from the reducer the tailer runs inline
 *  (src-tauri/src/transcript.rs:1131-1149). Anything working outranks anything waiting: the
 *  twinkle means "Operator is doing something", and one running lane makes that true. */
export function aggregateState(lanes: Array<{ phase: string }>): TrayPhase {
  let waiting = false
  for (const l of lanes) {
    if (l.phase === 'running') return 'busy'
    if (l.phase === 'waiting') waiting = true
  }
  return waiting ? 'your-turn' : 'idle'
}

const SIZE = 44 // the canvas: 22pt @2x, the size a macOS tray image is handed in
const CENTER = 3.5 // grid centre in dot-centre coords: (7-1)/2 + 0.5
const DISC = 3.4 // disc radius in cell units (StatusWave RADIUS)
const DOT_R = 0.5 // dot radius in cell units

/** THE VISIBLE MARK — 36px at scaleFactor 2, i.e. **18pt**.
 *
 *  18pt is what a macOS menu-bar template icon is: the system's own status items draw at roughly
 *  that, and anything larger reads as an app that did not measure. This was 40px (20pt), matched
 *  to the opaque box inside `tray.png` — which was itself the thing that was too big. Measured
 *  before the change: ink spanned x 2..41 in every phase, 40px across, 20.0pt.
 *
 *  The CANVAS stays 44. Shrinking the canvas instead would have been the same pixels with a
 *  different container and would have moved the problem to whatever else assumed 44. */
const MARK = 36.0 // visible mark diameter in px → 18pt at scaleFactor 2
const INSET = (SIZE - MARK) / 2 // 4px padding on each side
const PX = MARK / 7 // pixels per cell (7 cells across the mark)
const TAU = Math.PI * 2

interface Dot {
  cx: number
  cy: number
  v: number // size/brightness weight (LogoMark static)
  dur: number // breathing period (busy)
  off: number // phase offset (desync)
}

/** Frozen pseudo-random matching the renderer's `rand()`: frac(sin(seed·k)·m). The point is not
 *  randomness, it is that the tray's dots carry the SAME weights as the mark in the app. */
export function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

/** Dots inside the disc, in the same c-outer/r-inner order as LogoMark/StatusWave so the
 *  per-index weights line up with the brand mark. */
export function buildDots(): Dot[] {
  const max = DISC * DISC * 1.04
  const out: Dot[] = []
  for (let c = 0; c < 7; c++) {
    for (let r = 0; r < 7; r++) {
      const cx = c + 0.5
      const cy = r + 0.5
      const dx = cx - CENTER
      const dy = cy - CENTER
      if (dx * dx + dy * dy <= max) {
        const i = out.length
        out.push({
          cx,
          cy,
          v: rand(i + 11),
          dur: 1.4 + rand(i + 1) * 1.2, // 1.4-2.6s, the running tempo
          off: rand(i + 7),
        })
      }
    }
  }
  return out
}

/** Anti-aliased filled disc into the ALPHA channel only. Overlapping dots take the max alpha so
 *  seams don't double-darken. */
function paintDot(buf: Buffer, cx: number, cy: number, scale: number, op: number): void {
  const pcx = INSET + cx * PX
  const pcy = INSET + cy * PX
  const rad = scale * DOT_R * PX
  const x0 = Math.max(0, Math.floor(pcx - rad - 1))
  const x1 = Math.min(SIZE, Math.ceil(pcx + rad + 1))
  const y0 = Math.max(0, Math.floor(pcy - rad - 1))
  const y1 = Math.min(SIZE, Math.ceil(pcy + rad + 1))
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const dx = x + 0.5 - pcx
      const dy = y + 0.5 - pcy
      const dist = Math.sqrt(dx * dx + dy * dy)
      const cov = Math.min(1, Math.max(0, rad - dist + 0.5)) // ~1px AA edge
      if (cov <= 0) continue
      const a = Math.trunc(cov * op * 255)
      const idx = (y * SIZE + x) * 4 + 3 // alpha byte
      if (a > buf[idx]) buf[idx] = a
    }
  }
}

/** One RGBA frame for `state` at time `t` (seconds).
 *
 *  RGB STAYS ZERO - only alpha carries the shape, which is what makes it a template image macOS
 *  can tint for the active menu bar, and incidentally why the byte order does not matter: the
 *  raw-bitmap format is platform-dependent (BGRA on most), but with all three colour bytes at 0
 *  RGBA and BGRA are the same bytes, premultiplied or not. */
export function frame(dots: Dot[], state: TrayPhase, t: number): Buffer {
  const buf = Buffer.alloc(SIZE * SIZE * 4)
  // your-turn: the whole disc breathes in unison - a calm "your turn" beacon.
  const p = t / 2.6
  const pulse = (1 - Math.cos(TAU * (p - Math.floor(p)))) * 0.5
  for (const d of dots) {
    let op: number
    let scale: number
    if (state === 'busy') {
      const ph = t / d.dur + d.off
      const s = (1 - Math.cos(TAU * (ph - Math.floor(ph)))) * 0.5 // 0->1->0
      op = 0.3 + 0.65 * s // 0.30->0.95
      scale = 0.5 + 0.5 * s // 0.5->1
    } else if (state === 'your-turn') {
      op = 0.35 + 0.4 * pulse // gentle, legible
      scale = 0.62 + 0.3 * pulse
    } else {
      const w = 0.62 + 0.38 * d.v // idle: LogoMark's static weighting
      op = w
      scale = w
    }
    paintDot(buf, d.cx, d.cy, scale, op)
  }
  return buf
}

/** A frame as a template `NativeImage`, ready for `tray.setImage`. */
export function frameImage(dots: Dot[], state: TrayPhase, t: number): Electron.NativeImage {
  const img = nativeImage.createFromBitmap(frame(dots, state, t), { width: SIZE, height: SIZE, scaleFactor: 2 })
  img.setTemplateImage(true)
  return img
}

const TICK_MS = 80 // ~12.5fps - enough for a breathing dot, cheap enough to ignore
/** The your-turn pulse is a transient beacon, not a permanent state: after this it settles to
 *  the static mark so the menu bar doesn't pulse forever. Entering your-turn again (including a
 *  fresh turn after busy) re-arms it. Mirrors StatusWave's settle in the sidebar. */
const YOUR_TURN_SETTLE_S = 6

/** Drive the icon: cadence, the settle, and the decision NOT to paint. Returns the stop function.
 *
 *  It hands `paint` a state and a time rather than an image, which keeps every rule about WHEN
 *  the tray repaints testable under plain node — rasterizing needs Electron, timing does not.
 *
 *  The state is PULLED rather than pushed so a missed event cannot leave the icon stuck
 *  mid-twinkle: every tick asks what is true now. `paint` is only called when there is something
 *  new to show - idle paints once and then the loop rests. */
export function startTrayAnimation(
  getState: () => TrayPhase,
  paint: (state: TrayPhase, t: number) => void,
): () => void {
  let t = 0
  let idlePainted = false
  let prev: TrayPhase = 'idle'
  let ytElapsed = 0
  const tick = () => {
    const state = getState()
    if (state === 'your-turn' && prev !== 'your-turn') ytElapsed = 0 // a new stretch -> re-arm
    prev = state
    const settled = state === 'your-turn' && ytElapsed >= YOUR_TURN_SETTLE_S
    if (state === 'idle' || settled) {
      if (!idlePainted) {
        paint('idle', 0)
        idlePainted = true
      }
      return
    }
    idlePainted = false
    if (state === 'your-turn') ytElapsed += TICK_MS / 1000
    t += TICK_MS / 1000
    paint(state, t)
  }
  tick() // paint the static mark immediately rather than 80ms into the app's life
  const timer = setInterval(tick, TICK_MS)
  return () => clearInterval(timer)
}
