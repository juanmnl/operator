import { useCallback, useEffect, useState, type RefObject } from 'react'
import { EDIT_CMD_TAG, editStateMessage, type EditState } from '../../shared/preview-edit'

// The renderer end of the CSS controls: state from the page (src/shared/preview-edit-page.js), commands
// to it. Both over postMessage with the preview iframe, which works across origins. Messages are
// accepted only from that iframe's own window, the rule the pick/anchor listener keeps.

export type EditCommand = 'set' | 'undo' | 'reset' | 'resetAll' | 'deselect' | 'capture' | 'refresh'

export function usePreviewEdit(frameRef: RefObject<HTMLIFrameElement | null>, resetKey: unknown): {
  state: EditState | null
  send: (cmd: EditCommand, extra?: Record<string, unknown>) => void
} {
  const [state, setState] = useState<EditState | null>(null)
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const frame = frameRef.current
      if (!frame || e.source !== frame.contentWindow) return
      const s = editStateMessage(e.data)
      if (s) setState(s)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [frameRef])
  // A new page (reload, another URL) has no edits.
  useEffect(() => { setState(null) }, [resetKey])
  const send = useCallback((cmd: EditCommand, extra: Record<string, unknown> = {}) => {
    frameRef.current?.contentWindow?.postMessage({ [EDIT_CMD_TAG]: cmd, ...extra }, '*')
  }, [frameRef])
  return { state, send }
}
