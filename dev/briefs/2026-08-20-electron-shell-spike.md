# Brief — Electron shell spike: would going back to Electron actually buy what we think?

**Throwaway spike. Touch NOTHING under `src/` or `src-tauri/`.** All code lives under
`spike/electron/` with its own `package.json` (root `package.json` stays untouched).
Output: **`dev/briefs/2026-08-20-electron-shell-spike-RESULT.md`** — numbers, not opinions.
Budget: 1–2 days. If something is taking longer, write what you have and stop.

## Context — read these first, they narrow the question a lot

The user is weighing a return to Electron (we left it 2026-06-15, `docs/tauri-migration.md`).
Two facts already settled that you must NOT re-investigate:

1. **WebGL xterm in WKWebView is dead** — `dev/webgl-terminal-in-wkwebview.md` and
   `dev/briefs/2026-08-04-terminal-research-v2-RESULT.md`. But that research also found VS Code
   hits the same atlas-corruption under **Chromium** with Claude-Code-shaped output
   (xterm.js#5847). So "Electron fixes the terminal" is a hypothesis, not a fact. Test it.
2. **The hourly renderer kill (~1.1–1.2 GB) is OUR scrollback baseline, not a WebKit leak** —
   `dev/briefs/2026-08-06-renderer-heap-RESULT.md`: `ACTIVE_SCROLLBACK=10_000` +
   `INACTIVE_SCROLLBACK=2_000` × every mounted lane across all projects (27 at measurement).
   Chromium would hold the same buffers; it just doesn't kill its renderer at 1.2 GB. So the
   question is "what does the same footprint cost under Chromium, and what is the ceiling" — not
   "does the leak go away".

The renderer is 29k LOC of React behind ONE seam: `window.operator` (shape in
`src/renderer/env.d.ts`, 90 methods; Tauri impl in `src/operator-bridge.ts`). A complete fake of
that seam already exists: **`dev/mock-bridge.ts`** (+ `dev/mock-main.tsx`, `dev/mock.html`) boots
the real App in a plain browser. **Reuse it.** Your Electron bridge = mock-bridge for everything
EXCEPT the terminal, which you implement for real.

## Build (the minimum that makes the measurements real)

- `spike/electron/`: Electron (latest stable) + `node-pty` + a tiny main process exposing over IPC
  exactly the terminal subset: `terminalSpawn/Write/Resize/Kill/List/History` +
  `onTerminalData/onTerminalExit`. Mirror the arg/return shapes in `env.d.ts` and the
  base64 transport the renderer expects (see `terminalWrite`/`onTerminalData` in
  `src/operator-bridge.ts` — `base64ToBytes`, `createWriteQueue`). Spawn a real
  `claude --session-id <uuid>` the way `buildArgs` (`src/renderer/lib/launch-args.ts`) does, login
  shell and all, so real Claude Code streams into the real `TerminalSurface`.
- `spike/electron/renderer-main.tsx`: copy of `dev/mock-main.tsx` that installs
  `{ ...mockBridge, <real terminal methods> }`. Vite root = repo root so `src/renderer` imports
  resolve; do not edit `vite.config.ts` — use a spike-local config.
- Two renderer modes, switchable by env var: **DOM** (what ships) and **WebGL**
  (`@xterm/addon-webgl` is already in root `package.json`, unused; the guard that refuses it is in
  `TerminalSurface.tsx`/`TerminalPane.tsx` — you may bypass it ONLY via the spike's own copy of the
  option, never by editing those files).
- A packaged `.app` (electron-builder or `@electron/packager`, unsigned is fine) so bundle size and
  cold-start RSS are real, not dev-mode.

## Measure (this is the deliverable)

**M1 — WebGL terminal under Chromium on real Claude Code, long-running.** The prior false negatives
were all short tests; the failure shows up in *sustained* sessions. Run ≥2 h of a real `claude`
lane doing real work (or replay `scripts/width-audit/claude-turn.bin` through the pty in a loop for
the same duration — state which). Screenshot every 15 min; note any glyph garble, blank atlas,
wrong colours. Run the DOM mode as control for the same duration. Verdict per mode.

**M2 — Memory at our fleet shape.** Mount 27 terminals with the production scrollback sizes
(`src/renderer/lib/terminal-options.ts`), 2 of them streaming (replay is fine), for 1 h. Log
renderer-process RSS every 30 s (Electron: `process.getProcessMemoryInfo()`/`ps` on the Helper
(Renderer)). Report: resting RSS, peak, whether it is still growing at 1 h, and what Chromium's
actual ceiling is (V8 heap limit / any kill behaviour you can find for macOS). Compare to the Tauri
numbers on record (1089/1196 MB kills; 8 MB/lane close delta).

**M3 — Shell cost.** Packaged `.app` size; idle RSS (all processes summed) of 1 instance with 0
lanes, and of 3 instances at once (the user runs 3+ Operators across worktrees — this is the reason
we left, `docs/tauri-migration.md`: "bundle ~250MB→~10MB, idle RAM ~200–300MB→~30–40MB"). Compare
to the current Tauri build (`du -sh` the installed `Operator.app`; `ps` the running one).

**M4 — Port estimate, from having done the hardest piece.** Table of the 66 `invoke` commands in
`src/operator-bridge.ts` grouped by Rust module (`lib.rs` 2780 LOC, `worktree.rs` 2665,
`transcript.rs` 1638, `planlimits` 625, `chatstore` 545, `gridterm` 418, `mcp` 337, `quit` 324,
`artifacts` 271, `agents` 235, `usage` 452, `folderprefs` 175, `core` 458): Node equivalent,
effort (S/M/L), anything with no equivalent (gridterm's `alacritty_terminal` grid is one). Plus:
signing/notarize/updater (today: Tauri updater + `latest.json` on `juanmnl/operator-releases`) —
what replaces it and whether existing installs could even be migrated across shells.

## Report shape

TL;DR verdict first: for each of M1–M3, "Electron changes this: yes/no/partially — number". Then
the tables. Be explicit about what you could not measure and why. Leave the spike runnable
(`cd spike/electron && npm i && npm run dev`) so the user can see it.
