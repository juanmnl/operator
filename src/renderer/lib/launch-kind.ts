// Asks main once per DOCUMENT whether this renderer start is the app's launch or a reload (see
// electron/src/main/launch-kind.ts). Memoised because main answers `launch` only once per app run:
// asking twice from the same document (React StrictMode runs effects twice in dev) would make the
// launch look like a reload.
//
// `unknown` when the shell has no answer (the Tauri bridge, mocks, a failed call). Callers treat
// it as the old behaviour, restore where you were, which is the safe side: it never hides a place.

export type LaunchKind = 'launch' | 'reload' | 'unknown'

let pending: Promise<LaunchKind> | null = null

export function launchKind(): Promise<LaunchKind> {
  if (!pending) {
    const ask = window.operator?.launchKind
    pending = ask
      ? ask().then((k) => (k === 'launch' || k === 'reload' ? k : 'unknown'), () => 'unknown' as const)
      : Promise.resolve('unknown')
  }
  return pending
}

/** Tests only. */
export function resetLaunchKindForTests(): void { pending = null }
