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
    await expect(installUpdate()).resolves.toBeUndefined()
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
