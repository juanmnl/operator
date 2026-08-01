# Brief — the WebView has no timezone, so every correct date call renders UTC

**Lane: Code.** Write your result to `dev/briefs/webview-timezone-utc-RESULT.md`.

## This is NOT the bug that was already fixed

`dev/briefs/channel-timestamps-utc.md` diagnosed three `.slice(11, 16)` sites rendering raw UTC.
That fix landed (`d243aae`, Jul 30) and is correct: `lib/local-time.ts` uses `toLocaleTimeString`,
`ProjectChannel.tsx:760` calls `localTime(entry.at)`, and `local-time.test.ts` asserts
`22:10Z → 17:10` for `America/Guayaquil`.

**The user still sees UTC.** Measured 2026-07-31:

| | |
|---|---|
| machine | `America/Guayaquil`, UTC−5, local **19:31** |
| stored dispatch | `2026-07-31T23:21:21.022Z` — correct UTC |
| channel row shows | **23:21** |
| correct local would be | **18:21** |

Reproduction, exact:

```
node -e "...toLocaleTimeString(...)"        →  18:21   (correct)
TZ= node -e "...toLocaleTimeString(...)"    →  23:21   (what the app shows)
```

So the formatter is fine and the stored data is fine. **The runtime resolves to UTC**: JavaScript's
ambient timezone inside the app's WKWebView is not the system zone. Neither the release nor the dev
`operator` process carries `TZ` in its environment.

The tests pass precisely because Node HAS a timezone. A test that relies on ambient resolution
cannot catch an environment that has none — which is why a correct fix shipped and the symptom
survived it.

## What I want

1. **Confirm the mechanism before fixing it.** I am confident but not certain. Establish what
   `Intl.DateTimeFormat().resolvedOptions().timeZone` actually returns inside the running app (a
   dev build is up; a temporary debug line or the console is fine). If it returns `UTC` or
   `Etc/UTC`, that is the whole bug. If it returns the right zone, STOP — my diagnosis is wrong,
   say so in the result, and do not proceed to a fix built on it.
2. **Fix it at the source, once.** `localTime(iso, timeZone?)` and `localDay(iso, timeZone?)`
   already accept an explicit zone; the comment calls it "for tests only". Make it a real runtime
   value: resolve the system zone authoritatively and use it everywhere, rather than trusting
   ambient resolution. Resolving it backend-side (Rust knows the host zone) and handing it to the
   renderer is the option I would take, but argue it if setting `TZ` on the process at startup is
   simpler and equally reliable — one mechanism, not both.
3. **Every surface, not just the channel.** `SessionActivityView`, `SessionInfoBar`,
   `CanvasConversation`, `DispatchLog` and `PlanMeter`'s "Updated 3m ago" all format dates. If the
   runtime has no zone they are ALL wrong, and the channel is just where it is most visible. Sweep
   for `toLocaleTimeString` / `toLocaleDateString` / `Intl.DateTimeFormat` and report which were
   affected.
4. **A test that would have caught it.** The current tests pass an explicit `timeZone` and so can
   never see this. Add one that exercises the path the app actually takes — with ambient resolution
   forced to UTC, the rendered string must still be local.

## Watch out

- `PlanMeter`'s relative ages ("Updated 3m ago") are computed from a delta, not a formatted zone,
  so they are probably NOT affected. Confirm rather than assume.
- Do not change the stored format. `at` is correct ISO UTC and everything sorts and compares on it.
- Day separators bucket on `localDay`. If the zone is wrong the SEPARATOR is wrong too, in a way
  that only shows after 19:00 local — see the note at `project-channel.ts:243`.

## Done means

The channel shows local time in the running app, the sweep in `3` is reported, `npm test` green,
`npx tsc --noEmit` clean, and the result file states what
`Intl.DateTimeFormat().resolvedOptions().timeZone` returned in-app before the fix.
