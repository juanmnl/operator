# Handoff — 2026-09-01

**`main` = `2a7157a`, pushed. 0.20.0 is PUBLISHED and LIVE** (tag `electron-v0.20.0`, run
33571557155 green 5m30s). Verified past the green check: `operator-releases` `v0.20.0` is
`draft:false`; `latest-mac.yml` serves **0.20.0** with sha512 (the Electron feed); swap
`latest.json` serves **0.20.0** with a darwin-aarch64 **signature** (408 B); both updater assets
return **HTTP 200** at full content-length. Every 0.19.x install will be offered it.

Final gates on `main`: renderer **1042 pass / 33 pre-existing fail**, electron **426 / 0**,
cargo **179 / 0**, root `tsc` + electron typecheck + `npm run build` all clean.

**⚠ THE ONE THING TO DO FIRST: nothing in 0.20.0 has been GUI-verified.** No human has hovered a
real orb or watched a lane launch with `--effort` in a real window. It is published anyway, on the
user's explicit go-ahead. The effort change decides **how every agent starts** — exercise that
first. Clean path back is `git revert 2a7157a` + a `0.20.1` tag.

## What 0.20.0 was: Operator's model/effort handling had drifted from the CLI

Audit trigger: "models have been updated from Claude, how is Operator handling this?"

**Model handling was already right and needed nothing.** Launch passes an ALIAS
(`launch-args.ts` → `--model fable|opus|sonnet|haiku`), so the CLI resolves the newest point
release itself; labels and rates are family substring matches, so `claude-opus-5` /
`claude-fable-5-1` resolve with no table entry; the transcript's dated id is display-only and is
never fed back into a relaunch. **Do not "fix" this into a dated table.**

Three commits, each verified by re-running the gates rather than reading the lane's report:

1. **`ffb9253` — effort ladder.** Operator offered `high|normal|low`. Claude Code's settings schema
   is `effortLevel: enum(["low","medium","high","xhigh"]).catch(undefined)` — **an out-of-enum value
   is silently dropped**, no error. `normal` was never a level, so the `operator` and `design`
   lanes (both shipped `effort:'normal'`) never ran at the effort the UI claimed. New
   `src/renderer/lib/effort.ts` owns the ladder: `migrateEffort` (`normal`→`medium`, migrate not
   re-default), `settingsEffort` (**the ONE** `max`→`xhigh` clamp), `effortCode` (L/M/H/XH/MAX —
   `effortLevel[0]` stopped identifying once `medium` and `max` coexist). `ClaudeSettings.effortLevel`
   is typed `SettingsEffortLevel`, so **the type system now refuses a `max` write to a settings file**.
   Migration touched 26 stored values (6 roster pins, 5 project defaults, 15/53 saved sessions).
   ⚠ **`--effort` accepts `max`; the settings.json enum does NOT.** That asymmetry is the trap.
2. **`70da6a8` — orb hover.** Hovering a lane shows MODEL and EFFORT in both rail states, each row
   labelled `RUNNING` or `AT LAUNCH`. `lib/lane-meta.ts` owns the provenance rules;
   `LaneMeta.tsx` renders both widths from one component.
3. **`1ed9af2` — usage rates.** `rates()` returns a **triple** (input, output, cacheRead) in
   `electron/src/main/usage.ts` **and** `src-tauri/src/usage.rs` — keep them in step.
   `sonnet-5` → 2/10 matched before bare `sonnet` → 3/15; `fable-5-1` cache reads 0.25 flat;
   fast-mode Opus → 10/50. Bare-alias ambiguity resolves **pessimistically** (higher rate) on
   purpose: under-reporting is the failure this module refuses.

## Findings worth not re-deriving

- **`usage.speed` IS persisted** by Claude Code on every real assistant record (confirmed
  independently: 128,956 `standard`, 22 null = `<synthetic>`, **zero `fast`**, across 7,029 files).
  Fast-mode billing is implemented and correct; it changes no number today.
- **The money was in Sonnet, not Fable.** Replaying the whole corpus: −$538.83 of a $20,157.89
  all-time total (−2.67%), all from 26,417 `claude-sonnet-5` rows. The Fable cache-read fix moves
  **$0.00** today — every Fable row on disk is `claude-fable-5`, not `5.1`. It becomes worth
  ~$7,825 the day 5.1 traffic appears (10.4B cache-read tokens on Fable).
- **CI log line "Swap feed NOT published (dry run)" is NOT a failure.** It is a skipped step. The
  swap feed still reads the new version because `releases/latest/download/` resolves to the newest
  non-draft release. Don't chase it next release. Likewise `Operator.app.tar.gz.sig` is absent as a
  *file* on operator-releases and should be — the signature lives inside `latest.json`.
- **The user's `~/.claude/settings.json` now sticks.** The launch path no longer writes it at all.
  It currently reads `effortLevel: "medium"` (set deliberately). Before this release, every lane
  launch overwrote it — observed happening live mid-session.

## Two things this session proved WRONG that were previously believed

- **`session.model` is NOT the transcript's ground truth in the UI.** `DashboardView:3028` merges
  `model: t.model ?? hookSession.model` — the **launch config wins**, deliberately (it stops a fresh
  `/model` switch being reverted by a lagging transcript). The observation is carried separately as
  `AgentSession.runningModel`. A brief asserted the opposite and would have shipped the launch
  config labelled "RUNNING"; the lane checked and pushed back. **A brief's stated ground truth is a
  hypothesis.**
- **`project_hover_card_stuck`'s "the sidebar rail has none of it" is now stale.**
  `lib/use-hover-card.ts` was rewritten around one `openFor` field; `installHoverCloseListeners()`
  installs every dismiss path at module scope (`blur`, `resize`, `visibilitychange`, `mouseout`
  guarded on null `relatedTarget`, `documentElement` `mouseleave`, capture `scroll`/`keydown`).
  The untested gap was the **wiring**, not the reducer — a `close` event was proven to close a card,
  but nothing proved a pointer leaving the window ever produced one.
- **`MOCK_SESSIONS[].model` was lying** — it fed both the observer and the launch config with the
  same alias, so the divergence case could not be staged and the mock asserted a reality that does
  not exist (observer models are full ids, never aliases). Now split.

## Open, non-blocking

- **GUI verification of 0.20.0** (above) — the only real item.
- **`HARD_FALLBACK.effort` deliberately left at `'high'`** (`model-config.ts`). It is reached only
  by preset-less custom lanes; `xhigh` is Anthropic's *coding-specific* recommendation and this
  fallback covers every lane type. One line to change if the user disagrees.
- **Version drift, intentional:** root `package.json` + `src-tauri/*` are still **0.16.0** while the
  app ships 0.20.0. The Electron workflow reads **only** `electron/package.json`; the Tauri
  `build.yml` (`v*` tags) is the legacy path. Harmless; don't fix it inside a release commit.
- **33 pre-existing renderer failures** in 5 files (`forgotten-projects`, `ghost-probe`,
  `lane-accents`, `rail-foot`, `terminal-options`) — all jsdom/`localStorage` environment errors,
  unrelated to any of this work. They were the baseline before and after.
- CI Node-20 deprecation warnings on `actions/checkout@v4` / `setup-node@v4` (still green).

## Where things are

Briefs `dev/briefs/{effort-ladder-update,orb-hover-model-effort,usage-rates-refresh}.md`;
results `dev/results/` same names. Lane branches `operator/101200` and
`design/orb-hover-model-effort` are **merged and fast-forwarded into `main`** — linear history,
no merge commits. Release notes live at `electron/release-notes/<VERSION>.md`; **CI hard-fails if
the file is missing**, and the tag version must equal `electron/package.json`.

---

# Previous handoffs

# Handoff — 2026-08-24

**`main` = `d26dfce`, pushed. 0.17.1 is PUBLISHED and LIVE** (tag `electron-v0.17.1`, run
32660149264 green ~5.5m, 2026-08-23 19:05Z). operator-releases `v0.17.1` serves BOTH feeds:
`latest.json` 0.17.1 signed (Tauri copies) + `latest-mac.yml` 0.17.1 (Electron copies). Every
0.17.0 will offer 0.17.1 once and then stop self-offering. Root `npm test` 798 · `tsc` clean ·
`electron/` 226 + typecheck clean. Working tree: the user's own `.gitignore` edit — leave it.

## What 0.17.1 was: the first week of Electron in the wild

The user found six regressions in the shipped 0.17.0 in one sitting; all fixed, verified in
source by Operator, released as one tag:

1. **Self-update loop** — `updater.ts` read `updateInfo.version`, never `isUpdateAvailable`;
   electron-updater fills `updateInfo` in both directions, so 0.17.0 offered itself on every
   launch (toast stacked ×4). Now gated + `app.getVersion()` belt-and-braces (`e7bf2cf`).
2. **Traffic lights big** — the port reinstated `hiddenInset` + `trafficLightPosition{14,18}`,
   the override Tauri dropped in `63a55ae`. `hiddenInset` is the TOOLBAR variant. Now
   `titleBarStyle:'hidden'` = Tauri's Overlay; centres (16,16)/(39,16)/(62,16). ⚠ The 12pt
   legacy SIZE is not recoverable — modern-linked framework metric, Swift-probed; plist doesn't move it.
3. **No tray** — never ported. Now `tray.ts` + `tray-anim.ts` (template PNG inside app.asar
   read via fs; Quit via `app.quit()` so QuitGuard vetoes; animation pulls from the same
   `liveLanes()` as the guard; skipped on `--mcp-serve`).
4. **`claude: command not found` (Plan usage) + worktree setup** — `/bin/sh` hardcoded where
   Tauri used `$SHELL`; `sh -l` never reads `~/.zshrc`. Now `login-shell.ts` in both call sites.
5. **Rail vs lights** — `RAIL_W` 60→70 (modern 14pt cluster spans 9→69), constants in
   `rail-metrics.ts`; card lid stays at 8 (decided + gated in `drive-rail-invariant.mjs` — a
   14px lid was tried and reads as a broken corner). The "don't retune from dev" comment is
   inverted: Electron dev and packaged draw the SAME cluster.
6. **Drop/paste double delivery** — a drop hit BOTH the preload window listener (quoted real
   path) and the pane's bytes→bracketed-paste route (`[Image #N]`). Probe in real Electron 43:
   only DROP double-fired; paste never did (capture-phase preempts xterm). Fixed with
   `stopPropagation` in `handleDrop`; paste hardened (`stopImmediatePropagation`); images
   dropped ANYWHERE now become `[Image #N]` via `paste-image.ts`.

## 0.18.0 — 2026-08-25 (tag `electron-v0.18.0`)

Everything merged 2026-08-24 on `main` (`08b5e1d`), QA-verified headlessly (`dev/results/qa-*.md`):
- Title-bar drag (Electron `-webkit-app-region`), tray icon 20→18pt, rail hover cards (one controller).
- Dev-server reaper (pgid tree kill, `~/.operator/dev-leases.json`, boot sweep — legacy orphans NOT reaped).
- Worktree reaper: classifier + dry-run plan + Settings → Worktrees; `AUTO_REAP_ON_TRIGGERS=false`.
- Agent comms reconnected: `--mcp-config` wired, tools are `mcp__operator__report`/`task_status`
  (were doubled), report lifecycle + Inbox/Outbox panel, dispatch drop leaves a trace, per-thread hops.
- Session env + skills S0–S3 (per-session settings FILE, Environment + read-only Skills pages).
- Code navigator S1–S4 (Files in main view + right panel, CodeMirror 6; search/deep links pending).
- Preview: server attribution tiers + path survives port change (minimal address bar).
- Syntax ink tokens per palette with a 4.5:1 test.
⚠ Nothing above has been seen in a real window — see the eyeball list in the Obsidian hub note.

## 0.17.2 — SHIPPED 2026-08-24 (tag `electron-v0.17.2`, both branches merged; feeds verified)

- **`operator/26b80` @ `607979d` — Preview bleed.** The active terminal painted THROUGH the
  preview iframe (Chromium OOPIF; WKWebView's opaque frame masked it). Fix: `pane-visibility.ts`
  — the active pane is `visibility:hidden` under any Chat/Preview overlay (no resize, so the
  never-resize rule holds). PROOF: `electron/probes/preview-bleed.cjs` captures with
  `capturePage()` and pixel-counts the selection colour — user's screenshot reproduced
  (76377px), 0px with the fix; exits non-zero on bleed. 798 root + 226 electron green.
  ⚠ The BLACK stage is NOT ours: mantel's app fails to MOUNT when framed (frame console
  captured; the probe's control page proves capturePage sees OOPIF content). An easy follow-up
  if wanted: Preview shows "the app didn't mount" instead of a black rectangle.
- **`operator/rail-orbs-mute` @ `1455efe` — resting orbs recede.** All rest states unified at
  `REST_OP` 0.25 (was waiting .58 / idle .42 / error .5); running 0.95 is now the only bright
  thing; ΔE + luminance ratios derived across all 4 themes (Light was the risk; initial stays
  crisp). ⚠ Deliberate cost, flagged for the user: the waiting-vs-idle notch measured invisible
  (ΔE 5.3 on 1984 Light), so it was dropped — **"waiting on you" currently has NO rail signal**
  (the 6s pulse beacon still fires on entry). If that information matters, it needs a MARKER,
  not a brightness notch. 760 green + the known 33 jsdom/Node-26 localStorage failures.

Merged, bumped, tagged and published 2026-08-24 (run 32736637878). The two ⚠ flags above remain
live questions: the black-stage notice follow-up, and the missing waiting signal on the rail.

## User eyeball checks pending (need a real window — install 0.17.1 first)
1. Traffic lights at (16,16)/(39,16)/(62,16), zoom 17pt clear of the card; the "bump" gone.
2. Tray: icon in the menu bar, twinkles when a lane runs, menu lists sessions, Quit asks.
3. Plan usage card populates; paste/drop a screenshot → ONLY `[Image #N]`.
4. On `operator/rail-orbs-mute` (`cd electron && npm run dev`): one running lane is the only
   bright orb, on Mission Control AND Light.

## ⚠ Operator defect surfaced by dogfooding this week
**2 of ~9 OPERATOR-DISPATCH lines vanished with ZERO trace in any lane jsonl** (login-shell,
preview-bleed — both re-dispatched successfully later when the lane was idle). Distinct from the
known brake/HOP_LIMIT stall ([[project_delivery_brakes_stall]]): these left no queue-operation
either. Until fixed, a coordinator must grep lane transcripts for the brief filename after every
dispatch. Not yet on the board as its own investigation — the user was asked, no answer yet.

## Direction notes from this session
- **IDE question** ("what about adding an ide?"): recommended NO embedded editor (orchestrator,
  not harness; Orca-breadth is the wrong race). Instead: (a) "Open in editor" on projects +
  lane worktrees (only Reveal-in-Finder exists today), (b) Diff-panel line comments that become
  `OPERATOR-DISPATCH` lines, (c) maybe Claude Code's own `/ide` per lane. Not yet briefed.
- Light-theme screenshots came from the packaged app — the user does switch themes; check both.

## Where things live
Briefs + OUTs: `~/.operator/briefs/electron-*.md`, `rail-*.md`. Screenshot stash:
`/tmp/operator-shots/`. Hub note updated through 2026-08-23. Memory index: RESUME line points here.
