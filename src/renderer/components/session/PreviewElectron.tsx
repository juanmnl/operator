import { useCallback, useEffect, useRef, useState } from 'react'
import type { CdpTarget } from '../../../shared/types'
import { cdpButton, cdpModifiers, keyInput, toPage } from '../../lib/preview-electron'

// Preview's "Electron app" source: a lane's running Electron app, shown and driven over Chrome
// DevTools Protocol (electron/src/main/preview-cdp.ts). The toolbar controls, the hook that owns the
// attach state, and the canvas the frames are drawn into. AppPreviewPanel places them.

export interface PreviewElectronState {
  /** The debugging port reserved for this lane; null when its project is not an Electron app. */
  port: number | null
  targets: CdpTarget[]
  attachedId: string | null
  error: string | null
  /** The attached window's CSS viewport, from its frames. */
  css: { w: number; h: number }
  attach: (targetId: string) => void
  detach: () => void
}

/** Polls the lane's app windows while `enabled`, and owns which one is attached. */
export function usePreviewElectron(terminalId: string | undefined, enabled: boolean): PreviewElectronState {
  const [port, setPort] = useState<number | null>(null)
  const [targets, setTargets] = useState<CdpTarget[]>([])
  const [attachedId, setAttachedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [css, setCss] = useState({ w: 0, h: 0 })

  // Whether this lane has a port at all decides whether the source is offered, so it is asked for
  // whatever `enabled` says; the windows are polled only while the source is chosen.
  useEffect(() => {
    setPort(null); setTargets([])
    if (!terminalId || !window.operator.previewCdpTargets) return
    let stopped = false
    const poll = () => {
      window.operator.previewCdpTargets!(terminalId)
        .then((r) => { if (!stopped) { setPort(r.port); setTargets(r.targets) } })
        .catch(() => { /* no answer is no windows */ })
    }
    poll()
    const t = window.setInterval(poll, enabled ? 2000 : 10000)
    return () => { stopped = true; clearInterval(t) }
  }, [terminalId, enabled])

  useEffect(() => {
    const unsubFrame = window.operator.onPreviewCdpFrame?.((f) => {
      setCss((prev) => (prev.w === f.cssWidth && prev.h === f.cssHeight ? prev : { w: f.cssWidth, h: f.cssHeight }))
    })
    const unsubGone = window.operator.onPreviewCdpDetached?.((reason) => {
      setAttachedId(null)
      if (reason !== 'switching') setError(`Disconnected: ${reason}.`)
    })
    return () => { unsubFrame?.(); unsubGone?.() }
  }, [])

  const attach = useCallback((targetId: string) => {
    if (!terminalId || !window.operator.previewCdpAttach) return
    setError(null)
    void window.operator.previewCdpAttach(terminalId, targetId).then((r) => {
      if (r.ok) setAttachedId(targetId)
      else { setAttachedId(null); setError(r.error) }
    })
  }, [terminalId])

  const detach = useCallback(() => {
    window.operator.previewCdpDetach?.()
    setAttachedId(null)
    setCss({ w: 0, h: 0 })
  }, [])

  // Leaving the source, or the lane, lets go of the app.
  useEffect(() => { if (!enabled && attachedId) detach() }, [enabled, attachedId, detach])
  useEffect(() => () => { window.operator.previewCdpDetach?.() }, [terminalId])

  // A window that closed is no longer attachable; one that is the only window is attached at once.
  useEffect(() => {
    if (!enabled || !port) return
    if (attachedId && !targets.some((t) => t.id === attachedId)) { setAttachedId(null); return }
    if (!attachedId && targets.length === 1 && !error) attach(targets[0].id)
  }, [enabled, port, targets, attachedId, error, attach])

  return { port, targets, attachedId, error, css, attach, detach }
}

const segBtn = (on: boolean): React.CSSProperties => ({
  height: 20, padding: '0 8px', border: 'none', borderRadius: 5, cursor: 'pointer', outline: 'none',
  fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 600,
  background: on ? 'var(--overlay-subtle)' : 'transparent', color: on ? 'var(--accent)' : 'var(--fg-muted)',
})

/** Web dev server or Electron app, and which app window. Shown only for a lane with a CDP port. */
export function ElectronSourceControls({ state, source, onSource }: {
  state: PreviewElectronState
  source: 'web' | 'electron'
  onSource: (s: 'web' | 'electron') => void
}) {
  if (state.port == null) return null
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
      <span style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 6, padding: 1 }}>
        <button onClick={() => onSource('web')} style={segBtn(source === 'web')} title="The lane's web dev server">Web</button>
        <button onClick={() => onSource('electron')} style={segBtn(source === 'electron')}
                title={`The lane's running Electron app, on debugging port ${state.port}`}>Electron app</button>
      </span>
      {source === 'electron' && state.targets.length > 1 && (
        <select
          value={state.attachedId ?? ''}
          onChange={(e) => { if (e.target.value) state.attach(e.target.value) }}
          title="Which window of the app"
          style={{
            maxWidth: 180, fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--fg)',
            background: 'transparent', border: '1px solid var(--border)', borderRadius: 5, padding: '1px 4px', outline: 'none',
          }}
        >
          <option value="">Choose a window…</option>
          {state.targets.map((t) => <option key={t.id} value={t.id}>{t.title || t.url}</option>)}
        </select>
      )}
    </span>
  )
}

/** Shown in the stage area while the Electron source is chosen but nothing is attached. */
export function ElectronEmptyState({ state }: { state: PreviewElectronState }) {
  const port = state.port
  return (
    <div style={{ padding: '24px 20px', fontSize: 12, lineHeight: 1.6, color: 'var(--fg-muted)', maxWidth: 520 }}>
      {state.error && <p style={{ margin: '0 0 10px', color: 'var(--fg)' }}>{state.error}</p>}
      {state.targets.length > 1
        ? <p style={{ margin: 0 }}>Choose one of the app's windows in the bar above.</p>
        : (
          <>
            <p style={{ margin: '0 0 8px' }}>
              No Electron app is answering on port {port}. Start the app with remote debugging on that port.
              In its main process, before <code style={{ fontFamily: 'var(--font-mono)' }}>app</code> is ready:
            </p>
            <pre style={{ margin: '0 0 8px', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'var(--font-mono)', fontSize: 11, whiteSpace: 'pre-wrap', color: 'var(--fg)' }}>
              {"if (process.env.OPERATOR_CDP_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.OPERATOR_CDP_PORT)"}
            </pre>
            <p style={{ margin: 0 }}>
              Or run Electron with <code style={{ fontFamily: 'var(--font-mono)' }}>--remote-debugging-port={port}</code>.
              The lane's agent was told the same thing.
            </p>
          </>
        )}
    </div>
  )
}

/** The attached window's frames, drawn at their device pixels and shown at `width`×`height`, with
 *  mouse, wheel and keys forwarded in the page's CSS px. */
export function PreviewElectronCanvas({ width, height, scale, interactive }: {
  width: number
  height: number
  scale: number
  /** False while Annotate owns the pointer (its layer sits above and takes the clicks anyway). */
  interactive: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let latest = 0
    return window.operator.onPreviewCdpFrame?.((f) => {
      const seq = ++latest
      const img = new Image()
      img.onload = () => {
        const c = canvasRef.current
        if (!c || seq !== latest) return
        if (c.width !== img.naturalWidth || c.height !== img.naturalHeight) { c.width = img.naturalWidth; c.height = img.naturalHeight }
        c.getContext('2d')?.drawImage(img, 0, 0)
      }
      img.src = `data:image/jpeg;base64,${f.data}`
    })
  }, [])

  const send = window.operator.previewCdpInput
  const at = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect()
    return toPage(e.clientX - r.left, e.clientY - r.top, scale)
  }
  const mouse = (type: 'mousePressed' | 'mouseReleased' | 'mouseMoved') => (e: React.MouseEvent) => {
    if (!interactive || !send) return
    if (type === 'mousePressed') canvasRef.current?.focus()
    const p = at(e)
    send({ kind: 'mouse', type, x: p.x, y: p.y, button: type === 'mouseMoved' ? 'none' : cdpButton(e.button), clickCount: type === 'mouseMoved' ? 0 : e.detail || 1, modifiers: cdpModifiers(e) })
  }
  return (
    <canvas
      ref={canvasRef}
      tabIndex={0}
      aria-label="Electron app preview"
      onMouseDown={mouse('mousePressed')}
      onMouseUp={mouse('mouseReleased')}
      onMouseMove={mouse('mouseMoved')}
      onContextMenu={(e) => e.preventDefault()}
      onWheel={(e) => {
        if (!interactive || !send) return
        const p = at(e)
        send({ kind: 'wheel', x: p.x, y: p.y, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: cdpModifiers(e) })
      }}
      onKeyDown={(e) => {
        // ⌘ combinations stay Operator's (⌘K, ⌘E, ⌘'), as they do while a web preview has focus.
        if (!interactive || !send || e.metaKey) return
        e.preventDefault()
        send(keyInput(e, 'keyDown'))
      }}
      onKeyUp={(e) => {
        if (!interactive || !send || e.metaKey) return
        e.preventDefault()
        send(keyInput(e, 'keyUp'))
      }}
      style={{ display: 'block', width, height, outline: 'none', cursor: 'default' }}
    />
  )
}
