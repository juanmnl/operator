import { useRef } from 'react'
import type { CSSProperties, ReactNode, MouseEvent } from 'react'

interface DragRegionProps {
  style?: CSSProperties
  children?: ReactNode
  /** Test hook, forwarded to the element. The shell tags its header with this so a driver can
   *  assert every mode's frame is the same box rather than eyeballing screenshots. */
  'data-toolbar-header'?: string
}

// macOS double-click threshold (ms). Native dblclick can't reach us because
// startDragging() takes over on the first mousedown, so we time consecutive
// presses ourselves.
const DOUBLE_CLICK_MS = 400

// A window drag handle. We drive the drag ourselves — startWindowDrag() on
// mousedown — instead of leaning on Tauri's data-tauri-drag-region attribute.
// On macOS that attribute's handler dies after the first OS drag (the drag loop
// swallows the mouseup) or when the strip remounts on a view switch, which is
// the "I could move it once, then it stopped" bug. A React onMouseDown re-binds
// to the live node every render, so it never goes stale.
//
// Interactive children (buttons, links, inputs) are left alone so their clicks
// still work; the press only starts a drag when it lands on bare titlebar.
export function DragRegion({ style, children, ...rest }: DragRegionProps) {
  const lastDownRef = useRef(0)
  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return // left button only
    if ((e.target as HTMLElement).closest('button, a, input, textarea, select, [role="button"]')) return
    // A second press on the bare titlebar within the threshold is a double-click:
    // zoom the window (fill the screen ⇆ restore) like a native title bar, and
    // skip the drag so it doesn't fight the toggle.
    const now = e.timeStamp
    if (now - lastDownRef.current < DOUBLE_CLICK_MS) {
      lastDownRef.current = 0
      window.operator.toggleWindowMaximize?.()
      return
    }
    lastDownRef.current = now
    window.operator.startWindowDrag?.()
  }
  // `drag-region` paints a grab/grabbing cursor (see styles.css) so the strip
  // reads as draggable; interactive children keep their own pointer cursor.
  return (
    <div className="drag-region" onMouseDown={onMouseDown} style={style} {...rest}>
      {children}
    </div>
  )
}
