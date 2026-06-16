import type { CSSProperties, ReactNode, MouseEvent } from 'react'

interface DragRegionProps {
  style?: CSSProperties
  children?: ReactNode
}

// A window drag handle. We drive the drag ourselves — startWindowDrag() on
// mousedown — instead of leaning on Tauri's data-tauri-drag-region attribute.
// On macOS that attribute's handler dies after the first OS drag (the drag loop
// swallows the mouseup) or when the strip remounts on a view switch, which is
// the "I could move it once, then it stopped" bug. A React onMouseDown re-binds
// to the live node every render, so it never goes stale.
//
// Interactive children (buttons, links, inputs) are left alone so their clicks
// still work; the press only starts a drag when it lands on bare titlebar.
export function DragRegion({ style, children }: DragRegionProps) {
  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return // left button only
    if ((e.target as HTMLElement).closest('button, a, input, textarea, select, [role="button"]')) return
    window.operator.startWindowDrag?.()
  }
  // `drag-region` paints a grab/grabbing cursor (see styles.css) so the strip
  // reads as draggable; interactive children keep their own pointer cursor.
  return (
    <div className="drag-region" onMouseDown={onMouseDown} style={style}>
      {children}
    </div>
  )
}
