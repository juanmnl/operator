# Chat: liveness signals + interrupt (ship this first, standalone)

**Source:** `dev/chat-view-critique.md` §2 (the ranked #2 pain) and §D. User confirmed it directly
on 2026-07-28: *"in chat, there's no visual feedback when the agent is thinking, using tools, etc."*

## Why this is separable from the structured-transcript build

The big decision (tool calls / edits / subagents / permissions as first-class blocks) needs new
`NarrationEntry` kinds and new `transcript.rs` parsing. **This task needs none of that.** Every
signal below already exists on `AgentSession` and already drives the sidebar orb:

| Field | Type | Already used by |
|---|---|---|
| `phase` | `'idle' \| 'running' \| 'compacting' \| 'waiting'` | sidebar `SessionItem`, StatusWave |
| `status` | `'active' \| 'ended'` | composer's existing `live` check |
| `lastToolName` | `string \| null` | sidebar |
| `activeSubagents` | `number` | sidebar |
| `activity` | `ActivityEntry[]` | Activity panel |

`CanvasConversation.tsx` references **none** of them — grep it and confirm. So this is a read of
data already on the wire. Do not add transcript parsing in this task; if you find yourself editing
`transcript.rs`, stop, you have drifted into the other build.

## Build

### 1. Status line at the foot of the transcript (§D)

Sits at the bottom edge of the reading surface, where the eye already is while waiting. Carries:
current activity (from `lastToolName` / `phase`), elapsed time, and **stop**.

- **Only `running` and `compacting` animate.** This is an app-wide rule — motion means busy, and
  `waiting`/`idle` rest static. See the StatusWave precedent; do not invent a second motion idiom.
- `waiting` means the agent needs the user. It must read as *your turn*, quietly — no pulse.
- When `phase === 'idle'` and the session is alive, the line should not occupy space.

### 2. Interrupt

`ChatComposer` currently disables on session death only (`disabled={!live}`) and never on phase, so
mid-run you get a normal send box and no way to stop. **While running, the composer's send action
becomes stop.** Interrupt is a bare ESC to the pty via `terminalWrite` — Claude Code's own
interrupt — not a kill. Never terminate the process.

### 3. Thinking gets its third state (critique §3 / §C)

`CanvasConversation` filters to `kind === 'user' | 'text'`, so `thinking` entries are **discarded at
render** — the reasoning behind every decision is unrecoverable even though it is already parsed and
already durable in `chat.db`. Neither "throw away" nor "always inline" is right: give it a collapsed
state consistent with §C. While the agent is *actively* thinking, that is also the most honest thing
the status line can say.

### 4. Jump-to-latest that doubles as the running indicator (§E, first bullet only)

When scrolled away from the bottom it reads e.g. `Editing dispatch.ts · 12s ↓` — the control that
returns you to the live edge also tells you what you are returning to. One control, two jobs.

**Scope guard:** the unread marker and the anchor-to-a-turn reflow fix are the OTHER two bullets of
§E. Leave them out of this task. Jump-to-latest is in scope only because it is the running
indicator.

## Do not

- Do not rebuild the prose typography. The critique is explicit that reading quality is already good
  (document style, full width, 13.5/21, code chips, real lists and tables). This work is additive.
- Do not touch `transcript.rs` (see above).
- No solid accent fills for state, no colored left-border marker stripe, and never stack `opacity` on
  `var(--fg-muted)` — the token already carries the recede. All six palettes must pass.

## Verify

`dev/mock-bridge.ts` now has `MOCK_CHAT` keyed to session `s-code`. **Port 1433 is NOT the app's dev
server** — it is a bare Python SimpleHTTP on an empty directory. Run the mock harness on a free port
(`npx vite --port <free>`), and drive the running / waiting / compacting / idle phases plus a dead
session. Add a theme pass across all six palettes per `dev/drive-theme-pass.mjs`.
