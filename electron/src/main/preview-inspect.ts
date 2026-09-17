// The preview inspector, redlines and the layout grid, drawn INSIDE the Preview's own <iframe>.
// Mirrors `preview_inspect_open/move/close` in `lib.rs` by API; the Tauri shell still uses a
// native webview.
//
// NO SECOND PAGE. Until 2026-09-17 this created a WebContentsView over the stage and loaded the
// preview URL into it whenever Inspect or Redlines turned on (AppPreviewPanel `nativeHost`). That
// was a second copy of the app: the iframe the user had been using stayed underneath, and the view
// started again from the URL Operator had loaded. Toggling Redlines therefore reset the app's
// in-app route, its state and its scroll position, and laid the page out under device emulation
// (`screen.width` became the viewport, heights rounded differently). That was the reported
// "turning Redlines on changes the layout" (dev/results/redlines-layout-shift-2026-09-17.md,
// `probes/preview-host-parity.cjs`).
//
// The renderer cannot reach into the cross-origin iframe, but the main process can: the iframe is
// a frame of the main window's webContents, and `WebFrameMain.executeJavaScript` runs in it. So the
// same scripts (`src/shared/preview-inspector.js`, `src/shared/preview-overlay.js`) are injected
// into the page the user is already looking at, and switching an overlay only reconfigures them.
// The renderer scales the iframe with a CSS transform, which the scripts already account for with
// `scale`, exactly as they did for the emulated view.
//
// Picks and the redline anchor come back through `window.parent.postMessage`, which the renderer
// accepts only from its own preview iframe (AppPreviewPanel). The main window's preload also runs
// in this frame (badge block) and exposes nothing to it; that stays true.
import { BrowserWindow, webFrameMain, type WebFrameMain } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PreviewOverlayConfig } from '../../../src/shared/types'
import { PREVIEW_BRIDGE_JS, PREVIEW_FRAME_NAME } from '../../../src/shared/preview-frame'
import { OVERLAY_FNS_JS } from './overlay-fns'

/** A script from `src/shared`, read once at module load so a failure is loud at boot, not on
 *  first use. */
function readShared(file: string): string {
  const candidates = [
    // Packaged and dev alike: `build:main` copies it beside the bundles.
    join(__dirname, '..', file),
    // Running straight from the repo without a build step.
    join(__dirname, '..', '..', '..', 'src', 'shared', file),
  ]
  for (const p of candidates) {
    try { return readFileSync(p, 'utf8') } catch { /* try the next */ }
  }
  console.error(`[inspector] ${file} not found; the inspector will be inert`)
  return ''
}

const INSPECTOR_JS = readShared('preview-inspector.js')
const OVERLAY_JS = readShared('preview-overlay.js')

/** Every overlay off: what `close` leaves in the page instead of unloading it. */
export function overlaysOff(config: PreviewOverlayConfig | null): PreviewOverlayConfig | null {
  return config ? { ...config, inspect: false, redlines: false, grid: null } : null
}

/** The preview iframe among a window's frames: a DIRECT child of the top frame, with our name.
 *  Anything nested inside the previewed app (its own iframes) never matches. */
export function isPreviewFrame(frame: { name: string; parent: unknown } | null | undefined, top: unknown): boolean {
  return !!frame && frame.parent === top && frame.name === PREVIEW_FRAME_NAME
}

/** The renderer's latest overlay configuration, applied again after every load of the page. */
let config: PreviewOverlayConfig | null = null
/** Whether the renderer has the overlays open (Inspect or Redlines). Off, the page is left alone. */
let active = false

export function installPreviewInspect(
  getWindow: () => BrowserWindow | null,
  onAnchor: (anchored: boolean) => void,
): void {
  const previewFrame = (): WebFrameMain | undefined => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return undefined
    const top = win.webContents.mainFrame
    return top.frames.find((f) => isPreviewFrame(f, top))
  }

  /** Put the scripts in the page (each guards against running twice) and apply the configuration. */
  const inject = (frame: WebFrameMain) => {
    if (!config) return
    const script = INSPECTOR_JS + PREVIEW_BRIDGE_JS + OVERLAY_FNS_JS + OVERLAY_JS
      + `\n;window.__operatorOverlay && window.__operatorOverlay.configure(${JSON.stringify(config)});`
    void frame.executeJavaScript(script).catch(() => { /* mid-navigation: did-frame-finish-load injects again */ })
  }

  const apply = () => {
    const frame = previewFrame()
    if (frame && config) inject(frame)
  }

  let watched: BrowserWindow | null = null
  const watch = () => {
    const win = getWindow()
    if (!win || win === watched) return
    watched = win
    // The page navigated or reloaded (HMR full reload, a link, the ⟳ button): a new document has
    // none of the scripts and no anchor.
    win.webContents.on('did-frame-finish-load', (_e, isMainFrame, processId, routingId) => {
      if (isMainFrame || !active) return
      const frame = webFrameMain.fromId(processId, routingId)
      if (!isPreviewFrame(frame, win.webContents.mainFrame)) return
      onAnchor(false)
      inject(frame!)
    })
  }

  // The page is loaded by the renderer's iframe; `url` and the rect are the native-view API's and
  // are not needed here.
  const open = () => {
    watch()
    active = true
    apply()
  }

  const close = () => {
    active = false
    const off = overlaysOff(config)
    config = null
    onAnchor(false)
    const frame = previewFrame()
    if (frame && off) {
      void frame.executeJavaScript(`window.__operatorOverlay && window.__operatorOverlay.configure(${JSON.stringify(off)})`)
        .catch(() => { /* page gone */ })
    }
  }

  const configure = (next: PreviewOverlayConfig) => {
    config = next
    if (active) apply()
  }

  const clearAnchor = () => {
    void previewFrame()?.executeJavaScript('window.__operatorOverlay && window.__operatorOverlay.clearAnchor()')
      .catch(() => { /* no page to clear */ })
  }

  // SCREENSHOTS for Inspect notes (preview-shot-capture.ts) are taken from the main window over the
  // stage, like Annotate's. The hover outline lives in the page, so it is hidden first; the crop's own
  // outline is drawn into the image afterwards.
  const hideOutline = async () => {
    await previewFrame()?.executeJavaScript('window.__operatorInspector && window.__operatorInspector.hide && window.__operatorInspector.hide()')
      .catch(() => { /* no page */ })
  }

  // The iframe moves and hides with the renderer's DOM, so these have nothing to do.
  previewApi = { open, move: () => {}, close, setVisible: () => {}, configure, clearAnchor, hideOutline }
}

export let previewApi: {
  open: (url: string, x: number, y: number, w: number, h: number) => void
  move: (x: number, y: number, w: number, h: number) => void
  close: () => void
  setVisible: (visible: boolean) => void
  configure: (config: PreviewOverlayConfig) => void
  clearAnchor: () => void
  hideOutline: () => Promise<void>
} = { open: () => {}, move: () => {}, close: () => {}, setVisible: () => {}, configure: () => {}, clearAnchor: () => {}, hideOutline: async () => {} }
