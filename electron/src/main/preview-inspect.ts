// The preview inspector: an embedded webview on the user's own dev server, with a script
// injected that highlights elements and lets them annotate one. Mirrors
// `preview_inspect_open/move/close` in `lib.rs`.
//
// THE BEACON IS GONE, AND THAT IS THE POINT. Tauri's version can't route command IPC from a
// remote embedded webview — its ACL denies it — so the injected script encodes its payload into
// an `<img src="operatorpick://ipc?d=<base64>">` and Rust registers a custom URI scheme to
// catch it. Electron has no such restriction: a WebContentsView takes a preload, and the
// preload can `ipcRenderer.send` directly. So the whole beacon/custom-scheme/1×1-GIF apparatus
// collapses into one function call, and the script's `beacon()` is redirected onto it.
//
// The script itself is `src/shared/preview-inspector.js` — the SAME file the Rust `include_str!`s,
// so a fix to the inspector lands in both shells.
//
// THE VIEW ALSO HOSTS REDLINES AND THE LAYOUT GRID (Electron only). Nothing the renderer draws can
// paint above this view, so while it is up those are drawn inside the page by
// `src/shared/preview-overlay.js`, configured from the renderer through `configure`. The page is
// zoomed to the stage's scale, so it lays out at the device preset instead of at the stage's
// scaled width.
import { BrowserWindow, WebContentsView, ipcMain } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PreviewOverlayConfig } from '../../../src/shared/types'
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

/** Redirect the shared script's `beacon()` onto real IPC. The script calls
 *  `beacon(data, onOk, onFail)`; under Tauri that is an image request to a custom scheme,
 *  here it is a channel. Appended rather than edited into the file so the file stays exactly
 *  what Rust compiles in. */
const BRIDGE_JS = `
;(function () {
  if (!window.__operatorPickBridge) return;
  window.__operatorBeacon = function (data, onOk, onFail) {
    try { window.__operatorPickBridge(JSON.stringify(data)); onOk && onOk() }
    catch (e) { onFail && onFail() }
  };
})();
`

let view: WebContentsView | null = null
/** The renderer's latest overlay configuration, applied again after every page load. */
let config: PreviewOverlayConfig | null = null
/** Whether a redline anchor is set, as last reported to the renderer. */
let anchored = false

export function installPreviewInspect(
  getWindow: () => BrowserWindow | null,
  onPick: (data: string) => void,
  onAnchor: (anchored: boolean) => void,
): void {
  const setAnchored = (value: boolean) => {
    if (anchored === value) return
    anchored = value
    onAnchor(value)
  }

  ipcMain.on('operator-preview:pick', (_e, data: string) => onPick(data))
  ipcMain.on('operator-preview:anchor', (_e, value: unknown) => setAnchored(value === true))

  /** Push the configuration into the page: the zoom factor first, then the overlay's settings. */
  const apply = () => {
    if (!view || !config) return
    view.webContents.setZoomFactor(config.scale > 0 ? config.scale : 1)
    void view.webContents
      .executeJavaScript(`window.__operatorOverlay && window.__operatorOverlay.configure(${JSON.stringify(config)})`)
      .catch(() => { /* mid-navigation: did-finish-load applies it again */ })
  }

  const open = (url: string, x: number, y: number, w: number, h: number) => {
    const win = getWindow()
    if (!win) throw new Error('no main window')
    if (view) { move(x, y, w, h); return }

    view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '..', 'preload', 'inspector.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        // Loads the (sandboxed) preload in the page's iframes too, for the badge stub. It grants
        // no node access; see preload/inspector.ts.
        nodeIntegrationInSubFrames: true,
      },
    })
    // The user's dev server is arbitrary local code. It gets no node, no shared context with
    // the app's renderer, and its own navigation is its business — but it must not be able to
    // open windows in our app.
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // A new document has no anchor, whatever the previous one had.
    view.webContents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) setAnchored(false)
    })
    view.webContents.on('did-finish-load', () => {
      void view?.webContents.executeJavaScript(INSPECTOR_JS + BRIDGE_JS + OVERLAY_FNS_JS + OVERLAY_JS)
        .then(apply)
        .catch((e) => { console.error('[inspector] injection failed:', e) })
    })
    win.contentView.addChildView(view)
    move(x, y, w, h)
    void view.webContents.loadURL(url)
  }

  const move = (x: number, y: number, w: number, h: number) => {
    view?.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) })
  }

  const close = () => {
    config = null
    setAnchored(false)
    if (!view) return
    const win = getWindow()
    try { win?.contentView.removeChildView(view) } catch { /* window already gone */ }
    // `close()` on the webContents, not just removal: an orphaned view keeps its renderer
    // process, and this one is running someone else's dev server.
    try { view.webContents.close() } catch { /* already closing */ }
    view = null
  }

  // Hidden, not closed. Nothing the renderer draws can paint above this view, including the
  // full-window overlay a side-panel drag relies on for its mousemoves; closing it instead would
  // reload the page and lose whatever the user had done in it.
  const setVisible = (visible: boolean) => {
    view?.setVisible(visible)
  }

  const configure = (next: PreviewOverlayConfig) => {
    config = next
    apply()
  }

  const clearAnchor = () => {
    void view?.webContents
      .executeJavaScript('window.__operatorOverlay && window.__operatorOverlay.clearAnchor()')
      .catch(() => { /* no page to clear */ })
  }

  previewApi = { open, move, close, setVisible, configure, clearAnchor }
}

export let previewApi: {
  open: (url: string, x: number, y: number, w: number, h: number) => void
  move: (x: number, y: number, w: number, h: number) => void
  close: () => void
  setVisible: (visible: boolean) => void
  configure: (config: PreviewOverlayConfig) => void
  clearAnchor: () => void
} = { open: () => {}, move: () => {}, close: () => {}, setVisible: () => {}, configure: () => {}, clearAnchor: () => {} }
