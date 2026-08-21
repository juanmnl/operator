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
