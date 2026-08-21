import { describe, it, expect, vi, afterEach } from 'vitest'

// The updater is INERT by design until a feed exists: Tauri's `latest.json` and
// electron-updater's `latest-mac.yml` are different formats, so pointing it at the old feed
// would report a corrupt feed on every launch.
describe('the updater, before a feed exists', () => {
  afterEach(() => { vi.resetModules(); delete process.env.OPERATOR_UPDATE_FEED })

  it('checkUpdate answers "no update" rather than throwing when no feed is configured', async () => {
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
    // Matching the Tauri bridge, which wraps its own check in a catch: an update checker that
    // reports its own errors is worse than one that stays quiet.
    vi.resetModules()
    process.env.OPERATOR_UPDATE_FEED = 'http://127.0.0.1:9/nowhere/'
    const { checkUpdate } = await import('./updater')
    await expect(checkUpdate()).resolves.toBeNull()
  })
})
