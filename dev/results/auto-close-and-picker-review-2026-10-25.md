# Pre-merge review: auto-close holds and the picker follow-up (2026-10-25)

Branch `operator/b8ce80` (tip `de3dbc7`), two code commits on top of `26c3c0d`:

- `80f5987`: the automatic lane close refuses while a message is owed, there is unsent input, or a
  delivery is held.
- `58f4101`: the pre-merge review's P1 and P2.

Diff `git diff 26c3c0d operator/b8ce80`. `git merge-tree` confirms it merges cleanly onto main
`ccd2967`. Line numbers are at `de3dbc7`.

## Merge verdict

**Mergeable. Nothing blocks it.**

- P1 and P2 are closed, and the rules they cite are in the 2.1.310 binary.
- The fallback change only widens the hold, so it cannot under-hold.
- The auto-close refusals are wired with the right values for live and suspended lanes.
- A stale draft flag can keep a live, idle lane open with no time limit. That is the safe
  direction, and it is the same rule idle suspension already follows.

## Tests run

On an export of `de3dbc7`:

- Root `npx vitest run`: 129 files, 2115 passed.
- Root `npx tsc --noEmit -p .`: clean.
- Electron `npx vitest run`: 57 files, 1002 passed.
- Electron `npm run typecheck` (main + renderer): clean.

## 1. `80f5987`: the automatic close respects holds

- **The decision.** `laneCloseDecision` refuses on `owed`, `unsentInput` and `heldDeliveries > 0`
  (`lane-lifecycle.ts:108-110`). The check comes after `focused` and `openWork` and before the
  suspended branch, so it applies to suspended lanes and to the went-quiet backstop as well. A
  released lane's close goes through the same plan and is held the same way.
- **The snapshot.** It is built once per tab and set on both the suspended and the live snapshot
  (`DashboardView.tsx:4755` onward):
  - `owed` = `owesSubmission` (unwritten, held, or written and unconfirmed) or a message waiting
    on `whenLaneReady`;
  - `unsentInput` = `hasUnsentInput(tab.id)`;
  - `heldDeliveries` = `heldDeliveriesFor(project.dispatches, roleId, now)`.

  These are the same three inputs idle suspension reads.

### Can a stale flag keep a lane open forever?

| Input | Bounded? | Why |
|---|---|---|
| `owed` | Yes | `pending` ends at confirmation or at the end of the delivery watch. An unwritten message ends at its write. A held one ends when the draft flag clears (see `unsentInput`). A suspended tab has nothing owed, because the suspend diverts its queue. |
| `heldDeliveries` | Yes, 24 h | `HELD_RECORD_MAX_AGE_MS`. It is keyed by role, so an `undelivered` or `pending-approval` record keeps every lane of that role from auto-closing for up to a day. That is the idle-suspend rule, now also applied to closing. |
| `unsentInput` on a suspended lane | Yes | The flag is cleared on the old pty's exit, and a lane with unsent input is never suspended in the first place. |
| `unsentInput` on a live lane | **No time limit** | See below. |

A live lane's draft flag clears only on Enter, Ctrl+C, a double Esc, a typed key's reassessment,
Deliver now, or the pty exiting. The flag can be stale:
- a draft deleted with Backspace;
- a double Esc that the picker rule held, which needs a third Esc;
- a draft restored as unknown after a reload, on a lane the person never opens again.

In each of these, an idle lane stays open, unsuspended and unclosed, until someone presses Enter in
it. Nothing outside the lane says so.

This is a choice, not a bug: closing would discard text that may be real. It costs a pty and its
memory. If Code wants a bound, the obvious one is to let the went-quiet backstop suspend, not close,
a lane whose draft is `draftUnknown` after a long quiet. That keeps the conversation, but the
composer text is still lost. I would not change it before merging.

## 2. `58f4101`: P1 and P2

### The rules, checked in the 2.1.310 binary

| Rule | Binary | Match |
|---|---|---|
| `SLASH_DRAFT = /^\//` (`lane-keystrokes.ts:121`) | `rA(h)`: `h.startsWith("/")`. The argument lists then open with arguments typed: `suggestionType:"directory"` for the commands in `n2`, `"custom-title"` for `/resume`, and `"command"` from any command's `getArgumentCompletions`. | Wider than the binary (it holds for every `/`-draft), so it cannot under-hold. Closes P1. |
| `EMOJI` (`:129`) | `rce=/(^|\s):([a-z0-9_+-]{2,})$/`, gated on `emojiCompletionEnabled!==!1` (on by default). | Same pattern. It holds even when no emoji name matches, which is wider than the binary and safe. Closes P2. |
| `CHANNEL` (`:131`) | `oce=/(^|\s)#([a-z0-9][a-z0-9_-]*)$/`, gated on a Slack MCP client. | Same pattern, held whether or not Slack is connected. Safe. Closes P2. |

I listed every suggestion type the binary sets: `file`, `agent`, `mid-command`, `command`,
`directory`, `custom-title`, `emoji`, `slack-channel`, `shell`. `shell` (bash mode) and the
non-`@` `file` list open from Tab, and Tab already sets `pickerMaybe` and `triggerSeen`. Every type
is now covered.

### The `triggerSeen && UNSEEN` fallback

`listMayBeOpen` now returns true whenever the draft has seen a trigger (`/ @ : #` or Tab) and
part of it is text the keys lost track of (`:146`). The old fallback tried a few prefixes on the
text after the last unseen point. The new one is a strict superset, so it cannot under-hold.

It also closes a case the old one missed: a Tab-opened `file` list (no `@`) that stays open while
the person keeps typing path characters. In that case the tail is `UNSEEN` + the typed characters,
and only the new rule holds.

The cost is more over-holding. A draft that contains a trigger character and was edited with arrows
or Home/End keeps `pickerMaybe` set, so its double Esc needs a third Esc. That is the safe direction,
and `triggerSeen` is reset by any clear.

## Not changed by these commits

The draft-hold pill is the only sign of a stale flag, and it shows only when a message is held. The
lane menu's Suspend is hidden on such a lane (`unsentInput`). The announce log is the only place a
coordinator skipped for a stale draft is visible. These points were already known from the earlier
rounds.
