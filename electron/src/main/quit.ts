// The quit guard: ask before quitting while agents are still working.
//
// Ported from `src-tauri/src/quit.rs`, and CHEAPER here — `event.preventDefault()` on
// `before-quit` IS the veto that Tauri had to build around `RunEvent::ExitRequested`.
//
// RUST OWNED THE VETO AND THE LANE COUNT, and main owns them here for the same reason: the
// accident this guards left the webview navigated away with no React app at all, so a count
// read from a frontend store is absent in exactly the case it is needed.
import { app, BrowserWindow, dialog } from 'electron'

export interface QuitLane { terminalId: string; project: string; phase: string }

/** The phases that mean "mid-turn", and the one decision in this module that is pure.
 *
 *  `waiting` IS BUSY, deliberately: an agent blocked on YOU is the precise lane you forgot
 *  about. `idle` is not, because a guard that fires on nearly every quit is one that trains its
 *  own dismissal.
 *
 *  Ported from `is_busy` in quit.rs. The Electron wiring originally asked for
 *  `running || compacting` and dropped `waiting` — which is to say it stayed silent about
 *  exactly the lane the guard exists for. */
export function isBusy(phase: string): boolean {
  return phase === 'running' || phase === 'compacting' || phase === 'waiting'
}

/** How long to wait for the renderer to confirm it mounted the dialog before falling back to a
 *  native one. The renderer may be mid-reload, crashed, or navigated away — which is precisely
 *  the accident this exists for — and a guard that silently does nothing in that case is not a
 *  guard. */
const DIALOG_ACK_MS = 400

export class QuitGuard {
  private ask = true
  private quitting = false
  /** THE LATCH. One answer per question — see `decide`. */
  private answered = false
  /** Which dialog currently owns the open question, so a second ⌘Q cannot raise another one on
   *  top of it. `nativeAsk` is `await`ed on a modal sheet, and a second sheet queued behind the
   *  first is a question the user answers twice. */
  private asking: 'none' | 'renderer' | 'native' = 'none'
  private ackTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly busyLanes: () => QuitLane[],
    private readonly idleCount: () => number,
    private readonly onTeardown: () => void,
  ) {}

  /** Mirror of the "Ask before quitting…" switch, which lives in localStorage with the app's
   *  other prefs. Main cannot read that, and must still be right when the renderer is gone. */
  setAsk(ask: boolean): void { this.ask = ask }

  /** The window a modal must hang on, RAISED first — and the reason every `showMessageBox` in
   *  this file takes one.
   *
   *  THE FREEZE. `dialog.showMessageBox(options)` with no parent window is Electron's
   *  application-modal branch: on macOS it runs `[NSAlert runModal]`, a nested run loop on the
   *  browser process's UI thread. Every window stops painting and the app stops answering — the
   *  hang the user reported as Operator freezing on quit. Passing a window instead takes the
   *  `beginSheetModalForWindow:` branch, which is document-modal: the sheet drops out of the
   *  title bar, the run loop keeps turning, and the promise resolves on the callback.
   *
   *  RAISED, not merely passed, and both halves matter. A sheet on a minimized or hidden window
   *  is a question nobody can see attached to an app that will not quit, which is the freeze
   *  again from the user's side. It also gives the second fix its teeth: a document-modal sheet
   *  blocks the web contents underneath, so a stale renderer dialog left over from a late ack
   *  cannot be clicked while the sheet is up.
   *
   *  `undefined` when there is no window at all — the app-modal call is still the right
   *  fallback there, because there is nothing to attach to and the question must still be
   *  asked. */
  private modalParent(): BrowserWindow | undefined {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) return undefined
    // A window can be torn down between the check and any of these; a guard that throws here
    // is a quit that hangs, which is the thing being fixed.
    try {
      if (win.isMinimized()) win.restore()
      if (!win.isVisible()) win.show()
      win.focus()
    } catch { /* gone from under us — fall through and ask anyway */ }
    return win
  }

  /** THE UPDATE'S QUESTION, asked ONCE and by the guard itself.
   *
   *  An update used to reach `quitAndInstall` without the guard knowing, so the guard asked its
   *  own question on the way out and its veto CANCELLED the install. The user pressed "Install &
   *  Restart" and stayed on the old version. So the guard asks first, in its own voice, with the
   *  same busy-lane count it would have used — and `beginQuitting()` below then makes sure it
   *  cannot ask a second time.
   *
   *  NATIVE, not the renderer's dialog, and deliberately: the renderer dialog exists for styling,
   *  and the failure being fixed here is a prompt that got lost. An install prompt that a
   *  mid-reload renderer can swallow would be the same bug with a nicer font. */
  async askInstall(version: string): Promise<boolean> {
    const lanes = this.busyLanes()
    const detail = lanes.length
      ? `${lanes.map((l) => `${l.project} (${l.phase})`).join(', ')}\n\nRestarting ends their terminals. The update is already downloaded — if you'd rather not now, it installs the next time you quit.`
      : 'The update is already downloaded. Operator will restart once it is installed.'
    const opts = {
      type: 'question' as const,
      buttons: ['Not now', 'Install and restart'],
      defaultId: 1,
      cancelId: 0,
      message: lanes.length
        ? `Install ${version} and restart? ${lanes.length} lane${lanes.length === 1 ? ' is' : 's are'} busy`
        : `Install ${version} and restart?`,
      detail,
    }
    // Parented for the same reason as `nativeAsk` — this one is asked while the app is very
    // much alive and mid-update, so freezing the UI thread here is if anything worse.
    const parent = this.modalParent()
    const { response } = parent
      ? await dialog.showMessageBox(parent, opts)
      : await dialog.showMessageBox(opts)
    return response === 1
  }

  /** DISARM THE VETO. Everything after this point treats the quit as already decided, which is
   *  what stops `before-quit` asking a question the user has just answered — and cancelling the
   *  installer's own quit with it. */
  beginQuitting(): void { this.quitting = true }

  install(): void {
    app.on('before-quit', (e) => {
      if (this.quitting || !this.ask) { this.onTeardown(); return }
      const lanes = this.busyLanes()
      if (!lanes.length) { this.onTeardown(); return }

      e.preventDefault()
      const win = this.getWindow()
      const payload = { lanes, idle: this.idleCount() }

      // A SECOND ⌘Q WHILE A QUESTION IS OPEN. Re-emitting to the renderer is deliberate — it is
      // how a renderer that respawned mid-question gets its dialog back — but nothing else may
      // restart. Re-arming the timer could raise a native sheet over a renderer dialog that is
      // already up, and clearing the latch would let an answer to the FIRST dialog land after
      // an answer to the second.
      if (this.asking !== 'none') {
        if (this.asking === 'renderer' && win && !win.isDestroyed()) {
          win.webContents.send('operator-event:onQuitRequested', payload)
        }
        return
      }

      this.answered = false
      if (win && !win.isDestroyed()) {
        this.asking = 'renderer'
        win.webContents.send('operator-event:onQuitRequested', payload)
        // If the renderer never acks, it is not in a state to ask anything — go native.
        this.ackTimer = setTimeout(() => {
          this.ackTimer = null
          if (this.answered) return
          void this.nativeAsk(lanes)
        }, DIALOG_ACK_MS)
      } else {
        void this.nativeAsk(lanes)
      }
    })
  }

  /** The renderer mounted its dialog — cancel the native fallback.
   *
   *  A LATE ACK IS NOT AN ERROR AND IS NOT OBEYED. If it arrives after `DIALOG_ACK_MS` the
   *  fallback sheet is already up, and the renderer has already shown its own dialog by the
   *  time it calls this (it acks in the same turn it sets the state). Both are then on screen.
   *  The sheet is document-modal on that window, so it covers the renderer's dialog and takes
   *  the click; whichever is answered, `decide`'s latch keeps the first answer. */
  dialogShown(): void {
    if (this.ackTimer) { clearTimeout(this.ackTimer); this.ackTimer = null }
  }

  /** `false` = Stay open. The veto then stands and nothing else happens.
   *
   *  ONE ANSWER PER QUESTION, and the latch is the fix for a real disagreement rather than
   *  tidiness. A renderer that acks after `DIALOG_ACK_MS` leaves TWO dialogs up, and they can
   *  be answered differently — the old code took both: native "Stay open" left the veto
   *  standing and did not close the question, so a later "Quit anyway" from the stale renderer
   *  dialog quit an app the user had just chosen to keep. The first answer is the user's
   *  answer; the second is a stale dialog's echo and is dropped. */
  decide(quit: boolean): void {
    if (this.answered) return
    this.answered = true
    this.asking = 'none'
    if (this.ackTimer) { clearTimeout(this.ackTimer); this.ackTimer = null }
    if (!quit) return
    this.quitting = true
    this.onTeardown()
    app.quit()
  }

  private async nativeAsk(lanes: QuitLane[]): Promise<void> {
    if (this.answered) return
    this.asking = 'native'
    const names = lanes.map((l) => `${l.project} (${l.phase})`).join(', ')
    const opts = {
      type: 'warning' as const,
      buttons: ['Stay open', 'Quit anyway'],
      defaultId: 0,
      cancelId: 0,
      message: `${lanes.length} agent${lanes.length === 1 ? ' is' : 's are'} still working`,
      detail: `${names}\n\nQuitting ends their terminals.`,
    }
    const parent = this.modalParent()
    const { response } = parent
      ? await dialog.showMessageBox(parent, opts)
      : await dialog.showMessageBox(opts)
    // BOTH answers are recorded, "Stay open" included. It used to fall off the end, leaving the
    // question open — which is precisely what let a stale renderer dialog quit afterwards.
    this.decide(response === 1)
  }
}
