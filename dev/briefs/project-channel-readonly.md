# Brief — the project channel, step 1: read-only feed

Design: `https://claude.ai/code/artifact/03cc9418-5fd3-4cf0-b88a-3c3c6b4c3a99`
Feasibility audit (read it): `dev/briefs/research-project-chat-return-path-RESULT.md`

**Scope: render what ALREADY EXISTS as one project feed. No delivery, no composer that sends, no
new write path.** Everything needed is already on disk and already exposed. Stop at the line below.

## Why this step alone is worth shipping

Two stores already hold the whole conversation and nothing displays them together:

- **`Project.dispatches`** — `DispatchRecord { id, at, fromRoleId?, toRoleId?, task, outcome }`,
  where `outcome` now includes `pending-approval` and `rejected`.
- **`chat.db` replies** — `OPERATOR-REPLY` rows, shipped in v0.11.0. Read via the existing
  `window.operator.projectReplies(projectId)` (`operator-bridge.ts:178` → `project_replies`,
  `lib.rs:1588`). **Nothing reads it today.** Confirm it returns rows before building UI on it; if
  the table is empty because no lane has emitted a reply yet, say so rather than assuming it's broken.

Merged and time-ordered, that is already "what my agents are saying to each other" — with zero
delivery risk, because nothing new is sent.

## Build

### Placement
A row between the project name and the `AGENTS` label in `Sidebar.tsx` — `# channel`, with an unread
count on the right. Project-level, so it reads as the room the lanes are in, not another lane.

Add `contentMode === 'channel'` alongside the existing modes in `DashboardView.tsx` (`gallery`,
`agents`, `project`, `prefs`, `globalPrefs`, `folderPrefs`, `localTerminal`). It is a project-scoped
full view, not a `projectTab` — the sidebar row switches to it, and `activeProjectId` still scopes it.

Unread = messages newer than a per-project `lastReadAt` in localStorage. Reading the channel clears it.

### The feed
One list, ascending by timestamp, day separators. Each entry:

- **Avatar — a CIRCLE.** 26px, the lane's `Role.accent` tinted background + 1px border, initials in
  `laneTextColor(accent)` (`lib/lane-color.ts`) so it stays ≥4.5:1 on the three light palettes.
  **Circles, not rounded squares.** The mockup got this wrong: squares are the PROJECT vocabulary
  (`ProjectRail` tiles) and circles are the lane/session vocabulary. Do not blur them — that
  distinction is why a project never reads as an agent. The human's own avatar is also a circle,
  differentiated by neutral `--overlay-medium` fill rather than a lane accent.
- **Header row:** author name in `laneTextColor(role.accent)` · `→ target` in `--fg-muted` ·
  timestamp · a state chip.
- **Body:** the task or reply text, in the body font (this is prose, not protocol).

### State chips — the point of the whole design
Derive from `DispatchRecord.outcome`; do not invent states:

| outcome | chip | tone |
|---|---|---|
| `sent` / `launched` | `delivered` | accent |
| `queued` | `queued · behind current task` | `--status-compacting` |
| `pending-approval` | `held · needs your approval` | warn |
| `rejected` | `declined` | muted |
| `unassigned` | `no matching lane` | muted |
| a reply | `posted` | accent |

A `pending-approval` row gets **Approve & send** / **Decline** wired to the existing
`onApproveDispatch` / `onRejectDispatch` — already implemented in `DashboardView` and already used by
`DispatchLog`. Reuse them; do not add a second approval path.

### Identity resolution
- Dispatch: `fromRoleId` / `toRoleId` → `project.roster`. Absent `toRoleId` → "no matching lane".
- Reply: `ProjectReply { session_id, to, text, timestamp }` carries **no roleId** — resolve
  `session_id` → session → `roleId` → Role. If it can't resolve (session gone), show the lane id
  verbatim rather than a blank; never guess.
- **Do not attribute subagent prose.** `NarrationEntry` has no caller field (audit §5), so a
  subagent's words are indistinguishable from its parent lane's. Attribute to the lane, full stop.

### The composer — present but INERT
Render it exactly as designed, with the target pills and the `Send ⌘↵` affordance **disabled**, and
one honest line of helper text saying sending arrives in the next step. Do NOT wire it to
`submitQueue`.

Rationale for building it disabled rather than omitting it: the feed alone doesn't communicate that
this becomes two-way, and a channel with no visible input reads as a log. If a disabled composer
feels like a tease, omit it and say so in your result — but do not make it send.

## Do NOT build

- No delivery of anything (human→lane, lane→lane, fan-out). That's steps 2-4.
- No hop budget / pair brake / kill switch — they belong with delivery, in
  `dev/briefs/agent-to-agent-delivery.md`. A pause control with nothing to pause is a lie.
- No new frontend write path into `chat.db` — it stays tailer-write / frontend-read (`lib.rs:1567`).
- No threading, no message ids, no presence/typing indicators (tailer polls at 1s).

## Traps

- **Never stack opacity on `--fg-muted`** — the guard test fails the build. Hover reveals go `0 → 1`.
- No colour-CHANGING border on a radiused element (WKWebView freeze) — the avatar border is static
  per lane, which is fine; don't animate it on state change.
- Motion is the busy signal: nothing in this feed animates. It is history.
- The channel is a scrolling view: follow the containing-block rule from
  `dev/briefs/fix-scrollbar-layout-shift.md` — scroller full width, measure box on inner children,
  header inside the scroller and sticky. Do not reintroduce the 3px shift.
- `⌘J` currently toggles Console⇄Chat. Check the chord map (`lib/key-routing`, `isAppChord`) before
  adding any new chord, and don't collide with `⌘⇧O`.

## Verify

- `npm test` + `npm run build` green.
- Unit-test the merge: dispatches and replies interleave correctly by timestamp; a reply whose
  session no longer resolves still renders with its raw lane id; each `outcome` maps to exactly one
  chip; unread counts only entries newer than `lastReadAt`.
- A new `dev/drive-project-channel.mjs`: renders a project with a mixed feed, asserts order, asserts
  a `pending-approval` row exposes approve/decline, asserts the composer cannot submit.
- `node dev/drive-theme-pass.mjs` — all 6 palettes; avatar initials and author names must stay
  legible on the three light ones, which is exactly what `laneTextColor` is for.
- Report whether `projectReplies` actually returned rows on the real store, and how many.

## Write your result to

`dev/briefs/project-channel-readonly-RESULT.md` — what landed, what `projectReplies` returned, and
whether the inert composer reads as honest or as a tease.
