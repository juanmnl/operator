# RESULT — the project channel, step 1: read-only feed

Shipped as specified: one merged, time-ordered feed of what already exists. **Nothing sends.**
Screenshot: `/tmp/operator-shots/project-channel.png`.

---

## First, the thing you asked me to check: `projectReplies` on the real store

**The table exists and is EMPTY — 0 rows. It is not broken.**

```
sqlite3 ~/.operator/chat.db ".tables"        → messages  replies
sqlite3 ~/.operator/chat.db "SELECT COUNT(*) FROM replies;"  → 0
sqlite3 ~/.operator/chat.db "SELECT COUNT(*) FROM messages;" → 13649
```

The schema is present with its `replies_by_project` index, so the migration has run — the app has
been launched on that build. It holds nothing because **no lane has ever emitted
`OPERATOR-REPLY`**: the sentinel shipped days ago, nothing prompts a lane to use it, and the
charters don't mention it. The stray-row sweep also reads 0 (`messages WHERE kind='reply'`), so
the intermediate-build cleanup did its job.

**Consequence, stated plainly: the reply half of this feed is unexercised against real data.**
Today the only real content in your channel is `Project.dispatches`. The merge, attribution and
ordering for replies are covered by unit tests and by the driver against synthetic rows, but the
first real reply will be the first real proof. If you want content there, the cheap move is a
line in the coordinator's charter telling it to post progress with `OPERATOR-REPLY [project] …`.

---

## What landed

### `lib/project-channel.ts` — the merge, render-free and unit-tested

`buildChannelFeed(dispatches, replies, roster, sessions)` → one ascending feed.

- **Ties break on id**, so two entries stamped in the same second can't reshuffle between
  renders (asserted both ways round).
- **Identity.** A dispatch resolves `fromRoleId`/`toRoleId` against the roster. A reply carries
  only `sessionId`, so it resolves session → `roleId` → Role; when that fails the **raw id is
  printed** (`s-vanished` in the driver) rather than blanked or guessed. An unnamed dispatch
  sender reads `unknown lane` — real, since an ad-hoc session has no lane.
- **`project` is the broadcast token** → no target shown.
- **No subagent attribution.** `NarrationEntry` has no caller field, so everything is attributed
  to the lane, full stop.
- `chipForOutcome` — one chip per outcome, none invented, and an unknown future outcome prints
  verbatim instead of being mislabelled. Only `pending-approval` is `actionable`.
- `unreadEntries`, `groupByDay`, `channelInitials` alongside.

### `components/session/ProjectChannel.tsx` — the view

- **Avatars are CIRCLES** (`border-radius: 50%`, asserted). Squares are the project vocabulary
  (`ProjectRail` tiles); circles are the lane/session one. Accent tint + a **static** hairline
  (no colour-changing border on a radiused element), initials through `laneTextColor`.
  An unresolved author gets a neutral `--overlay-medium` fill rather than a borrowed lane colour.
- Header row: author in `laneTextColor(accent)` · `→ target` muted · time · state chip.
  Body is prose in the body face. Day separators between buckets. Nothing animates — it's history.
- **Held rows expose Approve & send / Decline wired to the existing `onApproveDispatch` /
  `onRejectDispatch`.** No second approval path.
- Scroller full width, measure box on inner children, header sticky **inside** it, `overflow-y:
  scroll` — the containing-block rule from the layout-shift work. `drive-layout-shift` still
  reports NO LAYOUT SHIFT.

### `Sidebar.tsx` — the `# channel` row

Above the `AGENTS` label, so it reads as the room rather than another lane. Unread badge, active
tint, `data-channel-nav`.

### `DashboardView.tsx` — wiring

`contentMode === 'channel'`, ranked below a focused session (opening a lane from the channel
shows the lane) and above Project Home. `activeProjectId` still scopes it. Read marks live in
`localStorage['operator.channelReadAt']` keyed per project; reading clears the badge.

---

## Two defects the verification caught

**1. The unread badge under-counted.** I first loaded replies only when the channel *opened*, so
the sidebar counted dispatches but zero replies until you looked — the badge disagreed with the
feed it was advertising (6 vs 9 in the driver). Now replies load whenever a project is **scoped**.
One query per project switch, and the badge is computed from the *same* `buildChannelFeed` the
view renders, so the two cannot diverge.

**2. The accent chip was unreadable on two light palettes.** `channel state chip` measured
**2.92:1 on Mission Control light and 2.44:1 on 1984 light** — under the 3:1 floor. Same
bare-`var(--accent)`-as-small-text class as the ALSO ACTIVE tail and the sidebar project name.
Both accent-derived tones now use `color-mix(in srgb, var(--accent) 55%, var(--fg))`: **5.46–13.40
across all six**. `--status-compacting` and `--fg-muted` were already tuned and are untouched.

---

## Verification

- `npm test` — **308 passed / 37 files**. `npm run build` — clean.
- **17 new unit tests**: interleaving by timestamp; total ordering under tie; each outcome → one
  chip; only `pending-approval` actionable; unknown outcome verbatim; reply resolved via session;
  **unresolvable session printed raw**; broadcast target null; unroutable dispatch readable;
  unread counts only entries newer than `lastReadAt`, everything when never read, nothing when
  caught up; day bucketing; initials.
- **`node dev/drive-project-channel.mjs` (new)** — 8 groups, all green:

```
1 sidebar row: {"text":"#channel9","unread":"9"}
2 feed order: FIRST · REPLY between · SECOND | THIRD · FOURTH · REPLY broadcast · FIFTH · SIXTH · REPLY from a gone session
2 interleaved by time: true      day separators: [2026-07-29, 2026-07-30]
3 chips: delivered, posted, delivered, queued · behind current task, held · needs your approval,
         posted, declined, no matching lane, posted
4 authors: Operator, Code, Operator, Operator, Research, Research, qa, Operator, s-vanished
4 avatars are CIRCLES: 50%
5 approve/decline offered only on the held row: [d4]
6 composer: textareaDisabled true · sendDisabled true · pills [everyone, Operator, Research, Code, Design]
6 nothing was written to any pty: true   (writes 0 → 0, after fill + click + ⌘↵)
7 unread after reading: null   read mark persisted per project
8 approving delivered the held task: 1   its chip → delivered
```

Note `qa` and `s-vanished` in the author list — those are the two fallbacks working: a dispatch
from a lane the roster doesn't have, and a reply whose session is gone.

- `node dev/drive-theme-pass.mjs` — 6 palettes, **0 below floor**, with five new probes:
  author name 6.48–7.99, avatar initials 4.87–7.20, message body 12.99–17.15, both chips
  5.46–13.40, composer note 4.16–7.03.
- `drive-dispatch-authority`, `drive-sidebar`, `drive-navigation`, `drive-layout-shift` — pass.
- Ran against a temporary vite on 1440 (your dev server is down); stopped afterwards.

## Does the inert composer read as honest or as a tease?

**Honest, and I'd keep it — but only because of the helper line.** The disabled field plus the
target pills is what makes the page read as a room rather than an audit log; without it the view
is a table with a `#` on top. What stops it being a tease is that it says *why* in words —
"Read-only for now: this shows what your agents have said to each other. Sending — and delivery
into a lane — lands in the next step." — rather than leaving a dead control to be discovered by
clicking. The placeholder repeats it inside the field, so you get the answer wherever you look.

The one thing I'd change if you disagree: the pills are the weakest part. They imply a choice
that doesn't exist yet, and unlike the field they carry no explanation. Dropping the pill row and
keeping the disabled field + note would lose very little.

## Not built, per scope

No delivery of anything. No hop budget / pair brake / kill switch (a pause control with nothing to
pause is a lie). No new frontend write path into `chat.db` — still tailer-write / frontend-read. No
threading, message ids, or presence. No new chord: I checked `isAppChord`, and the channel is
reached by the sidebar row only, so nothing collides with `⌘J` or `⌘⇧O`.
