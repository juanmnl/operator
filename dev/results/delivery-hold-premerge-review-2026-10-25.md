# Pre-merge review: delivery hold on draft at 26c3c0d (2026-10-25)

Branch `operator/98a1c0` at `26c3c0d`. Two things not reviewed before:

1. `da26ae4`, "Hold a double Esc only when a / or @ can have opened a suggestion list" (r3 N1).
2. The merge of main `844cc57` (the lifecycle fixes) at `26c3c0d`.

Line numbers are at `26c3c0d`.

## Merge verdict

**Mergeable. Nothing blocks it.**

- The merge resolution is correct, and the cross-branch claims hold.
- `da26ae4` does what N1 asked for. It cites real binary rules for `/command`, mid-draft
  `/command` and `@` mentions.
- It is not true that it never under-holds. Claude Code 2.1.310 opens three more suggestion lists
  that the rule does not see (P1, P2). In those cases a double Esc clears the flag while the text
  stays, which is the merge direction. P1 is a narrow regression against `b72339b`, which held
  there. P2 was already a gap.
- All of these need the same gesture: a double Esc within 800 ms while that list is open, then a
  delivery before the person sends. I would merge, and have Code close P1 and P2 next. P1's fix is
  small: treat a draft that starts with `/` as "list may be open" whatever follows.

## Tests run

On an export of `26c3c0d`:

- Root `npx vitest run`: 129 files, 2101 passed.
- Root `npx tsc --noEmit -p .`: clean.
- Electron `npx vitest run`: 57 files, 1002 passed.
- Electron `npm run typecheck` (main + renderer): clean.

## 1. `da26ae4`: the suggestion-list rule

### The cited binary rules (2.1.310)

Checked in the installed binary (`~/.local/share/claude/versions/2.1.310`):

| Rule in `lane-keystrokes.ts` | In the binary | Match |
|---|---|---|
| `MID_COMMAND` (`:120`) | `nA`: `h.slice(0,x).match(/[\s。、？！]\/([a-zA-Z0-9._:-]*)$/)` | Same. The binary also returns null when the draft starts with a command in `T1t`, so it opens the list less often than this rule does. That direction is safe. |
| `AT_MENTION` (`:123`) | `G1t=new RegExp(String.raw\`(^\|${L7})@([\p{L}\p{N}\p{M}_\-./\\()[\]~:]*\|"[^"]*"?)$\`,"u")` | Same character set and quoted form. Code's set adds U+200C and U+200D for the agent list (`CU`). |
| `COMMAND_MENU` (`:118`) | `rA(h)`: starts with `/`, command name up to the first space. `q$e(h,x)`: `!h&&x.includes(" ")&&!x.endsWith(" ")`, which closes the command list once arguments follow. | Same for the command-name list. P1 covers what the binary does with arguments. |

The `triggerSeen` fallback for text the keys lost track of (`listMayBeOpen`, `:130`) only adds
cases where a list is assumed open. It cannot under-hold.

### Where it under-holds (the merge direction)

The suggestion code next to `G1t` in the binary fills the same suggestion list from five sources,
not three: `file`, `agent`, `mid-command`, `command`, plus the three below. Each of them is a list
the first Esc closes (`disableEscapeDoublePress:U_`, `U_=Uf.length>0`), so a double Esc there does
not clear the input.

**P1. Low (regression against `b72339b`): argument completions after a slash command.**

When the draft starts with a command and arguments follow, the binary still opens lists:
- `suggestionType:"directory"` for the commands in `n2` (`/add-dir`-style path arguments);
- `"custom-title"` for `/resume <title>`;
- `"command"` for any command with `getArgumentCompletions`.

`COMMAND_MENU` requires "at most a space after the name", so `/resume my-sess` or `/add-dir src/`
reads as "no list". `MID_COMMAND` and `AT_MENTION` do not match either.

Failure scenario: the person types `/add-dir src/`, and the directory list opens. They double-tap
Esc to close it. The list closes and the text stays, but the flag clears. A dispatch arrives and
is pasted after `src/`, and the CR submits `/add-dir src/[from A] …`.

`b72339b` held here, because any typed `/` set `pickerMaybe`.

**P2. Low (was already a gap): emoji and Slack channel lists.**
- `rce=/(^|\s):([a-z0-9_+-]{2,})$/` opens an emoji list when `A$e` finds a match. It is gated on
  `emojiCompletionEnabled`, whose check is `emojiCompletionEnabled!==!1`, so it is **on unless set
  false**. A draft ending in ` :ho` (`:hover`, `:house`) can have it open.
- `oce=/(^|\s)#([a-z0-9][a-z0-9_-]*)$/` opens a Slack channel list when a Slack MCP client is
  connected.

Neither is seen by `listMayBeOpen`, and neither was by `b72339b`.

A fix for both, for Code:
- treat any draft that starts with `/` as "list may be open";
- add `(^|\s):[a-z0-9_+-]{2,}$` and `(^|\s)#[a-z0-9][a-z0-9_-]*$` to `listOpensOn`.

Both only widen the hold.

## 2. The merge at `26c3c0d`

- **Resolution.** The only conflict (`git show --remerge-diff`) is DashboardView's import lines.
  The resolution keeps both sides: `clearUnsentInput`, `onDraftChange` and `restoreDrafts` from the
  hold, and `suspendDecision` and `wakesOnFocus` from the lifecycle. Correct.
- **By-hand suspend is blocked by owed messages, unsent text and held deliveries.** True. The
  candidate comes from the shared `suspendCandidate`, which sets
  `pendingSubmission: owesSubmission(...)` (`:4509`) and `unsentInput: hasUnsentInput(...)`.
  `suspendDecision` refuses each of them, plus `heldDeliveries`. `suspendLane`'s own re-check uses
  `owesSubmission` and `!hasUnsentInput` (`:4291`).
- **Retire reads `owesSubmission`.** True: `withActivity` sets `settling` from it (`:1255`).
- **Restart.** `handleRestartLane` and the restart candidate use `owesSubmission` (`:4223`, `:4150`).
- **Lane menu Suspend on a lane with a held message.** `canSuspendByHand` reads the same candidate,
  so the item is not offered.
- **Noted, not a merge issue.** `heldDeliveriesFor` does not count the new `held` outcome
  (`HELD_OUTCOMES`). That is harmless, because a held message is always also owed in the queue and
  `owesSubmission` covers it.

### The automatic lane close that Code reported

The automatic close (`planLaneCloses`, `DashboardView.tsx:4781`) checks neither owed submissions
nor unsent input. This was true on both sides and at the merge base. A lane the person typed into
and left goes quiet. The went-quiet backstop then closes it: the draft is lost with the composer,
and a message held on that draft is written to the dead pty and reported undelivered. It is
reported, not silent, and it existed before. Recommend that `planLaneCloses` skip a lane with
`owesSubmission` or `hasUnsentInput`. That is for Code as a follow-up, and it does not block this
merge.
