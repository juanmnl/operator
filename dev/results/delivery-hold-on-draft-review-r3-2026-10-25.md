# Review round 3: delivery hold on draft (2026-10-25)

Commit reviewed: `b72339b` on `operator/98a1c0` (also `operator/ced0c0`), diff
`git diff 88c0332 b72339b`. Round 2: `dev/results/delivery-hold-on-draft-review-r2-2026-10-25.md`.
Scope: S1-S6, and regressions in the lines this commit touches. The branch tip `0480d60` adds the
terminal-link fix, which is reviewed separately. Line numbers are at `b72339b`.

## Merge verdict

**Nothing blocks merging.** S1-S6 are closed. The one new point (N1) is that the S1 rule errs
toward holding: a stale hold that shows in the pane and is cleared by Enter, Ctrl+C, a third Esc
or Deliver now. It is worth a follow-up, not a reason to wait. The GUI recipe in Code's write-up
still has to be run before release. None of this has been checked in the app.

## Tests run

On an export of `b72339b`:

- Root `npx vitest run`: 123 files, 1998 passed.
- Root `npx tsc --noEmit -p .`: clean.
- Electron `npx vitest run`: 57 files, 1002 passed.
- Electron `npm run typecheck` (main + renderer): clean.

## S1-S6

| Finding | Status |
|---|---|
| S1 double Esc while a suggestion list is open | Closed. Any `@` or `/` typed or pasted, or a Tab, sets `pickerMaybe` (`lane-keystrokes.ts:110`, `:138`, `:156`). Then the first Esc starts no pair: it is taken as closing the list. That matches the binary: the prompt input passes `disableEscapeDoublePress:U_` with `U_=Uf.length>0`, and the input's escape case returns early (`case"escape":if(Z)return`), so the first Esc only closes the list. Three Escapes clear, as in the TUI. A restored (unknown) draft assumes a list is open. |
| S2 `\` + Enter from the character before the cursor | Closed for the cases named. `tail` follows typed and pasted text and reads its last character. A paste ending in `\` and `\`, x, Backspace both read as a newline, and the TUI's replacement of `\` by the newline is mirrored. Arrows, Home/End, Tab and Ctrl-edits mark the text unseen, so Enter sends. That is wrong only if the cursor was moved back to just after a `\`, which is rare. |
| S3 re-submitted announcement | Closed. A line with `reports` comes back with the `onlyIf` idle check, under the coordinator's in-flight entry, and marks its reports delivered only after a confirmed write. If a pass already holds that coordinator, the owed line is dropped and the pass announces the still-undelivered reports. A line for a terminal that is gone is dropped, because the reports are durable in artifacts.db. |
| S4 images lost on reload | Closed. `images` travels on `OwedSubmission` and goes back through `submit(..., { images })`. |
| S5 record stuck at `held` | Closed. Main keeps `held` per owed entry (`kind: 'held'`). A re-submission starts with `entry.held` set, so its settle turns the record back to `sent`, and `markHeld` does not mark it twice. |
| S6 lane suspended across the reload | Closed. `splitOwed` sends an entry whose terminal is gone but whose `laneKey` is known to `toWake`. After `suspendedRestored`, `wakeOrEnded` wakes the suspended tab with the message, or reports it ended. A woken message with `held` flips its record back. |

## New point

### N1. Low: `/` anywhere in a draft keeps a double Esc from clearing the flag

`src/renderer/lib/lane-keystrokes.ts:110`, `:138`, `:156`.

`opensPicker` is true for any text containing `@` or `/`, and `pickerMaybe` stays set until an Esc,
Enter or Ctrl+C. The first Esc after it is taken to close a list. That includes the `/` in a path
or a URL (`https://…`), where no list was ever open. A draft with a path or link that the person
clears with Esc Esc is therefore cleared in the TUI while the flag stays on.

This is the safe direction: nothing merges. The cost is the stale hold that round 1's F5 removed:

- A message to that lane waits behind the pill until Enter, Ctrl+C, a third Esc or Deliver now.
- For a coordinator, there is no pill at all. The announce pass skips it ("unsent text in the
  composer") until the person next presses Enter there. The reports wait, durable, and nothing
  outside the announce log says so.

I did not find in the binary where `Uf` is filled, so I cannot say exactly which `/` opens the
command menu. In normal use it opens only at the start of the input. Narrowing `/` to "first
character of the draft" and dropping `pickerMaybe` on a space after `@` would remove most of the
false holds, and it needs a GUI check either way. For Code, as a follow-up.

## Touched lines checked, no regressions

- `noteDraftKey` ordering: the Esc pair bookkeeping (`prevKey` dropped after a clear or a picker
  Esc), the picker flag cleared on Esc, Enter and clear, and the tail updates are consistent. A
  Shift+Enter or `\`+Enter appends a newline and keeps the draft. ⌘V leaves the tail to the paste
  event, which supplies the text. An image paste with no text marks the tail unseen.
- `TAIL_MAX` keeps the tail at 256 characters with a sentinel in front, so memory stays bounded
  per lane. `clearUnsentInput` drops the tail and the picker flag.
- `resubmit` reads `refreshReports`, which is declared later in the component. The effect runs
  after the render has finished, so the binding is initialised by then.
- Main's `held` op only updates an entry that exists, and a `held` for a settled key is ignored
  (tested).
- `back` for `settleUnreturnedHeld` now includes the `toWake` entries, so a held record is not
  marked lost before its wake is tried. A wake that fails still turns it `undelivered` through
  `reportUndelivered`, which matches `held`.
