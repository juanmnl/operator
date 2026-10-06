// Asks main once per DOCUMENT for its record of the previous app run (last-run.json, see
// electron/src/main/last-run.ts). Memoised like lib/launch-kind: main hands out the crash
// auto-resume to its first caller only, and React StrictMode runs effects twice in dev.
//
// Null when the shell has no answer (the Tauri bridge, mocks, a failed call) or no record: the
// caller falls back to the renderer's own snapshot.

import type { PreviousRunInfo } from '../../shared/types'

let pending: Promise<PreviousRunInfo | null> | null = null

export function previousRun(): Promise<PreviousRunInfo | null> {
  if (!pending) {
    const ask = window.operator?.previousRun
    pending = ask ? ask().then((r) => r ?? null, () => null) : Promise.resolve(null)
  }
  return pending
}

/** Tests only. */
export function resetPreviousRunForTests(): void { pending = null }
