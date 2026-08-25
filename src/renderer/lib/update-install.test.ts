import { describe, it, expect } from 'vitest'
import {
  IDLE,
  installPressed,
  installProgressed,
  installFailed,
  installBusy,
  installLabel,
  installStatus,
  installTitle,
  fmtSize,
  type InstallState,
} from './update-install'

// THE BUG THIS MACHINE EXISTS FOR: `const [installing, setInstalling] = useState(false)`, set
// true on the press and never set back. A download running, a download finished, and a download
// that died in its first second were the same pixel. Every test below is a case where the
// boolean could not tell the truth.

describe('the press', () => {
  it('shows progress immediately rather than waiting for the first tick', () => {
    // The optimistic 0%. Without it the button sits on "Install & Restart" through the whole TLS
    // handshake, and the press reads as ignored — which is the original complaint.
    expect(installPressed()).toEqual({ kind: 'downloading', percent: 0, transferred: 0, total: 0 })
    expect(installLabel(installPressed())).toBe('Downloading… 0%')
  })

  it('is refused while bytes are moving, and allowed again after a failure', () => {
    expect(installBusy(IDLE)).toBe(false)
    expect(installBusy(installPressed())).toBe(true)
    expect(installBusy({ kind: 'installing' })).toBe(true)
    // A retry in place, because the alternative to retrying is quitting the app — and most
    // causes here (a dropped connection, a full disk, a 502) are transient.
    expect(installBusy(installFailed('ECONNRESET'))).toBe(false)
  })
})

describe('progress', () => {
  it('rounds, and carries the byte counts through', () => {
    const s = installProgressed(installPressed(), 42.7, 58_000_000, 136_354_476)
    expect(s).toEqual({ kind: 'downloading', percent: 43, transferred: 58_000_000, total: 136_354_476 })
  })

  it('NEVER GOES BACKWARDS', () => {
    // electron-updater recomputes percent per chunk over a stream whose length it re-learns
    // across a 302. A bar that jumps back reads as a fault in the app, not in the number.
    let s: InstallState = installProgressed(installPressed(), 60)
    s = installProgressed(s, 12)
    expect(s).toMatchObject({ kind: 'downloading', percent: 60 })
  })

  it('100% is the HANDOVER, not a full bar', () => {
    // Nothing else arrives on this channel afterwards — Squirrel takes it from here and the quit
    // pre-empts any further render. Sitting on "Downloading… 100%" would be the permanent
    // "Installing…" bug wearing a different number.
    expect(installProgressed(installPressed(), 100)).toEqual({ kind: 'installing' })
    expect(installProgressed(installPressed(), 143)).toEqual({ kind: 'installing' })
    expect(installLabel({ kind: 'installing' })).toBe('Installing…')
  })

  it('clamps a nonsense percent instead of rendering it', () => {
    expect(installProgressed(IDLE, -5)).toMatchObject({ percent: 0 })
    expect(installProgressed(IDLE, NaN)).toMatchObject({ percent: 0 })
  })

  it('a tick with no local press still shows the download — the OTHER surface started it', () => {
    // Press the sidebar arrow, then open preferences. Preferences never saw a press, and its
    // button used to read "Install v0.18.1 & Restart" over a download already in flight.
    expect(installProgressed(IDLE, 30, 1, 2)).toMatchObject({ kind: 'downloading', percent: 30 })
  })

  it('a retry after a failure clears the failure rather than rendering both', () => {
    const failed = installFailed('sha512 mismatch')
    const retried = installProgressed(failed, 5)
    expect(retried).toMatchObject({ kind: 'downloading', percent: 5 })
    // …and the floor does not carry over from a previous attempt's percent.
    expect(installProgressed(installFailed('x'), 5)).toMatchObject({ percent: 5 })
  })
})

describe('failure', () => {
  it('keeps the shell’s real message, which is the entire value', () => {
    const s = installFailed('sha512 mismatch')
    expect(s).toEqual({ kind: 'failed', message: 'sha512 mismatch' })
    // Named, so the three lines the one line omits are reachable.
    expect(installStatus(s)).toEqual({
      text: 'sha512 mismatch — see ~/.operator/updater.log',
      isError: true,
    })
  })

  it('still says something actionable when the message is empty', () => {
    // Back to a button that did nothing, otherwise.
    expect(installFailed('').message).toBe('The update stopped for an unknown reason.')
    expect(installFailed('   ').message).toBe('The update stopped for an unknown reason.')
  })

  it('offers the verb again, not the noun', () => {
    expect(installLabel(installFailed('nope'), '0.18.2')).toBe('Retry v0.18.2 & Restart')
    expect(installLabel(installFailed('nope'))).toBe('Retry')
  })
})

describe('what each surface renders', () => {
  it('the preferences line: bytes once the size is known, and nothing at rest', () => {
    // At rest the caller's own check status ("You're up to date.") shows through.
    expect(installStatus(IDLE)).toBeNull()
    expect(installStatus(installPressed())).toEqual({ text: 'Starting the download…', isError: false })
    expect(installStatus(installProgressed(IDLE, 50, 68_177_238, 136_354_476)))
      .toEqual({ text: '65.0 MB of 130.0 MB', isError: false })
    expect(installStatus({ kind: 'installing' })).toEqual({
      text: 'Downloaded. Operator will restart.', isError: false,
    })
  })

  it('the sidebar arrow has only a tooltip, so every state has to fit in one', () => {
    expect(installTitle(IDLE, '0.18.2')).toBe('Update 0.18.2 available — install & restart')
    expect(installTitle(installProgressed(IDLE, 43), '0.18.2')).toBe('Downloading 0.18.2… 43%')
    expect(installTitle({ kind: 'installing' }, '0.18.2')).toBe('Installing 0.18.2 — Operator will restart')
    expect(installTitle(installFailed('ENOSPC'), '0.18.2')).toContain('click to retry')
  })

  it('the default label still names the version, so nothing regressed at rest', () => {
    expect(installLabel(IDLE, '0.18.2')).toBe('Install v0.18.2 & Restart')
  })
})

describe('fmtSize', () => {
  it('is a download size and nothing more', () => {
    expect(fmtSize(0)).toBe('0 B')
    expect(fmtSize(-1)).toBe('0 B')
    expect(fmtSize(512)).toBe('512 B')
    expect(fmtSize(1024)).toBe('1.0 KB')
    expect(fmtSize(136_354_476)).toBe('130.0 MB')  // the real 0.18.1 zip
    expect(fmtSize(3 * 1024 ** 3)).toBe('3.0 GB')
  })
})
