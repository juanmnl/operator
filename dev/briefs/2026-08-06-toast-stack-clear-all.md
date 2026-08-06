# Clearing a pile of toasts: coalesce identical ones, and dismiss the stack at once

**User ask, 2026-08-06:** five actionable error toasts stacked in the top-right — four of them
the *identical* card (`Operator never started the task it was sent`) plus one for `Code` — and the
only way to clear them is four separate ✕ clicks. "Can you also dismiss all those toasts at once?"

(The *reason* there are five is a separate, already-dispatched bug —
`dev/briefs/2026-08-06-false-undelivered-toasts.md`, in flight with the Code lane. **This task is
the pile-up itself, not its cause.** Fixing the cause does not fix the affordance: any burst of
actionable toasts reproduces it.)

## Current state

- `src/renderer/components/Toast.tsx` — `Toasts` renders a plain `messages.map`, unbounded. Each
  card has a ✕ (`beginExit`) and, when `action` is present, no auto-dismiss: it stays forever.
  There is no stack-level control and no dedupe.
- `src/renderer/views/DashboardView.tsx:234` `toasts` state, `:388` `pushToast`, `:393`
  `dismissToast`, `:4394` render site.

## Build

1. **Coalesce identical toasts.** Same `text` + `kind` + `detail` collapses to ONE card carrying a
   count (`×4`). This is the real complaint — four byte-identical cards is a rendering bug, not
   information. Dismissing the coalesced card clears all of its occurrences. Its `action` should be
   the most recent occurrence's (each undelivered toast's SHOW targets a different terminal, so the
   count must not silently discard the others — if that reads badly, decide it and say why).
2. **Dismiss all.** A stack-level control that clears every visible toast in one click. Appears
   only when it earns its space (a stack of 2+ *after* coalescing; you own the threshold). Word it
   — "Dismiss all", not a bare glyph. Per house rule, two verbs never share a glyph: the ✕ already
   means *dismiss this one*, so the stack-level control must not be another bare ✕.
3. **Cap the stack.** Even coalesced, an unbounded column can run off-screen. Cap the rendered
   count and indicate the remainder rather than clipping silently.

## Hard constraints

- **Dismissal is presentation only.** It must NEVER touch a `DispatchRecord` outcome. An
  `undelivered` dispatch stays `undelivered` in the project log after its toast is gone — the log
  is the record, the toast is the notice. (Dismissing in the *dispatch log* meaning `rejected` is a
  different, existing mechanism; do not wire the two together.)
- **Do not touch `reportUndelivered` or the submit-queue path** (`DashboardView.tsx` ~1288, and
  `src/renderer/lib/submit-queue.ts`). The Code lane is editing exactly that region right now.
  Keep this change inside `Toast.tsx` plus the toast state at `DashboardView.tsx:234/388/393/4394`.
- House UI rules: semantic CSS vars only, no hardcoded colour, transparent/surface controls (no
  solid accent fill), no browser focus ring, no coloured left-border stripe, never recede a card
  with a group `opacity`. Do not put a colour-changing border on a rounded element (WKWebView
  freeze). Match the existing card's type scale and spacing.
- Unit tests for coalescing and clear-all. `npm test` + `npx tsc --noEmit` + `npm run build` green.

## Output

Write what you built + the decisions you made (coalesce key, threshold, cap) to
`/Users/juanmnl/Developer/operator/dev/briefs/2026-08-06-toast-stack-clear-all-RESULT.md`
— that absolute path in the MAIN repo, not only your worktree — and report via `operator__report`.
Implement it; do not stop at a design document.
