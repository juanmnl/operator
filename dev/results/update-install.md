# "Install & Restart" never installed

**Branch:** `operator/a30080` · 2026-08-25 · Code lane
**Symptom:** user on 0.17.2, 0.18.0 available, button shows a toast and nothing happens. Forever.

## The cause, confirmed

Three separate things, and each one alone would have been enough to lose the install.

**1. The guard vetoed the updater's own quit.** `installUpdate` downloaded and then called
`autoUpdater.quitAndInstall` directly. That quit lands on `before-quit`, which is exactly where
`QuitGuard` asks whether to quit while lanes are busy — and its `e.preventDefault()` **cancels
the quit the installer was relying on**. With any lane running (i.e. every realistic moment
someone presses this button), the install could not proceed. The guard was doing its job; nothing
had told it this quit was already decided.

**2. Every error ended at `console.error`.** In a packaged app that is nowhere a user can reach,
so a signature mismatch, a 404 on the feed and a full disk were all indistinguishable from a
button that did nothing.

**3. My own `will-quit` teardown hold made it worse.** Added with the dev-server reaper: veto once,
await teardown, quit again. `quitAndInstall(false, true)` relaunches through a hand-off that wants
an uninterrupted quit, and a `preventDefault()` in the middle of it is the same shape as the veto
in (1). This was a second cancellation sitting behind the first.

## The fix — an order

`installUpdate(host)` now sequences, and every step is load-bearing:

1. **Download**, reporting progress. Asking first would put a dialog up and then make the user
   wait behind it.
2. **`autoInstallOnAppQuit = true` the moment the bytes land.** Even if everything below is
   declined, an ordinary quit later still installs — the download is not thrown away because the
   moment passed.
3. **Ask ONCE**, up front, through the guard: *"Install 0.18.0 and restart? 3 lanes are busy"*,
   naming them and saying the update installs on the next quit if not now.
4. **Prepare the quit** — `quit.beginQuitting()` disarms the veto, and teardown runs *to
   completion* so `will-quit` has nothing left to hold.
5. **Then** `quitAndInstall(false, true)`.

`InstallHost` (`confirm`, `prepareQuit`) is injected from `index.ts` rather than imported, so the
ordering is testable against a fake and `ipc.ts` does not import `index.ts` back (that cycle
bundles badly).

**On the relaunch, verified as far as it can be without a signed build:** `tornDown` moved to
module scope and `prepareQuit` sets it, so the `will-quit` handler returns immediately instead of
calling `preventDefault()`. `isForceRunAfter: true` is asserted by a test, because passing `false`
would install the update and leave the user staring at a closed app.

**The ask is a native dialog, deliberately.** The renderer's quit dialog exists for styling; the
bug being fixed is a prompt that got lost. An install prompt a mid-reload renderer can swallow
would be the same bug with a nicer font.

## Surfaced, not swallowed

- `onUpdateProgress(percent, transferred, total)` → a toast at the quarter marks (a toast per
  percent is a stream, not information).
- `onUpdateError(message)` → an error toast carrying **the real message** — `sha512 mismatch`,
  `ENOSPC`, whatever it was. Subscribed once on mount, not per check, or the timer would stack
  listeners.
- **`~/.operator/updater.log`** gets electron-updater's own (verbose) log plus every error, with
  `Error` serialised properly — `JSON.stringify` renders one as `{}`, which is the least useful
  possible log line. The next report arrives with evidence instead of a guess.

## Tests

Nine new, against a fake `autoUpdater` that records its calls — because the fix *is* an order:

- download → **confirm** → **prepareQuit** → quit, asserted as a sequence. The guard is disarmed
  and teardown is finished before the quit, which is the whole fix.
- asks **once** — never a second question the guard could veto on;
- `quitAndInstall(false, **true**)`, so it relaunches;
- declining leaves the app running and never quits — **and still arms `autoInstallOnAppQuit`**;
- a failed download reports the real message, never asks, and never quits;
- progress and error events reach the sink.

One pre-existing test needed an `on: () => {}` on its fake: `configure()` now subscribes to
`download-progress` and `error`, and without the emitter surface the subscribe threw into
`checkUpdate`'s catch and returned the same `null` a real failure produces — a very quiet way to
break a test, and worth the comment it got.

| | |
|---|---|
| `tsc --noEmit` (root) | **0** |
| `tsc --noEmit -p electron/tsconfig.json` | **0** |
| `vitest run` (electron) | **379 passed, 0 failed** |
| `npm test` (root) | **956 passed / 33 failed** — the 33 unchanged, pre-existing jsdom |
| `vite build` | green |

## Not verified — and this one needs a real release

The ordering is proven against a fake; **the actual install is not**, and cannot be from a dev
build: `resolveFeedUrl` returns null when unpackaged, by design, so an unpackaged run never
downloads anything. What is unproven end to end:

1. that Squirrel.Mac's hand-off survives our teardown running before `quitAndInstall`;
2. that `isForceRunAfter` relaunches after that teardown;
3. that the native dialog appears above a busy window.

The cheapest real test is a **0.18.1 published to the feed**, then pressing the button on a
packaged 0.18.0 with a lane running. If it fails, `~/.operator/updater.log` now exists and will
say why — which it would not have for this report.
