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
import { BrowserWindow, WebContentsView, ipcMain } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const INSPECTOR_JS = (() => {
  // Bundled `out/main/` sits two levels under the spike root; the shared script lives in the
  // repo. Read once at module load so a failure is loud at boot, not on first use.
  const candidates = [
    // Packaged and dev alike: `build:main` copies it beside the bundles.
    join(__dirname, '..', 'preview-inspector.js'),
    // Running straight from the repo without a build step.
    join(__dirname, '..', '..', '..', 'src', 'shared', 'preview-inspector.js'),
  ]
  for (const p of candidates) {
    try { return readFileSync(p, 'utf8') } catch { /* try the next */ }
  }
  console.error('[inspector] preview-inspector.js not found; the inspector will be inert')
  return ''
})()

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

export function installPreviewInspect(getWindow: () => BrowserWindow | null, onPick: (data: string) => void): void {
  ipcMain.on('operator-preview:pick', (_e, data: string) => onPick(data))

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
      },
    })
    // The user's dev server is arbitrary local code. It gets no node, no shared context with
    // the app's renderer, and its own navigation is its business — but it must not be able to
    // open windows in our app.
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('did-finish-load', () => {
      void view?.webContents.executeJavaScript(INSPECTOR_JS + BRIDGE_JS).catch((e) => {
        console.error('[inspector] injection failed:', e)
      })
    })
    win.contentView.addChildView(view)
    move(x, y, w, h)
    void view.webContents.loadURL(url)
  }

  const move = (x: number, y: number, w: number, h: number) => {
    view?.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) })
  }

  const close = () => {
    if (!view) return
    const win = getWindow()
    try { win?.contentView.removeChildView(view) } catch { /* window already gone */ }
    // `close()` on the webContents, not just removal: an orphaned view keeps its renderer
    // process, and this one is running someone else's dev server.
    try { view.webContents.close() } catch { /* already closing */ }
    view = null
  }

  previewApi = { open, move, close }
}

export let previewApi: {
  open: (url: string, x: number, y: number, w: number, h: number) => void
  move: (x: number, y: number, w: number, h: number) => void
  close: () => void
} = { open: () => {}, move: () => {}, close: () => {} }
