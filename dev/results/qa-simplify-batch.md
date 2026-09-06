# Result — QA of `operator/e78fc0` (QA lane), 2026-09-05

Brief: `dev/briefs/qa-simplify-batch.md`. **Pinned to `402b8e1`** — the branch this brief describes
("7 commits; results in `dev/results/*.md`"). Worked in the existing shared worktree at
`/Users/juanmnl/.operator/worktrees/operator-e78fc0`.

**⚠ The branch moved twice during this run**, both times from another lane committing in the
*same shared worktree* directory while my session had files sitting in its working tree:
`operator/e78fc0` went `03c41a8 → 402b8e1` (mid-setup) → `5c9a25d` (after I'd already run every
suite and driver below), the second jump adding an entire Tuning-page feature plus a
"review-simplify-batch" fix-up — none of which this report covers. **That later commit also swept
up my throwaway `dev/qa-real-fixture.json`** (431 KB of real private chat history I'd regenerated
for item 2) into its tree. Flagged to the Code lane directly (`OPERATOR-REPLY`): this repo is
public on GitHub, so that file must come out of history before `operator/e78fc0` is pushed or
merged. Everything below is otherwise unaffected — none of the files item 1–5 exercise were
touched by that second commit except `port-alloc.ts`/`terminals.ts`/`DashboardView.tsx`, which
picked up unrelated Tuning-page hooks; re-run item 5 if that matters before merge.

## Summary

| # | Item | Verdict |
|---|---|---|
| 1 | Every test suite + Playwright harness | **PASS** — all green except one pre-existing, unrelated dead harness |
| 2 | Toolbar model/effort chips (dev/qa-real bridge) | **1 real bug found** — model chip leaks a previous lane's value across a same-cwd sibling switch |
| 3 | Dev servers panel (fixture ps table, all 4 owner classes + postgres-with-tags) | **PASS** — no defects |
| 4 | Spawn argv (operator vs code role) | **PASS** — no defects |
| 5 | Port allocation against real sockets | **PASS** — no defects |

---

## 1. Every suite and harness

| Command | Result |
|---|---|
| `npm test -- --run` (renderer) | **1018 pass / 0 fail**, 71 suites |
| `cd electron && npm test -- --run` | **450 pass / 0 fail**, 24 suites |
| `cargo test --manifest-path src-tauri/Cargo.toml` | **183 pass / 0 fail**, 3 ignored |
| `npm run verify:visual -- --port 5817` | **PASS** (default `#term` glyph capture) |
| `npm run verify:input -- --port 5818` | **PASS**, 6/6 assertions |
| `npm run verify:resize -- --port 5901` | **FAIL — pre-existing, unrelated.** `scripts/ghostty-resize/harness.ts` imports `ghostty-web`, which is not in `package.json` on this branch or on `main`. This is the shelved native-terminal spike (`project_ghostty_terminal`, marked DEAD in project memory), not a regression from this branch. |
| `npm run verify:resize-guard -- --port 5902` | **PASS** |
| `npm run verify:width -- --port 5903` | **PASS**, all rows |
| `OPERATOR_DEV_PORT=5907 npm run verify:dom` | **PASS**, 0 mismatched rows / 30 |
| `OPERATOR_DEV_PORT=5908 npm run verify:ghost` | **PASS**, 0 mismatches across 9 scenarios × 2 fixtures |

**Harness lost to the chat.html deletion:** `node scripts/visual/capture.mjs --page chat --sel "#chat"` now times out (`page.waitForFunction: Timeout 30000ms exceeded`) — `scripts/visual/chat.html` and `chat-harness.tsx` were deleted along with the Chat view, exactly as `dev/results/remove-chat-files.md` records. Nothing else in `package.json` referenced it, so no script definition needed removing.

Total: **1651 automated test-suite assertions pass, 0 fail**; one harness fails for a reason that predates this branch.

---

## 2. Toolbar model/effort chips — driven through `dev/qa-real.html`

New driver: `dev/drive-tuning-chips.mjs` (committed alongside this report). Regenerated the fixture
first (`node dev/qa-extract-real.mjs`, real `~/.operator` data — **deleted after this run**, see the
flag above about it leaking into a later commit), then `npx vite --port 5920` +
`MOCK_PORT=5920 node dev/drive-tuning-chips.mjs`.

**11 of 13 checks pass:**
- `/model opus\r` and `/effort high\r` are sent to the terminal as bare typed lines — confirmed
  byte-exact, confirmed not wrapped in a `\x1b[200~…\x1b[201~` bracketed-paste sequence.
- Both `PopMenu` panels carry `data-no-drag`, and picking a value never calls the window-drag
  bridge (`startWindowDrag`) — the menus are not drag handles.
- The chip persists correctly on the ordinary path: pick a value, leave for Project Home, come
  back to the **same** session — chip still reads the picked value.

**1 real bug (2 failing assertions), found via the brief's own "survives a tab switch" ask:**

> Switching from a tuned lane to a **different, untuned lane that shares the same working
> directory** leaves the Model chip showing the *previous* lane's value.

Repro: open lane BIG (`terminalId=t-qa-big`, same cwd as lane LONG), set its model to Opus via the
chip. Switch to lane LONG (same directory, no model ever set on it) — the sidebar's active-row
highlight correctly moves to LONG (confirmed by reading each row's computed background), but the
Model chip keeps reading **"Opus"** instead of resetting to the "Model" placeholder. Reproduced
deterministically 3 times.

**Root cause**, `src/renderer/components/session/SessionToolbar.tsx`:
```js
useEffect(() => {
  if (modelProp) setModel(modelProp)
}, [modelProp])
```
This has no branch for `modelProp` going falsy. Two lanes in the same directory share **one**
`SessionToolbar` instance because it is keyed by `key={activeSession.workingDirectory}` — so
switching between them re-renders the same component with new props instead of remounting it, and
this effect only ever writes a *truthy* incoming model over the stale local state.

The Effort chip does **not** show the same symptom, but only by accident: its own effect reloads
from `folderPrefsLoad()` on every `[projectPath, effortLevelProp]` change regardless of
truthiness, which happens to overwrite the stale value. There is no equivalent fallback for the
model chip.

**Impact:** any project where two lanes share a working directory (no worktree, or a plain
second terminal in the same folder) can show a wrong model on the toolbar after switching between
them — the exact kind of silent-lie-in-the-UI this feature exists to prevent (it is, after all,
the surface for "which model is this lane burning tokens on").

**Fix sketch** (not applied — brief said no code changes outside `dev/`): add the missing `else`
branch, mirroring the effort effect:
```js
useEffect(() => { setModel(modelProp ?? null) }, [modelProp])
```

---

## 3. Dev servers panel — fixture `ps` table, all four owner classes + postgres-with-tags

New harness: `dev/qa-devservers.html` + `qa-devservers-main.tsx` (mounts the real
`WorktreesSection` standalone against a fixture). New driver: `dev/drive-devservers.mjs`. The
fixture (`dev/qa-devservers-fixture.json`) was generated by running the **real classifier**
(`electron/src/main/dev-servers.ts`'s `devServerInventory`) over a fabricated `ps -eww -o
pid,pgid,command -E` table via `parseTaggedTable`/`parsePsTable` from `reap.ts` — not hand-authored
`DevServerProc` objects — so the UI test exercises the real attribution rules end to end.

Fixture covered, and classified correctly:
- **dead-app** (tagged, `OPERATOR_APP_PID` of a dead Operator)
- **abandoned-lane** (tagged, this app, terminal not open)
- **live-lane** ×2 (tagged, terminal open now; and tagged with a *different but currently-alive*
  Operator's app pid)
- **untagged** — a plain `vite` under a known project root, no tag at all
- **postgres-with-tags** — `postgres -D … -p 5433` carrying an inherited `OPERATOR_TERMINAL_ID`
  with **no** `OPERATOR_APP_PID`, exactly the scenario the module's own header comment warns
  about. Confirmed it **is listed** (a tagged row bypasses the dev-server-shape regex, so
  `postgres` shows up despite matching no server pattern) and correctly classified `untagged` —
  "No Operator tag" / "nothing proves Operator started it" — **never** one of the two "safe to
  stop" labels.
- The `--mcp-serve` artifact helper (also tagged) is correctly **excluded** entirely.

All 16 driver assertions pass:
- No select-all control anywhere in the panel; every row's checkbox is independent and starts
  unchecked.
- The trigger button reads "Stop 2 selected" (counts the picks, never "all").
- Confirm wording matches exactly: *"2 processes and everything under them will be stopped. 1
  belongs to a lane that is open right now — its preview will stop working."*
- **Cancel kills nothing** — `devServerKill` called zero times, both checkboxes remain checked.
- Confirming calls `devServerKill` exactly once, with exactly the two picked pids and no others.

No defects found in this panel.

---

## 4. Spawn argv — operator role vs. code role

Verified end-to-end through the **real** chain `rolePresets()` → `resolveAgentConfig()` →
`buildArgs()` / `buildSessionSettings()` (the same path `DashboardView.tsx`'s
`handleLaunchSession` and `terminals.ts` walk), via a throwaway vitest file
(`electron/src/main/_qa-spawn-args.test.ts`, run and deleted — not left in the tree).

**Operator role:**
```
settings: {"tui":"default","remoteControlAtStartup":true}
argv:     ["--session-id", "<uuid>", "--model", "fable", "--effort", "medium",
           "--remote-control", "operator · Operator", "Fix the thing"]
```
- `remoteControlAtStartup` is `true` and the key is present (own-property checked, not just
  truthy).
- `--remote-control` is immediately followed by the name, and the name is immediately followed by
  the prompt — the exact adjacency `remote-control-operator-only.md` added a test for (an
  optional-argument flag with nothing after its name would otherwise swallow the prompt as the
  name).

**Code role:**
```
settings: {"tui":"default","remoteControlAtStartup":false}
argv:     ["--session-id", "<uuid>", "--model", "opus", "--effort", "high", "Fix the thing"]
```
- `remoteControlAtStartup` is `false` **and present as an explicit key** (the deliberate exception
  to "drop keys that carry nothing" — an absent key would fall through to Claude Code's
  currently-auto-ON org default).
- No `--remote-control` flag at all — correct, since a non-coordinator role gets no phone-visible
  name.

`mcpConfigArg` also checked: packaged form omits the app-path argv entry, dev form includes it —
both are valid JSON with the expected `command`/`args` shape.

No defects found.

---

## 5. Port allocation against real sockets

Verified `allocatePort` (`electron/src/main/port-alloc.ts`) against the **real** `isPortFree`
(`port-probe.ts`, real TCP binds on both loopbacks) via a throwaway vitest file
(`electron/src/main/_qa-port-alloc.test.ts`, run and deleted).

Procedure, matching the brief exactly:
1. Scanned the real window (1420–1520) for the first genuinely free port and **bound a real
   `net.Server`** on it (the "throwaway server" / stranger) — port **1423** on this run (1420–1422
   were already held by other real processes on this machine).
2. Allocated for lane A1 in `/cwd/A` → **1424** (skipped the stranger, confirmed independently free
   via a second real `isPortFree` check).
3. Allocated for lane A2, same cwd → **1424** again, `shared: true` (correct same-cwd sharing;
   nothing is bound there yet so the sibling reservation is reused).
4. Allocated for lane B1, a **different** cwd → **1426** (1425 was also already held by another
   real process on this machine — consistent with the port-allocation-fix result doc's own
   finding), independently confirmed free, and distinct from both A's port and the stranger's.

Assertions: the stranger's port is never handed to anyone; the two same-cwd lanes get the identical
port with `shared: true`; the different-cwd lane gets its own, unshared, genuinely-free port. No
defects found — this closes out the exact 2026-09-05 double-allocation/stranger-port failure the
brief and `port-allocation-fix.md` describe.

---

## Commands used (for re-running)

```
cd /Users/juanmnl/.operator/worktrees/operator-e78fc0   # shared worktree, HEAD 402b8e1 when tested
npm test -- --run
(cd electron && npm test -- --run)
cargo test --manifest-path src-tauri/Cargo.toml
npm run verify:visual -- --port 5817
npm run verify:input -- --port 5818
npm run verify:resize -- --port 5901          # pre-existing FAIL, see above
npm run verify:resize-guard -- --port 5902
npm run verify:width -- --port 5903
OPERATOR_DEV_PORT=5907 npm run verify:dom
OPERATOR_DEV_PORT=5908 npm run verify:ghost

node dev/qa-extract-real.mjs                  # regenerates dev/qa-real-fixture.json (delete after)
npx vite --port 5920 &
MOCK_PORT=5920 node dev/drive-tuning-chips.mjs
node dev/drive-devservers.mjs                 # MOCK_PORT=5920, same server

# items 4 and 5 were throwaway vitest files under electron/src/main/_qa-*.test.ts,
# run with `npx vitest run <file> --reporter=verbose` from electron/, then deleted.
```

## Not done

- Items 2's driver and 3's driver/fixture/harness are committed under `dev/` as instructed
  (`drive-tuning-chips.mjs`, `qa-devservers.html`, `qa-devservers-main.tsx`,
  `drive-devservers.mjs`, `qa-devservers-fixture.json`). Items 4 and 5 were one-off vitest files,
  deleted after use since they duplicate real-source assertions rather than adding a reusable
  fixture — the interesting artifact is this report, not the script.
- No GUI verification beyond what these headless drivers exercise — per `feedback_env_constraints`,
  a real window is the user's to check.
- The one real bug (§2) was not fixed — brief said no code changes outside `dev/`.
- `operator/e78fc0` moved to `5c9a25d` during this run (see the flag at the top); that later work
  is unverified.
