# Brief — build the composer control changes

**Lane: Code.** Write your result to `dev/briefs/composer-controls-impl-RESULT.md`.

Implements the design in `dev/briefs/composer-controls-and-model-picker-RESULT.md` (copied into
your worktree alongside this file — read it for the reasoning; this brief is the scope). Files:
`src/renderer/components/session/ChatComposer.tsx`, `CanvasConversation.tsx`, `PopMenu.tsx`
(props only), plus one new draft-store module.

Everything below is buildable on the pty today. Nothing here needs new plumbing.

---

## 1. The orb becomes send-family only — it is never Stop

**The principle: the orb is the Enter key made visible. Enter never stops, so the orb never stops.**

Today `send()` never checks `busy`, so while the agent runs, **Enter sends into the turn and the
orb beside it stops the turn** — two verbs, six pixels apart, and the composer already prints
`↵ sends into this turn` next to a stop square. That is the defect.

New state table for the orb (right end of the control row):

| lane | draft | control | glyph | ring | caption |
|---|---|---|---|---|---|
| idle / waiting | empty | status light, **not a button** (`cursor: default`, `aria-disabled`) | none | none | — |
| idle / waiting | text | **Send** | arrow ↑ | `color-mix(in srgb, var(--accent) 55%, transparent)` | — |
| running / compacting | empty | status light (core animates — that IS the busy signal) | none | none | — |
| running / compacting | text | **Steer** | arrow ↑ over a 6px baseline bar | same accent ring | `Steers into this turn` |
| no live session | any | grey, `opacity .45`, `aria-disabled` | none | none | — |

- The core stays `StatusWave` with the lane accent, exactly as now. Do not touch it.
- `onClick` is always `send()`. Remove the `busy ? interrupt : send` branch entirely.
- Keep `data-composer-action`, but its values become `send` | `steer` | `idle`.
- `aria-label`: `Send` / `Steer into this turn` / `Agent status`.
- **Do not add motion here.** The orb core already animates when busy; that is the whole signal.

Rename the existing caption string `↵ sends into this turn` → `Steers into this turn`, and fix its
ink while you are in it — see §3.

## 2. Stop moves to the status line

`CanvasConversation.tsx:1085-1112` renders the status line (orb + phrase + elapsed). Add Stop to
the **right end of that row**, and delete the `:1108-1110` comment claiming Stop lives in the
composer — that note was right only while the orb *was* Stop.

- Render when `signal.interruptible && live` (a strict subset of when the line renders, so it
  never appears alone).
- **Labelled, not icon-only:** `■` + the word `Stop`. Mono 10px, `padding: 0 8px`, `height: 22`,
  `borderRadius: 7`, background `transparent`, text `var(--fg)`, border
  `1px solid color-mix(in srgb, var(--color-error) 45%, var(--border))`.
- **Never red ink.** `--color-error` measures 2.81:1 on 1984-light; it carries the border only.
- Calls the existing `interruptSession(session?.terminalId)`. Do not change `INTERRUPT_SEQ` —
  `dev/qa-chat-stop.md` proved a single `\x1b` is correct.

**Stop must admit failure** (the "stop does nothing" report is live, and QA showed the byte is
right, so the fault is between click and write):

- on click → label `Stopping…`, disabled. **No spinner** — a second motion idiom is forbidden.
- resolves when `signal` leaves running/compacting (the line changes on its own).
- after **2500ms** with no phase change → label `Stop again`, re-enabled, and a mono line appears
  beneath: `No response yet — Esc in the terminal also interrupts.`
- **never auto-fire a second ESC.** Each extra keystroke is another chance to split something.

After a confirmed stop, show a one-line advisory in the composer's caption slot for ~6s:
`Stopped — your last message is back in the agent's input.` (Claude Code restores the interrupted
draft into its own composer — see the note in `lib/interrupt.ts`.) **Advisory only. Do not try to
clear the pty composer**; that concatenation is a separate defect QA has to confirm first.

## 3. The caption's ink is a contrast bug today

It renders at **9.5px `var(--fg-muted)`**. The status line six pixels above deliberately uses
`--fg` *because* muted at 11px measured 4.16:1 on Mr Pink light and 4.30:1 on 1984 light — under
the body floor. Muted at 9.5px is strictly worse than what was already rejected.

Take it to **10.5px** with `color-mix(in srgb, var(--fg) 74%, transparent)` — the established
`.op-lbl` recede. **Not** opacity stacked on `--fg-muted`; that is forbidden outright.

## 4. Pills: two, not three — and a collapse ladder

**Do not add a Verbosity pill.** It has no carrier: no `verbosity` setting exists, `--verbose` is
the TUI's tool-output display flag (our chat renders the transcript, not the TUI), and
`outputStyle` is deprecated *and* one of only two settings keys that do not auto-reload. The
freed slot is **reserved for Permission mode — do not build it**; its mid-session carrier is
unconfirmed.

Row order stays: `📎` `/` · `Model` `Effort` · spacer · caption · orb.

| row width | Model | Effort |
|---|---|---|
| ≥ 520px | `Opus ▾` | `Effort · High ▾` |
| 400–520px | `Opus ▾` | `High ▾` |
| < 400px | `Opus · High ▾` — one pill, one popover, two sections | folded in |

**Model never collapses away** (it is the lane's identity); Effort is the adjustable.

## 5. Two honesty additions inside `PopMenu` (existing slots, no new component)

- **Model** — on the *active* row, show the resolved id as the `hint`: `Opus` left,
  `claude-opus-5` in muted mono right, read from `session.model` once the transcript backfills it.
  The alias auto-updates; this lets the user see which point release they actually landed on.
- **Effort** — `pickEffort` writes the **global** settings file, so changing it from one lane's
  composer changes the default for every future lane in every project, and nothing on screen says
  so. Add a footer: `Global — applies to new turns in every lane.`
- **Keep `Other…` exactly as built.** It is the degradation path for a tier we have no preset for.

## 6. Per-chat drafts

We lose composer text on every lane switch today (the `useEffect` on `session?.id` clears it), and
the loss is silent.

- **Scope:** per session id. **Survives:** lane switch, ⌘J Console⇄Chat, panel remount, **and app
  restart**.
- **Storage:** one key, `operator.chatDrafts` → `Record<sessionId, string>`. One key, not N, so
  eviction is a single write. Wrap in `try/catch { /* quota */ }` like every other caller.
- **Attachments: in-memory only** — a module-level `Map<sessionId, Attachment[]>`. They survive a
  lane switch; they must **not** be persisted, because the object URLs die with the page and a
  restored chip would have a broken preview.
- **Restore:** caret to end. **Do not auto-focus** — that would break ⌘1-9 stepping through lanes.
- **Cleared on:** a successful send. **Not** on interrupt, not on switch, not on blur.
- **Evicted on:** hydrate — drop every key whose session id is not in the live session list.
- Leave the model/effort pill re-seeding on session switch exactly as it is.

## Explicitly out of scope

- **The QuestionPanel** — blocked on `dev/briefs/stream-json-alongside-pty-RESULT.md`, which does
  not exist yet. Do not sketch it, do not scaffold for it.
- **A Permission mode pill** — reserved, not approved.
- **`INTERRUPT_SEQ`, the submit queue, `chatSignal`** — all correct; do not touch.

## Done means

- `npm run build` clean, `npm test` green (say the count).
- Verified in **all six palettes** via `dev/drive-theme-pass.mjs`, with the contrast table for the
  new Stop border and the corrected caption ink.
- **Six control states** shown in light and dark: empty · text · busy+empty · busy+text ·
  stopping · no live session.
- **Overflow:** draft past the 140px grow cap (scrollbar appears, controls do not move); 6+
  attachment chips wrapping; a long free-typed model id (ellipsis, pill never exceeds ⅓ of the row).
- **Narrow:** the collapse ladder at 520 / 400 / 340px, no horizontal overflow, Stop still hittable.
- **The house rule, checked directly:** assert there is no state in which Stop occupies a pixel
  that was Send or Steer in the previous frame.
- Drafts: switch lanes mid-sentence and come back; then restart the app and come back.
