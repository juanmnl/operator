// COLD LAUNCH OR RENDERER RELOAD — which one is the renderer starting in?
//
// The renderer cannot tell on its own. A reload (the stall watchdog respawning a frozen
// WebContent, a crash, ⌘R in dev) starts it from nothing, exactly like a launch: fresh JS state,
// the same localStorage. What differs is the MAIN process, which lives for the whole app run and
// sees every renderer start in it. So the answer is kept here: the first renderer to ask in this
// process is the launch, and every later one is a reload.
//
// Why it matters: the app opens on the home overview at launch (user decision, 2026-09-16), but a
// reload must put the user back where they were. Landing on the overview after the hourly respawn
// would look like the app throwing away their place.

export type LaunchKind = 'launch' | 'reload'

/** One per app run. `claim()` answers `launch` exactly once, then `reload`. */
export function createLaunchTracker(): { claim: () => LaunchKind } {
  let claimed = false
  return {
    claim() {
      if (claimed) return 'reload'
      claimed = true
      return 'launch'
    },
  }
}
