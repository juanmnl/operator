# Result — the diagnosis is wrong. The WebView has the timezone, and `localTime` returns local.

Brief: `dev/briefs/webview-timezone-utc.md`. Lane: Code.

**No code changed.** The brief's step 1 says: *"If it returns the right zone, STOP — my diagnosis
is wrong, say so in the result, and do not proceed to a fix built on it."* It returns the right
zone. So this is a measurement report, not a fix.

## What `Intl.DateTimeFormat().resolvedOptions().timeZone` returns in-app

Measured inside the **running dev build** (pid 85775, started 17:32, loading from the vite dev
server on :1432 — i.e. the current source), by a temporary probe in `lib/local-time.ts` that
`fetch`ed its readings to a local listener. Probe reverted immediately; `git status` on that file
is clean against `HEAD`.

```
zone       America/Guayaquil
locale     en-GB
offsetMin  300                        (UTC−5, correct)
localTime('2026-07-31T23:21:21.022Z') → 18:21      ← the CORRECT local time
localDay ('2026-07-31T23:21:21.022Z') → 2026-07-31 ← the correct local day
```

That is the exact instant from the brief's table, run through the exact function the channel row
calls, in the app's own WKWebView. It renders **18:21**, which is what the brief says the correct
answer is. The runtime is not UTC and `localTime` is not the defect.

## The corroborating measurements

Three more, because "the diagnosis is wrong" is worth more than one reading.

**1. WKWebView resolves the zone under every environment, including `TZ=`.** I compiled a
25-line Swift probe (`WKWebView` + `evaluateJavaScript`) and ran it three ways:

| launched as | zone | rendered |
|---|---|---|
| my full shell env | `America/Guayaquil` | 18:21 |
| the release app's stripped launchd env (`PATH=/usr/bin:/bin:…`, no `LANG`, no `TZ`) | `America/Guayaquil` | 18:21 |
| `TZ=` (empty, the brief's repro) | `America/Guayaquil` | 18:21 |

**The `TZ= node` reproduction does not transfer.** Node honours `TZ`; WKWebView does not — it
resolves through CoreFoundation, so an absent or empty `TZ` is not a mechanism by which a WebView
can end up on UTC. That is why the app can lack `TZ` (both processes do — verified with `ps eww`)
and still be correct.

**2. The app is not sandboxed**, which was my next suspect for a WebContent process that can't
read the host zone. Entitlements are `allow-jit`, `allow-unsigned-executable-memory`,
`allow-dyld-environment-variables`, `disable-library-validation` — no `app-sandbox`.

**3. The data is fine and so is the path.** All 347 `dispatches[].at` values in
`~/.operator/projects.json` end in `Z`, and every `replies.ts` row in `chat.db` does too — so the
"a naive local ISO string without the `Z` parses as local and renders its own digits back" failure,
which produces this exact symptom with a perfectly correct timezone, is not what is happening
either. `ProjectChannel.tsx:760` calls `localTime(entry.at)` with no interposed formatting, and
there are no surviving `.slice(11, 16)` / `.slice(0, 10)` sites anywhere in `src/`.

## So what was the user looking at?

Probable, with evidence — but I could not prove it, and I would rather say so than dress it up.

**The release window was started before the binary that contains the fix was built.**

```
release process  pid 76392   started  Fri Jul 31 16:30:38
release binary   …/MacOS/operator      mtime    Jul 31 17:10
frontend bundle  dist/assets/main-Bo-Aci8J.js   mtime  Jul 31 17:09   ← contains hourCycle:"h23"
```

Tauri embeds the frontend **in the binary**. A running process keeps the bundle it launched with;
replacing the file on disk at 17:10 does not change what pid 76392 is rendering. So the window the
user was reading at 19:31 has been showing a 16:30-vintage frontend all along, and if that build
predates `d243aae` (Jul 30 18:42) it still renders `entry.at.slice(11, 16)` — the raw UTC digits,
`23:21`, exactly as reported.

**What I could not establish:** what the pre-17:10 binary actually contained. `target/release/` was
rewritten wholesale at 17:10 and left no artifact of the previous build, so there is nothing to
inspect. The claim above is consistent with every measurement I have, but it is inference.

**The one-step test: quit that Operator window and relaunch it.** If it then shows `18:21`, this
was it and there is nothing to fix. If it still shows `23:21` after a genuine relaunch, my
measurements say the bug is not where the brief looked and I would start from the fresh process.

**Worth checking first, though — there is a month-old Operator in `/Applications`:**

```
/Applications/Operator.app/Contents/MacOS/operator    2026-06-30 14:50
```

That is four weeks older than the timestamp fix and *definitely* renders raw UTC. It is not in the
process list right now, but it is what a Dock icon or Spotlight launch would open. If the user ever
reaches Operator that way rather than through the build output, that alone explains the report and
explains why a correct fix "shipped and the symptom survived it".

## The sweep (brief item 3)

Every date/time formatting site in `src/`, and whether an ambient-UTC runtime *would* have hit it.

| site | call | zone source | would UTC break it? |
|---|---|---|---|
| `lib/local-time.ts:31` `localTime` | `toLocaleTimeString` + `hourCycle:'h23'` | ambient | yes |
| `lib/local-time.ts:42` `localDay` | `Intl.DateTimeFormat` → `formatToParts` | ambient | yes |
| `ProjectChannel.tsx:760` | `localTime(entry.at)` | via above | yes |
| `DispatchLog.tsx:56` | `localTime(d.at)` | via above | yes |
| `lib/project-channel.ts:252` | `localDay(e.at, tz)` — day separators | ambient | yes |
| `SessionActivityView.tsx:49,50,184` | `toLocaleTimeString([], {hour,minute[,second]})` | ambient | yes |
| `SessionInfoBar.tsx:16,17` | same | ambient | yes |
| `CanvasConversation.tsx:370` | same | ambient | yes |
| `lib/plan-limits.ts:133` | `Intl.DateTimeFormat({timeZone: zone})` | **explicit** — the IANA zone Claude prints in its own `/usage` output | **no** |
| `lib/format.ts` `relativeTime` | `Date.now() - Date.parse(iso)` | **none** | **no** |
| `lib/plan-limits.ts` `updatedAgo` | `(now - Date.parse(fetchedAt))/60000` | **none** | **no** |

Harness-only, not shipped: `dev/mock-bridge.ts:561,564`, `dev/drive-channel-time.mjs:50,51`.

**In fact affected: none of them**, because the runtime has the zone.

**`PlanMeter`'s relative ages — confirmed, not assumed** (brief's first "watch out"). `updatedAgo`
is a millisecond delta floored into minutes and `relativeTime` likewise; neither constructs a
calendar value, so no zone can reach them. The one zoned thing `PlanMeter` shows is the reset
string, and `PlanMeter.tsx:210` renders it **verbatim** because Claude already localised it and
stamped it with its own zone — so it is immune by a different route, and `plan-limits.ts`'s own
`Intl` use pins that zone explicitly rather than inheriting it.

## What I recommend against

**Do not plumb a backend-resolved zone into the renderer** (brief item 2). Ambient resolution is
demonstrably working in this app, so that work would add a Rust→renderer channel, a threading
change through `localTime`/`localDay` and both their callers, and a new "what if the zone changes
while the app runs" question — all to replace a mechanism measured correct. It would also be
strictly worse in one respect: `Intl` follows a live system-zone change, and a value resolved once
at startup and handed across does not.

**Do not add brief item 4's test either.** A test that forces ambient resolution to UTC and asserts
the output is still local can only pass if the zone is threaded explicitly — so it is not a test
that would have caught this, it is a test that *requires* the fix I am arguing against. There is
nothing for it to catch: the existing `local-time.test.ts` pins zones precisely so it tests the
conversion rather than the runner's environment, which is the right shape.

## Housekeeping

- The temporary probe in the main checkout's `src/renderer/lib/local-time.ts` was reverted; that
  file is byte-identical to `HEAD`. Nothing else in `/Users/juanmnl/Developer/operator` was touched.
- `npx tsc --noEmit` — clean. `npm test` — 45 files, 569 tests, all passing. Both unchanged, since
  no source changed.
