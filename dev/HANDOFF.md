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

## Ready for 0.17.2 — two branches VERIFIED against their briefs, NOT merged (user's call)

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

Merging both + bump to 0.17.2 mirrors the 0.17.1 flow (`~/.operator/briefs/electron-0.17.1-merge-bump.md`
is the template; bump = `electron/package.json` + lock only; tag `electron-v0.17.2` is the user's push).

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
