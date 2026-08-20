// IPC registration — the transport for the contract in ../shared.
//
// Every handler below is checked against the SAME signature `src/renderer/env.d.ts` declares,
// so the compiler is what keeps main and renderer in step. There are no channel-name string
// literals here and no `any` on a payload: both are the usual way an Electron main process
// drifts a quarter-degree from its renderer and nobody notices for a month.
import { BrowserWindow, dialog, ipcMain, shell, app, nativeImage } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { buildArgs } from '../../../../src/renderer/lib/launch-args'
import { channel, eventChannel, SPEC, type ApiMethod } from '../shared/operator-api'
import type { EventMethod, EventPayload, InvokeHandlers, SendHandlers } from '../shared/ipc-contract'
import type { TerminalManager } from './terminals'

/** Push an event to the renderer. Typed off the renderer's own subscription callback, so
 *  `broadcast(win, 'onTerminalData', id)` — one argument short — will not compile. */
export function broadcast<K extends EventMethod>(win: BrowserWindow, method: K, ...payload: EventPayload<K>): void {
  win.webContents.send(eventChannel(method), ...payload)
}

/** MIME types we are willing to inline as a data: URL for `imageDataUrl`. Anything else comes
 *  back empty rather than as a guessed type — the renderer renders this straight into an
 *  <img>, and guessing is how a text file becomes a rendering surface. */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
}

export function registerIpc(terminals: TerminalManager, getWindow: () => BrowserWindow | null): void {
  const invoke: InvokeHandlers = {
    // --- terminals ---------------------------------------------------------------------
    // Composes the launch exactly as `operator-bridge.ts` does, except that the folder
    // picker, the session uuid and `buildArgs` all run HERE. The renderer-only inputs —
    // the tui/renderer pref (localStorage) and the terminal's resolved theme colours (CSS
    // custom properties) — ride in `launchOptions`, which is already the opaque bag the
    // Tauri bridge reads `permissionMode` / `projectId` / `resumeSessionId` out of.
    terminalSpawn: async (cwd, launchOptions) => {
      let target = cwd
      if (!target) {
        const picked = await dialog.showOpenDialog({ properties: ['openDirectory'] })
        if (picked.canceled || !picked.filePaths[0]) return null
        target = picked.filePaths[0]
      }
      const o = launchOptions ?? {}
      const resumeId = o.resumeSessionId
      const sessionId = resumeId ? String(resumeId) : randomUUID()
      return terminals.spawn({
        cwd: target,
        args: buildArgs(o, sessionId),
        sessionId,
        tuiMode: o.tuiMode === 'fullscreen' ? 'fullscreen' : 'default',
        colorScheme: o.colorScheme === 'light' ? 'light' : 'dark',
        orchestrationNote: (o.orchestrationNote as string) ?? null,
      })
    },
    terminalKill: async (id) => { terminals.kill(id) },
    terminalList: async () => terminals.list(),
    terminalHistory: async (id) => terminals.history(id),
    shellSpawn: async (cwd) => terminals.spawnShell(cwd),
    getDevPorts: async () => terminals.devPorts(),

    // --- OS surface --------------------------------------------------------------------
    pickFolder: async () => {
      const picked = await dialog.showOpenDialog({ properties: ['openDirectory'] })
      return picked.canceled ? null : (picked.filePaths[0] ?? null)
    },
    revealPath: async (path) => { shell.showItemInFolder(path) },
    savePastedImage: async (dataB64, ext) => {
      const dir = await mkdtemp(join(tmpdir(), 'operator-paste-'))
      const file = join(dir, `pasted-${Date.now()}.${ext.replace(/^\./, '')}`)
      await writeFile(file, Buffer.from(dataB64, 'base64'))
      return file
    },
    imageDataUrl: async (path) => {
      const mime = IMAGE_MIME[extname(path).toLowerCase()]
      if (!mime) return ''
      try { return `data:${mime};base64,${(await readFile(path)).toString('base64')}` } catch { return '' }
    },
    getVersion: async () => app.getVersion(),
  }

  const send: SendHandlers = {
    terminalStart: (id, cols, rows) => terminals.start(id, cols, rows),
    terminalWrite: (id, data) => terminals.write(id, data),
    terminalResize: (id, cols, rows) => terminals.resize(id, cols, rows),
    openExternal: (url) => { if (/^https?:\/\//i.test(url)) void shell.openExternal(url) },
    showMainWindow: () => { getWindow()?.show() },
    quitApp: () => { app.quit() },
    toggleWindowMaximize: () => {
      const w = getWindow()
      if (!w) return
      if (w.isMaximized()) w.unmaximize()
      else w.maximize()
    },
    growWindowWidth: (delta) => {
      const w = getWindow()
      if (!w || w.isMaximized()) return
      const b = w.getBounds()
      w.setBounds({ ...b, width: Math.max(720, Math.round(b.width + delta)) })
    },
    // NO PROGRAMMATIC WINDOW DRAG EXISTS IN ELECTRON. Tauri's `startDragging()` has no
    // counterpart: a custom title bar is dragged with the CSS `-webkit-app-region: drag`,
    // which lives on the element — i.e. inside `src/renderer`, which this spike may not
    // touch. So the drag strip is inert here, and this is a PORT ITEM, not a stub: see the
    // ledger. It is the only place where the renderer's contract does not map onto Electron.
    startWindowDrag: () => {},
    setDockIcon: (variant) => {
      if (process.platform !== 'darwin' || !app.dock) return
      const icon = join(__dirname, '..', '..', '..', '..', 'src-tauri', 'icons', variant === 'light' ? 'icon.png' : 'icon.png')
      const img = nativeImage.createFromPath(icon)
      if (!img.isEmpty()) app.dock.setIcon(img)
    },
    // The Tauri backend runs a stall watchdog off this ping and recovers the webview when it
    // stops. Not ported — Chromium's own unresponsive/responsive events are the equivalent
    // and belong in the shell, not on this channel. Accepted and dropped so the renderer's
    // 1/s call is not an unhandled-channel warning every second.
    rendererHeartbeat: () => {},
  }

  for (const [method, handler] of Object.entries(invoke) as Array<[ApiMethod, (...a: unknown[]) => unknown]>) {
    ipcMain.handle(channel(method), (_e, ...args) => handler(...args))
  }
  for (const [method, handler] of Object.entries(send) as Array<[ApiMethod, (...a: unknown[]) => void]>) {
    ipcMain.on(channel(method), (_e, ...args) => handler(...args))
  }

  // The ledger is not decoration: assert at boot that every method SPEC calls `native` is
  // actually registered somewhere. A method marked native with no handler is the exact bug
  // this whole typed layer exists to make impossible, and it is the one thing the types
  // cannot catch (the handler maps are Partial by design).
  const registered = new Set<string>([...Object.keys(invoke), ...Object.keys(send)])
  const missing = (Object.keys(SPEC) as ApiMethod[]).filter(
    (m) => SPEC[m].impl === 'native' && SPEC[m].delivery !== 'event' && SPEC[m].delivery !== 'local' && !registered.has(m),
  )
  if (missing.length) console.error('[shell] SPEC says native but no handler is registered:', missing.join(', '))
}
