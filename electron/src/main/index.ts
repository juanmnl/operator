// Main process — lifecycle, the window, the navigation guards, and the MCP branch.
//
// Written as the shell we would KEEP, not scaffolding: context isolation on, sandbox on, node
// integration off, and every way a webview can be talked into leaving the app closed off
// explicitly. That last part is not hygiene theatre — Operator has already lost a window to it
// (2026-08-14: a stray Finder drop navigated the WKWebView to `file:///…/image.png`, and
// closing the resulting window killed every lane's pty).
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { TerminalManager } from './terminals'
import { Transcript, type DispatchEvent, type ReplyEvent } from './transcript'
import type { AgentSession, NarrationEntry } from '../../../src/shared/types'
import { ChatStore, ArtifactStore } from './chat-store'
import { QuitGuard, isBusy } from './quit'
import { registerIpc, broadcast } from './ipc'
import { startBench } from './bench'
import { serve as serveMcp } from './mcp-serve'
import { isAllowedNavigation } from './navigation'
import { installPreviewInspect } from './preview-inspect'
import { createTray, type OperatorTray } from './tray'
import { reapOrphanedDevServers } from './reap'
import { releaseLeasesOf } from './leases'
import { loadSessions } from './store'
import { aggregateState, buildDots, frameImage, startTrayAnimation, type TrayPhase } from './tray-anim'

// Bundled to CJS (node-pty is a native CJS addon and a sandboxed preload has no ESM loader),
// so `__dirname` is the real thing here — `import.meta.url` compiles to an empty string.
const here = __dirname

/** The dev server the renderer is served from. Operator reserves a port per worktree, so this
 *  is passed in rather than hardcoded — a spike that squats 1420 fights the real app. */
const DEV_URL = process.env.OPERATOR_ELECTRON_URL ?? null

let mainWindow: BrowserWindow | null = null
let terminals: TerminalManager | null = null
let transcript: Transcript | null = null
let chat: ChatStore | null = null
let artifacts: ArtifactStore | null = null
let tray: OperatorTray | null = null
let trayPhase: TrayPhase = 'idle'
let stopTrayAnim: (() => void) | null = null

/** The ONLY origins this app may navigate to. Anything else — a dropped file, a link the
 *  renderer mishandled, a redirect — is refused and, if it looks like a real web URL, handed to
 *  the system browser instead. The decision itself lives in `navigation.ts` so it is testable
 *  without a window. */
const allowNavigation = (url: string) => isAllowedNavigation(url, DEV_URL, join(here, '..', 'renderer'))

function installNavigationGuards(win: BrowserWindow): void {
  const wc = win.webContents

  // THE DROP BACKSTOP. A file dropped on a webview is a navigation, and the default answer is
  // "yes". Prevented here even though the preload also cancels the drop event: the renderer is
  // the layer that can be mid-reload, crashed, or not listening yet, and this is the layer that
  // cannot.
  wc.on('will-navigate', (e, url) => {
    if (allowNavigation(url)) return
    e.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
  // Same guard, the redirect path — `will-navigate` does not fire for a server-side redirect.
  wc.on('will-redirect', (e, url) => { if (!allowNavigation(url)) e.preventDefault() })
  // `window.open` / target=_blank: never a new Electron window, always the system browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // No <webview> tags. Nothing uses one, and an open door means a future preview surface can
  // quietly get node access.
  wc.on('will-attach-webview', (_e, webPreferences) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
  })
  wc.on('render-process-gone', (_e, details) => {
    console.error('[shell] renderer gone:', details.reason, details.exitCode)
  })
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 720,
    // TAURI PARITY, and it is the traffic lights that decide it. `tauri.conf.json` asks for
    // `titleBarStyle: "Overlay"` + `hiddenTitle` — a standard titled window with a transparent,
    // full-size content view, buttons where AppKit puts them. Electron's equivalent is `hidden`;
    // `hiddenInset` is the TOOLBAR variant, which enlarges the buttons and spreads them (measured
    // on the packaged 0.17.0: ~13pt lights on 23pt centres, 23.75pt below the top edge, against
    // the standard 12pt on 20pt centres), and the explicit `trafficLightPosition` that used to
    // sit here only moved that wrong geometry around.
    titleBarStyle: 'hidden',
    show: false, // the renderer calls showMainWindow(), exactly as it does under Tauri
    backgroundColor: '#0b0d10',
    webPreferences: {
      preload: join(here, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      // A background Chromium renderer is throttled to ~1fps with coalesced timers. Operator's
      // whole premise is that a lane you are not looking at keeps working.
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

/** How long quit will wait for the lane trees to be reaped before going anyway.
 *
 *  `killAll` reaps concurrently and its own grace period is 1.5s, so the honest worst case is a
 *  little over that. This ceiling exists because the alternative failure mode is an app that
 *  cannot be quit — and a leaked dev server is a far smaller problem than that. */
const TEARDOWN_DEADLINE_MS = 4000

/** Memoized so every path into quit (`QuitGuard.decide`, the guard's non-asking branches,
 *  `will-quit`) waits on the SAME teardown rather than starting a second one. */
let teardownPromise: Promise<void> | null = null

function teardown(): Promise<void> {
  if (teardownPromise) return teardownPromise
  teardownPromise = (async () => {
    transcript?.stop()
    // AWAITED, and it is why teardown is async at all: `killAll` now reaps each lane's whole
    // process tree, and quit must not race the app's exit against the SIGTERM it just sent to a
    // dev server. Quitting used to leak exactly as much as closing a lane did.
    try {
      await Promise.race([
        terminals?.killAll() ?? Promise.resolve(),
        new Promise<void>((r) => setTimeout(r, TEARDOWN_DEADLINE_MS)),
      ])
      await releaseLeasesOf(process.pid)
    } catch (e) {
      console.error('[shell] teardown reap failed:', e)
    }
    chat?.close()
    artifacts?.close()
    stopTrayAnim?.()
    stopTrayAnim = null
    tray?.destroy()
    tray = null
  })()
  return teardownPromise
}

function boot(): void {
  const win = () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null)

  // BEFORE the first port is handed out. A previous run that crashed or was force-quit leaves
  // its dev servers bound to ports in the same 1420-1520 range this run is about to allocate
  // from, and the collision reaches the user as a lane whose dev server "won't start".
  // Not awaited: it takes up to its own grace period and nothing about opening the window
  // depends on it. It never throws, and it never signals anything it cannot prove is orphaned —
  // see `reapOrphanedDevServers`.
  void reapOrphanedDevServers(loadSessions)

  terminals = new TerminalManager(
    (id, data) => { const w = win(); if (w) broadcast(w, 'onTerminalData', id, data) },
    (id, code, signal) => { const w = win(); if (w) broadcast(w, 'onTerminalExit', id, code, signal) },
  )
  transcript = new Transcript()
  chat = new ChatStore()
  artifacts = new ArtifactStore()

  // The tailer's outputs. `chat` is persisted BEFORE the event goes out, matching the Rust —
  // the frontend's re-read on a reply relies on the row already being there.
  // The tailer assigns the durable seq (it owns the tool-call→result pairing); main just
  // persists what it is handed.
  transcript.on('chat', (sessionId: string, entries: Array<[number, NarrationEntry]>) => {
    chat?.append(sessionId, entries)
  })
  transcript.on('dispatch', (d: DispatchEvent) => { const w = win(); if (w) broadcast(w, 'onOrchestratorDispatch', d) })
  transcript.on('reply', (r: ReplyEvent) => {
    // PERSIST, then emit — the order the Rust guarantees, and what the channel's re-read relies
    // on: the event is a live notification, not the delivery mechanism.
    chat?.appendReply(r.id, r.sessionId, r.projectId, r.to, r.text, r.ts)
    const w = win()
    if (w) broadcast(w, 'onOrchestratorReply', r)
  })
  transcript.on('sessions', (sessions: AgentSession[]) => {
    const w = win()
    if (w) broadcast(w, 'onSessionUpdate', sessions)
    refreshTray()
  })

  transcript.start({
    isAlive: (id) => terminals!.isAlive(id),
    isActive: (id) => terminals!.activeWithin(id, 1500),
  })

  const quit = new QuitGuard(
    () => mainWindow,
    () => transcript!.liveLanes((id) => terminals!.isAlive(id))
      .filter((l) => isBusy(l.phase))
      .map((l) => ({ terminalId: l.terminalId, project: l.project, phase: l.phase })),
    // The idle ones go too, and are counted in one line of the dialog.
    () => transcript!.liveLanes((id) => terminals!.isAlive(id)).filter((l) => !isBusy(l.phase)).length,
    teardown,
  )
  quit.install()

  installPreviewInspect(() => mainWindow, (data) => { const w = win(); if (w) broadcast(w, 'onPreviewPick', data) })
  registerIpc({ terminals, transcript, chat, artifacts, quit, getWindow: () => mainWindow })
  mainWindow = createWindow()

  // The menu bar. AFTER the window, because "Show Operator" shows it — and it is the one way
  // back to a hidden app, so it must never be the thing that failed to start: a tray that
  // throws (no menu bar at all, a display swapped mid-launch) must not take the app with it.
  try {
    tray = createTray({ showWindow, quit: () => app.quit() })
    refreshTray()
    // The icon breathes with the fleet. The animator PULLS `trayPhase` rather than being pushed
    // at, so a missed `sessions` event cannot leave it stuck mid-twinkle.
    const dots = buildDots()
    stopTrayAnim = startTrayAnimation(() => trayPhase, (state, t) => tray?.setImage(frameImage(dots, state, t)))
  } catch (e) {
    console.error('[shell] tray unavailable:', e)
  }
}

/** Show and focus the main window, recreating it if it is gone — the same answer `activate`
 *  gives. Closing the window is not quitting on macOS, and the lanes keep running behind it. */
function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow()
  mainWindow.show()
  mainWindow.focus()
}

/** Relabel the tray from the same lane list the quit guard reads, so the menu and the guard
 *  cannot disagree about what is running. */
function refreshTray(): void {
  if (!tray || !transcript || !terminals) return
  const lanes = transcript.liveLanes((id) => terminals!.isAlive(id))
  tray.refresh(lanes)
  trayPhase = aggregateState(lanes)
}

if (process.argv.includes('--mcp-serve')) {
  // Never open a window, take a lock, or touch the dock on this path.
  try { app.dock?.hide() } catch { /* not on macOS, or too early — neither matters here */ }
  serveMcp()
} else {
  app.whenReady().then(boot)

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow() })

  // Closing the last window must NOT end the app on macOS — and must not end the lanes.
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

  // `before-quit` is also where QuitGuard hangs its veto; this runs after it decides.
  //
  // The quit is HELD OPEN for one pass so the reap can finish. Electron gives `will-quit` no way
  // to await anything, so the shape is: veto once, await the (memoized) teardown, quit again —
  // the second pass finds `tornDown` set and lets the app go. Without the hold, `app.quit()`
  // tears the process down microseconds after the SIGTERM goes out and the dev servers survive
  // the very fix meant to end them.
  let tornDown = false
  app.on('will-quit', (e) => {
    if (tornDown) return
    e.preventDefault()
    void teardown().finally(() => { tornDown = true; app.quit() })
  })

  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
  })

  process.on('unhandledRejection', (r) => { console.error('[shell] unhandled rejection:', r) })
}
