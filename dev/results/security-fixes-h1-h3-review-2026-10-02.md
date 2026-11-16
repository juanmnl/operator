# Review: security fixes H1–H3 (branch `operator/bbc780`) — 2026-10-02

**Branch:** `operator/bbc780`, commits `10affd4` (H2), `8939826` (H1), `177ddd8` (H3) and `311eaeb` (result), checked against `dev/results/security-audit-2026-10-01.md`.

**Method:**
- Read the full diff (`git diff main...operator/bbc780`).
- Read the surrounding code: every pty writer, the pick handler and card, the tailer's replay and dedupe, and `buildArgs` and its caller in `terminals.ts`.
- Ran the suites on a `git archive` export of the branch in the scratchpad. The main checkout was not touched.
- Ran edge-case probes against the branch's own modules, and one argv probe against the installed `claude` 2.1.287. That probe used a blocking `UserPromptSubmit` hook and a nonexistent model, so no model request was made.

## Verdict

**Merge: yes.** The fixes do what they claim, and every change is strictly safer than `main`. Nothing legitimate broke in what I could test.

One residual weakness in H1 (R1) should be fixed soon, but it does not need to block the merge. The rest are Low.

## Tests

| Suite | Result |
|---|---|
| Renderer (root `npx vitest run`) | 113 files, 1675 tests passed |
| Electron (`electron/ npx vitest run`) | 45 files, 809 tests passed |
| Root `npx tsc --noEmit` | exit 0 |

The counts match Code's write-up.

## Findings

### R1. Medium, CONFIRMED (code). The confirm card can hide most of the note the user approves

**Where:**
- `AppPreviewPanel.tsx` (pending-note card, branch ~`:1000-1018`) shows the note in a box with `maxHeight: 120, overflow: 'auto'`.
- `src/shared/preview-inspector.js:95-100` looks up `window.__operatorBeacon` at call time, in the page's own main world.

**Scenario:**
1. The user types "make the button blue" into the in-page Inspect card.
2. The previewed page has already replaced `window.__operatorBeacon` (or `JSON.stringify`). It appends 40 newlines and an instruction to the user's own text.
3. Operator's card shows the first few lines, which are the user's words, and the rest needs a scroll.
4. The user clicks → Console, and the lane receives the hidden instruction.

The page can also pad a self-posted pick the same way. Measured with the branch's own `acceptPick` and `formatPick`: such a note is 43 lines, and the 120 px box shows about 7 of them.

Hiding is easier still with characters that `stripControlChars` deliberately keeps:
- Bidi overrides (`U+202E`/`U+202C`) display the text reordered.
- Zero-width characters (`U+200B`, `U+FEFF`) are invisible.

Both pass through unchanged (probe output below).

**Why it is not a merge blocker:** before this branch the same text was sent with no card at all. After it, sending needs a click.

**Fix (Code):**
- Make the card show the whole note, with no inner scroll, or say "N lines, M characters" and expand by default past a threshold.
- Collapse runs of three or more blank lines.
- Remove or make visible the bidi controls (`U+202A–202E`, `U+2066–2069`) and zero-width characters (`U+200B–200D`, `U+FEFF`) in the card. Better still, remove them in the text that is sent too.

### R2. Low, CONFIRMED. A page can switch off Inspect notes until the panel remounts

**Where:** `AppPreviewPanel.tsx`, `handlePick`:
1. It sets `pickPendingRef.current = true` before the async block.
2. The async block calls `formatPick(p)`.
3. `formatPick` runs `(p.message || '').trim()` (`preview-pick.ts:~36`), which throws when `message` is a number or an object.
4. The rejection is unhandled. `setPendingPick` never runs, so no card appears, and `clearPendingPick` is only reachable from the card.
5. `pickPendingRef` stays `true`, and every later pick is dropped by `acceptPick`.

**Probe:** `formatPick(acceptPick('{"message":1}', …))` threw `(p.message || "").trim is not a function`.

**Impact:** the page can turn Inspect notes off; it gains nothing else.

**Fix:**
- In `acceptPick`, keep only string fields (and finite numbers in the boxes).
- Wrap the async block in `try/finally` so the ref is reset on failure.

### R3. Low, CONFIRMED (mechanism). Changed directive ids can replay old dispatches once after upgrade

**Where:**
- `electron/src/main/directives.ts`: `parseDirectives` now strips control characters, and `parseDispatches` adds `Task: `. Both happen before `directiveId(sessionId, role, task)` in `transcript.ts:595`.
- The tailer re-reads a resumed lane's transcript from offset 0 (`Track.offset = 0`, `transcript.ts:169`) and emits every directive again.
- The renderer dedupes only through the `localStorage` seen list `operator.dispatch.seen` (`DashboardView.tsx:2275-2280`), keyed by that id.

**Scenario:** after the upgrade, a resumed lane re-reads an old `OPERATOR-DISPATCH [x] -…` line, or a line whose body held a control character. It now gets a new id that is not in the seen list, so the dispatch fires a second time, prefixed `Task: `. This only affects bodies that started with `-` or carried a stripped character, so it is rare.

It is the same class as the existing 500-entry cap on the seen list, which already lets very old directives replay.

**Fix:** either of these:
- Compute the id from the unmodified body, and apply the strip and prefix after the id.
- On a seen-list miss, also check the id the old parser would have produced.

### R4. Low, CONFIRMED. One pty writer still sends unstripped external text: dropped file names

**Where:** both of these write `bracketedPaste(paths.join(' '))` with no stripping. This is the audit's L3, and the branch did not change it.
- `DashboardView.tsx:726` → `writesForDroppedPaths` (`paste-image.ts:82-95`).
- `TerminalPane.tsx:277, 696`. The temp path there embeds `extFor(f)`, taken from the dropped file's own name (`paste-image.ts:17-23`). `savePastedImage` does not clean `ext` (`ipc.ts:371`).

**Scenario:** a file name containing `ESC[201~`, dragged by the user onto a lane, ends the paste early. This needs the user to drop a crafted file.

**Fix:**
- Route these writes through `stripControlChars`.
- Limit `ext` to `[a-z0-9]{1,8}`.

**The other writers were checked and are not exposed:**

| Writer | Why it is not exposed |
|---|---|
| `submitTyped` / `typedSequence` | Callers are only `SessionToolbar.tsx:176, 184`, sending `effortCommand(level)` and `modelCommand(id)`, which are Operator-built strings |
| `clearComposerSequence` | Constant bytes |
| `interrupt.ts:16` | Constant bytes |
| xterm `onData` (`TerminalPane.tsx:325`, `GridTerminalPane.tsx:331`) | The user's own keystrokes |
| `bench.tsx` | Dev only |

### R5. Low, PLAUSIBLE. A pending note follows the panel, not the lane it came from

**Where:** `sendPendingPick` calls the current render's `onDispatch`. That routes to the `session.terminalId` of the moment of the click (`DashboardView.tsx:5353`). `renderPreview` mounts `AppPreviewPanel` with no `key` tied to the session.

**Scenario:** if React reuses the instance when the user switches sessions while a note waits, the note goes to the newly shown lane. It is still visible in the card, but it is no longer the lane that was being inspected.

**Fix:** store the `terminalId` with the pending note and send to that one, or clear the note when `terminalId` changes.

## Checked and clean

### H2

- **Rule:** `stripControlChars` (`src/shared/control-chars.ts`) removes C0 except `\t` and `\n`, plus DEL and C1 (`U+0080–U+009F`, including `U+009B`, the single-character CSI). It turns `\r\n` and lone `\r` into `\n`.
- **Probe output** (branch modules):

  | Input | Output |
  |---|---|
  | `日本語テキスト` | unchanged |
  | `emoji 👩‍💻🚀` (with ZWJ) | unchanged |
  | `tab\there\nline` | unchanged |
  | `crlf\r\nx` | `crlf\nx` |
  | `c1 \u009b201~ nel\u0085` | `c1 201~ nel` (`hasControlChars` true) |
  | `latin é ñ  nbsp` | unchanged |
  | bidi and zero-width characters | unchanged (see R1) |

- **Coverage:** `submitSequence` (`submit-queue.ts:25`) is used by every `submitQueue.submit` caller:
  - dispatches into live workers, replies into the coordinator, reused-lane dispatches;
  - retry, after the constant clear sequence;
  - report announcements and Preview notes.

  `attachImages` (`:323`) strips the joined paths.
- **MCP:** `mcp-serve.ts:304` refuses `dispatch`/`reply` with control characters in `lane` or `body`, before a request row is opened. A test confirms no row is created. `\r` is allowed and then normalised in `submitSequence`, which is consistent.
- **Sentinel:** `directives.ts:86-87` strips both the target and the body.
- **Delivery confirmation still matches:** `normalizeTurn` strips before collapsing whitespace, so a sent `a\x1b[201~b` and its recorded turn both normalise to `a[201~b`. The new case in `delivery-confirm.test.ts` passes.

### H1

- **Gate:** `acceptPick` requires Inspect on, no note pending, and a JSON object, and it removes `target`. `PreviewPick.target` is gone from the type.
- **Inspect cannot be set by the page:**
  - `inspecting` is set only by `setPointerMode`, from the segment's `onClick` (branch `:619-622, :906`), and turned off by Annotate.
  - No IPC, menu command or page message sets it.
  - It is not persisted.
- **The card is outside the page:** it is a sibling rendered before the stage container in Operator's own DOM. The cross-origin iframe cannot click it, focus into it or cover it.
- **No auto-focus:** neither button has `autoFocus`, so Enter in the page cannot reach them. A page cannot move focus into the parent document.
- **No swap while pending:** a second pick while one waits is dropped rather than replacing it. The ref is set before the screenshot await, so a pick in that gap is dropped too.
- **CDP path:** `preview-cdp.ts` → `index.ts:336` → `onPreviewPick` reaches the same `handlePick` and gate.
- **CSS-controls panel:** `PreviewEditPanel` already required a click, and its text now goes through the stripped `submitSequence`.

### H3

- **Placement:** `launch-args.ts:68` pushes `'--', prompt` as the last two tokens. In `terminals.ts:292`, `[...prefix, ...o.args]` puts Operator's own flags first and appends nothing after `o.args`, so `--` is always directly before the prompt.
- **Single builder:** the only prompt-carrying argv builder is `buildArgs`. Its only `initialPrompt` source is `DashboardView.tsx:2990`.
- **Resume:** `--resume <id>` with a prompt goes through the same function, and the id is always present as its value.
- **Every flag ahead of `--`:** `--resume`, `--session-id`, `--dangerously-skip-permissions`/`--permission-mode`, `--model`, `--effort`, `--allowedTools <variadic>`, `--name`, `--remote-control <name>`.
- **My probes of the installed `claude` 2.1.287**, adding to Code's p1–p9:

  | Probe | argv | Recorded prompt |
  |---|---|---|
  | a1 | `--allowedTools Bash Read -- 'hello after variadic'` | `'hello after variadic'` (the variadic option stops at `--`) |
  | a2 | `--allowedTools Bash Read -- --dangerously-skip-permissions` | `'--dangerously-skip-permissions'` |
  | a3 | `--append-system-prompt note --mcp-config {…} --allowedTools Bash --name probe--code -- -x` | `'-x'` |

  Before this branch, a prompt that followed `--allowedTools` with no later flag would have been taken as a tool name. The `--` fixes that as well.
- **Second guard:** MCP `dispatch` refuses a task starting with `-`, and the sentinel prefixes it with `Task: `. Bodies are trimmed first, so leading whitespace does not get around this. The id change is R3.

## Not covered

- Interactive (non `-p`) `claude` argv parsing. Same parser, not run.
- GUI behaviour of the card (layout, narrow widths, stage re-fit). That is the user's GUI check list in Code's write-up.
- Audit probe P1 (whether `ESC[201~` + `!cmd` actually runs in a live lane). It is now unreachable from the patched paths except R4.

## Recommended follow-ups (not dispatched)

- **Code:** R1 (card shows the full note and makes bidi and zero-width characters visible), R2 (`acceptPick` type checks + `try/finally`), R3 (id from the unmodified body), R4 (strip dropped paths, limit `ext`), R5 (pin the note to its terminal).

None of these blocks the merge.
