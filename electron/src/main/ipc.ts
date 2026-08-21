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
import { buildArgs } from '../../../src/renderer/lib/launch-args'
import { channel, eventChannel, SPEC, type ApiMethod } from '../shared/operator-api'
import type { EventMethod, EventPayload, InvokeHandlers, SendHandlers } from '../shared/ipc-contract'
import type { TerminalManager } from './terminals'
import type { Transcript } from './transcript'
import type { ChatStore, ArtifactStore } from './chat-store'
import type { QuitGuard } from './quit'
import * as store from './store'
import * as prefs from './folder-prefs'
import * as agents from './agents'
import * as wt from './worktree'
import * as moodboard from './moodboard'
import { fetchPlanLimits } from './plan-limits'
import { computeUsage, computeInsights } from './usage'
import { checkUpdate, installUpdate } from './updater'
import { previewApi } from './preview-inspect'

export function broadcast<K extends EventMethod>(win: BrowserWindow, method: K, ...payload: EventPayload<K>): void {
  if (!win.isDestroyed()) win.webContents.send(eventChannel(method), ...payload)
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
}

export interface Deps {
  terminals: TerminalManager
  transcript: Transcript
  chat: ChatStore
  artifacts: ArtifactStore
  quit: QuitGuard
  getWindow: () => BrowserWindow | null
}

export function registerIpc(d: Deps): void {
  const invoke: InvokeHandlers = {
    // --- terminals ---------------------------------------------------------------------
    // Composes the launch exactly as `operator-bridge.ts` does, except that the folder picker,
    // the session uuid and `buildArgs` all run HERE. The renderer-only inputs — the tui pref
    // (localStorage) and the terminal's resolved theme colours (CSS custom properties) — ride
    // in `launchOptions`, already the opaque bag the Tauri bridge reads its own keys out of.
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
      const spawned = d.terminals.spawn({
        cwd: target,
        args: buildArgs(o, sessionId),
        sessionId,
        tuiMode: o.tuiMode === 'fullscreen' ? 'fullscreen' : 'default',
        colorScheme: o.colorScheme === 'light' ? 'light' : 'dark',
        orchestrationNote: (o.orchestrationNote as string) ?? null,
      })
      // Register BEFORE returning: the tailer must be watching before Claude's first line
      // lands, or the opening turn is read only on the next poll — or not at all if the pane
      // reloads first.
      d.transcript.register(spawned.terminalId, {
        claudeSessionId: sessionId,
        cwd: target,
        permissionMode: (o.permissionMode as string) ?? null,
        projectId: (o.projectId as string) ?? '',
      })
      return spawned
    },
    terminalKill: async (id) => { d.terminals.kill(id) },
    terminalList: async () => d.terminals.list().map((t) => ({ ...t, ...(d.transcript.identity(t.id) ?? {}) })),
    terminalHistory: async (id) => d.terminals.history(id),
    shellSpawn: async (cwd) => d.terminals.spawnShell(cwd),
    getDevPorts: async () => d.terminals.devPorts(),
    sessionPorts: async (id) => d.terminals.sessionPorts(id),

    // --- sessions, chat, artifacts -----------------------------------------------------
    getSessions: async () => d.transcript.sessions(),
    chatHistory: async (sessionId) => d.chat.load(sessionId),
    projectReplies: async (projectId) => d.chat.replies(projectId),
    artifactReports: async (limit) => d.artifacts.listReports(limit ?? 50),
    artifactPendingStatus: async () => d.artifacts.pendingStatus(),
    artifactAckStatus: async (ids) => { d.artifacts.markApplied(ids) },

    // --- folder prefs / agents / mcp ---------------------------------------------------
    folderPrefsLoad: (projectPath) => prefs.loadFolder(projectPath),
    folderPrefsLoadGlobal: () => prefs.loadGlobal(),
    folderPrefsSaveSettings: (path, settings) => prefs.saveSettings(path, settings),
    folderPrefsSaveMd: (path, content) => prefs.saveMd(path, content),
    folderPrefsCreateFile: (path, type) => prefs.createFile(path, type),
    getMcpServers: (projectPath) => prefs.getMcpServers(projectPath),
    agentsList: (projectPath) => agents.listAgents(projectPath),
    agentSave: (def, originalPath) => agents.saveAgent(def, originalPath),
    agentDelete: (path) => agents.deleteAgent(path),

    // --- worktrees ---------------------------------------------------------------------
    inspectRepo: (cwd) => wt.inspectRepo(cwd),
    worktreeCreate: async (cwd, branch, laneId) => {
      try { return await wt.createWorktree(cwd, branch, laneId) } catch (e) { return { error: String(e) } }
    },
    worktreeStatus: (path) => wt.worktreeStatus(path),
    pathExists: (path) => wt.pathExists(path),
    worktreeRemove: async (path, sourceRoot) => {
      try { await wt.removeWorktree(path, sourceRoot); return { ok: true } } catch (e) { return { ok: false, error: String(e) } }
    },
    worktreeDiff: (path, base) => wt.worktreeDiff(path, base),
    branchDiff: (sourceRoot, branch, baseBranch) => wt.branchDiff(sourceRoot, branch, baseBranch),
    runCheck: (cwd, command) => wt.runCheck(cwd, command),
    worktreeCommit: async (path, message) => {
      try { return { ok: true, sha: await wt.commitAll(path, message) } } catch (e) { return { ok: false, error: String(e) } }
    },
    worktreeMerge: (worktreePath, sourceRoot, branch, baseBranch) => wt.mergeBranch(worktreePath, sourceRoot, branch, baseBranch),
    worktreeDiscard: async (worktreePath, sourceRoot, branch) => {
      try { await wt.discardBranch(worktreePath, sourceRoot, branch); return { ok: true } } catch (e) { return { ok: false, error: String(e) } }
    },
    projectIdentity: async (path) => {
      const missing = !(await wt.pathExists(path))
      if (missing) return { dirty: 0, missing: true }
      const info = await wt.worktreeStatus(path)
      return { branch: info.branch, dirty: info.changes, missing: false }
    },

    // --- durable stores ----------------------------------------------------------------
    loadSessions: () => store.loadSessions(),
    loadProjects: () => store.loadProjects(),
    loadRoleDefaults: () => store.loadRoleDefaults(),
    backupProjects: (stamp) => store.backupProjects(stamp),
    planLimits: (force) => fetchPlanLimits(force ?? false),

    // --- project assets ----------------------------------------------------------------
    operatorHome: async () => store.operatorDir(),
    previewInspectOpen: async (url, x, y, w, h) => { previewApi.open(url, x, y, w, h) },
    projectAssetDir: (id) => moodboard.projectAssetDir(id),
    moodboardAdd: (id, dataB64, ext) => moodboard.moodboardAdd(id, dataB64, ext),
    moodboardList: (id) => moodboard.moodboardList(id),
    moodboardImage: (id, name) => moodboard.moodboardImage(id, name),
    moodboardRemove: (id, name) => moodboard.moodboardRemove(id, name),

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
    // THE APP'S version, not Electron's. `app.getVersion()` reads the running bundle's
    // Info.plist — right when packaged, but under `electron .` it is Electron's own and the
    // gallery showed "v43.4.1". The SHELL's package.json is the source, and it is what the
    // packager stamps into Info.plist, so dev and packaged agree. (Reading the repo root
    // instead would report the Tauri app's version, which is a different number.)
    getUsageStats: (days) => computeUsage(days ?? 0),
    getUsageInsights: (days) => computeInsights(days ?? 0),
    checkUpdate: () => checkUpdate(),
    installUpdate: () => installUpdate(),
    getVersion: async () => {
      try {
        const pkg = JSON.parse(await readFile(join(__dirname, '..', '..', 'package.json'), 'utf8'))
        if (typeof pkg.version === 'string') return pkg.version
      } catch { /* packaged: fall through to the bundle's own version */ }
      return app.getVersion()
    },
  }

  const send: SendHandlers = {
    terminalStart: (id, cols, rows) => d.terminals.start(id, cols, rows),
    terminalWrite: (id, data) => d.terminals.write(id, data),
    terminalResize: (id, cols, rows) => d.terminals.resize(id, cols, rows),
    noteSessionPort: (id, port) => d.terminals.noteSessionPort(id, port),
    saveSessions: (sessions) => { void store.saveSessions(sessions) },
    saveProjects: (projects) => { void store.saveProjects(projects) },
    saveRoleDefaults: (defaults) => { void store.saveRoleDefaults(defaults) },
    setActiveSession: () => {},
    openExternal: (url) => { if (/^https?:\/\//i.test(url)) void shell.openExternal(url) },
    showMainWindow: () => { d.getWindow()?.show() },
    quitApp: () => { app.quit() },
    quitDialogShown: () => d.quit.dialogShown(),
    quitDecision: (quit) => d.quit.decide(quit),
    quitSetAsk: (ask) => d.quit.setAsk(ask),
    toggleWindowMaximize: () => {
      const w = d.getWindow()
      if (!w) return
      if (w.isMaximized()) w.unmaximize()
      else w.maximize()
    },
    growWindowWidth: (delta) => {
      const w = d.getWindow()
      if (!w || w.isMaximized()) return
      const b = w.getBounds()
      w.setBounds({ ...b, width: Math.max(720, Math.round(b.width + delta)) })
    },
    // NO PROGRAMMATIC WINDOW DRAG EXISTS IN ELECTRON. Tauri's `startDragging()` has no
    // counterpart: a custom title bar is dragged with the CSS `-webkit-app-region: drag`, which
    // lives on the element — i.e. inside `src/renderer`. It is the one place where the
    // renderer's contract does not map onto Electron. See PORT-LEDGER.md.
    previewInspectMove: (x, y, w, h) => previewApi.move(x, y, w, h),
    previewInspectClose: () => previewApi.close(),
    startWindowDrag: () => {},
    setDockIcon: (variant) => {
      if (process.platform !== 'darwin' || !app.dock) return
      const icon = join(__dirname, '..', '..', '..', 'src-tauri', 'icons', variant === 'light' ? 'icon.png' : 'icon.png')
      const img = nativeImage.createFromPath(icon)
      if (!img.isEmpty()) app.dock.setIcon(img)
    },
    // Chromium's own unresponsive/responsive events are the equivalent of the Rust stall
    // watchdog and belong in the shell, not on this channel. Accepted and dropped so the
    // renderer's 1/s call is not an unhandled-channel warning every second.
    rendererHeartbeat: () => {},
  }

  for (const [method, handler] of Object.entries(invoke) as Array<[ApiMethod, (...a: unknown[]) => unknown]>) {
    ipcMain.handle(channel(method), (_e, ...args) => handler(...args))
  }
  for (const [method, handler] of Object.entries(send) as Array<[ApiMethod, (...a: unknown[]) => void]>) {
    ipcMain.on(channel(method), (_e, ...args) => handler(...args))
  }

  // The ledger is not decoration: assert at boot that every method SPEC calls `native` is
  // actually registered. A method marked native with no handler is the exact bug this typed
  // layer exists to prevent, and it is the one thing the types cannot catch (the handler maps
  // are Partial by design).
  const registered = new Set<string>([...Object.keys(invoke), ...Object.keys(send)])
  const missing = (Object.keys(SPEC) as ApiMethod[]).filter(
    (m) => SPEC[m].impl === 'native' && SPEC[m].delivery !== 'event' && SPEC[m].delivery !== 'local' && !registered.has(m),
  )
  if (missing.length) console.error('[shell] SPEC says native but no handler is registered:', missing.join(', '))
  else console.error(`[shell] ${registered.size} native IPC handlers registered; ${(Object.keys(SPEC) as ApiMethod[]).filter((m) => SPEC[m].impl === 'mock').length} methods still on the mock`)
}
