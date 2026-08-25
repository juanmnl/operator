// The `window.operator` seam, mirrored method-for-method — WITHOUT a second copy of it.
//
// `env.d.ts` declares the API as a global (`Window['operator']`), so the whole shape is
// reachable structurally. Re-typing 90 signatures here would create exactly the drift this
// file exists to prevent: the day someone adds a method to the renderer's contract, a hand-
// written mirror keeps compiling and the shell silently lacks it. Deriving it instead makes
// that a TYPE ERROR, in `DELIVERY` below.
//
// Nothing in this file is Electron-specific. It is the contract; `ipc.ts` is the transport.
/// <reference path="../../../src/renderer/env.d.ts" />

export type OperatorApi = Window['operator']
export type ApiMethod = keyof OperatorApi

/** A method's signature with the `?:` optionality stripped — several are declared optional
 *  in env.d.ts (the renderer feature-detects them), but a shell that implements one must
 *  still match its call shape exactly. */
export type Method<K extends ApiMethod> = NonNullable<OperatorApi[K]>

/** How a method crosses the process boundary.
 *
 *  - `invoke` — returns a Promise; one round trip (`ipcMain.handle`).
 *  - `send`   — returns void; fire-and-forget (`ipcMain.on`). Never await one.
 *  - `event`  — `on…(cb) => unsubscribe`; main pushes, the renderer subscribes.
 *  - `local`  — answered inside the renderer/preload, never reaching main. */
export type Delivery = 'invoke' | 'send' | 'event' | 'local'

/** Whether THIS shell answers a method itself, or falls through to `dev/mock-bridge.ts`.
 *  Kept next to the delivery kind on purpose: it is the port ledger (see the M4 table in
 *  the RESULT brief), and a ledger that lives outside the code goes stale in a week. */
export type Impl = 'native' | 'mock'

export interface MethodSpec {
  delivery: Delivery
  impl: Impl
  /** Which Rust module owns it today, so the ledger reads against the Tauri backend. */
  rust?: string
}

/** THE EXHAUSTIVE TABLE. `Record<ApiMethod, …>` is the point: add a method to `env.d.ts`
 *  and this file stops compiling until the shell says what it intends to do about it. */
export const SPEC: Record<ApiMethod, MethodSpec> = {
  // --- terminals: the piece this shell implements FOR REAL ---------------------------
  terminalSpawn:        { delivery: 'invoke', impl: 'native', rust: 'lib.rs' },
  terminalStart:        { delivery: 'send',   impl: 'native', rust: 'lib.rs' },
  terminalWrite:        { delivery: 'send',   impl: 'native', rust: 'lib.rs' },
  terminalResize:       { delivery: 'send',   impl: 'native', rust: 'lib.rs' },
  terminalKill:         { delivery: 'invoke', impl: 'native', rust: 'lib.rs' },
  terminalList:         { delivery: 'invoke', impl: 'native', rust: 'lib.rs' },
  terminalHistory:      { delivery: 'invoke', impl: 'native', rust: 'lib.rs' },
  shellSpawn:           { delivery: 'invoke', impl: 'native', rust: 'lib.rs' },
  onTerminalData:       { delivery: 'event',  impl: 'native', rust: 'lib.rs' },
  onTerminalExit:       { delivery: 'event',  impl: 'native', rust: 'lib.rs' },

  // --- OS/window surface: a few lines each in Electron, so they are real here too -----
  openExternal:         { delivery: 'send',   impl: 'native', rust: 'plugin-opener' },
  revealPath:           { delivery: 'invoke', impl: 'native', rust: 'plugin-opener' },
  pickFolder:           { delivery: 'invoke', impl: 'native', rust: 'plugin-dialog' },
  savePastedImage:      { delivery: 'invoke', impl: 'native', rust: 'lib.rs' },
  imageDataUrl:         { delivery: 'invoke', impl: 'native', rust: 'lib.rs' },
  getVersion:           { delivery: 'invoke', impl: 'native', rust: 'plugin-updater' },
  showMainWindow:       { delivery: 'send',   impl: 'native', rust: 'core' },
  quitApp:              { delivery: 'send',   impl: 'native', rust: 'quit.rs' },
  startWindowDrag:      { delivery: 'send',   impl: 'native', rust: 'core' },
  toggleWindowMaximize: { delivery: 'send',   impl: 'native', rust: 'core' },
  growWindowWidth:      { delivery: 'send',   impl: 'native', rust: 'core' },
  onWindowResize:       { delivery: 'event',  impl: 'native', rust: 'core' },
  onFileDrop:           { delivery: 'local',  impl: 'native', rust: 'core' },
  setDockIcon:          { delivery: 'send',   impl: 'native', rust: 'lib.rs' },
  rendererHeartbeat:    { delivery: 'send',   impl: 'native', rust: 'lib.rs' },

  // --- everything else: the mock answers, and the ledger says what a real port costs ---
  // (see electron/PORT-LEDGER.md for the S/M/L estimates that go with these)
  onSessionUpdate:        { delivery: 'event',  impl: 'native', rust: 'transcript.rs' },
  onOrchestratorDispatch: { delivery: 'event',  impl: 'native', rust: 'transcript.rs' },
  onOrchestratorReply:    { delivery: 'event',  impl: 'native', rust: 'transcript.rs' },
  getSessions:            { delivery: 'invoke', impl: 'native', rust: 'transcript.rs' },
  chatHistory:            { delivery: 'invoke', impl: 'native', rust: 'chatstore.rs' },
  projectReplies:         { delivery: 'invoke', impl: 'native', rust: 'chatstore.rs' },
  setActiveSession:       { delivery: 'send',   impl: 'native', rust: 'transcript.rs' },
  getDevPorts:            { delivery: 'invoke', impl: 'native', rust: 'lib.rs' },
  sessionPorts:           { delivery: 'invoke', impl: 'native', rust: 'lib.rs' },
  noteSessionPort:        { delivery: 'send',   impl: 'native', rust: 'lib.rs' },
  artifactReports:        { delivery: 'invoke', impl: 'native', rust: 'artifacts.rs' },
  artifactPendingStatus:  { delivery: 'invoke', impl: 'native', rust: 'artifacts.rs' },
  artifactAckStatus:      { delivery: 'invoke', impl: 'native', rust: 'artifacts.rs' },
  gridtermAttach:         { delivery: 'send',   impl: 'mock', rust: 'gridterm.rs' },
  gridtermResize:         { delivery: 'send',   impl: 'mock', rust: 'gridterm.rs' },
  gridtermScroll:         { delivery: 'send',   impl: 'mock', rust: 'gridterm.rs' },
  gridtermSetTheme:       { delivery: 'send',   impl: 'mock', rust: 'gridterm.rs' },
  gridtermDetach:         { delivery: 'send',   impl: 'mock', rust: 'gridterm.rs' },
  onGridUpdate:           { delivery: 'event',  impl: 'mock', rust: 'gridterm.rs' },
  onQuitRequested:        { delivery: 'event',  impl: 'native', rust: 'quit.rs' },
  quitDialogShown:        { delivery: 'send',   impl: 'native', rust: 'quit.rs' },
  quitDecision:           { delivery: 'send',   impl: 'native', rust: 'quit.rs' },
  quitSetAsk:             { delivery: 'send',   impl: 'native', rust: 'quit.rs' },
  skillsCatalog:          { delivery: 'invoke', impl: 'native' },
  worktreeReapPlan:       { delivery: 'invoke', impl: 'native' },
  worktreeReap:           { delivery: 'invoke', impl: 'native' },
  folderPrefsLoad:        { delivery: 'invoke', impl: 'native', rust: 'folderprefs.rs' },
  folderPrefsLoadGlobal:  { delivery: 'invoke', impl: 'native', rust: 'folderprefs.rs' },
  folderPrefsSaveSettings:{ delivery: 'invoke', impl: 'native', rust: 'folderprefs.rs' },
  folderPrefsSaveMd:      { delivery: 'invoke', impl: 'native', rust: 'folderprefs.rs' },
  folderPrefsCreateFile:  { delivery: 'invoke', impl: 'native', rust: 'folderprefs.rs' },
  getMcpServers:          { delivery: 'invoke', impl: 'native', rust: 'mcp.rs' },
  inspectRepo:            { delivery: 'invoke', impl: 'native', rust: 'worktree.rs' },
  worktreeCreate:         { delivery: 'invoke', impl: 'native', rust: 'worktree.rs' },
  worktreeStatus:         { delivery: 'invoke', impl: 'native', rust: 'worktree.rs' },
  projectIdentity:        { delivery: 'invoke', impl: 'native', rust: 'worktree.rs' },
  pathExists:             { delivery: 'invoke', impl: 'native', rust: 'lib.rs' },
  worktreeRemove:         { delivery: 'invoke', impl: 'native', rust: 'worktree.rs' },
  worktreeDiff:           { delivery: 'invoke', impl: 'native', rust: 'worktree.rs' },
  branchDiff:             { delivery: 'invoke', impl: 'native', rust: 'worktree.rs' },
  runCheck:               { delivery: 'invoke', impl: 'native', rust: 'worktree.rs' },
  worktreeCommit:         { delivery: 'invoke', impl: 'native', rust: 'worktree.rs' },
  worktreeMerge:          { delivery: 'invoke', impl: 'native', rust: 'worktree.rs' },
  worktreeDiscard:        { delivery: 'invoke', impl: 'native', rust: 'worktree.rs' },
  agentsList:             { delivery: 'invoke', impl: 'native', rust: 'agents.rs' },
  agentSave:              { delivery: 'invoke', impl: 'native', rust: 'agents.rs' },
  agentDelete:            { delivery: 'invoke', impl: 'native', rust: 'agents.rs' },
  getUsageStats:          { delivery: 'invoke', impl: 'native', rust: 'usage.rs' },
  getUsageInsights:       { delivery: 'invoke', impl: 'native', rust: 'usage.rs' },
  saveSessions:           { delivery: 'send',   impl: 'native', rust: 'core.rs' },
  loadSessions:           { delivery: 'invoke', impl: 'native', rust: 'core.rs' },
  saveProjects:           { delivery: 'send',   impl: 'native', rust: 'core.rs' },
  loadProjects:           { delivery: 'invoke', impl: 'native', rust: 'core.rs' },
  saveRoleDefaults:       { delivery: 'send',   impl: 'native', rust: 'core.rs' },
  loadRoleDefaults:       { delivery: 'invoke', impl: 'native', rust: 'core.rs' },
  backupProjects:         { delivery: 'invoke', impl: 'native', rust: 'core.rs' },
  planLimits:             { delivery: 'invoke', impl: 'native', rust: 'planlimits.rs' },
  operatorHome:           { delivery: 'invoke', impl: 'native', rust: 'lib.rs' },
  projectAssetDir:        { delivery: 'invoke', impl: 'native', rust: 'lib.rs' },
  moodboardAdd:           { delivery: 'invoke', impl: 'native', rust: 'lib.rs' },
  moodboardList:          { delivery: 'invoke', impl: 'native', rust: 'lib.rs' },
  moodboardImage:         { delivery: 'invoke', impl: 'native', rust: 'lib.rs' },
  moodboardRemove:        { delivery: 'invoke', impl: 'native', rust: 'lib.rs' },
  previewInspectOpen:     { delivery: 'invoke', impl: 'native', rust: 'lib.rs' },
  previewInspectMove:     { delivery: 'send',   impl: 'native', rust: 'lib.rs' },
  previewInspectClose:    { delivery: 'send',   impl: 'native', rust: 'lib.rs' },
  onPreviewPick:          { delivery: 'event',  impl: 'native', rust: 'lib.rs' },
  checkUpdate:            { delivery: 'invoke', impl: 'native', rust: 'plugin-updater' },
  installUpdate:          { delivery: 'invoke', impl: 'native', rust: 'plugin-updater' },
}

/** The methods this shell answers itself — the preload exposes exactly these and the
 *  renderer layers them over the mock. Derived from SPEC so the two can't disagree. */
export const NATIVE_METHODS = (Object.keys(SPEC) as ApiMethod[]).filter((k) => SPEC[k].impl === 'native')

/** `operator:terminalWrite` — one namespace, one name per method, no hand-written strings.
 *  A typo becomes a type error rather than a channel nobody listens on. */
export const channel = <K extends ApiMethod>(m: K): `operator:${K}` => `operator:${m}`

/** Push channels (main → renderer). Same rule: derived, never spelled out twice. */
export const eventChannel = <K extends ApiMethod>(m: K): `operator-event:${K}` => `operator-event:${m}`
