# Terminal scrollback on long-running lanes — pipeline trace (2026-09-25)

Read-only. No code changed, nothing launched or killed. Checkout at `65ffdd2` (0.26.0 + hub-note
commit). Claude Code checked against the installed binary, 2.1.282. xterm is `@xterm/xterm` 6.0.0.

## Summary

- History exists in two places. **xterm in the renderer** keeps 10,000 lines for the pane on screen and
  2,000 for every other pane (`terminal-options.ts:125,158`). **Electron main** keeps 256 to 512 KB of raw
  pty bytes per lane (`terminals.ts:34,778-787`). That byte buffer is only read back after a renderer reload.
- **The main reason long sessions have little scrollback is upstream.** In classic mode, when Claude
  Code 2.1.282 resets its frame it blanks the visible rows in place and never pushes them into scrollback
  (verified again against 2.1.282 below). No setting in Operator's pty pipeline can restore lines that
  were never sent.
- **The largest loss Operator causes itself:** a pane that stops being `active` has its xterm history
  cut to 2,000 lines right away, and the lines do not come back. `active` goes false when you switch lanes,
  **when you open Preview on the same lane**, and **when the lane ends**.
- **Renderer crash (Electron):** main only logs it, and nothing reloads the window. After ⌘R, every
  pane's history is rebuilt from the last 256 to 512 KB of pty bytes. The replay starts at an arbitrary
  chunk, so it can open mid-escape-sequence. It also loses the terminal modes Claude set once at startup:
  bracketed paste, focus reporting, and for fullscreen lanes, the alt screen and mouse tracking.
- **App restart or lane suspend:** all pty history is lost. The only way back is `claude --resume`
  re-rendering the conversation (not verified what it prints).
- **Memory is bounded, not growing per hour.** Every buffer in the pipeline has a cap. For 13 lanes the
  estimated total is about 80 MB in the renderer and about 7 MB in main. The live renderer is at 800 MB
  after 3 days, so terminal buffers account for about 10% of it.

---

## 1. The pipeline, stage by stage

| # | Stage | Where | What it keeps | Bound |
|---|---|---|---|---|
| 1 | node-pty `onData` → `Buffer` → base64 IPC | `electron/src/main/terminals.ts:347-352` (lanes), `:385-390` (shells) | nothing; forwards every chunk | — |
| 2 | Main-side history | `terminals.ts:778-787` `pushHistory`, cap `:34` | raw bytes, as a list of whole pty chunks | grows to 2 × 256 KB, then drains to ≤ 256 KB. So **256 to 512 KB** at any moment |
| 3 | History read | `terminals.ts:548-551` `history(id)` → `ipc.ts:171` | concatenation of (2) | — |
| 4 | Bridge decode | `electron/src/renderer/bridge.ts:73-79` | one streaming `TextDecoder` per terminal id | — |
| 5 | Pane subscribe + replay | `src/renderer/components/terminal/TerminalPane.tsx:515-537` | `pending[]` until the history fetch settles | short-lived |
| 6 | Hidden-pane buffer | `TerminalPane.tsx:74-79`, `lib/hidden-output.ts:19-35`, `BG_CAP` `TerminalPane.tsx:25` | output of a pane that is not active | ≤ 512,000 chars, then written to xterm in full (no drop since `df8802a`) |
| 7 | xterm buffer | options `terminal-options.ts:327`; trim `:198` via `scrollbackFor` `:162` | parsed cells | 10,000 lines active / 2,000 inactive, plus `rows` |
| 8 | Transcript tailer (not the pty) | `electron/src/main/transcript.ts:26-35` | last 80 narration entries in the live payload; full history goes to `~/.operator/chat.db` via `chat-store.ts` | durable |

`TerminalSurface.tsx:37` passes `replayHistory` unconditionally, so **every** xterm pane fetches main
history when it mounts, not only re-attached ones. The prop's doc (`TerminalPane.tsx:31-34`) and the
comment at `:527-528` say fresh launches skip it, which is no longer true. It is harmless in practice
because a fresh lane's pty is not exec'd until the pane fits (`terminals.ts:6-8`), so history is empty
at mount. But the doc is misleading.

All lanes, across all projects, stay mounted: `DashboardView.tsx:5351` maps every `terminals` entry.
The container is `display:none` when the content mode is not the terminal (`:5346`). A pane is `active`
only when `t.id === activeTerminalId && !t.ended && mainView === 'terminal'` (`:5380`, `:5389`).

## 2. How many lines of history a session keeps, and where

**xterm (renderer), per pane:**
- On screen: `ACTIVE_SCROLLBACK = 10_000` lines (`terminal-options.ts:125`), set at construction (`:327`).
- Any other state: `INACTIVE_SCROLLBACK = 2_000` (`:158`). Assigning `term.options.scrollback` a lower value
  trims the buffer immediately (`applyPaneActivation`, `:198`; the repo's own harness
  `dev/drive-scrollback-trim.mjs` asserts the cut). Raising it back to 10,000 on reactivation restores nothing.

**Main (Electron), per pty:** 256 to 512 KB of raw bytes (`terminals.ts:34`, `:781-786`). In lines, the repo's
classic-mode captures run about 58 bytes per `\n` (`scripts/width-audit/claude-turn.bin`: 6,087 B, 106 `\n`,
33 cursor-ups, 17 sync frames; `claude-stream.bin`: 6,192 B, 107 `\n`, 39 cursor-ups). So 256 to 512 KB is about
4,400 to 8,800 newline bytes. Many of those newlines belong to status-block redraws after a cursor-up, so
the number of distinct lines is lower. The fixtures are 6 KB each, so this ratio is rough.

In time rather than lines: a working turn emits spinner and status frames continuously. At an assumed
1 to 5 KB/s (**not measured**; the fixtures are too short and nothing in the app counts bytes), 256 KB
covers about 1 to 4 minutes of a busy turn. **The main-side buffer is bounded by time, and redraw traffic
pushes real content out of it.** To measure it: add a cumulative byte counter per lane next to
`historyBytes` (`terminals.ts:86`), or run `scripts/width-audit/capture-claude.py` with a longer deadline
across a real multi-minute turn.

**Where the missing history actually goes (classic mode, upstream).** Re-checked against 2.1.282, the binary
this machine runs now. The earlier result (`dev/results/scrollback-and-missing-input-RESULT.md`, done
against 2.1.268) still holds, and the byte-level detail is now confirmed:

```js
case"clearTerminal":d+=c.altScreen?yqr():MWt(c.viewportRows);break;
function yqr(){return Sb+out+gy}                       // alt screen: ESC[2J ESC[3J ESC[H
function MWt(r){return gy+(_X+lFr(1)).repeat(r)+gy}   // classic:    ESC[H (ESC[2K ESC[1B)×rows ESC[H
function lFr(e=1){return e===0?"":ya(e,"B")}           // cursor down
```

(`_X`, `gy`, `Sb`, `out` resolve to `ESC[2K`, `ESC[H`, `ESC[2J`, `ESC[3J` from their `ya(n,"K"/"H"/"J")`
definitions. Minified names repeat across modules, so the mapping is by pattern, but it is the only
reading consistent with `lFr` being cursor-down.)

In classic mode, a frame reset (`reason` ∈ clear/resize/offscreen) moves to the top of the viewport and
**erases each visible row in place**. It does not scroll those rows up, so they never enter xterm's
scrollback. Then it repaints only the last `viewportRows` of its virtual screen. Anything that was on
screen at the moment of a reset is gone, in any terminal, not just Operator's. Long turns trigger
`offscreen` resets repeatedly, so this explains most of "the scrollback is thin after a long session".

## 3. What is lost, by event

| Event | xterm (renderer) | Main history | Terminal modes |
|---|---|---|---|
| **Switch lane away** | Trimmed to 2,000 lines at once (`terminal-options.ts:198`); not restored on return | kept | kept (xterm instance survives) |
| **Open Preview on the same lane** | Same trim: `active` is false when `mainView !== 'terminal'` (`DashboardView.tsx:5380`) | kept | kept |
| **Lane ends** (`t.ended`) | Same trim, so the final output of a finished lane is capped at 2,000 lines | kept until kill | kept |
| **Hidden pane receives output** | Held ≤ 512K chars, then parsed. Nothing dropped since `df8802a` (`hidden-output.ts:29-33`) | kept | kept |
| **Renderer crash** | Everything. Main logs `render-process-gone` to stderr only (`electron/src/main/index.ts:85-87`), and nothing reloads the window. The window stays blank until ⌘R (`app-menu.ts:28`) | kept | — |
| **After ⌘R (re-attach)** | Rebuilt from main history only: the last 256 to 512 KB (`DashboardView.tsx:2385-2428` → `TerminalPane.tsx:529-537`). Everything older is gone | kept | **Lost if the startup bytes were drained** (see D3) |
| **App restart / quit** | Everything | Everything (ptys killed; the history lives in the `Managed` object) | — |
| **Lane suspend → resume** | Everything (pty killed); the resumed lane is a new `claude --resume` | Everything | — |

On the "~1.1 GB respawn": that measurement (memory note, 2026-08-06) was WKWebView under Tauri, which
WebKit killed and respawned automatically. Under Electron there is no auto-respawn. A Chromium renderer
that dies stays dead until reloaded. The installed 0.26.0 renderer (`pid 79697`) has the same age as the
app (3 days) at 800 MB RSS with 13 `claude` processes running, so no crash or reload has happened in that
window. The packaged app writes `console.error` nowhere persistent (`~/.operator/logs` has only
`updater.log`), so a crash would leave no record.

## 4. Memory growth per hour of output

Every stage is capped, so once the caps fill, **the terminal pipeline adds roughly zero bytes per hour**.
Steady-state estimates (xterm 6.0 stores 3 × uint32 = 12 bytes per cell, `BufferLine.ts:22,68`; assuming
160 columns, which is not measured):

| Holder | Per lane | 13 lanes (1 active) |
|---|---|---|
| xterm, active pane | (10,000 + rows) × 160 × 12 B ≈ 19 MB + line-object overhead | ≈ 20 MB |
| xterm, inactive pane | 2,000 × 160 × 12 B ≈ 3.9 MB | ≈ 47 MB |
| hidden buffer | ≤ 512K chars; two-byte string once box-drawing chars appear ≈ ≤ 1 MB | ≤ 12 MB |
| main history | ≤ 512 KB + one `Buffer` object per chunk | ≈ 7 MB |

Total is about 80 MB in the renderer and about 7 MB in main. That is about 10% of the 800 MB renderer.
Terminal buffers do not explain the renderer's size, and the inactive trim now saves about
12 × 15 MB ≈ 180 MB. The comment justifying it (`terminal-options.ts:127-157`) cites the WKWebView
737 MB / respawn measurement, which does not describe this shell.

## 5. Defects, ranked by user impact

**D1 — Classic-mode Claude Code erases history instead of scrolling it (upstream).** Impact: every long
session, every lane, the dominant cause. Mechanism in §2. Operator cannot fix this on the pty side, and
replaying pty bytes cannot restore it, because the bytes never carried those lines as scroll. Confirmed
from the 2.1.282 binary.

**D2 — The inactive trim deletes history on every switch-away, on Preview, and on lane end.** Impact:
frequent and irreversible. A lane you glance away from for one second loses everything past 2,000 lines.
Two cases are likely not intended: opening Preview on the lane you are reading, and a finished lane
keeping only 2,000 lines of its final output. `terminal-options.ts:158,198`; `DashboardView.tsx:5380,5389`.
Confirmed from source.

**D3 — After a renderer reload, the replay starts mid-stream.** Impact: rare (needs a crash plus ⌘R, or a
dev reload), but when it happens every lane with more than 512 KB of output is affected at once.
- `pushHistory` drops the oldest whole chunks (`terminals.ts:784-786`). Its comment calls this "harmless — it
  has scrolled away" (`:782-783`). That is wrong for replay: the first surviving chunk is written to a
  fresh xterm first, so a split CSI prints literally at the top (the `;239m…` signature). This is the
  bgBuffer-cap mechanism from memory, which was fixed in the renderer in `df8802a` and still exists here.
- Claude sets `ESC[?2004h` (bracketed paste), `?1004h` (focus), `?2031h` and `CSI >1u` **once**, in the
  first 50 bytes of the session. Fullscreen lanes also set `?1049h` and the mouse modes `?1000/1002/1003/1006h`
  in the first 125 bytes. Measured in all four `scripts/width-audit/*.bin` captures: each appears once
  (fullscreen mouse modes twice), at bytes 19 to 122. After 512 KB of output those bytes have been drained, so
  the re-attached xterm starts with those modes off. Expected consequences, **not verified live**:
  - Multi-line text pastes are no longer bracketed, because xterm decides that from its own mode
    (`InputHandler.ts:1969`).
  - Focus in/out reports stop.
  - A fullscreen lane's frames land in the normal buffer with mouse tracking off, so wheel events no
    longer reach Claude.
  - `CSI >1u` is unaffected either way: xterm 6.0 does not implement the kitty keyboard protocol.
- Classic-mode redraws are relative (cursor-up, then rewrite). Replayed from an arbitrary point and at the
  current width rather than the width the bytes were composed for, the first redraws land on rows that
  hold different content.

**D4 — A renderer crash is silent and not recovered.** Impact: rare (not observed in 3 days), severe:
blank window, no record. `index.ts:85-87` only calls `console.error`. Confirmed from source.

**D5 — Restart and suspend lose all terminal history.** Impact: every restart, including every update
install. Nothing on disk holds pty output, and what the user sees afterwards depends on what
`claude --resume` re-renders. By design, but it is the reason "history" disappears across days.

**D6 — Duplicate bytes on re-attach.** Impact: low. Bytes that reach the renderer between subscribe and
the history snapshot land in both `pending` and the snapshot (`TerminalPane.tsx:510-537`, stated in its own
comment). In classic mode a duplicated chunk containing `\n` duplicates lines. Needs a byte offset to fix
(see F1).

## 6. Which of these match the known ghosting / overprint defects

- **bgBuffer cap (loss, decapitated escape; memory `project_terminal_ghost_bgcap_mechanism`).** Fixed in
  the renderer (`df8802a`, `hidden-output.ts`). **The same mechanism is still present in main's
  `pushHistory`** (D3), reachable only through a reload's replay. Expected signature: literal
  `NN;NNm`-style fragments and misplaced rows at the **top** of a pane's history just after a reload.
- **Scroll overprint (memory `project_terminal_ghost_scroll_overprint`: two strings interleaved glyph by
  glyph, nothing missing, a line shown once clean and once interleaved).** The earlier research left two
  candidates open: compositor, or a byte-level overwrite. The source adds a third that fits the signature:
  Claude's renderer writes a diff against the frame it believes is on screen (`Qa`/`Kv`, cursor moves plus
  changed cells only). If the real screen differs, the unchanged cells of the old content stay and the
  changed cells of the new content land between them. The result is two strings woven together with
  nothing missing. Anything that desynchronises xterm's screen from Claude's model produces it:
  - a replay that starts mid-stream (D3). In the Tauri 0.15.2 era of that sighting, the WebContent process
    was killed and re-attached about hourly, so every lane went through this replay about once an hour.
  - duplicated bytes (D6)
  - a width change between composition and parse, now ordered correctly in `applyPaneActivation`
    (`terminal-options.ts:187-224`)

  **This is a hypothesis, not a verified cause.** The test is the one the memory note already asks for:
  replay real captured bytes through xterm starting from a chunk boundary well into the stream (not byte 0)
  and check the **buffer** for interleaved rows.
- **Missing prompt after a switch (scrollback-and-missing-input-RESULT #2).** Fixed:
  `applyPaneActivation` now scrolls to the bottom before and after the post-parse fit
  (`terminal-options.ts:209-222`).
- **Fullscreen composer ghost (memory `project_terminal_ghosting_fullscreen`).** Nothing found here that
  bears on it, other than D3's alt-screen-mode loss after a reload.

## 7. Fixes proposed

In order of payoff for effort. None are implemented.

**F0 — small, do first.**
1. `index.ts:85`: on `render-process-gone` with reason `crashed`/`oom`, append a line to
   `~/.operator/logs/renderer.log` and call `wc.reload()`. The re-attach path already exists.
2. Stop trimming where it is not needed. Keep `active` scrollback when `mainView === 'preview'` for the
   same lane, and for ended lanes. Or raise `INACTIVE_SCROLLBACK` to about 5,000 lines (≈ +12 × 5.8 MB ≈ 70 MB,
   measured against an 800 MB renderer). Its WKWebView justification no longer applies.
3. `pushHistory`: after draining, cut the front at a safe boundary (the byte after the last `ESC[?2026l`,
   or the first `\n` not inside an escape) instead of a whole-chunk boundary, and fix the comment at `:782-783`.
4. Record the startup mode set per pty in main (a small scanner for `CSI ? Pm h/l`) and prefix it to
   `history()` output. This fixes D3's lost bracketed paste and alt-screen/mouse state.
5. Correct the `replayHistory` doc (`TerminalPane.tsx:31-34`, `:527-528`) to match `TerminalSurface.tsx:37`.

**F1 — headless mirror in main (the right pty-side design).** Run `@xterm/headless` per lane in main,
fed from `onData`, as the single source of truth for screen + scrollback + modes. Replace `history()` with
`@xterm/addon-serialize` output (content plus modes), tagged with a byte offset. Re-attach then gets an exact
state instead of a mid-stream byte tail (fixes D3, D6), and panes can **hydrate on activation**, so an
inactive xterm can hold very little or be disposed and rebuilt (makes D2 unnecessary). Cost: main parses
every byte once (xterm's parser handles MB/s; 13 lanes is small), and the scrollback memory moves to main
(≈ 20 MB per lane at 10,000 lines / 160 cols; cap it at a lower line count there if needed). Neither package
is installed today.

**F2 — disk-backed raw pty log.** Append each lane's bytes to `~/.operator/sessions/<uuid>/pty.log`
(rotated, e.g. 2 × 8 MB). It survives restart, but raw replay has the same mid-stream problem as D3 unless
paired with F1's serialized snapshots. Its main value is as **ground truth for the ghost investigations**,
which have been blocked on the lack of real pty bytes since August.

**F3 — history from the transcript, not the pty (the only fix for D1 and D5).** Claude Code's JSONL
transcript holds the whole conversation. Operator already tails it (`transcript.ts`) and stores narration
durably in `chat.db` (`chat-store.ts`). A read-only "History" surface for a lane, opened by scrolling past
the top of xterm or from the lane menu, would give complete history that survives restarts, independent of
Claude's repaint behaviour and of any Operator cap. Cost: it is a rendered view (messages, tool calls,
diffs), not a byte-exact terminal, and it needs the markdown size guard from the 2026-06-30 freeze. The other
existing lever is fullscreen TUI mode (`getTuiMode`, `terminal-options.ts:48`), where Claude does its own
scrolling. It trades D1 for the open fullscreen-ghost issue.

**Recommendation:** F0 now (a day, low risk). Then F3 for long-session history, because D1 is the dominant
cause and nothing on the pty side reaches it. Then F1 when the reload/replay path is next touched. Add F2's
log only as an opt-in diagnostic.

## What was not done

- No live GUI check of any loss; per project constraints, that is the user's.
- Output rate (bytes/s during a turn) is estimated, not measured, so the "minutes of history in main" figure
  is a range, not a number.
- Pane width was assumed to be 160 columns for the memory figures.
- Did not check what `claude --resume` prints on restart.
- The D3 mode-loss consequences (paste, focus, mouse) are derived from xterm source and the captures, not
  observed.
