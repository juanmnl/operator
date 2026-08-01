# Result — the channel driver tests delivery with delivery switched off

`node dev/drive-project-channel.mjs` now runs clean against the vite dev server on `main`
(HEAD `7218742`), deterministically, in ~29s. Ran it twice back to back — identical output both
times, no `pageerror`s. Only `dev/drive-project-channel.mjs` changed; no product code was
touched, per the brief's "do not."

## 1. The rest-state assumption (the bug that was reported)

Confirmed exactly as the brief described: `c0c392c` flipped the kill switch's default from
paused to live (`chatterPausedFrom` in `src/renderer/lib/agent-delivery.ts` — absent key → live).
The driver still asserted "paused at rest," so its toggle-click at what is now phase 14 flipped
delivery **off**, and everything downstream measured brake behaviour with delivery disabled.

Fixed by inverting AND asserting explicitly (requirement 1). New phase 13 checks three things at
rest, before touching the toggle at all: the label reads "Agent↔agent live", `aria-pressed` is
`true`, and `localStorage.getItem('operator.chatterPaused')` is `null` — i.e. this is the
*default*, not a stored preference. It then fires a real relay message and confirms it delivers,
prefixed, with the right chip — proving the rest state is actually live, not just labeled live.

The rest of the switch's phases were renumbered and restructured per requirement 3 — flipped
explicitly from a known state rather than assumed:

- **13** — rest state is live (new, asserts the default)
- **14** — turn it OFF, from the known-live state of 13 → the paused path (label, `aria-pressed`,
  persisted `"1"`, a relay message posted-not-delivered)
- **15** — human→lane still works while paused (was 14, unchanged content — see §2)
- **16** — turn it back ON, from the known-paused state of 14 → also what re-establishes live
  delivery for the brake coverage below
- **17–20** — idle-target / hop-budget / pair-brake / length-cap (were 16–19; content unchanged
  except where noted in §3)
- **21** — turn it off again, halts delivery (was 20)

## 2. Phase 14 (now 15) — human→lane during pause: REAL, not drift

Determined by reading the code, not by guessing from output. `sendChannelMessage`
(`DashboardView.tsx:1422`) — the human-send path the composer calls — never reads
`chatterPaused` anywhere in its body. The kill switch is only ever consulted inside the
agent-reply subscription (`DashboardView.tsx:1210`, `evaluateDelivery({ paused:
chatterPausedRef.current, ... })`), which is a *different* code path entirely, reachable only by
`__mockReply`/the real tailer, never by the composer's `⌘↵`.

So "the switch halts agent→agent only" (the comment at `agent-delivery.ts:88`) is accurate and
enforced by the two paths never sharing that check, not by one path remembering to skip it. This
is shipped behaviour, correctly covered by the driver — not a defect, and nothing to hand to Code.

## 3. Two more things this fix surfaced (not asked for, but block "runs clean")

Restructuring 13–21 turned real delivery back on, which is what a fixed driver is *for* — and
that immediately hit two more problems the paused-cascade had been hiding:

**a) The mock never confirms a submission, so every second write to one terminal stalls ~30s.**
`submit-queue.ts`'s closed-loop confirm (`RESCUE_AFTER_MS = 30_000`) waits for a transcript turn
before a terminal's next queued submission can even start writing. In the real app that turn
appears in under a second; in the mock, nothing ever calls the exposed confirmation hook
(`window.__mockUserTurn`, `mock-bridge.ts:474`) unless a driver does it. `drive-project-channel.mjs`
never did — so this wasn't new, it was **latent**: phase 9 (`HUMANTOCODE`, sent right after phase
8's approval to the same terminal) was already silently wrong before I touched anything (verified
by running it in isolation — the write lands at exactly ~30s, past every wait in the file), and
phase 12's fan-out was undercounting by one live lane for the same reason. Both were masked
because nobody had looked past the paused-cascade at the bottom of the file.

Fixed in the driver only: a `confirmWrite(terminalId)` helper reads back the raw text of a
terminal's last write and calls `__mockUserTurn` with it, mirroring the pattern already
established in `dev/drive-dispatch.mjs`. Wired into every write-producing action from phase 8
onward (`laneReply` now confirms its own target after every call). This is a harness fix, not a
product one — it makes the driver measure decisions instead of measuring `submit-queue.ts`'s own
timing, which has its own test suite already.

**b) Cross-phase pollution nearly gave a false hop-limit failure.** First pass at the restructure
had the new phase 13 (rest-state proof) and phase 16 (re-enable) both relay Code→Research, same
as the old file. The hop-budget test (18) *also* ping-pongs Code↔Research — and the pair brake
counts every delivery on that ordered pair in the last 60s regardless of which phase sent it. Two
prior real deliveries pushed the loop into tripping the pair brake one hop early, which read
exactly like "the hop limit is broken" until traced back to `pairHistory` being shared,
app-lifetime state (`deliveryStateRef` in `DashboardView.tsx`, never reset between phases). Fixed
by moving the hop-budget loop to Code↔Operator, a pair nothing earlier in the file touches, so it
starts from zero. The pair-brake test (19) is unaffected — it already uses the distinct
Research↔Operator pair.

## 4. Brake coverage with delivery ON (requirement 2)

All three now measured for real, against actual `terminalWrite` calls, not just the decision log:

- **Hop limit**: 5 delivered, hop 6 refused — `posted · chain limit reached`.
- **Pair brake**: 4 delivered in the 60s window, the 5th suspended — `posted · pair sending too
  fast` — and a different pair (Operator→Code) still delivers while that one is suspended.
- **Length cap**: a 3008-char reply lands as exactly 2035 chars on the wire (2000-char content
  cap from `DELIVER_MAX_CHARS` + the 35-char `[Operator · message from Operator] ` prefix — fixed
  the old assertion, which measured the *wrapped* bracketed-paste bytes including the ESC[200~/
  ESC[201~ envelope, not the submitted text; that number is now read back with the wrapper
  stripped) — ending in the "truncated…" pointer.

## Everything else (phases 1–12)

Unchanged in substance. Phases 8, 9, and 12 needed the confirm-write fix from §3a to actually pass
(they were previously "passing" only because they'd never delivered anything real to check, or
were about to start failing once §3a's stall got hit) — same assertions as before, now genuinely
verified rather than accidentally correct.
