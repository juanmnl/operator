import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { LAYOUT_EASE, LAYOUT_MOVE_MS } from '../../lib/layout-motion'

// The right side panel's place in the root row, and the only thing that animates when it opens
// or closes.
//
// DOCKED, there are two boxes. The SLOT is the flex item: its width is the panel's share of the
// row, and it is what grows and shrinks. The SURFACE inside it is the panel you see: fixed at the
// panel's width and anchored to the slot's INNER edge, one gap in, so it slides in behind the
// card's edge with the gap intact and its contents already laid out at their final width — Plan's
// text, the Diff and the Preview iframe never re-wrap or resize during the move; the window edge
// clips what has not arrived yet. Anchored to the window edge instead, the moving edge uncovered
// the panel from its right-hand end: line endings appeared before the tabs, and the gap only
// opened at the end. The panel used to mount and unmount in one frame: in Electron the card jumped
// at once and the terminal refit ~170ms later (its fit waits for pty output to go quiet), two
// separate jumps.
//
// The slot also owns the row's gap in front of the panel (`marginLeft: -gap`, width + gap), so a
// slot at width 0 costs the row nothing and the card reaches the window edge exactly as it did
// when the panel was unmounted.
//
// OVERLAID (`overlay`, when docking would leave the console under its minimum; see `placePanel`),
// the slot takes no width at all and the surface is a drawer over the card's right edge. It slides
// in by transform, so nothing in the row moves and the terminal is never refit. It starts BELOW the
// card's toolbar band (`overlayTop`): full height, it covered the toolbar's own panel toggle, so the
// drawer could not be closed from the button that opened it (found driving it in Electron).
//
// `animate` is true only while the active lane's own move is running. A lane switch that changes
// which panel state is showing stays instant: the incoming lane's terminal fits on activation, and
// a slot still moving underneath it would make that fit land at a mid-move width. When `animate`
// drops while an animation is running (the move was cancelled by a lane switch) the animation is
// finished on the spot, for the same reason.
export function SidePanelSlot({ open, width, gap, animate, overlay = false, overlayTop = 0, onMoveStart, style, children }: {
  open: boolean
  width: number
  gap: number
  animate: boolean
  /** Draw over the card instead of beside it. */
  overlay?: boolean
  /** Where an overlaid drawer starts, from the card's top: the card's toolbar band stays uncovered. */
  overlayTop?: number
  /** Fired when the move's clock actually starts, which on an open is two frames after the toggle
   *  plus however long the mount took. The caller's settle timer restarts from here, so the
   *  terminals are not released to refit while the edge is still moving. */
  onMoveStart?: () => void
  /** The surface's own paint (background, radius). */
  style?: CSSProperties
  children: ReactNode
}) {
  // Rendered through the close animation, not just while `open`.
  const [mounted, setMounted] = useState(open)
  const slotRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const animRef = useRef<Animation | null>(null)
  const full = width + gap
  const onMoveStartRef = useRef(onMoveStart)
  onMoveStartRef.current = onMoveStart
  const prev = useRef({ open, full, overlay })

  if (open && !mounted) setMounted(true)

  // A cancelled move finishes whatever is running at once (see the header).
  useLayoutEffect(() => {
    if (!animate) animRef.current?.finish()
  }, [animate])

  useLayoutEffect(() => {
    const was = prev.current
    prev.current = { open, full, overlay }
    const openChanged = was.open !== open
    const running = animRef.current
    const slot = slotRef.current
    const surface = surfaceRef.current
    // Where the edge is NOW, so a reversal mid-move continues from there instead of snapping.
    const fromW = running && slot && !overlay ? slot.getBoundingClientRect().width : null
    const fromX = running && surface && overlay ? new DOMMatrixReadOnly(getComputedStyle(surface).transform).m41 : null
    running?.cancel()
    animRef.current = null
    if (!slot || !surface) return
    const canAnimate = animate && typeof slot.animate === 'function' && was.overlay === overlay
    // Animated: a change of `open` in either mode, and — docked only — a change of width while the
    // panel stays open (the rail moved and the panel's docked width follows it).
    if (!canAnimate || (!openChanged && (overlay || was.full === full))) {
      if (!open) setMounted(false)
      return
    }
    const opts: KeyframeAnimationOptions = { duration: LAYOUT_MOVE_MS, easing: LAYOUT_EASE, fill: 'forwards' }
    let anim: Animation
    if (overlay) {
      // Off-screen = past the window edge: the panel's width, its gap, and the root's 8px pad.
      const off = width + gap + 8
      const start = fromX ?? (open ? off : 0)
      anim = surface.animate([{ transform: `translateX(${start}px)` }, { transform: `translateX(${open ? 0 : off}px)` }], opts)
    } else {
      const start = fromW ?? (openChanged ? (open ? 0 : was.full) : was.full)
      const end = open ? full : 0
      if (start === end) { if (!open) setMounted(false); return }
      anim = slot.animate([{ width: `${start}px` }, { width: `${end}px` }], opts)
    }
    animRef.current = anim
    // OPENING, the clock starts on the frame AFTER the mount. Mounting the panel's contents is one
    // long task (measured ~150ms in the mock harness), and an animation created inside it had
    // spent most of its 260ms before the first frame painted — it opened with a single 370px
    // jump, the thing this component exists to remove. Held at its first keyframe and played two
    // frames later: the first frame callback still runs inside the late frame, whose timeline time
    // predates the long task, so playing there jumped just the same. A close has no mount to wait for.
    let raf = 0
    if (open && openChanged && fromW == null && fromX == null) {
      anim.pause()
      raf = requestAnimationFrame(() => {
        raf = requestAnimationFrame(() => {
          if (animRef.current !== anim) return
          anim.play()
          onMoveStartRef.current?.()
        })
      })
    }
    anim.onfinish = () => {
      if (animRef.current !== anim) return
      animRef.current = null
      if (open) anim.cancel() // hand the geometry back to the inline style (identical value)
      else setMounted(false)
    }
    return () => cancelAnimationFrame(raf)
    // `animate` is read, not a dependency: it only decides whether a change of `open`, of the
    // width or of the mode is animated. A drag-resize changes `full` with `animate` false, so it
    // takes the instant path above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, full, overlay])

  useLayoutEffect(() => () => animRef.current?.cancel(), [])

  if (!mounted) return null
  return (
    <div
      ref={slotRef}
      data-side-panel-slot={overlay ? 'overlay' : 'dock'}
      style={overlay
        ? { position: 'relative', flexShrink: 0, width: 0, marginLeft: -gap, zIndex: 40 }
        : { position: 'relative', flexShrink: 0, overflow: 'hidden', width: open ? full : 0, marginLeft: -gap }}
    >
      <div
        ref={surfaceRef}
        data-side-panel
        style={{
          position: 'absolute', top: overlay ? overlayTop : 0, bottom: 0, width, overflow: 'hidden',
          ...(overlay
            // Over the card, so it needs the card's own depth to read as a layer above it.
            ? { right: 0, boxShadow: 'var(--shadow-panel), inset 0 0 0 1px var(--panel-edge)' }
            : { left: gap }),
          ...style,
        }}
      >
        {children}
      </div>
    </div>
  )
}
