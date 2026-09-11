// The Badging API, made a no-op for content Operator only DISPLAYS.
//
// Electron binds Chromium's BadgeService straight to `app.setBadgeCount`, with no frame or origin
// check and no JS hook in between, so any page rendered in this process badges Operator's Dock
// tile. It happened: the mantel project, open in the Preview pane, calls
// `navigator.setAppBadge(reservasCount)` and Operator showed a red "3" it never set.
// `probes/badge-block.cjs` reproduces it from a cross-origin iframe and from a top-level page.
//
// Replaced with a resolved no-op rather than deleted. A page that feature-detects keeps working
// either way, but one that calls it unguarded would throw inside the preview and break an app that
// works fine in a real browser.
//
// SELF-CONTAINED ON PURPOSE. `contextBridge.executeInMainWorld` serializes the function, so it may
// not reference anything outside its own body. The deletion has to happen in the MAIN world: the
// preload's isolated world has its own `Navigator.prototype`, and changing that one reaches nothing
// the page can see. `proto` exists for the test; in a preload it is always omitted.
//
// Both prototypes, because the same function runs in pages (`Navigator`) and in service workers
// (`WorkerNavigator`, via preload/service-worker.ts); each realm has only one of them.
export function blockBadging(proto?: Record<string, unknown>): void {
  type Ctor = { prototype: Record<string, unknown> } | undefined
  const g = globalThis as unknown as { Navigator?: Ctor; WorkerNavigator?: Ctor }
  const targets = proto ? [proto] : [g.Navigator?.prototype, g.WorkerNavigator?.prototype]
  for (const target of targets) {
    if (!target) continue
    for (const name of ['setAppBadge', 'clearAppBadge']) {
      if (typeof target[name] !== 'function') continue
      Object.defineProperty(target, name, {
        value: function () { return Promise.resolve() },
        writable: true,
        configurable: true,
        enumerable: true,
      })
    }
  }
}
