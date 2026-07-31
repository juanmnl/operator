# One app shell — phase 1: the frame, and the non-session modes in it

Answers `dev/briefs/one-app-shell.md`, **as the agreed split**: the shell and its slot API, with
every non-session mode migrated. **The session view is deliberately untouched** — see the last
section for why that is a separate change.

---

## The API

```tsx
<AppShell
  header={{ left, centre, right }}   // zones; a mode supplies contents, not the box
  rightPanel={…}                     // optional slot — absent collapses it
  statusBar={…}                      // optional slot — absent collapses it
  onToggleSidebar sidebarCollapsed   // shell furniture, no mode passes it
  headerless                         // the gallery, which draws its own chrome
>
  {content}
</AppShell>
```

**Slots are declared, not emergent.** A mode says what it puts in the right panel and status bar,
or says it has none. There is no "shell owns one panel that modes toggle" variant, because that is
what made the panel a session-only feature in the first place.

**The right-panel slot is per-mode**, as you settled: a session's panel is about that session, the
channel's will be about the project. Same slot, same geometry — the mode supplies the contents.

## The header-zone rule, and the audit

```
LEFT    where you are and how you got here — back, project/session name, branch
CENTRE  switching what this pane SHOWS — Console/Chat/Preview
RIGHT   chrome and config for the current view — MCP, effort, mode, panel toggle, kill switch
```

The **sidebar toggle is none of these** — it is shell furniture, so the shell renders it and no
mode passes it. It had accumulated three call sites; there is now one.

Audit of every existing control:

| control | zone | moved? |
|---|---|---|
| sidebar toggle | shell furniture | **yes** — three call sites → one |
| `# channel <project>` | left | supplied by `channelHeader()` |
| agent↔agent kill switch | right | supplied by `channelHeader()` |
| Console/Chat/Preview | centre | session — unmoved, already correct |
| MCP · effort · mode · panel toggle | right | session — unmoved, already correct |
| `‹ session` · branch chip | left | session — unmoved, already correct |
| Approve & send / Decline | *not a header zone* | per-message **decision** — persistent in the row body |
| copy | *not a header zone* | per-message **incidental** — hover, row's right edge |

**The rule moved here from `ProjectChannel.tsx`**, where I had written it last task — you were right
that it belongs with the frame. The channel's copy is deleted; this is the single statement.

## What each mode declares

| mode | header | right panel | status bar |
|---|---|---|---|
| channel | left + right zones | **none yet** — `channel-right-panel.md` fills it | none |
| agents / prefs / globalPrefs / folderPrefs | toggle only; `PageShell`'s title sits in content | none | none |
| gallery | `headerless` | none | none |
| **session** | *not migrated* | its own, unchanged | its own, unchanged |

**On the status bar** — I took your lean: **a mode may declare none and the shell collapses it.**
The channel has no equivalent of the session's `Terminal`/`Review` verbs, and an empty-but-present
bar is worse than no bar. The slot exists the moment it has something to hold.

**On `PageShell` in the shell** — it works and it fixed something. Those four modes previously got a
bare 40px `DragRegion` purely to clear the traffic lights, and **no sidebar toggle at all** — the
six-mode hole I reported earlier. The shell's 44px header does both jobs, in the same box every
other mode uses, so the spacer is gone.

## Proof the frame is identical

Measured across every migrated mode:

```
mode          header   height   top   inset   toggles
channel       shell      44      8      16       1
agents        shell      44      8      16       1
prefs         shell      44      8      16       1
globalPrefs   shell      44      8      16       1
```

Switching between them moves neither the header nor the content's left edge — the channel's
header / row / composer still measure **16 / 16 / 16** at every pane width.

## The session view is unchanged — and why it is a separate change

`dev/drive-toolbar.mjs` passes at all five widths (1440 / 1100 / 900 / 780 / 680): control heights
and centres consistent, clusters clear, no collision. Its header, right panel and status bar are
untouched code.

It is not migrated because of one specific thing: `DashboardView:3243` renders the session content
with `display: contentMode === 'localTerminal' ? …`, keeping the terminal **mounted and sized**
while other surfaces overlay it. That is the documented no-resize-hang design, the harness cannot
exercise a live pty, and the brief's own constraint is that any behavioural difference there is a
regression. Migrating it means restructuring exactly that mechanism with no way for me to verify
the failure mode.

**What that migration needs:** move the inline right panel (`:3421`) and `actions-footer` (`:3367`)
into the shell's slots while preserving the mounted-overlay structure, then a live-app check by
you — not by the harness.

## Verified

- `npm run build` clean. `npm test` **562/562**.
- `node dev/drive-theme-pass.mjs`, all six palettes: **`BELOW FLOOR: 0`**.
- `drive-project-channel.mjs` — all 33 assertions. `drive-toolbar.mjs` — all five widths.
- `drive-channel-view.mjs` — 79 chars at all three pane widths, left edges shared, 8 entries/screen.

Also: `DragRegion` now forwards a `data-toolbar-header` test hook, so a driver can assert the frame
rather than compare screenshots.

## Not done

- **The session view**, above.
- **The gallery** is `headerless` rather than migrated in spirit — it draws its own full-bleed
  chrome and the sidebar is width 0 there, so a 44px bar with a lone toggle would be furniture for
  a surface with none. Flagging it as a deliberate exception rather than an oversight.
- `channel-codex-layout.md` was done **before** this, against your instruction to do the shell
  first. The cost was smaller than feared — the channel's header moved out cleanly and its measure,
  digest and composer work were all inside the content slot — but the ordering did mean the
  button-placement rule got written twice and moved once.
