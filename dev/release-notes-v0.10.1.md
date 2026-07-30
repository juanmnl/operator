# Operator v0.10.1

Fixes the lane-deletion bug in 0.10.0, and the chat transcript now feeds instead of snapping.

## The ✕ on a lane card no longer deletes your lane

**This is the fix 0.10.0's release notes warned about.** In 0.10.0, ✕ on the project's agent board
removed the lane outright — its model, effort, accent and charter — unassigned every task pointing at
it, and left a running agent going with no lane to represent it. One click, no confirmation, no undo.

Now:

- **Deleting a lane takes two clicks.** The first arms it, the second commits.
- **A live lane can't be deleted at all** — stop it first. No more orphaned sessions.
- **The card has a real close-session control**, which is what most people wanted from ✕ in the
  first place. It routes through exactly the same path as closing from the sidebar, so there's one
  session lifecycle rather than two that can drift.

If you lost a lane on 0.10.0, re-add it from `+ Add agent` on the agent board — the preset restores
its configuration. Tasks that were assigned to it are sitting unassigned in the backlog and will need
reattaching.

## The transcript feeds upward

New messages used to jump the view to the bottom, so they appeared rather than arrived. The chat now
rises continuously, like paper through a typewriter.

It stays out of your way: scrolling up wins immediately and isn't fought, a jump larger than a
screenful snaps rather than sliding slowly through content you didn't ask to see, and
`prefers-reduced-motion` disables it.

Deliberately **not** a character-by-character reveal. Transcript text arrives in chunks, so typing it
out would misrepresent when the work actually happened — only motion we were already making is
animated.

## Also

- The sidebar has a proper empty state, now that new projects start with no lanes and you add them as
  you need them.

---

## Known issue — the feed stops following

Two bugs in the new upward feed, both found in review just after this build published, both fixed in
0.10.2:

- **Clicking anywhere in the transcript stops it following.** Cancellation is wired to the wrong
  event, so a plain click — not just a drag — detaches the feed.
- **Scrolling with a wheel while already at the live edge detaches it permanently**, with no way back
  short of switching sessions.

Neither loses data and neither affects the lane-deletion fix above. If the transcript stops rising on
its own, that's this — switching away and back re-engages it.

## Verification

The six-palette contrast sweep that couldn't complete for 0.10.0 has now run: **all six palettes,
zero below the contrast floor.** That was the one gate 0.10.0 shipped without, and it came back
clean — so the light-theme readability concern flagged in those notes did not materialise.
