import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolveFeedUrl } from './updater'

const DEFAULT_FEED = 'https://github.com/juanmnl/operator-releases/releases/latest/download'

// WHICH FEED, AND WHEN. Until the swap release there was no electron-updater feed at all and
// the module was inert by design. The feed exists now — `latest-mac.yml` + `.zip` published
// alongside Tauri's `latest.json` on the same operator-releases release — so the decision is no
// longer "nothing", it is these three cases.
describe('resolveFeedUrl', () => {
  it('an explicit OPERATOR_UPDATE_FEED wins, packaged or not', () => {
    expect(resolveFeedUrl('http://127.0.0.1:1462/', true)).toBe('http://127.0.0.1:1462/')
    expect(resolveFeedUrl('http://127.0.0.1:1462/', false)).toBe('http://127.0.0.1:1462/')
  })

  it('a packaged build with no override uses the operator-releases feed', () => {
    expect(resolveFeedUrl(undefined, true)).toBe(DEFAULT_FEED)
  })

  it('an UNPACKAGED build stays inert — a dev run must never offer an update to itself', () => {
    // `npm run dev` carries the same version as whatever is published, so a default feed that
    // applied here would offer every developer an "update" to the build they are sitting on.
    expect(resolveFeedUrl(undefined, false)).toBeNull()
  })

  it('an empty env var is not an override', () => {
    // `OPERATOR_UPDATE_FEED=` in a shell profile is an empty string, not an intention.
    expect(resolveFeedUrl('', true)).toBe(DEFAULT_FEED)
    expect(resolveFeedUrl('', false)).toBeNull()
  })
})

// The checker's other contract: it answers, it never rejects. The renderer chains `.then()` on
// it, so a rejection breaks the toast rather than reporting "no update".
describe('the updater never surfaces its own plumbing', () => {
  afterEach(() => { vi.resetModules(); delete process.env.OPERATOR_UPDATE_FEED })

  it('checkUpdate answers "no update" when nothing is configured (unpackaged, no override)', async () => {
    vi.resetModules()
    delete process.env.OPERATOR_UPDATE_FEED
    const { checkUpdate } = await import('./updater')
    await expect(checkUpdate()).resolves.toBeNull()
  })

  it('installUpdate is a no-op with nothing pending', async () => {
    vi.resetModules()
    delete process.env.OPERATOR_UPDATE_FEED
    const { installUpdate } = await import('./updater')
    const host = { confirm: async () => true, prepareQuit: async () => {} }
    await expect(installUpdate(host)).resolves.toBeUndefined()
  })

  it('a failing check resolves null rather than surfacing plumbing to the user', async () => {
    vi.resetModules()
    process.env.OPERATOR_UPDATE_FEED = 'http://127.0.0.1:9/nowhere/'
    const { checkUpdate } = await import('./updater')
    await expect(checkUpdate()).resolves.toBeNull()
  })
})

// THE SELF-UPDATE LOOP. Packaged 0.17.0 toasted "Update 0.17.0 available" on every launch,
// because `checkForUpdates()` describes the latest feed entry whether or not it is newer and the
// checker read `updateInfo.version` without ever reading `isUpdateAvailable`. These tests pin
// the flag as the answer, with the mock shaped like electron-updater's real resolutions
// (`AppUpdater.js:400-422`).
describe('an up-to-date app is never offered itself', () => {
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('electron-updater')
    vi.doUnmock('electron')
    delete process.env.OPERATOR_UPDATE_FEED
  })

  /** Load the module against a stubbed feed answer. The env override is what makes the checker
   *  configure at all under plain node, where nothing is packaged. */
  async function checkAgainst(result: unknown, version?: string) {
    vi.resetModules()
    process.env.OPERATOR_UPDATE_FEED = 'http://127.0.0.1:1462/'
    vi.doMock('electron-updater', () => ({
      autoUpdater: {
        setFeedURL: () => {},
        checkForUpdates: async () => result,
        autoDownload: true,
        autoInstallOnAppQuit: true,
        logger: null,
        // `configure()` subscribes to `download-progress` and `error` now, so the fake needs the
        // emitter surface — without it the subscribe throws and `checkUpdate` catches it into
        // the same `null` a real failure produces, which is a very quiet way to break a test.
        on: () => {},
      },
    }))
    if (version) vi.doMock('electron', () => ({ app: { isPackaged: true, getVersion: () => version } }))
    const { checkUpdate } = await import('./updater')
    return checkUpdate()
  }

  it('the SAME version in the feed is not an update', async () => {
    await expect(checkAgainst({ isUpdateAvailable: false, updateInfo: { version: '0.17.0' } })).resolves.toBeNull()
  })

  it('a NEWER version is', async () => {
    await expect(checkAgainst({ isUpdateAvailable: true, updateInfo: { version: '0.17.1' } })).resolves.toEqual({ version: '0.17.1' })
  })

  it('the flag alone decides — a truthy `updateInfo` without it means no update', async () => {
    // The exact shape of the bug: this resolution used to return `{version:'0.17.0'}`.
    await expect(checkAgainst({ updateInfo: { version: '0.17.0' } })).resolves.toBeNull()
    await expect(checkAgainst(null)).resolves.toBeNull()
  })

  it('belt and braces: the running version is refused even if the flag says otherwise', async () => {
    await expect(
      checkAgainst({ isUpdateAvailable: true, updateInfo: { version: '0.17.0' } }, '0.17.0'),
    ).resolves.toBeNull()
    // …and a genuinely newer one still gets through with `app` present.
    await expect(
      checkAgainst({ isUpdateAvailable: true, updateInfo: { version: '0.18.0' } }, '0.17.0'),
    ).resolves.toEqual({ version: '0.18.0' })
  })

  it('an available update with no version in it is still no update', async () => {
    await expect(checkAgainst({ isUpdateAvailable: true, updateInfo: {} })).resolves.toBeNull()
  })
})


// ── THE INSTALL ORDERING ─────────────────────────────────────────────────────────────────────
//
// THE BUG. `installUpdate` downloaded and then called `quitAndInstall` directly. That quit lands
// on `before-quit`, where `QuitGuard` asks whether to quit while lanes are busy — and the guard's
// `preventDefault()` CANCELLED the updater's quit. The user pressed "Install & Restart", saw a
// toast, and stayed on 0.17.2. Every error on the way was swallowed to `console.error`, which in
// a packaged app is nowhere, so it presented as a button that did nothing.
//
// The fix is an ORDER, so the tests are about order. A fake autoUpdater records the calls.

type Call = string

function fakeUpdater(over: Partial<{ downloadRejects: Error }> = {}) {
  const calls: Call[] = []
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
  return {
    calls,
    emit(event: string, ...args: unknown[]) { for (const h of handlers[event] ?? []) h(...args) },
    mock: {
      autoDownload: true,
      autoInstallOnAppQuit: false,
      logger: null as unknown,
      setFeedURL: () => { calls.push('setFeedURL') },
      on(event: string, h: (...a: unknown[]) => void) { (handlers[event] ??= []).push(h) },
      checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.18.0' } }),
      downloadUpdate: async () => {
        calls.push('downloadUpdate')
        if (over.downloadRejects) throw over.downloadRejects
        return []
      },
      quitAndInstall: (isSilent: boolean, isForceRunAfter: boolean) => {
        calls.push(`quitAndInstall(${isSilent},${isForceRunAfter})`)
      },
    },
  }
}

async function loadWithFake(fake: ReturnType<typeof fakeUpdater>) {
  vi.resetModules()
  process.env.OPERATOR_UPDATE_FEED = 'http://127.0.0.1:1462/'
  vi.doMock('electron-updater', () => ({ autoUpdater: fake.mock }))
  vi.doMock('electron', () => ({ app: { isPackaged: true, getVersion: () => '0.17.2' } }))
  return import('./updater')
}

describe('installUpdate — the order that makes it actually install', () => {
  afterEach(() => { vi.resetModules(); vi.doUnmock('electron-updater'); vi.doUnmock('electron'); delete process.env.OPERATOR_UPDATE_FEED })

  it('downloads, then ASKS, then prepares the quit, THEN quits — in that order', async () => {
    const fake = fakeUpdater()
    const { checkUpdate, installUpdate } = await loadWithFake(fake)
    await checkUpdate()

    const order: string[] = []
    await installUpdate({
      confirm: async () => { order.push('confirm'); return true },
      prepareQuit: async () => { order.push('prepareQuit') },
    })

    // The guard is disarmed and teardown is done BEFORE the quit, which is the whole fix: the
    // veto that cancelled the install cannot run after `prepareQuit`.
    expect(order).toEqual(['confirm', 'prepareQuit'])
    expect(fake.calls).toEqual(['setFeedURL', 'downloadUpdate', 'quitAndInstall(false,true)'])
  })

  it('asks ONCE — never a second question the guard could veto on', async () => {
    const fake = fakeUpdater()
    const { checkUpdate, installUpdate } = await loadWithFake(fake)
    await checkUpdate()
    let asked = 0
    await installUpdate({ confirm: async () => { asked++; return true }, prepareQuit: async () => {} })
    expect(asked).toBe(1)
  })

  // `isForceRunAfter` is what relaunches us once the installer finishes. Passing false here would
  // install the update and leave the user staring at a closed app.
  it('calls quitAndInstall with FORCE RUN AFTER, so it relaunches', async () => {
    const fake = fakeUpdater()
    const { checkUpdate, installUpdate } = await loadWithFake(fake)
    await checkUpdate()
    await installUpdate({ confirm: async () => true, prepareQuit: async () => {} })
    expect(fake.calls).toContain('quitAndInstall(false,true)')
  })

  it('DECLINING leaves the app running and never quits', async () => {
    const fake = fakeUpdater()
    const { checkUpdate, installUpdate } = await loadWithFake(fake)
    await checkUpdate()
    let prepared = false
    await installUpdate({ confirm: async () => false, prepareQuit: async () => { prepared = true } })
    expect(prepared).toBe(false)
    expect(fake.calls.some((c) => c.startsWith('quitAndInstall'))).toBe(false)
  })

  // …but the download is not thrown away. A user who says "not now" and quits an hour later
  // still gets the update, which is the point of arming this the moment the bytes land.
  it('arms autoInstallOnAppQuit once the download completes, even if the restart is declined', async () => {
    const fake = fakeUpdater()
    const { checkUpdate, installUpdate, updateDownloaded } = await loadWithFake(fake)
    await checkUpdate()
    expect(fake.mock.autoInstallOnAppQuit).toBe(false)  // not before
    await installUpdate({ confirm: async () => false, prepareQuit: async () => {} })
    expect(fake.mock.autoInstallOnAppQuit).toBe(true)
    expect(updateDownloaded()).toBe(true)
  })

  it('a failed DOWNLOAD reports the real message and never asks', async () => {
    const fake = fakeUpdater({ downloadRejects: new Error('sha512 mismatch') })
    const { checkUpdate, installUpdate, setUpdateSink } = await loadWithFake(fake)
    await checkUpdate()
    const errors: string[] = []
    setUpdateSink({ error: (m) => errors.push(m) })
    let asked = false
    await installUpdate({ confirm: async () => { asked = true; return true }, prepareQuit: async () => {} })
    expect(asked).toBe(false)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('sha512 mismatch')     // the REAL message, not "install failed"
    expect(fake.calls.some((c) => c.startsWith('quitAndInstall'))).toBe(false)
  })

  it('forwards download progress rather than swallowing it', async () => {
    const fake = fakeUpdater()
    const { checkUpdate, setUpdateSink } = await loadWithFake(fake)
    await checkUpdate()
    const seen: number[] = []
    setUpdateSink({ progress: (percent) => seen.push(percent) })
    fake.emit('download-progress', { percent: 42.7, transferred: 1, total: 2 })
    expect(seen).toEqual([43])
  })

  it('an autoUpdater error reaches the sink with its message', async () => {
    const fake = fakeUpdater()
    const { checkUpdate, setUpdateSink } = await loadWithFake(fake)
    await checkUpdate()
    const errors: string[] = []
    setUpdateSink({ error: (m) => errors.push(m) })
    fake.emit('error', new Error('ENOSPC: no space left on device'))
    expect(errors[0]).toContain('ENOSPC')
  })
})
