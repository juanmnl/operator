import { useCallback, useEffect, useState, type RefObject } from 'react'
import { EDIT_CMD_TAG, EDIT_STATE_TAG, editStateMessage, type EditState } from '../../shared/preview-edit'

// The renderer end of the CSS controls: state from the page (src/shared/preview-edit-page.js), commands
// to it. The page engine is the same on both Preview sources; only the TRANSPORT differs:
//   - the web preview's iframe: postMessage, accepted only from that iframe's own window, the rule the
//     pick/anchor listener keeps;
//   - an attached Electron app: over CDP (electron/src/main/preview-cdp.ts), state through the
//     Runtime.addBinding channel and commands through Runtime.evaluate.
// PreviewEditPanel only ever sees `state` and `send`.

export type EditCommand = 'set' | 'undo' | 'reset' | 'resetAll' | 'deselect' | 'capture' | 'refresh'

/** How edit messages reach the page and come back. `subscribe` hands over each raw message, in the
 *  page engine's own shape (`{ __operatorEdit: 'state', data }`). */
export interface EditTransport {
  subscribe: (onMessage: (data: unknown) => void) => () => void
  post: (msg: Record<string, unknown>) => void
}

/** The web preview: the page is the stage's iframe. */
export function iframeEditTransport(frameRef: RefObject<HTMLIFrameElement | null>): EditTransport {
  return {
    subscribe: (onMessage) => {
      const listener = (e: MessageEvent) => {
        const frame = frameRef.current
        if (!frame || e.source !== frame.contentWindow) return
        onMessage(e.data)
      }
      window.addEventListener('message', listener)
      return () => window.removeEventListener('message', listener)
    },
    post: (msg) => { frameRef.current?.contentWindow?.postMessage(msg, '*') },
  }
}

/** An Electron app attached over CDP. Main forwards the engine's state JSON; it is rewrapped in the
 *  engine's message shape so one parser serves both transports. */
export const cdpEditTransport: EditTransport = {
  subscribe: (onMessage) => window.operator.onPreviewCdpEdit?.((data) => onMessage({ [EDIT_STATE_TAG]: 'state', data })) ?? (() => {}),
  post: (msg) => { window.operator.previewCdpEditCommand?.(msg) },
}

export function usePreviewEdit(transport: EditTransport, resetKey: unknown): {
  state: EditState | null
  send: (cmd: EditCommand, extra?: Record<string, unknown>) => void
} {
  const [state, setState] = useState<EditState | null>(null)
  useEffect(() => transport.subscribe((data) => {
    const s = editStateMessage(data)
    if (s) setState(s)
  }), [transport])
  // A new page (reload, another URL, the other source) has no edits.
  useEffect(() => { setState(null) }, [resetKey, transport])
  const send = useCallback((cmd: EditCommand, extra: Record<string, unknown> = {}) => {
    transport.post({ [EDIT_CMD_TAG]: cmd, ...extra })
  }, [transport])
  return { state, send }
}
