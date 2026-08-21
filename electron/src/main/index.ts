// Main process — lifecycle, the window, the navigation guards, and the MCP branch.
//
// Written as the shell we would KEEP, not scaffolding: context isolation on, sandbox on, node
// integration off, and every way a webview can be talked into leaving the app closed off
// explicitly. That last part is not hygiene theatre — Operator has already lost a window to it
// (2026-08-14: a stray Finder drop navigated the WKWebView to `file:///…/image.png`, and
// closing the resulting window killed every lane's pty).
import { app, BrowserWindow, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { TerminalManager } from './terminals'
import { Transcript, type DispatchEvent, type ReplyEvent } from './transcript'
import type { AgentSession } from '../../../src/shared/types'
import { ChatStore, ArtifactStore } from './chat-store'
import { QuitGuard } from './quit'
import { registerIpc, broadcast } from './ipc'
import { startBench } from './bench'
import { serve as serveMcp } from './mcp-serve'
import { installPreviewInspect } from './preview-inspect'

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

/** The ONLY origins this app may navigate to. Anything else — a dropped file, a link the
 *  renderer mishandled, a redirect — is refused and, if it looks like a real web URL, handed to
 *  the system browser instead. */
function isAllowedNavigation(url: string): boolean {
  // Compare ORIGIN, not the prefix: the dev URL carries a page and a query string, and a prefix
  // test would refuse the app's own reload while happily allowing
  // `http://localhost:1450.evil.test/`.
  if (DEV_URL) {
    try { if (new URL(url).origin === new URL(DEV_URL).origin) return true } catch { return false }
  }
  // Packaged: `file://` inside our own out/renderer dir is the app itself. This deliberately
  // does NOT allow file:// generally — that is precisely the hole a dropped image walks through.
  const appDir = join(here, '..', 'renderer')
  if (url.startsWith('file://')) {
    try { return fileURLToPath(url).startsWith(appDir) } catch { return false }
  }
  return false
}

function installNavigationGuards(win: BrowserWindow): void {
  const wc = win.webContents

  // THE DROP BACKSTOP. A file dropped on a webview is a navigation, and the default answer is
  // "yes". Prevented here even though the preload also cancels the drop event: the renderer is
  // the layer that can be mid-reload, crashed, or not listening yet, and this is the layer that
  // cannot.
  wc.on('will-navigate', (e, url) => {
    if (isAllowedNavigation(url)) return
    e.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
  // Same guard, the redirect path — `will-navigate` does not fire for a server-side redirect.
  wc.on('will-redirect', (e, url) => { if (!isAllowedNavigation(url)) e.preventDefault() })
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
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 18 },
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

function teardown(): void {
  transcript?.stop()
  terminals?.killAll()
  chat?.close()
  artifacts?.close()
}

function boot(): void {
  const win = () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null)

  terminals = new TerminalManager(
    (id, data) => { const w = win(); if (w) broadcast(w, 'onTerminalData', id, data) },
    (id, code, signal) => { const w = win(); if (w) broadcast(w, 'onTerminalExit', id, code, signal) },
  )
  transcript = new Transcript()
  chat = new ChatStore()
  artifacts = new ArtifactStore()

  // The tailer's outputs. `chat` is persisted BEFORE the event goes out, matching the Rust —
  // the frontend's re-read on a reply relies on the row already being there.
  transcript.on('chat', (sessionId: string, entries: Array<Record<string, unknown>>) => {
    // seq is the store's primary key alongside session_id; the tailer emits entries in order,
    // so a monotonic counter per flush is enough to make the upsert idempotent.
    chat?.append(sessionId, entries.map((e, i) => [seqFor(sessionId, i), e as never]))
  })
  transcript.on('dispatch', (d: DispatchEvent) => { const w = win(); if (w) broadcast(w, 'onOrchestratorDispatch', d) })
  transcript.on('reply', (r: ReplyEvent) => {
    // PERSIST, then emit — the order the Rust guarantees, and what the channel's re-read relies
    // on: the event is a live notification, not the delivery mechanism.
    chat?.appendReply(r.id, r.sessionId, r.projectId, r.to, r.text, r.ts)
    const w = win()
    if (w) broadcast(w, 'onOrchestratorReply', r)
  })
  transcript.on('sessions', (sessions: AgentSession[]) => { const w = win(); if (w) broadcast(w, 'onSessionUpdate', sessions) })

  transcript.start({
    isAlive: (id) => terminals!.isAlive(id),
    isActive: (id) => terminals!.activeWithin(id, 1500),
  })

  const quit = new QuitGuard(
    () => mainWindow,
    () => transcript!.liveLanes((id) => terminals!.isAlive(id))
      .filter((l) => l.phase === 'running' || l.phase === 'compacting')
      .map((l) => ({ terminalId: l.terminalId, project: l.project, phase: l.phase })),
    () => transcript!.liveLanes((id) => terminals!.isAlive(id)).filter((l) => l.phase !== 'running').length,
    teardown,
  )
  quit.install()

  installPreviewInspect(() => mainWindow, (data) => { const w = win(); if (w) broadcast(w, 'onPreviewPick', data) })
  registerIpc({ terminals, transcript, chat, artifacts, quit, getWindow: () => mainWindow })
  mainWindow = createWindow()
}

/** Per-session append counter. The tailer hands us entries in order; the store upserts on
 *  (session_id, seq), so a tool row written at call time and rewritten when its result lands
 *  must reuse its seq. Tracking the count per session gives exactly that as long as the flush
 *  order is stable, which it is — `pending` is a FIFO. */
const seqCounters = new Map<string, number>()
function seqFor(sessionId: string, _i: number): number {
  const n = seqCounters.get(sessionId) ?? 0
  seqCounters.set(sessionId, n + 1)
  return n
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
  app.on('will-quit', teardown)

  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
  })

  process.on('unhandledRejection', (r) => { console.error('[shell] unhandled rejection:', r) })
}
