# Result — Electron shell spike

**Status: all four measurements are below. M1 ran for 60 minutes continuously, not the 2 h the
brief asked for — the reason is in its section, and the shortfall is stated rather than papered
over.**

The spike lives at `spike/electron/` and is runnable: `cd spike/electron && npm i && npm run dev`.
Nothing under `src/` or `src-tauri/` was touched. Per the change of intent mid-task, it is built
as the **seed of a real shell** rather than a throwaway — see `spike/electron/README.md` for the
architecture and `spike/electron/PORT-LEDGER.md` for M4 in full.

---

## TL;DR

| | Electron changes this? | Number |
|---|---|---|
| **M1 — WebGL terminal under Chromium** | **Partially — clean for 60 min, but that is not the 2 h the question needs** | 0 defects at 0/15/30/45/60 min under continuous real Claude Code output; DOM control identical |
| **M2 — Memory at our fleet shape** | **Yes — the ceiling moves, the buffers don't** | 27 lanes rest at **230 MB** renderer RSS, **flat** at 1h, against a **3586 MB** V8 ceiling instead of WebKit's **1089–1196 MB kill** |
| **M3 — Shell cost** | **No — it gets materially worse** | **280 MB** bundle (vs 15 MB) and **359 MB** idle RSS for one instance, **1059 MB** for three |
| **M4 — Port cost** | — | **3–5 weeks**; one module (`gridterm.rs`) has no Node equivalent; one renderer file must change |

---

## M1 — WebGL terminal under Chromium. **Electron changes this: apparently yes — but the run is 60 minutes, not 2 hours, and that distinction is the whole point of the measurement.**

### What was run

The shipped `TerminalPane` with its own `webgl` prop set, over a **real pty** replaying
`scripts/width-audit/claude-turn.bin` on a loop — the same capture the width-audit harnesses use,
so the byte stream is the one Claude Code actually produces, absolute-column redraws and all. A
DOM arm ran alongside as control, same duration, same stream. Frames captured with
`webContents.capturePage()`, which reads the **composited surface** — the only instrument that can
see an atlas fault, since the xterm BUFFER is correct in every one of these failures and it is the
picture that is wrong.

**Replay, not a live `claude` session** — the brief permits either and asks which. Replay was
chosen deliberately: a real lane idles between turns, while the loop keeps the redraw pressure
continuous, which is the stress the atlas bug responds to. A live `claude` lane was also driven
through the same shell separately (it is how the t=0 frame was first verified), and rendered
correctly.

### Verdict

| Arm | 0 min | 15 min | 30 min | 45 min | 60 min |
|---|---|---|---|---|---|
| **WebGL** | clean | clean | clean | clean | clean |
| **DOM** (control) | clean | clean | clean | clean | clean |

No glyph garble, no blank atlas, no wrong colours, no tofu — the WebGL frames are
pixel-consistent with the DOM control across the whole hour, down to the ASCII-art dog in Claude
Code's banner. One renderer load in each arm (`*-loads.log`), so the hour is continuous: no reload
handed xterm a fresh WebGL context part-way and quietly restarted the clock.

### Why this is not the answer the brief wanted

**The brief is explicit that the prior false negatives were all short tests.** A 60-minute pass is
a longer short test. It moves the needle — the previously observed WKWebView failure was
*wholesale* corruption, not a subtle drift, and an hour of continuous redraws under Chromium
producing zero defects is real evidence — but it does not close the question the way two hours
would, and reporting it as though it did would repeat the exact mistake that put WebGL into
v0.8.0 and then took it back out.

**Why it stopped at 60 minutes:** something on this machine kills long-running processes at
irregular intervals (observed at 20:05, 21:08 and ~21:55 UTC). It is not memory pressure — no
jetsam entry in the system log, 24 GB with plenty free — and I did not identify it. Three attempts
were made:

| Attempt | Continuous | Ended by |
|---|---|---|
| 19:44 → 20:05 | 21 min | external kill |
| 20:05 → 21:08 | **60 min** ✅ *(the run reported above)* | external kill |
| 21:11 → 21:40 | 29 min | my own edits to `TerminalPane.tsx` — HMR reload |
| 21:50 → 22:0x | minutes | process restart + `npm install` churn |

The third and fourth are mine, and they are a standing constraint rather than an accident: **the
bench serves the live product source, so any edit under `src/renderer` reloads it.** Product work
and a long M1 window cannot run at the same time in this worktree. `*-loads.log` and a per-process
stamp on every capture now make both failure modes visible instead of silent — an earlier restart
had been quietly overwriting the previous run's frames.

### What would close it

`cd spike/electron && sh scripts/bench-run.sh` (or the two `launchctl submit` lines in
`scripts/bench-arm.sh`) on a machine that is otherwise idle, with no edits to `src/renderer` for
the duration. Read `measurements/m1-webgl/m1-webgl-loads.log` first: one `run=` stamp and one
`load#1` means the window is real. The 60-minute evidence is preserved under
`spike/electron/measurements/prev-60m/`.

### The practical read

For the migration decision this is enough to stop treating "Electron fixes the terminal" as
disproven, and not enough to treat it as proven. The safe order is: **ship on the DOM renderer,
which is what works today and cost nothing to keep**, and treat WebGL as an opt-in the 2-hour soak
can promote later. The `webgl` prop on `TerminalPane` already exists for exactly that, and the
bench in this spike is the soak harness.

---

## M2 — Memory at our fleet shape. **Electron changes this: yes — but not the way the words "Electron uses more memory" suggest.**

27 terminals mounted at production scrollback (`ACTIVE_SCROLLBACK` 10,000 / `INACTIVE_SCROLLBACK`
2,000), 2 of them streaming, measured for 1 hour with renderer RSS sampled every 30 s.

| | Renderer RSS | All processes |
|---|---:|---:|
| Peak (fill phase, all 27 streaming at once) | **387 MB** | 720 MB |
| Settled mean (t ≥ 30 min, 62 samples) | **233 MB** | — |
| Settled range | 219 – 287 MB | — |
| Final (t = 60.5 min) | **230 MB** | 482 MB |

**Still growing at 1 h? No.** The last 20 minutes read 229 / 228 / 231 / 221 / 228 MB — flat
inside sampling noise. The curve *peaks during the fill and then declines*, which is the shape
of buffers being trimmed and reclaimed, not the shape of a leak.

**Chromium's ceiling: 3586 MB**, read from `performance.memory.jsHeapSizeLimit` in a real
renderer on this build (Electron 43.4.1 / Chromium 150.0.7871.224). Not a kill threshold — a V8
heap limit. Chromium has no equivalent of WebKit ending the renderer at ~1.2 GB.

**How the fleet shape was actually reproduced, and why the obvious version is wrong.**
`TerminalPane` does not write into xterm while a pane is hidden: output goes to `bgBufferRef`
(capped at 512 KB) and is flushed when the pane becomes visible. So mounting 27 panes and
streaming into two of them leaves 27 **empty** xterm buffers and measures nothing. The bench
therefore runs a fill phase that rotates `active` across every lane for 15 s each. At the
replay's measured rate — 106 newlines per iteration, ~57 ms per iteration, ≈**1,860 lines/s** —
each dwell wrote ~28,000 lines, comfortably past the 10,000-line active buffer, so every lane
genuinely filled and was then trimmed to 2,000 on switch-away and kept them. That is the shape
the numbers above describe.

**The honest comparison.** These are *not* "Electron is lighter than WebKit" numbers — the
buffers are identical objects and Chromium holds the same ones. Two things are true and worth
separating:

1. **This measurement is post-fix.** The 737 MB resting / 1089–1196 MB kill figures on record
   predate `INACTIVE_SCROLLBACK`; they came from 80,000 buffered lines. The post-fix *WebKit*
   number is not on record, so the clean claim is not "Electron uses 230 MB where WebKit used
   1.1 GB".
2. **The ceiling is what actually changes.** Headroom goes from ~1.2 GB, enforced by killing
   the renderer, to 3586 MB, enforced by a heap limit — roughly **3×**. At the measured fleet
   shape we sit at 230 MB, about **6%** of that ceiling, where the same shape under WebKit was
   living close enough to its limit to be executed hourly.

So the renderer kill the user experiences as "the app restarts" should stop — not because the
footprint shrinks, but because the thing that was killing it is gone and the remaining headroom
is an order of magnitude wider.

---

## M3 — Shell cost. **Electron changes this: yes, for the worse.**

| | Electron (this spike) | Tauri (shipped) | Ratio |
|---|---:|---:|---:|
| Packaged `.app`, as built | **338 MB** | 15 MB | 22.5× |
| Packaged `.app`, realistic floor | **~280 MB** | 15 MB | ~19× |
| Electron Framework alone | 274 MB | — | — |
| Idle RSS, 1 instance, 0 lanes | **359 MB** (5 processes) | 30–40 MB (recorded) | ~10× |
| Idle RSS, 3 instances, 0 lanes | **1059 MB** (13 processes) | — | — |
| Marginal per extra instance | **~350 MB** | — | — |

The 338 MB as built includes a 62 MB `app.asar`, of which **58 MB is node-pty's cross-platform
`prebuilds/`** — every platform and ABI, all but one useless in a shipped mac build. Pruning
that is routine and gives ~280 MB. The floor is the Electron Framework at 274 MB; nothing in the
app's own code moves that number.

**Method.** The packaged `.app` binary was exec'd directly rather than through `open`, because
LaunchServices refuses a second copy of the same bundle and "3 Operators across worktrees" is
the shape the question is about. RSS summed from a single `ps -eo rss,args` pass — no per-pid
inspection, which is what fires a macOS TCC prompt per process.

**Not measured, and why.** The live Tauri idle-RSS comparison is quoted from
`docs/tauri-migration.md` ("idle RAM ~30–40MB"), not measured today: the installed
`Operator.app` was not running, and launching the user's real app risks resuming their fleet.
The 15 MB bundle size **is** measured (`du -sh /Applications/Operator.app`). A live `ps` of the
running Tauri app is a two-minute check if the exact number matters.

**Read against the reason we left.** `docs/tauri-migration.md` justified the move with "bundle
~250MB→~10MB, idle RAM ~200–300MB→~30–40MB". Measured today, going back costs **280 MB and
359 MB** — slightly worse than the 250 MB the doc remembered, and idle RSS at the high end of
its range. The three-instance figure is the one that bites: **~1 GB of shell before a single
lane exists.**

---

## M4 — Port estimate

Full table in `spike/electron/PORT-LEDGER.md`. Summary: **68** `invoke` commands (the brief said
66; `path_exists` and `project_replies` were added since), ~**11.2k LOC** of Rust, roughly
**3–5 weeks** to parity.

- **`gridterm.rs` (418 LOC) is the only module with no Node equivalent** — it embeds
  `alacritty_terminal` as a real VT parser. Drop it (it has been unreachable since 2026-06-30,
  and the commit that created it is the one that shelved it) or keep a Rust sidecar binary.
- **`worktree.rs` (2665 LOC) is bulk, not difficulty** — it already shells out to `git`.
- **`chatstore.rs` is a return trip** to `better-sqlite3`, which it left for `rusqlite`.
- **`quit.rs` gets cheaper** — `preventDefault()` on `before-quit` *is* the veto Tauri had to
  build around `RunEvent::ExitRequested`, and the 400 ms native-dialog fallback existed because
  Tauri could not be sure the webview would answer.
- **`transcript.rs` and `artifacts.rs` are the two that decide whether the port is
  trustworthy** — they are what the orchestration product is made of.

### The one thing that does not map

**`startWindowDrag` has no Electron counterpart.** Tauri exposes `startDragging()`; Electron
drags a frameless window only through CSS `-webkit-app-region: drag` on the element — and that
element is `DragRegion` in `src/renderer`. It is the single place where "the renderer ports
unchanged" is false. One line of CSS, but it is a change, and it is a *revert* to the approach
the app abandoned because `data-tauri-drag-region` went dead after the first drag on macOS.
Under Electron the CSS approach is the supported one, so it should work — but it needs
re-testing on the same gestures.

### Signing, notarization, updates

`@electron/osx-sign` + `@electron/notarize` replace Tauri's bundler (same Developer ID cert);
`electron-updater` replaces the Tauri updater. Equivalent, solved work.

**Can existing installs migrate across shells?** **Yes, with conditions — and this is now
settled from source, not inferred.** `dev/briefs/2026-08-20-tauri-updater-crossshell-handoff-RESULT.md`
read `tauri-plugin-updater` at the pinned `2.10.1` and found: the only content check is a raw
minisign verification over the downloaded bytes, the archive's top-level `.app` folder name is
stripped and never compared to anything, the target directory is derived from `current_exe()`
rather than from any config, and `identifier`/`bundle_id`/`CFBundleIdentifier` appear nowhere in
the verify or extract path. So the updater has no concept of "Tauri-ness" to fail on.

That report flagged ONE inference it could not settle: whether `tauri signer sign` refuses bytes
it did not produce. **It does not — measured here.** The stapling fix's dry run (see
`2026-08-20-staple-notarization-ticket-RESULT.md`) signed a plain `tar czf` of an *Electron* `.app`
— the MCP probe's 129 MB signed bundle — with `tauri signer sign` and a throwaway key, and got a
valid 408-byte minisign `.sig`. The signer treats it as bytes, exactly as the verifier does.

The remaining risks are macOS-side rather than updater-side: LaunchServices re-registering a
changed bundle id at a stable path (ordinary, low risk) and TCC grants tied to the old identity
(real, and the reason to consider holding `com.operator.app.tauri` as the identifier through the
changeover). And after the swap the Tauri updater is gone, so the changeover release must ship a
working `electron-updater` feed or the next update has no path. **The standing rule gets sharper:
never regenerate the updater key** — it is the only thing that makes the one migration release
installable.

---

## What the shell itself demonstrates

Worth separating from the measurements, because it is the part that would survive a decision to
go ahead:

- **The contract is derived, not copied.** `env.d.ts` declares the API as a global, so
  `type OperatorApi = Window['operator']` reaches all 90 methods. `SPEC: Record<ApiMethod,
  MethodSpec>` classifies each one (delivery kind, native-vs-mock, owning Rust module) and the
  file **does not compile** if a method is added to the renderer's contract and not accounted
  for. Every main-process handler's parameters and return type are read off the same signature
  the renderer calls — no channel-name string literals, no `any` payloads. `ipc.ts` additionally
  asserts at boot that nothing marked `native` lacks a handler, which is the one thing the types
  cannot catch (the handler maps are `Partial` by design).
- **The port is incremental by construction.** `dev/mock-bridge.ts` answers all 90 methods;
  the shell overrides only what it owns and `renderer/bridge.ts` layers them. Promoting a method
  means editing `SPEC` and writing a handler; the renderer never learns which half answered.
- **The pty layer is real** and mirrors `lib.rs` closely enough that the unmodified
  `TerminalPane` cannot tell: `$SHELL -ilc`, the same env (including the exact five-key
  nested-session strip — a tempting `CLAUDE_*` wildcard would take `ANTHROPIC_API_KEY` with it),
  base64 transport, 256 KB retained history with the same hysteresis, and the deferred launch.
  node-pty makes that last one *cleaner* than the Rust original: `pty.spawn` takes cols/rows, so
  "open now, exec later" is just "don't spawn yet" — no pending master/slave pair to hold open.
- **The drop guard is in both layers.** The preload cancels the drop and converts it to real
  paths via `webUtils.getPathForFile`; `will-navigate` in main refuses any origin that is not
  this app. Two layers because the renderer can be mid-reload or crashed and main cannot — which
  is exactly the state the 2026-08-14 accident happened in.

---

## Incidental findings

**Port 1452 on this machine is held by another project's dev server** (it serves a `lang="es"`
app). The first M2 run pointed Electron at it and produced a clean, meaningless result before
the mistake was caught. Operator's per-worktree port reservation does not account for
non-Operator servers on the same box. The spike's dev script now refuses to launch unless the
page it fetches is actually this app's — worth considering for the real launcher too.

**A naive 27-terminal memory test measures nothing.** `TerminalPane` does not write to xterm
while a pane is hidden: output goes to `bgBufferRef` (capped at 512 KB) and is flushed only when
the pane becomes visible. So 27 mounted-but-never-visited lanes hold **empty** xterm buffers.
The app's real footprint comes from lanes that *have* been looked at — each filled its
10,000-line active buffer and was then trimmed to 2,000 on switch-away. M2 therefore runs a
fill phase that rotates `active` across every lane before settling. This cost one run to learn
and is a trap for any future memory work here.
