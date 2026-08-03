# Handoff — the coordinator was five commits behind, and the user was one build behind

**Written 2026-08-03, from the Operator lane (`operator/f35678`). Short session, two reports, no code
shipped from this lane.** Read this before diagnosing anything from a lane worktree, and before
believing a "still happening" report.

---

## What happened

Two user reports, in order:

1. **The macOS TCC modal — *"'Operator' would like to access data from other apps"* — "still getting
   this all the time."** I traced it to per-pid `lsof` in `session_ports` and dispatched Code to fix it.
   **The fix had already shipped**, from Code, in this same session: `2336610`, released as **v0.13.1**.
   I was diagnosing from a worktree based on `a023972` (the v0.13.0 handoff) and never checked. Code
   caught it and told me. Dispatch retracted; worktree fast-forwarded to `ce86232`.
2. **"When collapsed, I can't access settings, toggle, etc."** Verified on current `main` and dispatched
   to Design (in flight — see Open).

Net output of this lane: one live brief, one retraction, one worktree cleanup. Nothing merged.

---

## Traps — do not re-derive these

### 1. A lane worktree is a stale snapshot, and it will let you be confidently wrong
My root cause was correct code-reading — right file, right call chain, right polling intervals — and
**entirely obsolete**, because `main` had moved five commits underneath me during the session. Nothing
about reading `src-tauri/src/lib.rs:423` tells you it was deleted an hour ago. The evidence looks
identical either way.

**Before writing any brief: `git log --oneline main --not HEAD`.** If it prints anything, refresh first.
This is cheap and I skipped it, and the cost was an interrupt fired into a working lane telling it to fix
its own already-merged commit.

Generalises the coordinator lesson already in the vault ("merge as results land") from the *merge*
direction to the *read* direction: a coordinator who doesn't pull is briefing against a codebase that no
longer exists.

### 2. "The fix didn't work" — check the running binary before the source
The user was on a locally-built **v0.13.0**: `…/target/release/bundle/macos/Operator.app`, binary written
11:12, process launched 11:39, while the fix landed after. `strings` on that binary still contained the
`lsof` / `sTCP:LISTEN` arguments. A Tauri app keeps the frontend and the Rust binary it launched from —
replacing files on disk changes nothing about the running window.

**Three checks, all cheap, in this order:** `ps -o lstart` on the process → `ls -lT` on the binary →
`strings <binary> | grep <the thing you removed>`. The third is the decisive one and it is not obvious;
it proves the *shipped artifact* rather than the source tree.

This is the **second** time in two days a "fix didn't work" report resolved to a stale running process
(the first was the timezone/UTC one). It is now a pattern, not a coincidence — treat it as the default
hypothesis, not the fallback.

### 3. Standing hazard, restated because it bit again
`/Applications/Operator.app` is **v0.5.0, Jun 30** — five weeks and eight releases stale. That is what a
Dock or Spotlight launch opens. Anyone reasoning about "what the user is running" must ask *which*
Operator, not *whether* Operator.

### 4. Copying a brief into a lane worktree can silently clobber that lane's work
Briefs are invisible across worktrees, so the standing practice is to copy each brief into every live lane
dir. That practice writes into someone else's working tree. I copied `tcc-lsof-prompt.md` into two
worktrees — and `main` already contained Code's own file at that exact path. Here it landed as untracked
in both (confirmed via `git status --porcelain -- dev/briefs`, then removed), so nothing was lost. It was
luck, not care.

**`git -C <target> status --porcelain -- dev/briefs` before the `cp`.** A brief is not worth overwriting a
lane's in-progress result file.

---

## The two reports are causally linked, and that is the real finding

The collapsed sidebar strands **Settings, both prefs surfaces, the theme toggle, and the app version +
Install-update button** — the expanded `Sidebar` footer (`Sidebar.tsx:449/457/467/478`, `version`/`update`/
`onInstallUpdate` at `:70-74`) has all five; `SidebarRail` (`SidebarRail.tsx:75`) accepts **none** of them.
Zero occurrences of `onOpenPrefs`, `onToggleTheme`, `onInstallUpdate` in that file. It isn't a restyled
footer for 64px — it does not exist there.

**The update button exists nowhere else in the app.** So a user who works collapsed has no surface telling
them a release exists, which is one direct route to running a stale build, which is how you get a bug
report for something already fixed. Report 2 is a plausible cause of report 1.

`⌘K → toggle-sidebar` is not a mitigation: "un-collapse the thing you deliberately collapsed" is not access.

---

## Open

1. **Design is mid-flight on the collapsed rail** — brief `dev/briefs/collapsed-rail-strands-the-footer.md`,
   result due at `dev/briefs/collapsed-rail-strands-the-footer-RESULT.md`. Asked to **propose before
   building**: it's the bottom-left corner of every screen, the rail already spends that corner on
   `onOpenTeam` (see the precedent note at `SidebarRail.tsx:22`), and parity is explicitly *not* the goal —
   access is. Update visibility must be a visible state, not merely reachable.
2. **The user still has to rebuild or take the v0.13.1 update** before the TCC modal stops. Until then the
   symptom persists and means nothing.
3. **The TCC fix is still unverified by anyone.** Code shipped it unable to prove a *system* prompt stopped
   firing — no harness can observe that. It needs the owner's eyes on a real signed v0.13.1. If the modal
   survives the update, the candidate-set replacement is not the whole story and this reopens.

---

## Process note worth keeping

Code's correction arrived as a single `OPERATOR-REPLY` line and was worth more than any brief I wrote this
session — it cost one line and saved a lane from re-doing merged work. **A lane that pushes back on the
coordinator with a fact is the cheapest error-correction in this system.** It is also the second time in
two days that a lane's reasoned objection beat the coordinator's instruction. Keep the channel that
carries those open, and keep dispatches specific enough to be *refutable*.
