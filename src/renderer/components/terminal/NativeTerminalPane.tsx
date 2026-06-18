import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { ITheme } from '@xterm/xterm'

// Native terminal pane. The pty output is rendered natively by the wgpu NSView
// (src-tauri/src/termview.rs) behind this transparent element. This component:
//   1. On becoming active, attaches (tab switch) + pushes the theme palette.
//   2. Reports rect/scale so the view + pty stay sized.
//   3. Captures keys via a HEADLESS xterm (key encoder only; display transparent).
//   4. Forwards wheel → scrollback and mouse → selection / mouse-tracking /
//      opt+click-to-open-link (all resolved in Rust).
const TRANSPARENT = '#00000000'

export function NativeTerminalPane({ terminalId, active, theme }: { terminalId: string; active: boolean; theme: ITheme }) {
  const ref = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active

  const rect = (e?: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect()
    const scale = window.devicePixelRatio || 1
    return e
      ? ([e.clientX - r.left, e.clientY - r.top, scale] as const)
      : ([r.left, r.top, r.width, r.height, scale] as const)
  }

  // Mount: key encoder + geometry + wheel/mouse forwarding (once per terminal).
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: false,
      theme: { background: TRANSPARENT, foreground: TRANSPARENT, cursor: TRANSPARENT, cursorAccent: TRANSPARENT },
    })
    term.open(el)
    termRef.current = term
    term.onData((d) => window.operator.terminalWrite(terminalId, d))

    let raf = 0
    const reportRect = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        if (!ref.current || !activeRef.current) return
        const [x, y, w, h, s] = rect() as [number, number, number, number, number]
        window.operator.pocSetRect?.(terminalId, x, y, w, h, s)
      })
    }
    const ro = new ResizeObserver(reportRect)
    ro.observe(el)
    window.addEventListener('resize', reportRect)
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    mq.addEventListener('change', reportRect)

    // Wheel → native scrollback. Capture phase + preventDefault so xterm/page
    // don't also scroll.
    const onWheel = (e: WheelEvent) => {
      if (!activeRef.current) return
      e.preventDefault()
      const lines = Math.round(-e.deltaY / 20) || (e.deltaY < 0 ? 1 : -1)
      if (lines !== 0) window.operator.pocScroll?.(terminalId, lines)
    }
    el.addEventListener('wheel', onWheel, { capture: true, passive: false })

    // Mouse → selection / mouse-tracking report / opt+click link (Rust decides).
    // Down on the pane; move/up on window so a drag past the edge still tracks.
    let button = 0
    let dragging = false
    const send = (kind: 'down' | 'move' | 'up', e: MouseEvent) => {
      const [x, y, s] = rect(e) as [number, number, number]
      window.operator.pocMouse?.(terminalId, kind, x, y, s, button, e.altKey)
    }
    const onDown = (e: MouseEvent) => {
      if (!activeRef.current) return
      button = e.button
      dragging = true
      send('down', e)
    }
    const onMove = (e: MouseEvent) => { if (dragging) send('move', e) }
    const onUp = (e: MouseEvent) => { if (dragging) { dragging = false; send('up', e) } }
    el.addEventListener('mousedown', onDown, true)
    window.addEventListener('mousemove', onMove, true)
    window.addEventListener('mouseup', onUp, true)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('resize', reportRect)
      mq.removeEventListener('change', reportRect)
      el.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions)
      el.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('mouseup', onUp, true)
      term.dispose()
      termRef.current = null
      window.operator.pocDetach?.(terminalId)
    }
  }, [terminalId])

  // Becoming active (mount-if-active or tab switch): focus + attach + theme.
  useEffect(() => {
    if (!active || !ref.current) return
    termRef.current?.focus()
    const raf = requestAnimationFrame(() => {
      // Theme first so the freshly-built state's first frame is already themed
      // (no dark flash on a Light-theme session).
      window.operator.pocSetTheme?.(theme)
      const [x, y, w, h, s] = rect() as [number, number, number, number, number]
      window.operator.pocAttachTermview?.(terminalId, x, y, w, h, s)
    })
    return () => cancelAnimationFrame(raf)
  }, [active, terminalId])

  // Live theme changes while active.
  useEffect(() => {
    if (active) window.operator.pocSetTheme?.(theme)
  }, [active, theme])

  return <div ref={ref} style={{ position: 'absolute', inset: 0, background: 'transparent' }} />
}
