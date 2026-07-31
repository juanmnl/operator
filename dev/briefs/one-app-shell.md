# Brief — one app shell. Every view sits in the same frame.

User, with the channel and a session side by side: **"i need all layouts to be the same."**

**Do this BEFORE `channel-codex-layout.md` and `channel-digest.md`.** Those shape what lives inside
the conversation column; this defines the frame that column sits in. Doing them first means doing
them twice.

## What the two screenshots actually differ by

| | channel | session |
|---|---|---|
| right panel | **absent** | PLAN · DIFF · CHAT + YOUR TASKS |
| bottom status bar | **absent** | `Terminal` `Review` + the worktree path |
| header contents | toggle · `# channel <project>` · kill switch | toggle · `‹ <session>` · branch chip · CONSOLE/CHAT/PREVIEW · MCP · effort · mode · panel toggle |
| content width | full pane (no right panel to share with) | pane minus the right panel |

## The cause

**There is no shell component.** `grep` finds no `*Shell*` in `components/`, and the right panel and
the `actions-footer` status bar are rendered inline inside `DashboardView`'s **session branch**
(~`:3367`). So they exist for exactly one content mode, and every other mode — channel, agents,
prefs, gallery — gets whatever frame its own branch happens to build.

That is also why the header alignment drifted, why the sidebar toggle was missing from six modes,
and why the channel had to invent its own header. Each was a symptom; this is the thing.

## What to build

**One shell that owns the frame**, with slots each content mode fills:

```
┌──────────────────────────────────────────────────────────┐
│ HEADER            [context] [view switch] [view chrome]   │
├───────────────────────────────┬──────────────────────────┤
│ CONTENT                       │ RIGHT PANEL (optional)   │
│                               │                          │
├───────────────────────────────┴──────────────────────────┤
│ STATUS BAR        [actions]                     [context] │
└──────────────────────────────────────────────────────────┘
```

The rail and sidebar sit outside it and are unchanged.

**Header zones — this is the button-placement rule** the Codex brief asked for; it belongs here
instead. Define what each zone is *for*, then audit every existing control into it:

- **left** — where you are, and how you got here (back, project/session name, branch)
- **centre** — switching what this pane shows (CONSOLE/CHAT/PREVIEW is the existing example)
- **right** — chrome and config for the current view (MCP count, effort, mode, panel toggle, the
  agent↔agent kill switch)

The sidebar toggle is shell furniture, not view chrome — it should come from the shell, not be
rendered by three toolbars. You just extracted `SidebarToggle`; move it up rather than keeping
three call sites.

**Right panel and status bar become shell slots.** A mode declares what it puts there, or declares
that it has none — but the *decision* is explicit rather than emergent from which branch renders
what.

## ANSWERED — what goes in the channel's right panel

I had left this open with three options. **The user has answered it:**

> *"channel needs a right panel, maybe it's a place to have the moodboard, and other global,
> project wide info"*

So: **project-wide context**, not session context and not a message detail pane. The content brief
is `dev/briefs/channel-right-panel.md` — build the **slot** here and let that fill it.

What this settles for the shell: the right-panel slot is **per-mode**, not global. A session's panel
is about that session (PLAN · DIFF · CHAT); the channel's is about the project. Same slot, same
geometry, same collapse behaviour — different contents. Design the API so a mode supplies the panel,
rather than the shell owning one panel that modes toggle.

The **status bar** is still open. The session's carries `Terminal` / `Review` and the worktree path.
The channel has no equivalent verbs yet; an empty-but-present bar is worse than none. My lean is
that a mode may declare no status bar and the shell collapses it — but say what you chose.

## Constraints

- **Behaviour-preserving for the session view.** It is the most-used surface; its header contents,
  right panel and status bar keep working exactly as now. This is extraction, not redesign.
- Keep: the toolbar-header 44/16 box, the `PageShell` **page** family (do not fold it into this —
  page views legitimately have a different header; the shell owns the frame *around* them),
  local timestamps, the 4px rhythm, the shared left edge.
- `PageShell` views (agents, prefs, globalPrefs, folderPrefs) should sit in this shell too, with a
  page header inside the content slot. Say if that turns out to be wrong.
- No colour-changing border on a radiused element; no browser focus rings; no stacked opacity.

## Verify

- Screenshot every content mode and confirm the frame is identical: header height and inset, where
  the content starts, whether the right panel is present, whether the status bar is present.
- **The session view is unchanged** — compare before/after directly. Any difference there is a
  regression unless you argue for it.
- Switching between modes must not move the header or the content's left edge.
- `npm test`, `npm run build` clean; `node dev/drive-theme-pass.mjs`.

## Where to work

`main` is at `573deaa`. Commit in your own worktree; I'll merge forward. Do not touch
`/tmp/claude-501/merge-main`.

## Output

`dev/briefs/one-app-shell-RESULT.md`: the shell's API, the header-zone rule and the audit of every
control into it, what each mode declares for the right panel and status bar, your answer on the
channel's panel, and proof the session view is unchanged. Then one OPERATOR-REPLY line.
