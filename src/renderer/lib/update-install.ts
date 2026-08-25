// What an update install looks like from the renderer's side, as a pure machine.
//
// THE STATE IT REPLACES WAS A BOOLEAN, AND THE BOOLEAN COULD ONLY LIE. `installing` went true on
// the press and never came back: a download running, a download finished, and a download that
// died in its first second all rendered as "Installing…", forever. The main process has reported
// `onUpdateProgress`/`onUpdateError` since 0.18.1 (see electron/src/main/updater.ts); the two
// surfaces that offer the install — the preferences button and the sidebar's arrow — were the
// ones still not listening.
//
// It lives here rather than inside either component because both need the same answers and
// neither is a place logic can be tested: the renderer suite has no DOM renderer, and the parts
// of this worth pinning (a percent that cannot go backwards, an error that a retry clears, a
// download that starts from the OTHER surface) are all state transitions, not markup.

/** The install's whole state. `installing` is deliberately distinct from `downloading`: it is
 *  reached only when the bytes are actually done, so the word finally means what it says. */
export type InstallState =
  | { kind: 'idle' }
  /** Bytes are moving. `total` is 0 until electron-updater knows the size. */
  | { kind: 'downloading'; percent: number; transferred: number; total: number }
  /** Downloaded; handed to Squirrel, and the app is about to quit under us. */
  | { kind: 'installing' }
  /** It stopped, and this is the reason — the shell's own words, not a shrug. */
  | { kind: 'failed'; message: string }

export const IDLE: InstallState = { kind: 'idle' }

/** The user pressed Install. Optimistic 0% rather than waiting for main's first tick: the IPC
 *  round trip is short but not free, and a button that changes on the next frame is the entire
 *  point of this change. */
export function installPressed(): InstallState {
  return { kind: 'downloading', percent: 0, transferred: 0, total: 0 }
}

/** A `download-progress` tick.
 *
 *  MONOTONIC ON PURPOSE. electron-updater computes percent per chunk over a stream whose length
 *  it re-learns across a 302, and a bar that jumps backwards reads as a fault in the app rather
 *  than in the number. Once downloading, percent only ever rises.
 *
 *  It also accepts a tick arriving from `idle` or `failed`: the install can be started from the
 *  OTHER surface (press the sidebar arrow, then open preferences), and a retry after a failure
 *  has to clear the failure rather than render both at once. */
export function installProgressed(
  prev: InstallState,
  percent: number,
  transferred = 0,
  total = 0,
): InstallState {
  const clamped = Math.max(0, Math.min(100, Math.round(Number.isFinite(percent) ? percent : 0)))
  // 100% is not "downloading at 100" — it is the handover. Nothing further arrives on this
  // channel afterwards, so the label must not sit on a full bar waiting for a tick that the
  // quit will pre-empt.
  if (clamped >= 100) return { kind: 'installing' }
  const floor = prev.kind === 'downloading' ? prev.percent : 0
  return {
    kind: 'downloading',
    percent: Math.max(floor, clamped),
    transferred: Math.max(0, Math.round(transferred)),
    total: Math.max(0, Math.round(total)),
  }
}

/** It failed, and the message is the whole value. An empty one still has to say something a
 *  person can act on, or we are back to a button that did nothing. */
export function installFailed(message: string): Extract<InstallState, { kind: 'failed' }> {
  const trimmed = (message ?? '').trim()
  return { kind: 'failed', message: trimmed || 'The update stopped for an unknown reason.' }
}

/** Whether the install control should refuse the press.
 *
 *  A FAILURE IS PRESSABLE AGAIN. Most causes here are transient — a dropped connection, a full
 *  disk, a feed that 502'd — and the alternative to retrying in place is quitting the app. */
export function installBusy(state: InstallState): boolean {
  return state.kind === 'downloading' || state.kind === 'installing'
}

/** `1.2 MB`, `136.4 MB`, `0 B`. Only ever used for a download size, so binary units and one
 *  decimal is the whole requirement — not worth a general formatter. */
export function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let n = bytes
  let u = 0
  while (n >= 1024 && u < units.length - 1) { n /= 1024; u++ }
  return `${u === 0 ? Math.round(n) : n.toFixed(1)} ${units[u]}`
}

/** The install button's face. `version` is what the check found; absent, the button is offering
 *  a retry rather than a first attempt. */
export function installLabel(state: InstallState, version?: string): string {
  switch (state.kind) {
    case 'downloading': return `Downloading… ${state.percent}%`
    case 'installing': return 'Installing…'
    // Not "Failed". The button is a verb, and after a failure the verb is "try it again".
    case 'failed': return version ? `Retry v${version} & Restart` : 'Retry'
    default: return version ? `Install v${version} & Restart` : 'Install & Restart'
  }
}

/** The line beside the button. Returns null when the install has nothing to add and the caller's
 *  own check status should show through instead. */
export function installStatus(state: InstallState): { text: string; isError: boolean } | null {
  switch (state.kind) {
    case 'downloading':
      // The byte counts only appear once electron-updater knows the total; before that the
      // percent is the only honest thing on the line.
      return state.total > 0
        ? { text: `${fmtSize(state.transferred)} of ${fmtSize(state.total)}`, isError: false }
        : { text: 'Starting the download…', isError: false }
    case 'installing':
      return { text: 'Downloaded. Operator will restart.', isError: false }
    case 'failed':
      // The log is named because the message is one line and the cause is often three.
      return { text: `${state.message} — see ~/.operator/updater.log`, isError: true }
    default:
      return null
  }
}

/** The sidebar arrow's tooltip, which is the only text that fits there. */
export function installTitle(state: InstallState, version: string): string {
  switch (state.kind) {
    case 'downloading': return `Downloading ${version}… ${state.percent}%`
    case 'installing': return `Installing ${version} — Operator will restart`
    case 'failed': return `Update ${version} failed: ${state.message} — click to retry`
    default: return `Update ${version} available — install & restart`
  }
}
