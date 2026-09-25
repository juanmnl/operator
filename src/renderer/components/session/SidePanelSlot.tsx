import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { LAYOUT_EASE, LAYOUT_MOVE_MS } from '../../lib/layout-motion'

// The right side panel's place in the root row, and the only thing that animates when it opens
// or closes.
//
// Two boxes. The SLOT is the flex item: its width is the panel's share of the row, and it is what
// grows and shrinks. The SURFACE inside it is the panel you see: fixed at the panel's width and
// anchored to the slot's INNER edge, one gap in, so it slides in behind the card's edge with the
// gap intact and its contents already laid out at their final width — Plan's text, the Diff and the
// Preview iframe never re-wrap or resize during the move; the window edge clips what has not
// arrived yet. Anchored to the window edge instead, the moving edge uncovered the panel from its
// right-hand end: line endings appeared before the tabs, and the gap only opened at the end. The
// panel used to mount and unmount in one frame: in Electron the card jumped at once and the terminal
// refit ~170ms later (its fit waits for pty output to go quiet), two separate jumps.
//
// The slot also owns the row's gap in front of the panel (`marginLeft: -gap`, width + gap), so a
// slot at width 0 costs the row nothing and the card reaches the window edge exactly as it did
// when the panel was unmounted.
//
// `animate` is true only for a user's toggle. A lane switch that changes which panel state is
// showing stays instant: the incoming lane's terminal fits on activation, and a slot still moving
// underneath it would make that fit land at a mid-move width.
export function SidePanelSlot({ open, width, gap, animate, onMoveStart, style, children }: {
  open: boolean
  width: number
  gap: number
  animate: boolean
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
  const animRef = useRef<Animation | null>(null)
  const full = width + gap
  const onMoveStartRef = useRef(onMoveStart)
  onMoveStartRef.current = onMoveStart

  if (open && !mounted) setMounted(true)

  useLayoutEffect(() => {
    const el = slotRef.current
    const running = animRef.current
    // Where the edge is NOW, so a reversal mid-move continues from there instead of snapping.
    const from = running && el ? el.getBoundingClientRect().width : null
    running?.cancel()
    animRef.current = null
    if (!el) return
    if (!animate || typeof el.animate !== 'function') {
      if (!open) setMounted(false)
      return
    }
    const start = from ?? (open ? 0 : full)
    const end = open ? full : 0
    if (start === end) { if (!open) setMounted(false); return }
    const anim = el.animate(
      [{ width: `${start}px` }, { width: `${end}px` }],
      { duration: LAYOUT_MOVE_MS, easing: LAYOUT_EASE, fill: 'forwards' },
    )
    animRef.current = anim
    // OPENING, the clock starts on the frame AFTER the mount. Mounting the panel's contents is one
    // long task (measured ~150ms in the mock harness), and an animation created inside it had
    // spent most of its 260ms before the first frame painted — it opened with a single 370px
    // jump, the thing this component exists to remove. Held at its first keyframe and played two
    // frames later: the first frame callback still runs inside the late frame, whose timeline time
    // predates the long task, so playing there jumped just the same. A close has no mount to wait for.
    let raf = 0
    if (open && from == null) {
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
      if (open) anim.cancel() // hand the width back to the inline style (identical value)
      else setMounted(false)
    }
    return () => cancelAnimationFrame(raf)
    // `full` is read, not a dependency: a drag-resize changes it every frame and must not restart
    // the move. Only a change of `open` does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useLayoutEffect(() => () => animRef.current?.cancel(), [])

  if (!mounted) return null
  return (
    <div
      ref={slotRef}
      data-side-panel-slot
      style={{
        position: 'relative', flexShrink: 0, overflow: 'hidden',
        width: open ? full : 0, marginLeft: -gap,
      }}
    >
      <div
        data-side-panel
        style={{
          position: 'absolute', top: 0, bottom: 0, left: gap, width, overflow: 'hidden',
          ...style,
        }}
      >
        {children}
      </div>
    </div>
  )
}
