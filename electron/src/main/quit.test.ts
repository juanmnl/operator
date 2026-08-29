import { describe, it, expect, vi, beforeEach } from 'vitest'

const showMessageBox = vi.fn()
const appQuit = vi.fn()
let beforeQuit: ((e: { preventDefault: () => void }) => void) | null = null

vi.mock('electron', () => ({
  app: {
    on: (ev: string, fn: (e: { preventDefault: () => void }) => void) => { if (ev === 'before-quit') beforeQuit = fn },
    quit: () => appQuit(),
  },
  dialog: { showMessageBox: (...a: unknown[]) => showMessageBox(...a) },
  BrowserWindow: class {},
}))

const { isBusy, QuitGuard } = await import('./quit')

// Ported from `busy_means_mid_turn_or_blocked_on_you_but_never_idle` in quit.rs — the one pure
// decision in the module, and the one the design turns on.
describe('isBusy', () => {
  it('running and compacting are busy', () => {
    expect(isBusy('running')).toBe(true)
    expect(isBusy('compacting')).toBe(true)
  })

  it('WAITING is busy — an agent blocked on you is the lane you forgot about', () => {
    expect(isBusy('waiting')).toBe(true)
  })

  it('idle is NOT busy — a guard that fires on every quit trains its own dismissal', () => {
    expect(isBusy('idle')).toBe(false)
    expect(isBusy('')).toBe(false)
    expect(isBusy('ended')).toBe(false)
  })
})


// ── The quit dialog: one window to hang on, one answer per question ──────────────────────────
//
// Both defects below were live in the same six lines. The modal had no parent window, which on
// macOS is `[NSAlert runModal]` — a nested run loop on the browser process's UI thread, i.e.
// the freeze. And the 400ms renderer ack was a race with no latch behind it, so a renderer that
// acked late put a SECOND dialog on screen and the guard obeyed whichever answers arrived.

/** A stand-in for the real window, with the raise calls recorded. */
function fakeWindow(state: { minimized?: boolean; visible?: boolean } = {}) {
  const calls: string[] = []
  const win = {
    isDestroyed: () => false,
    isMinimized: () => state.minimized ?? false,
    isVisible: () => state.visible ?? true,
    restore: () => { calls.push('restore') },
    show: () => { calls.push('show') },
    focus: () => { calls.push('focus') },
    webContents: { send: (ch: string, payload: unknown) => { calls.push(`send:${ch}`); void payload } },
  }
  return { win, calls }
}

const LANES = [{ terminalId: 't0', project: 'operator', phase: 'running' }]

/** A guard wired to `win`, with `before-quit` captured. `teardown` records that it ran. */
function makeGuard(win: unknown | null) {
  const teardown = vi.fn()
  const g = new QuitGuard(() => win as never, () => LANES, () => 0, teardown)
  g.install()
  return { g, teardown, fire: () => beforeQuit?.({ preventDefault: () => {} }) }
}

describe('QuitGuard — the native dialog is parented', () => {
  beforeEach(() => { showMessageBox.mockReset(); appQuit.mockReset(); beforeQuit = null })

  it('hangs the fallback on the WINDOW — an unparented box runs [NSAlert runModal] and freezes the app', async () => {
    showMessageBox.mockResolvedValue({ response: 0 })
    const { win } = fakeWindow()
    const { g, fire } = makeGuard(null) // no window at before-quit time…
    void g
    fire()
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalled())
    // …so this one is legitimately unparented: there is nothing to attach to.
    expect(showMessageBox.mock.calls[0]).toHaveLength(1)

    // With a window, the window is the first argument — the beginSheetModalForWindow branch.
    showMessageBox.mockReset()
    showMessageBox.mockResolvedValue({ response: 0 })
    const g2 = makeGuard(win)
    g2.fire()
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalled())
    expect(showMessageBox.mock.calls[0][0]).toBe(win)
  }, 3000)

  it('RAISES the window first — a sheet on a minimized window is a question nobody can see', async () => {
    showMessageBox.mockResolvedValue({ response: 0 })
    const { win, calls } = fakeWindow({ minimized: true, visible: false })
    const { fire } = makeGuard(win)
    fire()
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalled())
    expect(calls).toContain('restore')
    expect(calls).toContain('show')
    expect(calls).toContain('focus')
  }, 3000)

  it('asks the install question on the window too', async () => {
    showMessageBox.mockResolvedValue({ response: 1 })
    const { win } = fakeWindow()
    const { g } = makeGuard(win)
    await expect(g.askInstall('0.18.2')).resolves.toBe(true)
    expect(showMessageBox.mock.calls[0][0]).toBe(win)
  })
})

describe('QuitGuard — one answer per question', () => {
  beforeEach(() => { showMessageBox.mockReset(); appQuit.mockReset(); beforeQuit = null })

  it('drops a contradicting second answer — the stale dialog cannot quit after "Stay open"', () => {
    const { win } = fakeWindow()
    const { g, teardown, fire } = makeGuard(win)
    fire()
    g.decide(false)          // the user says stay…
    g.decide(true)           // …and the other dialog, still on screen, says quit
    expect(appQuit).not.toHaveBeenCalled()
    expect(teardown).not.toHaveBeenCalled()
  })

  it('native "Stay open" CLOSES the question — it used to fall off the end and leave it open', async () => {
    // The exact disagreement: the ack lands late, so both dialogs are up. The user answers the
    // native sheet with "Stay open"; the renderer's stale dialog then reports "Quit anyway".
    showMessageBox.mockResolvedValue({ response: 0 }) // Stay open
    const { win } = fakeWindow()
    const { g, fire } = makeGuard(win)
    fire()
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalled())
    await Promise.resolve()
    g.dialogShown()  // the late ack
    g.decide(true)   // the stale dialog's answer
    expect(appQuit).not.toHaveBeenCalled()
  }, 3000)

  it('still quits on a single, unambiguous "Quit anyway"', () => {
    const { win } = fakeWindow()
    const { g, teardown, fire } = makeGuard(win)
    fire()
    g.decide(true)
    expect(teardown).toHaveBeenCalled()
    expect(appQuit).toHaveBeenCalled()
  })

  it('a second ⌘Q re-emits to the renderer but never raises a second dialog', async () => {
    showMessageBox.mockResolvedValue({ response: 0 })
    const { win, calls } = fakeWindow()
    const { fire } = makeGuard(win)
    fire()
    fire()
    fire()
    // Re-emitted each time, which is how a respawned renderer gets its dialog back…
    expect(calls.filter((c) => c === 'send:operator-event:onQuitRequested')).toHaveLength(3)
    // …but the native fallback is armed once, so no sheet queues behind another.
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledTimes(1))
  }, 3000)

  it('a renderer that acks in time keeps the native fallback away entirely', async () => {
    showMessageBox.mockResolvedValue({ response: 0 })
    const { win } = fakeWindow()
    const { g, fire } = makeGuard(win)
    fire()
    g.dialogShown()
    await new Promise((r) => setTimeout(r, 600)) // past DIALOG_ACK_MS
    expect(showMessageBox).not.toHaveBeenCalled()
  }, 3000)
})
