# Getting back to Project Home — the navigation model

**Design, 2026-07-28.** Answers `dev/briefs/back-to-project-view.md`. Blocking 0.10.1.

**Status: the blocking fix is built and verified.** This doc records the model behind it and settles the three questions the brief left open, so the next change to navigation doesn't re-litigate them. One item is specced-but-unbuilt and explicitly does not block (§4).

---

## 0. What shipped

| Level | Up-control | Where |
|---|---|---|
| session → **Project Home** | `‹ operator` | session toolbar — **new**, this fix |
| Project Home → gallery | `‹` | `ProjectView` header — already existed |
| gallery | — | top level |

Verified in `dev/drive-navigation.mjs` step 11: present in a focused session, **survives a collapsed sidebar** (the rail case), lands on Project Home with the moodboard reachable, and leaves `activeProjectId` untouched.

Two details that mattered more than they look:

- **The control is rendered unconditionally.** The toolbar previously hid the project name whenever a worktree branch contained it (`branchCoversProject`) — i.e. in most worktree sessions, which is where people live. A control may be redundant with a nearby label; it may not disappear.
- **It reuses `handleOpenProject`**, which clears the focused session while keeping `activeProjectId`. No new state, no new mode: `contentMode` stays derived.

---

## 1. Is it a real hierarchy? — Yes, and every level now has its rung

**gallery → project → session is a genuine containment hierarchy**, not three peer views. A session belongs to exactly one project; a project belongs to the gallery. The bug was that the hierarchy was only navigable *downward*: you could always go up one level **except from the level you are usually on**, and Project Home appeared solely as a side effect of unfocusing a session.

That asymmetry is the whole defect, and it's why a correctly-built, correctly-scoped moodboard read as missing. **A feature you cannot navigate to is indistinguishable from one that does not exist.**

**Rule to hold:** every level of this hierarchy has one visible, labelled control to its parent, and that control is in the header of the thing you are looking at. If a new level is ever added, it ships with its rung or it doesn't ship.

### Why not a full breadcrumb

The brief asks whether a breadcrumb is the honest expression. **Not at this depth.** A breadcrumb (`operator / Code`) earns its complexity when there are ancestors you'd want to jump *past* — but there is exactly one ancestor above a session, and the gallery is already one keystroke (`⌘⇧O`) or one logo-click away. A two-item breadcrumb is chrome that looks like navigation.

**Revisit if** a fourth level appears — a session sub-view that owns the header, say. Then the jump-past case becomes real and the breadcrumb pays for itself.

---

## 2. The sidebar project name — switcher only, no longer double duty

The brief is right that this was half the problem: the name was *the* home affordance, but it sits beside a `⌄` and presents as a project switcher. Two behaviours on one control, one of them signalled by a chevron that means the other.

**Decision: the sidebar header is the switcher. Full stop.** It no longer carries "go home" as an unadvertised second meaning.

Home is reachable from two places instead, both labelled:

1. **The session toolbar breadcrumb** (§0) — the primary route, and the one people look for.
2. **Inside the switcher popover**, the current project's row is tagged **`HOME`**. That row always did navigate to Project Home; it simply never said so, which is the other half of why this was missed. Now it says so.

The accent colouring on the sidebar name when `projectHomeActive` stays — but it is **state, not an affordance**: it tells you where you are, it does not advertise a click. That distinction is what went wrong here, and it is worth stating because the colouring looks like a call to action if you don't know its job.

---

## 3. What *doesn't* change

- **`contentMode` stays derived.** The temptation is to add an explicit `goToProjectHome` mode. Don't: derived-from-state is why scope survives Preferences, Usage and the Agents hub. The fix needed an *action* (clear the focused session, keep the scope), not a new mode.
- **`activeProjectId` is never touched by going home.** Going up a level inside a project must not change which project you are in. Asserted in the driver.
- **`ProjectView`'s existing `‹`** is untouched and remains the project → gallery rung.

---

## 4. Keyboard route — specced, not built, not blocking

There is no chord for "up to Project Home". Today's set: `⌘K` palette, `⌘N`, `⌘B`, `⌘W`, `⌘J`, `⌘1–9`, and the shifted navigation pair `⌘⇧O` (all projects) / `⌘⇧P` (switch project).

**Spec: `⌘⇧H` — up to Project Home**, completing the navigation triad as the third shifted pair-mate. Shift-gated for the same reason as its siblings: plain `⌘H` has no app meaning and must stay the terminal's.

**It must be added to `lib/key-routing`'s `isAppChord`, or the terminal swallows it.** The window handler alone is not enough — the terminal has to decline it too. This has bitten before (see `project_project_first_navigation`), and `⌘E` is the standing example of a chord wired in `DashboardView` that has never fired because it was never added there.

**This does not block 0.10.1.** The blocking defect was that there was *no* way back; that is fixed with a visible, labelled control that works with the sidebar collapsed. A chord is an accelerator for a route that already exists, and shipping one without the `isAppChord` entry would be worse than not shipping it — it would look wired and do nothing.

---

## 5. Verification

`dev/drive-navigation.mjs` step 11, already in the suite:

- a focused session has exactly one `[data-back-to-project]` control;
- it survives `⌘B` (sidebar collapsed to the rail) — the case the brief asks for specifically, and the reason the control lives in the toolbar rather than the sidebar;
- clicking it lands on Project Home with the moodboard reachable;
- `activeProjectId` is unchanged across the transition.

Theme-passed with the rest of the surfaces: **0 below floor** across all six palettes.

If `⌘⇧H` is built later, extend that step to press the chord from a focused session and assert the same four things, and add an `isAppChord` unit test alongside the existing `⌘⇧O`/`⌘⇧P` ones.
