// Preview for Electron apps: a lane's running Electron app, shown and inspected over the Chrome
// DevTools Protocol. Stage 1 of dev/results/native-preview-research-2026-09-17.md.
//
// The app is started with `--remote-debugging-port=<OPERATOR_CDP_PORT>` (preview-cdp-port.ts). Each
// of its windows is a `page` target listed at http://127.0.0.1:<port>/json/list. Preview attaches to
// one and:
//   SHOW     `Page.startScreencast` frames go to the renderer, which draws them in a canvas; mouse,
//            wheel and keys come back through `Input.dispatch*Event`.
//   INSPECT  the SAME scripts the web preview uses (preview-inspector.js, preview-overlay.js) are run
//            in the app's page with `Runtime.evaluate`, and registered with
//            `Page.addScriptToEvaluateOnNewDocument` so a reload keeps them. Picks and the redline
//            anchor come back through a `Runtime.addBinding` function and are handed to the renderer
//            as the same `onPreviewPick` / `onPreviewAnchor` events, so the UI path is shared.
//   SHOTS    a note's crop is `Page.captureScreenshot` with a clip, finished by the web preview's own
//            pipeline (preview-shot-capture.ts `finishShot`).
//   EDIT     the CSS controls' page engine (preview-edit-page.js) is injected with the rest. It talks to
//            its `window.parent`, which in an app's top-level page is the page itself: its state
//            messages are forwarded over the same binding, and commands are posted to the page with
//            `Runtime.evaluate`, which the engine accepts because their source is its parent.
//
// One attached app at a time, like the one Preview panel that shows it.
import { nativeImage } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CdpFrame, CdpInput, CdpShotRequest, CdpTarget, PreviewOverlayConfig, PreviewShot } from '../../../src/shared/types'
import { CdpConnection } from './cdp-client'

export { CdpConnection }
import { OVERLAY_FNS_JS } from './overlay-fns'
import { EDIT_FNS_JS } from './edit-fns'
import { EDIT_CMD_TAG, EDIT_STATE_TAG } from '../../../src/shared/preview-edit'
import { finishShot } from './preview-shot-capture'
import { cropRect, unionRect } from './preview-shots'

/** The binding the page calls with `{ kind, … }` JSON. */
export const CDP_BINDING = '__operatorCdpBridge'

/** Page targets worth offering, from `/json/list`. DevTools windows and service workers are not app
 *  windows. Pure. */
export function parseTargets(list: unknown): Array<CdpTarget & { webSocketDebuggerUrl: string }> {
  if (!Array.isArray(list)) return []
  const out: Array<CdpTarget & { webSocketDebuggerUrl: string }> = []
  for (const t of list) {
    const r = t as Record<string, unknown>
    if (r?.type !== 'page') continue
    if (typeof r.id !== 'string' || typeof r.webSocketDebuggerUrl !== 'string') continue
    const url = typeof r.url === 'string' ? r.url : ''
    if (url.startsWith('devtools://')) continue
    out.push({ id: r.id, title: typeof r.title === 'string' ? r.title : '', url, webSocketDebuggerUrl: r.webSocketDebuggerUrl })
  }
  return out
}

/** The page → Operator bridge for an attached app: the same three functions the iframe bridge
 *  defines (src/shared/preview-frame.ts), calling the CDP binding instead of `postMessage`. */
export const CDP_BRIDGE_JS = `
;(function () {
  var call = function (msg) {
    var b = window[${JSON.stringify(CDP_BINDING)}];
    if (typeof b !== 'function') throw new Error('no Operator binding');
    b(JSON.stringify(msg));
  };
  window.__operatorPickBridge = function (json) { call({ kind: 'pick', data: String(json) }); };
  window.__operatorAnchorBridge = function (value) { try { call({ kind: 'anchor', value: value === true }); } catch (e) {} };
  window.__operatorBeacon = function (data, onOk, onFail) {
    try { window.__operatorPickBridge(JSON.stringify(data)); onOk && onOk() }
    catch (e) { onFail && onFail() }
  };
  // CSS controls: the edit engine posts its state to window.parent, which is this window here.
  // Forwarded once per document, however often the bridge is evaluated.
  if (window.__operatorCdpEditForward) return;
  window.__operatorCdpEditForward = true;
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (ev.source !== window || !d || d[${JSON.stringify(EDIT_STATE_TAG)}] !== 'state' || typeof d.data !== 'string') return;
    try { call({ kind: 'edit', data: d.data }); } catch (e) { /* not attached */ }
  });
})();
`

export type BindingMessage = { kind: 'pick'; data: string } | { kind: 'anchor'; value: boolean } | { kind: 'edit'; data: string }

/** A `Runtime.bindingCalled` event → what it says, or null for any other binding or a malformed
 *  payload. Pure. */
export function routeBinding(params: { name?: unknown; payload?: unknown }): BindingMessage | null {
  if (params.name !== CDP_BINDING || typeof params.payload !== 'string') return null
  let m: Record<string, unknown>
  try { m = JSON.parse(params.payload) } catch { return null }
  if (m?.kind === 'pick' && typeof m.data === 'string') return { kind: 'pick', data: m.data }
  if (m?.kind === 'anchor' && typeof m.value === 'boolean') return { kind: 'anchor', value: m.value }
  if (m?.kind === 'edit' && typeof m.data === 'string') return { kind: 'edit', data: m.data }
  return null
}

/** The expression that delivers a CSS-controls command to the page's edit engine, or null for anything
 *  that is not one. The command is JSON-encoded into the expression, never concatenated. Pure. */
export function editCommandExpression(msg: unknown): string | null {
  if (!msg || typeof msg !== 'object') return null
  if (typeof (msg as Record<string, unknown>)[EDIT_CMD_TAG] !== 'string') return null
  return `window.postMessage(${JSON.stringify(msg)}, '*')`
}

/** The `Input.dispatch*Event` call for one forwarded input. Pure. */
export function inputCommand(ev: CdpInput): { method: string; params: Record<string, unknown> } {
  if (ev.kind === 'mouse') {
    return {
      method: 'Input.dispatchMouseEvent',
      params: { type: ev.type, x: ev.x, y: ev.y, button: ev.button, clickCount: ev.clickCount, modifiers: ev.modifiers },
    }
  }
  if (ev.kind === 'wheel') {
    return { method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: ev.x, y: ev.y, deltaX: ev.deltaX, deltaY: ev.deltaY, modifiers: ev.modifiers } }
  }
  // A printable key is sent as keyDown WITH text, which inserts it; CDP's rawKeyDown would not.
  return {
    method: 'Input.dispatchKeyEvent',
    params: {
      type: ev.type === 'keyDown' ? (ev.text ? 'keyDown' : 'rawKeyDown') : 'keyUp',
      key: ev.key, code: ev.code, text: ev.type === 'keyDown' ? ev.text : undefined,
      windowsVirtualKeyCode: ev.keyCode, nativeVirtualKeyCode: ev.keyCode, modifiers: ev.modifiers,
    },
  }
}

function readShared(file: string): string {
  for (const p of [join(__dirname, '..', file), join(__dirname, '..', '..', '..', 'src', 'shared', file)]) {
    try { return readFileSync(p, 'utf8') } catch { /* next */ }
  }
  console.error(`[preview-cdp] ${file} not found; inspect will be inert`)
  return ''
}

export interface PreviewCdpCallbacks {
  frame: (frame: CdpFrame) => void
  pick: (json: string) => void
  anchor: (anchored: boolean) => void
  /** CSS controls state from the page engine, as the JSON string it posts. */
  edit: (data: string) => void
  /** The app closed, the window went away, or the connection dropped. */
  detached: (reason: string) => void
}

const fetchJson = async (url: string, timeoutMs = 1500): Promise<unknown> => {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/** The app's windows on `port`. Empty when nothing answers (the app is not running, or it was
 *  started without the switch). */
export async function listTargets(port: number): Promise<CdpTarget[]> {
  try {
    return parseTargets(await fetchJson(`http://127.0.0.1:${port}/json/list`)).map(({ id, title, url }) => ({ id, title, url }))
  } catch {
    return []
  }
}

export function createPreviewCdp(cb: PreviewCdpCallbacks) {
  let conn: CdpConnection | null = null
  let attached: { port: number; targetId: string } | null = null
  let config: PreviewOverlayConfig | null = null
  let viewport = { width: 0, height: 0 }
  let scripts: string | null = null
  // The inspector starts ENABLED until it is configured (a shell that never configures it keeps it on),
  // so it is switched off at once: otherwise the first forwarded click opens a compose card and never
  // reaches the app. The renderer's configuration turns it on when Inspect is on.
  const pageScripts = () => (scripts ??= readShared('preview-inspector.js') + CDP_BRIDGE_JS + OVERLAY_FNS_JS + readShared('preview-overlay.js')
    + EDIT_FNS_JS + readShared('preview-edit-page.js')
    + '\n;window.__operatorInspector && window.__operatorInspector.configure({ enabled: false });')

  const evaluate = (expression: string) =>
    conn ? conn.send('Runtime.evaluate', { expression, awaitPromise: false }).catch(() => ({})) : Promise.resolve({})

  const applyConfig = () => {
    if (!config) return Promise.resolve({})
    return evaluate(`window.__operatorOverlay && window.__operatorOverlay.configure(${JSON.stringify(config)})`)
  }

  const detach = (reason = 'detached') => {
    const c = conn
    conn = null
    const was = attached
    attached = null
    config = null
    if (c && !c.closed) {
      void c.send('Page.stopScreencast').catch(() => {})
      c.close()
    }
    if (was) cb.detached(reason)
  }

  const attach = async (port: number, targetId: string): Promise<{ ok: true } | { ok: false; error: string }> => {
    detach('switching')
    let targets
    try { targets = parseTargets(await fetchJson(`http://127.0.0.1:${port}/json/list`)) } catch (e) {
      return { ok: false, error: `Nothing answers on port ${port}. Is the app running with --remote-debugging-port=${port}?` }
    }
    const target = targets.find((t) => t.id === targetId)
    if (!target) return { ok: false, error: 'That window is no longer open.' }
    let c: CdpConnection
    try { c = await CdpConnection.connect(target.webSocketDebuggerUrl) } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    conn = c
    attached = { port, targetId }
    c.onClosed(() => { if (conn === c) detach('the app closed the connection') })
    c.on('Runtime.bindingCalled', (params) => {
      const m = routeBinding(params)
      if (!m) return
      if (m.kind === 'pick') cb.pick(m.data)
      else if (m.kind === 'anchor') cb.anchor(m.value)
      else cb.edit(m.data)
    })
    // A new document: the scripts come from addScriptToEvaluateOnNewDocument; the configuration and
    // the anchor state are this side's to restore.
    c.on('Page.loadEventFired', () => { cb.anchor(false); void applyConfig() })
    c.on('Page.screencastFrame', (params) => {
      const sessionId = params.sessionId
      void c.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
      const meta = (params.metadata ?? {}) as { deviceWidth?: number; deviceHeight?: number }
      if (meta.deviceWidth && meta.deviceHeight) viewport = { width: meta.deviceWidth, height: meta.deviceHeight }
      cb.frame({ data: String(params.data ?? ''), cssWidth: viewport.width, cssHeight: viewport.height })
    })
    c.on('Inspector.detached', () => detach('the window was closed'))
    try {
      await c.send('Page.enable')
      await c.send('Runtime.enable')
      // Keys reach only a focused page, and the app's window is behind Operator's. Focus emulation
      // makes the page behave as focused (caret, focus events, typing) without raising the window.
      await c.send('Emulation.setFocusEmulationEnabled', { enabled: true })
      await c.send('Runtime.addBinding', { name: CDP_BINDING })
      await c.send('Page.addScriptToEvaluateOnNewDocument', { source: pageScripts() })
      await c.send('Runtime.evaluate', { expression: pageScripts() })
      const metrics = await c.send('Page.getLayoutMetrics') as { cssLayoutViewport?: { clientWidth: number; clientHeight: number } }
      if (metrics.cssLayoutViewport) viewport = { width: metrics.cssLayoutViewport.clientWidth, height: metrics.cssLayoutViewport.clientHeight }
      await c.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 })
    } catch (e) {
      detach('setup failed')
      return { ok: false, error: `Could not attach: ${e instanceof Error ? e.message : e}` }
    }
    return { ok: true }
  }

  const configure = (next: PreviewOverlayConfig) => { config = next; void applyConfig() }
  const closeOverlays = () => {
    if (config) void evaluate(`window.__operatorOverlay && window.__operatorOverlay.configure(${JSON.stringify({ ...config, inspect: false, redlines: false, grid: null })})`)
    config = null
    cb.anchor(false)
  }
  const clearAnchor = () => { void evaluate('window.__operatorOverlay && window.__operatorOverlay.clearAnchor()') }
  /** A CSS-controls command for the page's edit engine. Resolves once the page has run it. */
  const editCommand = (msg: unknown): Promise<void> => {
    const expr = editCommandExpression(msg)
    return expr ? evaluate(expr).then(() => undefined) : Promise.resolve()
  }
  /** Resolves when the app has handled the event (CDP answers an input command after dispatch). */
  const input = (ev: CdpInput): Promise<void> => {
    if (!conn) return Promise.resolve()
    const { method, params } = inputCommand(ev)
    return conn.send(method, params).then(() => undefined, () => undefined)
  }

  /** A note's crop: the targets (page CSS px) plus a margin, clamped to the viewport, captured with
   *  `Page.captureScreenshot`. Its clip is in DOCUMENT coordinates, so the viewport's scroll is added. */
  const shot = async (req: CdpShotRequest): Promise<PreviewShot | null> => {
    const c = conn
    if (!c) return null
    try {
      const crop = cropRect(unionRect(req.targets), { w: viewport.width, h: viewport.height }, req.margin)
      if (!crop) return null
      await evaluate('window.__operatorInspector && window.__operatorInspector.hide && window.__operatorInspector.hide()')
      const metrics = await c.send('Page.getLayoutMetrics') as { cssVisualViewport?: { pageX: number; pageY: number } }
      const sx = metrics.cssVisualViewport?.pageX ?? 0
      const sy = metrics.cssVisualViewport?.pageY ?? 0
      const res = await c.send('Page.captureScreenshot', {
        format: 'png', clip: { x: crop.x + sx, y: crop.y + sy, width: crop.w, height: crop.h, scale: 1 },
      }) as { data?: string }
      if (!res.data) return null
      const img = nativeImage.createFromBuffer(Buffer.from(res.data, 'base64'))
      if (img.isEmpty()) return null
      return await finishShot(img, crop, req.targets, req)
    } catch (e) {
      console.error('[preview-cdp] screenshot failed:', e)
      return null
    }
  }

  return {
    listTargets,
    attach,
    detach: () => detach(),
    isAttached: () => !!conn,
    attachedTo: () => attached,
    configure,
    closeOverlays,
    clearAnchor,
    editCommand,
    input,
    shot,
  }
}

export type PreviewCdp = ReturnType<typeof createPreviewCdp>

/** The app's one instance, set at startup (index.ts); null until then. */
export let previewCdp: PreviewCdp | null = null
export function installPreviewCdp(cb: PreviewCdpCallbacks): PreviewCdp {
  previewCdp = createPreviewCdp(cb)
  return previewCdp
}
