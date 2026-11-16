# Renderer SIGTRAP on 2026-10-13 and 2026-10-19: V8 heap out-of-memory

Research only. No code changed. Sources: the two `.ips` files in `~/Library/Logs/DiagnosticReports/`, the Electron 43.4.1 darwin-arm64 dSYM (GitHub release asset `electron-v43.4.1-darwin-arm64-dsym.tar.xz`, UUID 4C4C4442-5555-3144-A1E9-1C53C30304E8, which matches the UUID of the installed `Electron Framework`), `atos`, and the code cited below.

## Answer

Both crashes are the same V8 out-of-memory abort on the renderer main thread (`CrRendererMain`). It is not a Chromium CHECK and not a PartitionAlloc failure. The renderer's JS heap was full, and the allocation that failed was a string built by `JSON.stringify`, inside a `MessagePort` message handler. The `JSON.stringify` call is the last straw, not the cause. The cause is a heap that grows for days and is never released.

- Electron 43.4.1 (Chromium and V8 bundled with it) in both crashes. The `.ips` image list says `CFBundleVersion 43.4.1`. The 10-13 report says app 0.28.2 and the 10-19 report 0.28.3, but the framework is the same build.
- The native stack of the two crashes is identical from the abort up to `RendererMain`. Only the JIT frame addresses differ.

## Symbolicated crashing thread (identical in both reports)

Frame offsets are into `Electron Framework`; the names in the `.ips` (`ares_dns_rr_get_ttl`, `v8::CodeEvent::GetScriptColumn`, ...) are nearest-export guesses and wrong. With the dSYM:

```
partition_alloc::internal::OnNoMemoryInternal / OnNoMemory / OnErrnoNoMem   (oom.cc:85-106)  <- the brk
blink::AllocateCrashKeyString                                               (v8_initializer.cc:232)  V8 OOM callback
v8::Utils::ReportOOMFailure
v8::internal::V8::FatalProcessOutOfMemory                                   (api.cc:281)
v8::internal::HeapAllocator::CollectGarbageAndRetryAllocation               (heap-allocator.cc:536)  a GC ran, retry failed
v8::internal::FactoryBase::NewRawTwoByteString                              (factory-base.cc:904)
v8::internal::Factory::NewStringFromTwoByte                                 (factory.cc:1194)
v8::internal::JsonStringify                                                 (builtins-json.cc)
v8::internal::Builtin_JsonStringify
  <10 to 11 JIT frames: our JS>
v8::Function::Call -> blink::V8ScriptRunner::CallFunction
blink::JSEventHandler::InvokeInternal                                       an onmessage-style handler
blink::MessagePort::DispatchMessageEvent                                    (message_port.cc:424)
mojo::Connector -> sequence manager -> RendererMain
```

## Facts from the reports

| | 2026-10-13 | 2026-10-19 |
|---|---|---|
| App version in report | 0.28.2 | 0.28.3 |
| procLaunch | 2026-10-09 01:59:39 | 2026-10-16 12:26:04 |
| Crash | 11:41:21 | 12:08:26 |
| Renderer uptime | about 4.4 days | about 3.0 days |
| Faulting thread | 0, CrRendererMain | 0, CrRendererMain |
| Tag 14 regions, Tag 16 regions | 15,980 and 12,049 | 17,094 and 10,552 |

- The 10-19 renderer started within 2 s of the main process (`ps` shows main pid 1256 started 10-16 12:26:02), so it is the main window's renderer, not the Preview's out-of-process iframe. For 10-13 I did not check the main process start time; the same stack makes it the same kind of process (assumption).
- The report's `uptime` field (240000, 1000000) is a rounded boot-relative value; I used `procLaunch` for age.
- vmSummary "resident" figures are of the dead process and say nothing about heap size. The `.ips` has no heap size, so the heap limit at death is not recorded. The 1.4 TB and 385 GB totals are address reservations (V8 cage, guard region), as in the 10-06 notes.

## Comparison with 2026-10-06 (0.27.1)

`dev/results/relaunch-lost-sessions-2026-10-06.md:149-170` records the 10-06 trap on thread 3 (`ThreadPoolForegroundWorker`), not the main thread, after 7.8 days. That `.ips` is no longer in `DiagnosticReports`, so I could not symbolicate it. The signature differs from the two above (worker thread vs main thread), so I cannot say the 10-06 crash was a V8 OOM. A thread-pool abort fits PartitionAlloc `OnNoMemory` (the same final brk) or a different failure. The two new crashes are one class of failure; the 10-06 one is unproven. The 10-06 doc's statement that "the report does NOT show a V8 heap OOM" was right for that report and does not apply to these two.

## Why the heap fills (inference; the cause is not proven)

- Live renderer, same build: pid 22557, started 2026-10-19 12:20:30 (12 minutes after the crash), RSS 1,045 MB at 22.7 hours (measured with `ps` today, 11:00). `memory-footprint-research-2026-10-16.md` Q3: 287 MB at 4.8 minutes and 942 MB (peak 1,406 MB) at 10.7 hours, with 17 lanes. About 30 to 35 MB per hour, steady.
- At that rate the renderer reaches 2.2 GB at 3 days and 3.5 GB at 4.4 days. V8's default old-space limit on 64-bit is up to about 4 GB (assumption: Electron 43 default, no `--max-old-space-size` set; I found no `js-flags` or `max-old-space` in `electron/src/main/index.ts`). RSS also contains non-heap memory, so this is a rough fit, not a measurement. It fits the two crashes at 3.0 and 4.4 days.
- The terminal scrollback caps account for about 100 to 150 MB (estimate in the footprint doc). The rest of the growth is unexplained. Nobody has taken a heap snapshot.

## What in our renderer sits in this stack

- The `MessagePort` handler is most likely React's scheduler. `node_modules/scheduler/cjs/scheduler.production.js:84` and `:197-198` use `setImmediate` when it exists and `new MessageChannel()` otherwise. The window has `nodeIntegration: false` and `contextIsolation: true` (`electron/src/main/index.ts:129-130`), so the page has no `setImmediate` and React uses a `MessageChannel`. No application code in `src/` or `electron/src/` creates a `MessageChannel`, `MessagePort` or Worker (grep). So the JS frames are React render or effect work running from a scheduler tick. This is an inference from the stack plus the grep; the JIT frames are unsymbolized.
- `JSON.stringify` callers run from effects in `src/renderer/views/DashboardView.tsx`, and the effect at `:4876-4885` is the heaviest: on every change of `terminals, sessions, customNames` it stringifies the whole saved-sessions list twice (`:4882`, `:4885`) and sends it over IPC (`saveSessions`). The `projects` effect at `:4896-4899` does the same for projects. `:3137` pretty-prints `savedSessionsRef.current`. `:5636` stringifies the workspace snapshot. A multi-megabyte string of two-byte characters (the failing allocation is `NewRawTwoByteString`) is made on each run. These calls create large short-lived strings that make a nearly full heap fail sooner. They would be the allocation that trips the limit; I have not shown that any of them retains memory.
- The `localStorage` store is 13 MB on disk (`~/Library/Application Support/operator/Local Storage`, several 3.6 MB `.ldb` files rewritten within the last hour). That is the churn from those writes; it is not the renderer heap.

## Second finding: the crash recovery did not leave a trace

`electron/src/main/renderer-recovery.ts:123-129` should append a line to `~/.operator/logs/renderer-gone.log` on every renderer death and reload after 250 ms. That file does not exist anywhere under the home directory (`find ~ -name renderer-gone.log`), although the installed `app.asar` contains the string `renderer-gone.log` and `~/.operator/logs/` exists. The new renderer started 12 minutes after the 10-19 crash, which looks like a manual reload, not the 250 ms automatic one. I did not find why: `decideRecovery` returns `reload` for any reason except `clean-exit`, and `logRendererGone` swallows write errors. Possible causes, none verified: the `render-process-gone` event did not fire for this OOM abort, or the listener is attached to a `webContents` that was replaced. This needs a test with a forced renderer crash in the packaged build (`kill -TRAP` on the renderer helper), not only `-SEGV`.

## Options

1. Measure first (recommended before any fix). In a dev build, log `process.getProcessMemoryInfo()` and `performance.memory.usedJSHeapSize` hourly, and take a heap snapshot at 1 h and at 12 h through the existing CDP port (`electron/src/main/preview-cdp-port.ts`). Compare retained sizes by constructor. This finds the retained objects; reading code alone did not.
2. Contain it. Raise the renderer old-space limit (`app.commandLine.appendSwitch('js-flags', '--max-old-space-size=…')` before `app.ready`; I did not verify that Electron 43 honors it for renderers) and add a planned reload: when `usedJSHeapSize` passes a threshold, reload the window while the user is idle. The reload path already works for lanes (ptys live in main; `renderer-recovery.ts` and the reattach path). Trade-off: a raised limit only delays the crash, a planned reload costs a visible flash and a brief loss of renderer state.
3. Cut the churn. Stop stringifying the whole saved-sessions and projects lists on every terminal or session change: debounce, and compare a cheap version counter instead of two full serializations. This lowers GC pressure and the peak string size. It does not fix a leak.
4. Fix the recovery logging gap so the next death is recorded with `details.reason` (`oom` is what Electron should report here) and a reload happens.

Recommendation: do 4 and 1 now (cheap, and they turn the next crash into data), then choose between 2 and a code fix once the snapshot names the retained objects. Do 3 only if the snapshot shows the serialized lists are large.

## Not verified

- The exact JS function that called `JSON.stringify`. The JIT frames have no symbols; the `.ips` has no source map.
- That the previously unexplained growth is a leak in our code and not in a dependency or in Chromium.
- The V8 heap limit actually in force, and the heap size at death.
- The 10-06 crash class (the `.ips` is gone).
