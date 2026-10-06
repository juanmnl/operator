import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  RECOVERY_DELAY_MS, RELOAD_HASH, RELOAD_LIMIT, RELOAD_WINDOW_MS,
  decideRecovery, errorPageUrl, installCrashRecovery, logRendererGone, rendererGoneLogFile,
} from './renderer-recovery'

const crash = { reason: 'crashed', onErrorPage: false }

// The 2026-10-06 incident: the renderer died after 7 days and the window stayed black until the
// user quit, losing every lane.
describe('decideRecovery', () => {
  it('reloads after a crash or an OOM, and records the reload time', () => {
    expect(decideRecovery(crash, [], 1000)).toEqual({ action: 'reload', reloads: [1000] })
    expect(decideRecovery({ reason: 'oom', onErrorPage: false }, [], 1000).action).toBe('reload')
    expect(decideRecovery({ reason: 'killed', onErrorPage: false }, [], 1000).action).toBe('reload')
  })

  it('does nothing for clean-exit', () => {
    expect(decideRecovery({ reason: 'clean-exit', onErrorPage: false }, [], 1000)).toEqual({ action: 'none', reloads: [] })
  })

  it('reloads up to the limit inside the window, then shows the error page', () => {
    let reloads: number[] = []
    const actions: string[] = []
    for (let i = 0; i < RELOAD_LIMIT + 2; i++) {
      const d = decideRecovery(crash, reloads, 10_000 + i * 1000)
      reloads = d.reloads
      actions.push(d.action)
    }
    expect(actions).toEqual([...Array(RELOAD_LIMIT).fill('reload'), 'error-page', 'error-page'])
    expect(reloads).toHaveLength(RELOAD_LIMIT)
  })

  it('forgets reloads older than the window, so crashes days apart always reload', () => {
    const old = [0, 1000, 2000]
    expect(decideRecovery(crash, old, RELOAD_WINDOW_MS - 1).action).toBe('error-page')
    expect(decideRecovery(crash, old, RELOAD_WINDOW_MS)).toEqual({ action: 'reload', reloads: [1000, 2000, RELOAD_WINDOW_MS] })
    expect(decideRecovery(crash, old, 2000 + RELOAD_WINDOW_MS)).toEqual({ action: 'reload', reloads: [2000 + RELOAD_WINDOW_MS] })
  })

  it('does not reload or reshow when the error page itself dies, so it cannot loop', () => {
    expect(decideRecovery({ reason: 'crashed', onErrorPage: true }, [], 1000).action).toBe('none')
    expect(decideRecovery({ reason: 'crashed', onErrorPage: true }, [1, 2, 3], 4).action).toBe('none')
  })
})

describe('errorPageUrl', () => {
  it('is a data: page with a Reload link to the hash main watches, and escapes what it embeds', () => {
    const url = errorPageUrl('<crashed>', '/tmp/a&b/renderer-gone.log')
    expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true)
    const html = decodeURIComponent(url.slice(url.indexOf(',') + 1))
    expect(html).toContain(`href="${RELOAD_HASH}">Reload</a>`)
    expect(html).toContain('&#60;crashed&#62;')
    expect(html).toContain('/tmp/a&#38;b/renderer-gone.log')
    expect(html).not.toContain('<crashed>')
  })
})

describe('logRendererGone', () => {
  it('appends one JSON line per event under OPERATOR_DIR/logs', async () => {
    expect(rendererGoneLogFile()).toBe(join(process.env.OPERATOR_DIR!, 'logs', 'renderer-gone.log'))
    await logRendererGone({ at: '2026-10-06T10:17:15.000Z', reason: 'crashed', exitCode: 5, reloaded: true })
    await logRendererGone({ at: '2026-10-06T10:17:16.000Z', reason: 'crashed', exitCode: 5, reloaded: false })
    const lines = readFileSync(rendererGoneLogFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toEqual([
      { at: '2026-10-06T10:17:15.000Z', reason: 'crashed', exitCode: 5, reloaded: true },
      { at: '2026-10-06T10:17:16.000Z', reason: 'crashed', exitCode: 5, reloaded: false },
    ])
  })
})

// Kept after the log test above: each event here also appends to the log, without being awaited.
describe('installCrashRecovery', () => {
  const NEW_DOC = { isMainFrame: true, isSameDocument: false }

  /** A window whose loads emit start, commit and finish the way Electron's do. Only the start is
   *  emitted synchronously, so a test can cancel or commit a load on its own. */
  const setup = (opts: { quitting?: boolean } = {}) => {
    const wc = new EventEmitter()
    const urls: string[] = []
    let appLoads = 0
    const leaving = vi.fn()
    const loaded = vi.fn()
    const navigate = () => { wc.emit('did-start-navigation', NEW_DOC); wc.emit('did-navigate', {}, 'x', -1, ''); wc.emit('did-finish-load') }
    const win = {
      isDestroyed: () => false,
      loadURL: async (url: string) => { urls.push(url); navigate() },
      webContents: wc,
    }
    installCrashRecovery(win as unknown as Parameters<typeof installCrashRecovery>[0], {
      loadApp: () => { appLoads++; navigate() },
      quitting: () => !!opts.quitting,
      rendererLeaving: leaving,
      rendererLoaded: loaded,
    })
    const crash = () => wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 5 })
    const cmdR = () => navigate()
    return { wc, urls, appLoads: () => appLoads, leaving, loaded, crash, cmdR }
  }

  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('a crash releases main\'s hold on the old renderer at once and reloads after the delay', () => {
    const w = setup()
    w.crash()
    expect(w.leaving).toHaveBeenCalledTimes(1)
    expect(w.appLoads()).toBe(0)
    vi.advanceTimersByTime(RECOVERY_DELAY_MS)
    expect(w.appLoads()).toBe(1)
  })

  // Review M1/M2: both also happen on a plain Cmd+R, with no crash involved.
  it('Cmd+R releases main\'s hold on the old renderer too', () => {
    const w = setup()
    w.cmdR()
    expect(w.leaving).toHaveBeenCalledTimes(1)
    expect(w.appLoads()).toBe(0)
  })

  it('ignores same-document and Preview iframe navigations', () => {
    const w = setup()
    w.wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    w.wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    w.wc.emit('did-navigate-in-page', {}, 'app://x#y', true)
    expect(w.leaving).not.toHaveBeenCalled()
  })

  // Review M1 (round 2): `did-start-navigation` fires before `will-navigate`, so a navigation the
  // guard then cancels used to hold every dispatch for good under a renderer that stayed.
  it('a main-frame navigation that starts and is cancelled does not hold anything', () => {
    const w = setup()
    w.wc.emit('did-start-navigation', NEW_DOC) // a stray link; will-navigate then refuses it
    expect(w.leaving).not.toHaveBeenCalled()
    expect(w.loaded).not.toHaveBeenCalled()
  })

  it('holds on the commit, and reports the app\'s load so the ready fallback can arm', () => {
    const w = setup()
    w.wc.emit('did-start-navigation', NEW_DOC)
    w.wc.emit('did-navigate', {}, 'app://index.html', -1, '')
    expect(w.leaving).toHaveBeenCalledTimes(1)
    w.wc.emit('did-finish-load')
    expect(w.loaded).toHaveBeenCalledTimes(1)
  })

  it('the error page\'s load does not arm the ready fallback: it never sends ready', () => {
    const w = setup()
    for (let i = 0; i <= RELOAD_LIMIT; i++) { w.crash(); vi.advanceTimersByTime(RECOVERY_DELAY_MS) }
    expect(w.urls).toHaveLength(1)
    expect(w.loaded).toHaveBeenCalledTimes(RELOAD_LIMIT) // the app loads only
  })

  // Review L3.
  it('Cmd+R inside the delay replaces the recovery reload instead of being aborted by it', () => {
    const w = setup()
    w.crash()
    w.cmdR()
    vi.advanceTimersByTime(RECOVERY_DELAY_MS * 4)
    expect(w.appLoads()).toBe(0)
  })

  it('Cmd+R inside the delay also stops the error page from replacing the user\'s load', () => {
    const w = setup()
    for (let i = 0; i < RELOAD_LIMIT; i++) { w.crash(); vi.advanceTimersByTime(RECOVERY_DELAY_MS) }
    expect(w.appLoads()).toBe(RELOAD_LIMIT)
    w.crash() // over budget: the error page is due
    w.cmdR()
    vi.advanceTimersByTime(RECOVERY_DELAY_MS * 4)
    expect(w.urls).toEqual([])
  })

  it('shows the error page when nothing intervenes, and its Reload link loads the app', () => {
    const w = setup()
    for (let i = 0; i < RELOAD_LIMIT; i++) { w.crash(); vi.advanceTimersByTime(RECOVERY_DELAY_MS) }
    w.crash()
    vi.advanceTimersByTime(RECOVERY_DELAY_MS)
    expect(w.urls).toHaveLength(1)
    expect(w.urls[0].startsWith('data:text/html')).toBe(true)
    w.wc.emit('did-navigate-in-page', {}, `${w.urls[0]}${RELOAD_HASH}`, true)
    expect(w.appLoads()).toBe(RELOAD_LIMIT + 1)
  })

  it('does not reload while quitting', () => {
    const w = setup({ quitting: true })
    w.crash()
    vi.advanceTimersByTime(RECOVERY_DELAY_MS * 4)
    expect(w.appLoads()).toBe(0)
  })
})
