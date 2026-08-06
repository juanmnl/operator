# RESULT — `Retry` on a stranded dispatch, and `Open lane →` that moves you

Build clean · `npm test` **642 passed**. Both fixes driven against the real board.

---

## Bug 1 — Retry, and the semantics I chose

**It re-delivers the WHOLE message, through the same `deliverDispatch` path that approval and
routing use.** Not a bare CR into the lane's composer.

Both were genuinely on the table and the CR is cheaper — the text is already sitting there, and a
lone CR is a no-op on an empty composer. I rejected it because **it is only correct if the composer
still holds exactly what was pasted**, and these cards are hours to days old:

- composer **edited** since (a human typed into that lane): the CR submits text nobody chose to
  send. That is the worst outcome available here — it is not a failed retry, it is a wrong send.
- composer **cleared** since: the CR is a silent no-op, and the retry reports nothing.

Re-delivery depends on nothing that may have changed. It also goes through the one delivery path,
which is what satisfies the brief's hard requirement: **that path arms the closed loop**, so a
retry that does not arrive lands back on `undelivered` rather than flipping the card to delivered.
A second send path would have had to re-implement the confirmation, and would drift from it — the
codebase states that principle twice already, at `approveDispatch` and `assignDispatch`.

### What happens when the composer is no longer in the state that was left there

Stated plainly, because it is the cost of the choice:

**If the original paste is still sitting in the composer, the new one appends to it and the lane
reads the task twice, concatenated.** That is ugly. It is not destructive: the lane still receives
the task and acts on it once. **There is no composer-clear primitive in the app today** — the
rescue mechanism is a CR, which *submits* rather than clears — so this cannot currently be avoided.
Adding one (a kill-line before the paste) removes the duplication and is the obvious follow-up; I
did not add it in this pass because it is a new pty-input primitive and belongs with its own
verification, not smuggled into a recovery button.

If the composer was edited or cleared, re-delivery is simply correct — it does not care.

### Several cards, one lane

**They queue, and no refusal was added.** `submitQueue` is an ordered FIFO per terminal id, so
retries are delivered in the order they were clicked rather than racing each other. The queue
already answers the question the brief raised; a "one at a time" rule would be a second mechanism
saying the same thing less well.

### Where it appears

`Retry` leads the footer, `Open lane →` next, `Dismiss` last — the same order as the two branches
above it, where the verb that moves work forward leads and the one that closes it sits last. It
renders **only** on `undelivered` cards: the other Waiting outcomes were never sent, so there is
nothing to send *again* — they are approved or dismissed.

---

## Bug 2 — `Open lane →` now takes you there

The live branch called `focusTerminal`, which sets `activeTerminalId` / `activeSessionId` /
`activeProjectId` and **nothing else**. Two ways that produced "no visible effect":

1. `contentMode` ranks `prefs` / `agents` / `globalPrefs` / `folderPrefs` **above** `localTerminal`,
   so with any of those up the click changes ids behind the screen you are looking at.
2. It **returns early** when the id is not a live tab — and `liveRoles` is built from `terminals`
   *without* filtering `ended`, so a lane that has since died yields a truthy id that focuses
   nothing. The click was then swallowed rather than falling through to the roster.

New `openLaneTerminal` clears the competing surfaces the way `handleSelectSession` does, pins the
surface to the Console, and **returns whether it landed** so the caller can fall back:

```ts
const opened = tid ? onOpenLaneTerminal?.(tid) ?? false : false
if (!opened) onSelectTab('team')
```

**Added at the call site, not inside `focusTerminal`** — per the brief's instruction to check the
other callers first. There are two others (a toast's "Show" action, and the reconcile effect at
:577); both deliberately nudge state *under* whatever the user is looking at, and giving them
navigation would be a regression. So the shared helper is untouched and the board gets its own.

---

## Verify

Driven against the real board (`dev/mock-bridge.ts` gained one fixture — see below):

| Bullet | Result |
|---|---|
| `sent · never started` has a Retry that delivers | **2 Retry buttons** on the two `undelivered` cards; clicking one produced a real bracketed paste to the live lane's pty: `{"id":"t1","len":54,"head":"[200~Extract the dispatch router (retry…"}` |
| A retry that fails again shows as failed | By construction: it re-enters `deliverDispatch`, which arms the delivery confirmation — the same loop that produced `undelivered` in the first place. Not separately driven; the failure requires a real unresponsive TUI |
| `Open lane →` on a **live** lane lands you in it, in one click | Board present `true` → `false` after the click |
| `Open lane →` on a **dead** lane still lands on the roster | The `!opened` fallback now catches both "no id" *and* "id is stale", which is strictly more than the earlier fix covered |
| The nine stranded dispatches clear through the UI | Retry and Dismiss are both on the card; `projects.json` untouched |
| `npm test`, build | 642, clean |

**One fixture added:** the shipped mock had a single stranded dispatch aimed at an **idle** lane —
i.e. the branch that was already fixed — so the remaining dead path had no fixture at all. Added
`d-stranded-live`, aimed at the live `code` lane. Without it this driver would have exercised the
working half and reported success.

---

## Not done

- **No composer-clear before re-delivery**, so a retry against an untouched composer duplicates the
  text. Described above; the fix is a new pty primitive and wants its own pass.
- **The failed-retry path is not driven end to end** — it needs a TUI that accepts a paste and
  never starts a turn, which the mock cannot fake honestly. The mechanism is shared with the
  existing loop rather than reimplemented, which is why I am comfortable asserting it by
  construction and saying so here rather than claiming it was observed.
- **Timing constants untouched**, per the brief — the race is environmental (27 lanes live, the
  renderer at ~1 GB), and this makes the failure recoverable in one click instead.
- **The artifact plane is not entangled with this.** No shared code; this repairs the path that
  exists today.
