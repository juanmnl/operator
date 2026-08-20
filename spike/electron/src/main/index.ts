// Main process — app lifecycle, the window, and the navigation guards.
//
// Written as the shell we would KEEP, not scaffolding: context isolation on, sandbox on,
// node integration off, and every way a webview can be talked into leaving the app closed
// off explicitly. That last part is not hygiene theatre here — Operator has already lost a
// window to it once (2026-08-14: a stray Finder drop navigated the WKWebView to
// `file:///…/image.png`, and closing the resulting window killed every lane's pty).
import { app, BrowserWindow, shell, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { TerminalManager } from './terminals'
import { registerIpc, broadcast } from './ipc'
import { startBench } from './bench'

// Bundled to CJS (node-pty is a native CJS addon, and a sandboxed preload has no ESM loader),
// so `__dirname` is the real thing here — `import.meta.url` compiles to an empty string.
const here = __dirname

/** The dev server the renderer is served from. Operator reserves a port per worktree, so this
 *  is passed in rather than hardcoded — a spike that squats 1420 fights the real app. */
const DEV_URL = process.env.OPERATOR_ELECTRON_URL ?? null

let mainWindow: BrowserWindow | null = null
let terminals: TerminalManager | null = null

/** The ONLY origins this app may navigate to. Anything else — a dropped file, a link the
 *  renderer mishandled, a redirect — is refused and, if it looks like a real web URL, handed
 *  to the system browser instead. */
function isAllowedNavigation(url: string): boolean {
  // Compare ORIGIN, not the prefix: the dev URL carries a page and a query string, and a
  // prefix test would refuse the app's own reload and every other page it serves while
  // happily allowing `http://localhost:1450.evil.test/`.
  if (DEV_URL) {
    try { if (new URL(url).origin === new URL(DEV_URL).origin) return true } catch { return false }
  }
  // Packaged: the renderer is loaded from disk, and `file://` inside our own out/ dir is the
  // app itself. Note this deliberately does NOT allow file:// generally — that is precisely
  // the hole a dropped image walks through.
  const appDir = join(here, '..', 'renderer')
  if (url.startsWith('file://')) {
    try { return fileURLToPath(url).startsWith(appDir) } catch { return false }
  }
  return false
}

function installNavigationGuards(win: BrowserWindow): void {
  const wc = win.webContents

  // THE DROP BACKSTOP. A file dropped on a webview is a navigation, and the default answer is
  // "yes". Prevent it here even though the renderer also cancels the drop event: the renderer
  // is the layer that can be mid-reload, crashed, or simply not listening yet, and this is the
  // layer that cannot.
  wc.on('will-navigate', (e, url) => {
    if (isAllowedNavigation(url)) return
    e.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  // Same guard, the redirect path — `will-navigate` does not fire for a server-side redirect.
  wc.on('will-redirect', (e, url) => {
    if (!isAllowedNavigation(url)) e.preventDefault()
  })

  // `window.open` / target=_blank: never a new Electron window, always the system browser.
  // The renderer's own bridge already routes http(s) through `openExternal`; this is what
  // makes that a policy instead of a convention.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // No <webview> tags. Nothing in the renderer uses one, and leaving the door open means a
  // future preview surface can quietly get node access.
  wc.on('will-attach-webview', (_e, webPreferences) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
  })

  // A crashed renderer must not take the ptys with it silently — surface it, since the whole
  // memory question (M2) is "what does Chromium do when the renderer gets big".
  wc.on('render-process-gone', (_e, details) => {
    console.error('[shell] renderer gone:', details.reason, details.exitCode)
  })
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 720,
    // Matches the Tauri window: overlay title bar, hidden title, custom drag strip in the UI.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 18 },
    // Don't show a white flash before React paints — the renderer calls `showMainWindow()`,
    // exactly as it already does under Tauri.
    show: false,
    backgroundColor: '#0b0d10',
    webPreferences: {
      preload: join(here, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The renderer is our own code; this is the default and is stated so a future edit has
      // to argue with a line rather than an absence.
      webSecurity: true,
      // A background Chromium renderer is throttled to ~1fps and its timers are coalesced.
      // Operator's whole premise is that a lane you are not looking at keeps working, and a
      // throttled one would also invalidate every long-running measurement here.
      backgroundThrottling: false,
    },
  })

  installNavigationGuards(win)
  startBench(win)

  win.on('resize', () => broadcast(win, 'onWindowResize'))
  win.on('closed', () => { mainWindow = null })

  if (DEV_URL) void win.loadURL(DEV_URL)
  else void win.loadFile(join(here, '..', 'renderer', 'index.html'))

  return win
}

app.whenReady().then(() => {
  terminals = new TerminalManager(
    (id, data) => { if (mainWindow && !mainWindow.isDestroyed()) broadcast(mainWindow, 'onTerminalData', id, data) },
    (id, code, signal) => { if (mainWindow && !mainWindow.isDestroyed()) broadcast(mainWindow, 'onTerminalExit', id, code, signal) },
  )
  registerIpc(terminals, () => mainWindow)
  mainWindow = createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

// Closing the last window must NOT end the app on macOS — and, more to the point, must not
// end the lanes. The quit guard that belongs here (ask before quitting while agents are
// working) is NOT ported in this spike; `before-quit` only makes the teardown honest.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  terminals?.killAll()
})

// Nothing in this app should ever be asked to attach a debugger to a remote target or open a
// second renderer we didn't create.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
})

// Surface an unhandled main-process rejection rather than letting it vanish — a silent one
// here reads downstream as "the terminal stopped working for no reason".
process.on('unhandledRejection', (r) => { console.error('[shell] unhandled rejection:', r) })

export { ipcMain }
