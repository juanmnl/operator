# Renderer crash recovery — 2026-10-06

Branch `operator/d5ab40`. Not GUI-verified.

## Problem

`electron/src/main/index.ts` handled `render-process-gone` with a `console.error` only. When the
0.27.1 renderer died on 2026-10-06 10:17:15 (EXC_BREAKPOINT/SIGTRAP after 7 days uptime,
`~/Library/Logs/DiagnosticReports/Operator Helper (Renderer)-2026-10-06-101717.ips`), the window
stayed black. The user quit and relaunched, and quitting killed every lane. Main's stderr is lost
when the app is launched from Finder, so the event left no record in Operator's own files.

## What changed

New `electron/src/main/renderer-recovery.ts`:

- `decideRecovery({ reason, onErrorPage }, reloads, now)`: pure. Returns `reload`, `error-page`
  or `none`, plus the reload timestamps to keep.
  - `clean-exit` gives `none`.
  - A death while the error page is showing gives `none`, so a crashing error page cannot loop.
  - Otherwise `reload`, unless `RELOAD_LIMIT` (3) reloads already happened in the last
    `RELOAD_WINDOW_MS` (60 s). Then `error-page`.
- `errorPageUrl(reason, logFile)`: a `data:` HTML page that says the window crashed 4 times in a
  minute, that lanes are still running, where the log is, and has a Reload link. The link is
  `#operator-reload`, an in-page navigation, so the page needs no script and no preload API.
  Embedded values are HTML-escaped. The body is a drag region (hidden title bar), the link is not.
- `logRendererGone({ at, reason, exitCode, reloaded })`: appends one JSON line to
  `$OPERATOR_DIR/logs/renderer-gone.log` (default `~/.operator/logs/renderer-gone.log`). Never
  throws. No size cap: events are rare and capped at 4 per minute by the reload budget.

`electron/src/main/index.ts`:

- `loadApp(win)` factored out of `createWindow` (DEV_URL or the packaged `index.html`). Used for
  the first load and for every recovery reload.
- `installCrashRecovery(win)`, called next to `installNavigationGuards`, replaces the old
  `console.error` handler:
  - logs to stderr and to `renderer-gone.log` on every event;
  - on `reload`, calls `loadApp(win)` after 250 ms (reloading from inside the handler itself is
    not reliable);
  - on `error-page`, loads `errorPageUrl(...)` after 250 ms;
  - skips both when the window is destroyed or teardown has started (`teardownPromise` set), and
    logs `reloaded: false` in the quitting case;
  - `did-navigate-in-page` to `#operator-reload` while the error page is showing calls
    `loadApp(win)` again (manual reload, not counted against the budget).
- The budget is per window: a window recreated from the Dock or tray starts with an empty one.

Recovery relies on the existing renderer reattach path (`terminalList` + `terminalHistory` replay,
`src/renderer/lib/session-reattach.ts`). Session-restore logic was not touched.

## Tests

`electron/src/main/renderer-recovery.test.ts`, 7 tests: reload on `crashed`/`oom`/`killed`;
nothing on `clean-exit`; 3 reloads then error page; old reloads age out of the window; error-page
death does nothing; error page escapes and links to the hash; log lines are JSON under
`OPERATOR_DIR/logs`.

```
npm run typecheck   → clean (both tsconfigs)
npm test            → Test Files 47 passed (47), Tests 818 passed (818)
npm run build:main  → Done
```

## Not verified / left out

- Not run in the GUI. Untested in a real window: that `loadURL`/`loadFile` from the
  `render-process-gone` handler (deferred 250 ms) brings the app back, that the renderer reattaches
  every lane, and that `did-navigate-in-page` fires for a fragment link on a `data:` page. To test it
  in a dev instance, kill the renderer helper (`kill -SEGV <Operator Helper (Renderer) pid>`) once
  to see a reload, and four times inside a minute to see the error page.
- Cmd+R on the error page (menu role `reload`) reloads the error page, not the app. Only the
  Reload link loads the app.
- Main-side state tied to the old page (Preview inspect / CDP attach, the bench's `did-finish-load`
  counter) is not reset on recovery. The bench already records reloads as such.
- No `unresponsive` (hung renderer) handling. That is a different event and was not in the brief.
- The root cause of the SIGTRAP is not investigated here.
