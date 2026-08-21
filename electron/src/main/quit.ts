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
  private decided = false
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

  install(): void {
    app.on('before-quit', (e) => {
      if (this.quitting || !this.ask) { this.onTeardown(); return }
      const lanes = this.busyLanes()
      if (!lanes.length) { this.onTeardown(); return }

      e.preventDefault()
      this.decided = false
      const win = this.getWindow()
      const payload = { lanes, idle: this.idleCount() }

      if (win && !win.isDestroyed()) {
        win.webContents.send('operator-event:onQuitRequested', payload)
        // If the renderer never acks, it is not in a state to ask anything — go native.
        this.ackTimer = setTimeout(() => { if (!this.decided) void this.nativeAsk(lanes) }, DIALOG_ACK_MS)
      } else {
        void this.nativeAsk(lanes)
      }
    })
  }

  /** The renderer mounted its dialog — cancel the native fallback. */
  dialogShown(): void {
    if (this.ackTimer) { clearTimeout(this.ackTimer); this.ackTimer = null }
  }

  /** `false` = Stay open. The veto then stands and nothing else happens. */
  decide(quit: boolean): void {
    this.decided = true
    if (this.ackTimer) { clearTimeout(this.ackTimer); this.ackTimer = null }
    if (!quit) return
    this.quitting = true
    this.onTeardown()
    app.quit()
  }

  private async nativeAsk(lanes: QuitLane[]): Promise<void> {
    this.decided = true
    const names = lanes.map((l) => `${l.project} (${l.phase})`).join(', ')
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Stay open', 'Quit anyway'],
      defaultId: 0,
      cancelId: 0,
      message: `${lanes.length} agent${lanes.length === 1 ? ' is' : 's are'} still working`,
      detail: `${names}\n\nQuitting ends their terminals.`,
    })
    if (response === 1) this.decide(true)
  }
}
