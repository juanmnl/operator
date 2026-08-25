# Per-lane Inbox / Outbox

**Design, 2026-08-24. Design only.** The UI consumer that `agent-comms-audit.md` §5 (and Loss #2)
says is missing. Scoped to what the plumbing Code is building now exposes — nothing here needs a
capability the audit's §5 doesn't already call for.

---

## 0. Read this first — four things about the existing plumbing

| # | Finding | Where | What it means for this surface |
|---|---|---|---|
| 1 | **The outcome vocabulary already exists and is already carefully worded.** `chipForOutcome` maps all 10 outcomes to human labels + a 4-tone scale, and its comments record why each label reads as it does. | `lib/dispatch-outcome.ts` | This surface **imports it**. It does not write labels. The file's own header records what happened last time two half-vocabularies existed: `hop-limit` rendered as the raw string `"pair-brake"` on the only screen that would ever show it. |
| 2 | **`DispatchLog` already renders sent dispatches** — project-wide, on the Team screen, with approve/reject. | `DispatchLog.tsx`, mounted at `ProjectView.tsx:235` | The new tab is its **per-lane sibling**, reading the same `project.dispatches` filtered by role — not a replacement and not a second approve path. §6. |
| 3 | **`reports.seen` exists but is dead.** The column and its index are created; `list_reports` never selects it, `Report` has no field for it, and there is **no ack command for reports** (`artifacts_ack_status` acks `task_status`, a different table). | `artifacts.rs:87-89, 142-148`; `lib.rs:992-1010` | **The unread count has no source today.** This is the one thing the whole surface hangs on. §5 of the audit replaces `seen` with `delivered_at`/`acked_at`; that migration is a hard prerequisite, not a nice-to-have. |
| 4 | **"A state gets a MARKER, never a dimmer."** House rule, written down when the resting orbs were muted in 0.17.2, with the CIELAB measurements behind it. The rail has no opacity headroom left — `waiting` lost its notch for exactly this reason and is currently an open question. | `StatusWave.tsx:20-58` | The unread count on the orb **must be a marker beside the orb**, never a brightness change to it. §4. Getting this wrong would undo shipped work. |

---

## 1. Shape: one tab, two segments

Panel tabs today are `PLAN · DIFF · CHAT`, with `FILES` proposed. Adding both an INBOX and an
OUTBOX tab makes six, and at the default 460px panel width six uppercase mono tabs
(~55px each) overrun the row before the count badges are drawn.

So: **one tab, `INBOX`, carrying the unread count; two segments inside it.**

```
┌────────────────────────────────────────────┐
│ PLAN  DIFF  CHAT  FILES  ▏INBOX 2▕         │ 44
├────────────────────────────────────────────┤
│  ▏Received 2▕  Sent 14                     │ 30
├────────────────────────────────────────────┤
```

The count rides the **tab**, not the segment, because it is what makes you look at the panel at
all. Inside, each segment carries its own count so the split is visible before you switch.

---

## 2. Received — reports, with a real lifecycle

```
├────────────────────────────────────────────┤
│  ▏Received 2▕  Sent 14                     │
├────────────────────────────────────────────┤
│ ● Design · 14:22                  unread   │
│   Session settings design delivered — two  │
│   surfaces, decision table, build plan.    │
│   2 artifacts · session-settings-design    │
│                          Open ▸   Ack      │
├────────────────────────────────────────────┤
│ ● Research · 13:58                unread   │
│   Ripgrep is NOT installed — the `rg` on   │
│   this Mac is a zsh shim to the CC binary. │
│   1 artifact                               │
│                          Open ▸   Ack      │
├────────────────────────────────────────────┤
│   QA · 11:04                        acked  │
│   Diff panel smoke: 12 pass, 0 fail.       │
│                          Open ▸            │
├────────────────────────────────────────────┤
│   Code · 09:30                  delivered  │
│   Plumbing landed on operator/7d8780.      │
│                          Open ▸   Ack      │
└────────────────────────────────────────────┘
```

**The three states, and what each one honestly claims** — this is the whole point of the audit's
§3, so the labels must not over-claim the way `operator__report`'s return string does today:

| State | Written when | What it means | Ink |
|---|---|---|---|
| `written` | the row is inserted | It is in `artifacts.db`. **Nobody has seen it.** | `WARN_INK` — this is the state the audit is about |
| `delivered` | this surface renders it | The UI has shown it. Still nobody has *read* it. | `--fg-muted` |
| `acked` | a human clicks `Ack`, or the coordinator's turn consumes it | Someone has actually taken it. | `--fg-muted`, row recedes |

`written` should be rare and short-lived — if a row sits in `written` while the panel is open,
something is wrong with the reader, and the surface says so rather than smoothing it over. That
is the difference between a list and an audit trail.

**`●` is the unread marker** — a 5px dot in the lane's accent, at the row's left edge, on
`written` and `delivered` rows only. `Ack` clears it. A resting/acked row has no dot at all: the
row recedes to `--fg-muted` and keeps its ink, never a group `opacity` (house rule).

**`Ack` and `Open ▸` are two verbs and get two glyphs** — and neither is an `✕`. `✕` means
delete-a-lane elsewhere in this app, and the v0.10.0 data-loss note is explicit that two verbs
must never share a glyph. `Ack` is a word, deliberately: it is the only irreversible-ish action
on the row, and a word cannot be misread the way an icon can.

**`Open ▸`** expands the row in place to the full summary plus artifact contents — artifacts are
CONTENT, never paths (`artifacts.rs:47`), so there is something real to show. Long artifacts are
capped at 16KB per the markdown-freeze rule and say so: `showing the first 16 KB of 71 KB`.

**Empty state:** `No reports from other lanes yet.` — and, when the coordinator is looking at a
lane it has dispatched to: `Code has 2 tasks running and has reported nothing yet.` The second
sentence is the audit's entire thesis made visible: silence is now a stated fact with a
timestamp behind it, not an absence.

---

## 3. Sent — dispatches and replies, with the brake named

```
├────────────────────────────────────────────┤
│   Received 2   ▏Sent 14▕                   │
├────────────────────────────────────────────┤
│   → Review · 14:31             delivered   │
│     Review the comms audit before merge     │
├────────────────────────────────────────────┤
│   → QA · 14:12      held · chain limit     │
│     Smoke the diff panel                    │
│     ⓘ Code → QA hit the 4-hop budget with   │
│       no human in the chain. Nothing was    │
│       typed anywhere; nothing retries.      │
│                              Send anyway    │
├────────────────────────────────────────────┤
│   → Design · 13:44   held · pair too fast  │
│     One more pass on the orb                │
│     ⓘ Code → Design sent 6 messages in      │
│       under a minute, so that pair is       │
│       suspended for 5 minutes. Other lanes  │
│       are unaffected.              4m 12s   │
├────────────────────────────────────────────┤
│   → Research · 11:50   sent · never started│
│     Check the ripgrep assumption            │
│     ⓘ The bytes reached the pty but no turn │
│       followed — it's sitting in the        │
│       composer.                    Nudge    │
├────────────────────────────────────────────┤
│   → Ops · 09:02        no matching lane     │
│     Bump the release                        │
└────────────────────────────────────────────┘
```

- **Every chip comes from `chipForOutcome`.** The labels above are that function's, verbatim.
  No new strings.
- **`ⓘ` is the brake's own `note`**, from `evaluateDelivery`'s `block()` — those notes are already
  written as sentences to a human ("…so that pair is suspended for 5 minutes. Other lanes are
  unaffected."). They exist and are currently shown nowhere. Rendering them is most of what
  "naming the brake that stopped it" costs.
- **`4m 12s`** counts down `suspendedUntil` — a pair-brake is the one held state that clears
  itself, and a countdown is the difference between "wait" and "stuck". Every other held state
  gets no timer, because nothing retries them (the type's own comment says so).
- **`Send anyway`** appears only on `hop-limit` and `paused` — the two a human can legitimately
  override, since a human in the chain is exactly what resets the budget. It does **not** appear
  on `pair-brake` (that one is a rate limit and the timer is the answer) or on `unassigned`
  (there is no lane to send to).
- **`→`** is the sent-direction glyph and is used for nothing else on this surface; received rows
  use the accent dot, not `←`. Two directions, two distinct marks, neither reused.
- Resting rows — `delivered`, `declined`, `no matching lane` — sit at `--fg-muted` with no `ⓘ`
  and no action. The held and never-arrived rows are the only ones carrying warn ink, which is
  the ranking `chipForOutcome` already encodes.

---

## 4. The unread count on the rail orb

**A marker beside the orb. Never a change to the orb.** `StatusWave`'s rest level is a measured
constant with no headroom, and the file's house rule is explicit.

```
   collapsed rail          expanded rail

      ●②                     ●  Code            ②
      ●                      ●  Design
      ●                      ●  Review
```

- A small count in `--font-mono`, 8.5px, in the lane accent via `laneTextColor` (never the raw
  accent — 1.07–1.22:1 as text on the light palettes), transparent ground, no border, no fill.
- **Collapsed rail:** the count sits at the orb's top-right, outside the disc, so it adds ink to
  the row without adding any to the orb. `9+` past nine.
- **Expanded rail:** right-aligned on the row, where the queued-count chip already lives on roster
  cards — same slot, same register.
- **It appears only when > 0**, and it is the count of `written` + `delivered` reports **for that
  lane's inbox**. Acked rows never contribute.
- It does **not** count sent dispatches. Nothing about your own outbox is news to you.

**Coordinator's toolbar**: the same count, summed across the roster, as a chip in
`SessionToolbar`'s right cluster beside the MCP badge:

```
│ ▤  Operator · operator     CONSOLE CHAT PREVIEW FILES    ✉3   ⋯ ▦ │
```

`✉3`, transparent, hairline `--border`, `--fg-muted` at zero-ish and lane-neutral `--accent` ink
when non-zero. Clicking opens the panel on `INBOX · Received`. One glyph, one verb — it is not
also a compose button.

**A note Code will want:** this count is the first thing in the app that depends on
`delivered_at`/`acked_at` existing. Until that migration lands, the honest interim is to show
**no count at all** rather than deriving one from row age — a fabricated unread badge is worse
than none, and this whole surface exists because a confident claim ("Reported to Operator…you do
not need to relay it") outran what the system actually knew.

---

## 5. Component and prop notes

```
src/renderer/lib/lane-comms.ts          selectLaneComms() + unreadCount() — pure, tested
src/renderer/components/session/comms/
    LaneCommsPanel.tsx    the tab body: segment switch + the two lists
    ReceivedList.tsx      report rows, states, Ack, Open
    SentList.tsx          dispatch rows, chipForOutcome, brake notes, countdown
    UnreadMark.tsx        the rail/toolbar count — one component, both placements
```

```ts
// The one merge. Both lists and both counts read this; nothing re-derives.
export function selectLaneComms(
  project: Project,
  reports: Report[],          // artifactReports(), filtered to this project
  roleId: string,
): {
  received: ReceivedRow[]     // { id, fromRoleId, at, summary, artifacts, state }
  sent: SentRow[]             // { id, toRoleId, at, task, outcome, note?, suspendedUntil? }
  unread: number              // written + delivered, this lane only
}
```

```ts
export function LaneCommsPanel(props: {
  project: Project
  roleId: string
  segment: 'received' | 'sent'
  onSegment(s: 'received' | 'sent'): void
  onAck(reportId: number): void
  /** hop-limit / paused only. Routes through the SAME approve path DispatchLog uses. */
  onSendAnyway?(dispatchId: string): void
  /** `undelivered` only — re-types the pending message into the target's pty. */
  onNudge?(dispatchId: string): void
}): JSX.Element
```

```ts
export function UnreadMark(props: {
  count: number                       // renders nothing at 0
  accent?: string                     // lane accent; laneTextColor() applied inside
  placement: 'orb' | 'row' | 'toolbar'
}): JSX.Element | null
```

**Bridge additions Code needs** (the audit's §5.1 and §5.3, stated as calls):

```ts
artifactReports(limit?: number)                  // EXISTS — currently called from nowhere
artifactMarkDelivered(ids: number[]): Promise<void>   // NEW — sets delivered_at
artifactAckReports(ids: number[]): Promise<void>      // NEW — sets acked_at
```

`reports.seen` is replaced by the `delivered_at`/`acked_at` pair, not kept alongside it. One bit
cannot express three states, and leaving a dead column next to the live pair is how a future
reader concludes the wrong thing about what was seen.

---

## 6. What this does NOT change

- **`DispatchLog` stays.** It is the project-wide roll-up on Team; this is the per-lane view.
  Both read `project.dispatches`, both call `chipForOutcome`, and **approve/reject stays in one
  place** — `onSendAnyway` routes into the existing approve path rather than adding a second one.
- **No new outcome strings, no new tones.** `ChipTone` and its four values are unchanged.
- **No change to `StatusWave`.** The marker sits beside the orb; the orb's own config is
  untouched, so the 0.17.2 mute stands exactly as shipped and measured.
- **No toast on report insert.** The audit explicitly asks for a durable list *instead of* that.

---

## 7. Open questions for Code

1. **Who writes `delivered_at`?** If the panel writes it on render, a report is "delivered" the
   moment the tab happens to be open — which is weaker than it sounds but still stronger than
   `written`. If the coordinator's turn-priming writes it, it means something closer to "the
   coordinator was told". Both are defensible; they are **not** the same claim, and the label has
   to match whichever you pick.
2. **Does a report carry `to_role`?** §5.1 adds it. Until it does, every report is implicitly to
   the coordinator, so a non-coordinator lane's Received list is empty by construction — worth
   knowing before the empty state gets blamed on this UI.
3. **`Send anyway` on `hop-limit`** — does approving it *reset* the chain budget (a human in the
   chain is the documented reset), or does it deliver once and leave `exhausted` set? The audit's
   §4 rework may settle this; the button's tooltip has to say which.
4. **Countdown source.** `suspendedUntil` lives in a renderer `useRef` (`deliveryStateRef`) and is
   wiped by the hourly renderer respawn (Loss #5). A countdown reading a value that silently
   resets to zero will look like the brake cleared itself early. If the state is not persisted by
   the time this ships, the pair-brake row should say `suspended` with no timer rather than a
   number it cannot stand behind.
