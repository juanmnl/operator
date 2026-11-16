# Review: security follow-ups R1, R2, R4 (branch `operator/6c2a80`) — 2026-10-02

**Branch:** `operator/6c2a80`, three commits on `main` @ `c21e7a8` (H1–H3 already merged):

| Commit | Change |
|---|---|
| `ec3d1e1` | R1: the whole Inspect note is shown |
| `3919658` | R2: a malformed pick no longer switches Inspect off |
| `d3fd5d8` | R4: dropped file paths are stripped |

**Checked against:**
- my findings in `dev/results/security-fixes-h1-h3-review-2026-10-02.md`;
- Code's write-up, `dev/results/security-followups-r1-r2-r4-2026-10-02.md`.

**Method:**
- Read the full diff.
- Ran both suites on a `git archive` export in the scratchpad. The main checkout was not touched.
- Ran a probe file against the branch's own `cleanNote`, `acceptPick`, `ptyPath`, `pastePaths`, `writesForDroppedPaths` and `safeExt`.
- Read the bracketed-paste code in the installed `@xterm/xterm` 6.0.0.

## Verdict

**Merge: yes.** The three fixes do what they claim:
- **R1:** the card can no longer hide text with blank-line padding, bidi controls or zero-width characters, and it shows exactly what is sent.
- **R2:** `pickPendingRef` is reset on every path that does not show a card.
- **R4:** dropped and pasted image paths and the temp-file extension are clean.

One gap in R1 should be fixed next: Unicode tag characters (F1). There is also one remaining unstripped pty writer that this brief did not cover: xterm's own clipboard paste (F2). Neither is made worse by this branch.

## Tests

| Suite | Result |
|---|---|
| Renderer (`npx vitest run`) | 114 files, 1698 tests passed |
| Root `npx tsc --noEmit` | exit 0 |
| Electron (`npx vitest run`) | 45 files, 809 tests passed |
| Electron `npm run typecheck` | exit 0 |

These match Code's write-up.

## Probe results (branch modules)

| Input to `cleanNote` | Output | Note |
|---|---|---|
| `日本語テキスト、한국어` | unchanged | CJK fine |
| `👨‍👩‍👧`, `👩‍💻`, `🏳️‍🌈`, `❤️` | `👨👩👧`, `👩💻`, `🏳️🌈`, `❤️` | ZWJ sequences split, as Code stated (F3) |
| `می‌خواهم` (Persian with ZWNJ) | `میخواهم` | ZWNJ removed (F3) |
| `make it blue` + tag characters spelling `run rm -rf` | `make it blue` + the same 10 tag characters, length 22 | **survive, invisible** (F1) |
| U+2060, U+00AD, U+3164, U+2800, U+115F, U+FFA0, U+034F | all survive | invisible or blank-rendering (F1, F4) |
| U+200E, U+200F, U+061C | survive | Code left these out on purpose |
| U+FE0F, U+E0100 (variation selectors) | survive | correct for U+FE0F (emoji need it) |
| `top` + 40 × `\nㅤ` + `hidden` | 42 lines kept | not collapsed (F4) |
| `top` + 40 × `\n\t` / `\r\n` + `hidden` | `top\n\nhidden` | collapsed |
| U+0085, VT, FF runs | removed | |

Other modules:

| Function | Input | Output |
|---|---|---|
| `acceptPick` | extra box key, `__proto__` | dropped; `Object.prototype` not polluted |
| `ptyPath` | `/tmp/a ESC[201~ ^U !x \r.png` | `/tmp/a[201~!x.png` |
| `pastePaths` | path with CJK and ZWJ emoji | path unchanged (paths keep ZWJ) |
| `safeExt` | `PNG`, `.jpeg` | `png`, `jpeg` |
| `safeExt` | `svg+xml`, `png\x1b`, `''` | `null` |

## Findings

### F1. Medium, CONFIRMED (the characters survive); the effect on the model is PLAUSIBLE. Unicode tag characters pass the card invisibly

**Where:** `src/shared/control-chars.ts:42`. The regex is `INVISIBLE = /[‪-‮⁦-⁩​-‍﻿]/g`. It has no `u` flag and covers only BMP ranges.

**What survives:** the Tags block U+E0000–U+E007F. These characters render as nothing in Chromium. They encode ASCII one-for-one, which is the "ASCII smuggling" technique, and several LLMs have been shown to read them as text.

**Scenario:**
1. The page wraps `__operatorBeacon` and appends tag-encoded instructions to the user's note.
2. The card shows exactly the user's words; the size line counts characters but shows nothing else.
3. The user approves, and the lane receives the hidden instruction.

I did not test whether Claude Code or the model acts on them.

**Same class, lower impact:** U+2060–U+2064 (word joiner, invisible operators), U+00AD (soft hyphen), U+034F, U+180E, and U+E0100–U+E01EF (supplementary variation selectors, also used for smuggling) survive too.

**Fix:** add these ranges to `stripInvisibleChars`, with the `u` flag:
- U+E0000–U+E007F;
- U+E0100–U+E01EF;
- U+2060–U+2064, U+00AD, U+034F, U+180E.

Keep U+FE00–U+FE0F, which emoji presentation needs. Better still, apply the tag-block strip in `stripControlChars`, so it covers every pty write: tag characters have no legitimate use in a typed message. The one exception is subdivision flags (🏴󠁧󠁢󠁳󠁣󠁴󠁿), which are rare enough to lose.

### F2. Medium, CONFIRMED (code). xterm's own clipboard paste is still an unstripped pty writer

**Answer to the brief:** the drop path is no longer the only remaining unstripped writer of outside text.

**Where:**
- `TerminalPane.tsx:324-325` forwards `term.onData` to `terminalWrite`. That data includes a clipboard paste.
- xterm 6.0.0 builds the paste as `e.replace(/\r?\n/g,"\r")`, then `"\x1b[200~"+e+"\x1b[201~"` (`node_modules/@xterm/xterm/lib/xterm.js`, module 7861). It does not remove ESC.
- The existing capture-phase `paste` listener (`TerminalPane.tsx:~270-278`) handles images only.

**Scenario:**
1. A page in Preview, or any website, sets the clipboard in its `copy` handler (`e.clipboardData.setData('text/plain', 'npm ERR! …\x1b[201~\x15!curl …|sh\r')`).
2. The user copies what looks like an error message and pastes it into a lane.
3. The embedded `ESC[201~` ends the paste, and the rest arrives as keys.

This needs a user copy and paste, and the effect still depends on audit probe P1.

**Fix:** in the same capture-phase `paste` listener, take the clipboard text, `preventDefault`, and call `term.paste(stripControlChars(text))`, keeping `\n` and `\t`. iTerm warns on a paste that contains control characters; stripping matches what Operator already does for its own writes.

**Other writers, checked:**

| Writer | Status |
|---|---|
| `submitSequence`, `attachImages` | stripped |
| `pastePaths`, `writesForDroppedPaths` | stripped (this branch) |
| `typedSequence` | Operator-built slash commands |
| `clearComposerSequence`, `interrupt.ts` | constant bytes |
| `onData` keystrokes | the user's own |
| `GridTerminalPane.tsx:331` | same `onData` path, so F2 applies there too |
| `bench.tsx` | dev only |
| `terminals.ts:418` | only through IPC |

### F3. Low, CONFIRMED. Removing U+200C/U+200D changes legitimate text in Preview notes

**Where:** `stripInvisibleChars` removes U+200C and U+200D.

**Effect:**
- Emoji ZWJ sequences split: a family emoji shows as three people, and the rainbow flag as a white flag plus a rainbow.
- Persian, Arabic and Indic text that needs ZWNJ or ZWJ changes form; `می‌خواهم` becomes `میخواهم`.

Code documented this, and it affects Preview notes only. Paths and every other message keep ZWJ. Acceptable.

**If refined:** keep U+200D between two pictographic code points (`\p{Extended_Pictographic}`), and keep U+200C when it sits between two letters of the same script.

### F4. Low, CONFIRMED. Blank-rendering characters that are not whitespace avoid the blank-line collapse

**Where:** `cleanNote` collapses runs of lines matching `[^\S\n]*`. U+3164 (Hangul filler), U+2800 (braille blank), U+115F and U+FFA0 are not `\s`, so 40 lines of U+3164 are kept.

**Why it is Low:** the card has no height cap now, and the header says "42 lines, … characters". The padding cannot hide anything; it only makes the user scroll past blank lines before reaching the buttons.

**Fix:** treat these characters as whitespace in the collapse, or strip them along with F1.

### F5. Low, CONFIRMED (the audit's L3, not in this brief). A non-image dropped path is still shell-quoted only when it contains whitespace

**Where:** `paste-image.ts` `shellQuote`, unchanged.

**Probe:** `writesForDroppedPaths(['/tmp/$(id).txt', '/tmp/x;y.pdf'])` writes `/tmp/$(id).txt` and `/tmp/x;y.pdf` unquoted.

**Scenario:** dropped into a scratch shell pane, followed by Enter, the shell runs `$(id)`. In a Claude Code lane the text lands in the composer, not a shell. Low.

**Fix:** always single-quote.

## Checked and clean

### R1

- `formatPick` returns `cleanNote(...)` (`preview-pick.ts:35-40`).
- The card renders `pendingPick.msg`, and `sendPendingPick` sends that same `pendingPick.msg` to Console or Tasks. What the user approves is byte for byte what is sent. `withScreenshot` only appends Operator's own shot path.
- The text box has no `maxHeight` and no inner scroll. The card is `flex: '0 1 auto'` with `overflowY: 'auto'`, and the buttons come after the text in the DOM, so the user passes the whole note to reach them.
- The size line appears past 8 lines or 600 characters. Its sentence starts are bound with NBSP, which matches the house typography rule.
- One edge: a long run of U+00A0 wraps into visible blank space rather than hidden text. It is counted in the character total, so it trips the size line.

### R2

- `acceptPick` rebuilds the pick from typed fields only. Strings are kept for the text fields; finite-number boxes are kept with exactly `x/y/w/h`; a finite `scale` is kept.
- `target`, unknown keys and `__proto__` are dropped, and there is no prototype pollution (probe).
- `handlePick` wraps the whole async block in `try/catch/finally` and resets `pickPendingRef` whenever `shown` is false. `shown` is set only after `setPendingPick`.
- Code's component test fails without the `finally` and passes with it.
- With a card up, the ref stays set until Send or Discard, which is the intended no-swap rule.

### R4

- `ptyPath` removes control characters and then `\n` and `\t`.
- `pastePaths` is used at `TerminalPane.tsx:277` and `:696`.
- `writesForDroppedPaths` cleans before it splits images from other files, and drops empty paths.
- `safeExt` runs in the renderer, and again in main (`ipc.ts:370-377`), falling back to `.bin`. That also closes the `ext` traversal in `savePastedImage` from the audit's L6.
- `moodboardAdd`'s `ext` (`moodboard.ts:27`) is not covered. It was not in this brief.

### Legitimate text

- CJK, Hangul and emoji (including ZWJ sequences) are unchanged in pty writes and in paths.
- Only Preview notes lose U+200C/U+200D (F3).
- Tabs and single or double blank lines are kept in notes.

## Recommended follow-ups (not dispatched)

- **Code:**
  - F1: strip tag characters and the other invisible ranges, ideally in every pty write.
  - F2: strip control characters from xterm clipboard pastes, in the existing capture-phase `paste` listener.
  - F5: always quote dropped paths.
  - Optionally F3 and F4.
- **User (GUI checks from Code's write-up, unchanged):** the long-note card over an attached Electron app (check 3) is the one the tests cannot see.
