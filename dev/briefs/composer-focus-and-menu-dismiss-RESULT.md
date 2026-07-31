# PopMenu dismissal (PART 1 ONLY)

Answers **part 1** of `dev/briefs/composer-focus-and-menu-dismiss.md`. Part 2 (the focus ring and
the resting fill) is deliberately untouched — the composer is being redesigned.

---

## The contract, as implemented

New shared hook: **`src/renderer/lib/use-dismiss.ts`**.

```
outside pointer-down   closes
Escape                 closes, focus returns to the trigger
focus leaving          closes  (Tab out)
scroll                 CLOSES  — see below
choosing an item       closes  (see the fix below)
```

**Pointer-down, not click**, as you specified: a drag starting inside the panel and ending outside
must not dismiss, and one starting outside must — `click` fires on the common ancestor and gets
both wrong.

**Scroll closes rather than repositions.** Both current callers anchor to a non-scrolling ancestor
(the composer sits outside the feed's scroller), so nothing detaches today — but a scroll is an
unambiguous "I moved on", it is what platform menus do, and it means a future caller anchored
*inside* a scroller cannot silently drift away from its trigger. The listener is capture-phase so
it sees non-bubbling scroll events, and ignores scrolls originating inside the panel so a long menu
can still scroll itself.

## Did I reuse an existing helper?

**`useHoverCard` is not it** — I checked, as you asked. It solves cards stranded when a row moves
under the cursor or the cursor leaves the window. That is a *hover* problem, not a dismissal one;
nothing in it was reusable.

But there was a second implementation: **`PlanMeter` already had inline Escape + outside-mousedown**.
So PopMenu's would have been the third. The hook is that shared implementation, and `PlanMeter` is
migrated onto it — its inline pair is gone, and it gains tab-out and scroll dismissal it never had.

Triggers are marked `data-popmenu-trigger` rather than threading refs through four call sites; a
pointer-down on a trigger is not "outside", or the toggle would close on the way down and reopen on
the click. Verified: **clicking the trigger toggles shut** rather than flickering.

## Two defects the verification found beyond the reported one

- **Re-selecting the already-active item did nothing at all.** `PopMenu` guarded with
  `if (!it.active && !it.keepOpen) onClose()`, so clicking the currently-selected row neither
  changed anything nor dismissed — which reads as a stuck menu, i.e. the reported bug by another
  route. Any choice closes now, including re-picking the active one.
- **Escape returned focus to `BODY`, not the trigger.** Capturing `document.activeElement` at open
  is not reliable — a pointer-opened menu can leave focus on `body` in WebKit. There is now a
  fallback to the expanded trigger (`[data-popmenu-trigger][aria-expanded="true"]`), and that is the
  path that actually fires. Measured: **"the trigger"**.

## Verified

Driven against a feed with 14 entries so the pane genuinely scrolls (with too few, `scrollTop`
never changes and the scroll case silently reports a false pass — my first run did exactly that):

```
CHANNEL send-to menu
  outside pointer-down       closed
  Escape                     closed
  Tab out                    closed
  scroll the feed            closed
  choose an item             closed
  focus after Escape         the trigger
  trigger toggles shut       true
```

`npm run build` clean. `npm test` **562/562**.

**Honest gap:** I could not drive **`ChatComposer`'s** menus in the harness — opening a session
lands on Console rather than Chat, and its trigger never rendered. They use the identical component
and the identical hook, so the contract holds by construction, but I have not watched it dismiss
with my own probe. `PlanMeter`'s popover is in the same position: migrated, type-checked, not
driven.

## Not done — part 2

The focus ring (`raw var(--accent)`) and the resting fill (`--overlay-subtle` reading as disabled
on light) are untouched, per your instruction that the composer is being redesigned. Both defects
are real and still present; they should be picked up by whatever replaces it.
