# Result — Electron shell spike

**Status: M2, M3 and M4 are complete below. M1 is still running (2h window, started 20:05 UTC
2026-08-20, closes ~22:05) and will be added when it closes.**

The spike lives at `spike/electron/` and is runnable: `cd spike/electron && npm i && npm run dev`.
Nothing under `src/` or `src-tauri/` was touched. Per the change of intent mid-task, it is built
as the **seed of a real shell** rather than a throwaway — see `spike/electron/README.md` for the
architecture and `spike/electron/PORT-LEDGER.md` for M4 in full.

---

## TL;DR

| | Electron changes this? | Number |
|---|---|---|
| **M1 — WebGL terminal under Chromium** | *pending* | 2h run in progress; DOM control arm alongside |
| **M2 — Memory at our fleet shape** | **Yes — the ceiling moves, the buffers don't** | 27 lanes rest at **230 MB** renderer RSS, **flat** at 1h, against a **3586 MB** V8 ceiling instead of WebKit's **1089–1196 MB kill** |
| **M3 — Shell cost** | **No — it gets materially worse** | **280 MB** bundle (vs 15 MB) and **359 MB** idle RSS for one instance, **1059 MB** for three |
| **M4 — Port cost** | — | **3–5 weeks**; one module (`gridterm.rs`) has no Node equivalent; one renderer file must change |

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

**Can existing installs migrate across shells?** *Probably, once, through a one-way door.* The
Tauri updater verifies the payload against the baked-in minisign key and replaces the `.app` in
place without inspecting its contents — so an Electron `.app` with the same bundle id and
Developer ID should install over it like any other update. **This is an inference from how the
updater works, not something this spike tested**, and getting it wrong strands every installed
copy. After the swap the Tauri updater is gone, so the changeover release must ship a working
`electron-updater` feed or the next update has no path. The standing rule gets sharper: **never
regenerate the updater key** — it is the only thing that makes the one migration release
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
