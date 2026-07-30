# RESULT — channel step 3: agents deliver to each other

A lane's `OPERATOR-REPLY` is now typed into the addressee's session. Five guardrails ship with it,
and **the kill switch ships ON** — the feature is off until you turn it on.

---

## The one decision I made beyond the brief

**It defaults to paused.** The brief made the kill switch mandatory but not the default. Two agents
that can each answer the other ping-pong at roughly one hop per tailer poll, and that is what two
cooperative agents *do* — not an edge case. The guardrails below are what make turning it on safe;
shipping it off is what makes the feature safe to ship at all. Replies still post to the channel and
are still readable with it paused; they simply reach nobody's pty. `localStorage.operator.chatterPaused`,
absent-or-`'1'` = paused, so an existing install starts off too.

The switch is **app-wide, not per-project**, and lives in the channel header (`data-chatter-toggle`).
Its label states what IS (`Agent↔agent paused` / `Agent↔agent live`), not what the click does — a
control reading "Pause" while already paused is how you turn chatter on while trying to stop it.

## The five guardrails, with their actual thresholds

All of it is pure and in `src/renderer/lib/agent-delivery.ts`; `DashboardView` owns only the plumbing.

| Guardrail | Threshold | Outcome recorded |
|---|---|---|
| Kill switch | persisted, app-wide, outranks every other check | `paused` |
| Target liveness | never delivered, **never launched** | `queued` |
| Hop budget | stops at `hop >= 6` — **5 deliveries, the 6th refused** | `hop-limit` |
| Cycle brake | >4 in 60s **per ordered pair** → that pair suspended 5 min | `pair-brake` |
| Length cap | 2000 chars (`CHANNEL_MAX_CHARS`), truncate **plus a pointer** | `sent` |

Decision order is deliberate: kill switch → liveness → hop budget → pair suspension → pair trip. A
**blocked delivery does not count toward the pair window**, so a suspended pair cannot extend its own
suspension by hammering.

**How a chain is reconstructed without message ids:** a reply from lane X inherits the hop of whatever
was last delivered *to* X, +1 (`inheritedHop`). It is a heuristic, and deliberately the conservative
kind — a lane that speaks spontaneously long after being addressed inherits a stale hop and so stops
*sooner*, never later. A human message resets the addressee's chain (`resetChainFor`, called from
`sendChannelMessage`), which is what lets the budget recover **without a timer**: a chain becomes
legitimate again because a person joined it, not because it waited.

## Self-amplification: two independent guards

A relayed message that could be re-parsed as a sentinel would re-emit and re-deliver forever.

1. **The parser only ever runs on assistant turns.** `parse_directives` has exactly two call sites,
   both inside `apply_assistant` (`transcript.rs:414`, `:427`). A delivered message lands as a `user`
   turn. Verified, not assumed; the v0.11.0 quotation guards were not touched.
2. **The prefix cannot match `DIRECTIVE_LINE`.** `[Operator · message from Code] ` — unit-tested
   against the actual regex with a sentinel as the payload.

The prefix also names the sender, so a relayed message never reads as the recipient's own thought.

## Where a brake becomes visible

A delivery is recorded as a `DispatchRecord` carrying `replyId` (the reply's content-hash id), and the
channel **folds it into that reply's row** — one reply, one row, whatever happened to it. So a stopped
chain reads `posted · chain limit reached` rather than looking like the addressee ignored it. `replyId`
is also the durable double-delivery guard: the localStorage seen-set is the fast one, but a cleared
cache must not re-deliver a month of replies.

Two supporting changes fell out of this and are worth knowing about:

- **`ProjectReply` now carries `id`** (read-only: `SELECT id …` in `ChatStore::replies`). Without a
  stable key there was nothing to attach an outcome to. No new write path — chat.db stays
  tailer-write / frontend-read.
- **The channel re-reads replies when one arrives** (`replyTick`). Without it the reply row wouldn't
  exist yet, so the outcome — *including a brake* — would have been invisible until you switched
  projects and back. Safe because the tailer persists before it emits.

## What I deliberately did NOT do

**Nothing is written back to the sender's pty when delivery is blocked.** A "wasn't delivered" note is
itself a prompt, so the one moment we have decided the lanes are talking too much is the worst moment
to make one of them talk again — and a lane that replies to the notice re-triggers it, unbounded. The
human gets a toast and the chip; the sender gets silence. **The cost is real: a blocked sender may wait
on an answer that never comes.** It is the cheaper of the two.

**A broadcast (`to: project`) is never delivered to anyone.** It is addressed to the room, and fanning
it out would multiply one message by the roster on every hop — the fastest available runaway.

Not built, per scope: threading, message ids, ask→answer addressing, interrupt/priority injection,
subagent authorship, any new chat.db write path.

## Still unbounded, and you should know about it

1. **A window reload resets the brakes.** `DeliveryState` is in a ref, not persisted — a restart is a
   natural circuit-breaker reset and a hop chain that survives one would be unkillable by the only
   recovery every user knows. But the renderer can reload while the ptys survive (they are
   backend-owned), which clears a pair suspension mid-loop. The *kill switch* is persisted, so the
   strongest brake does survive. Persisting the rest is a small follow-up if you want it.
2. **A `queued` message still never arrives later.** Unchanged from step 2: nothing drains
   `DispatchRecord`s on launch. It is recorded honestly and stays in the log.
3. **There is still no delivery acknowledgement anywhere.** `submitQueue`'s watchdog CR remains a
   self-described heuristic. "Delivered" means "written to the pty", not "read".
4. **The cap applies to the body; the prefix rides on top.** A trimmed 3000-char reply wrote 2048
   bytes (2000 body + 33 prefix + bracketed-paste wrapper). Deliberate — the prefix is provenance and
   trimming it would be the wrong 33 characters to save.

## Verification

- `npm test` — **362 passed / 39 files** (was 336/38). `cargo test` — **102 passed**. `npm run build` — clean.
- **`agent-delivery.test.ts`, 18 tests**, one per guardrail plus two loop tests:
  - the kill switch outranks every other check and consumes no pair window
  - hop 1 on a fresh chain · the recipient inherits the hop · **stops at 6** · a human message resets it
  - the pair brake trips on the 5th in 60s, releases after 5 min, is per *ordered* pair (reverse
    direction and unrelated lanes unaffected), doesn't trip on the same volume spread out, and cannot
    have its suspension extended by a blocked send
  - 3000 chars truncated with a pointer; exactly 2000 untouched
  - the prefix doesn't match `DIRECTIVE_LINE` even with a sentinel payload
  - **the loop test**: two lanes each answering the other terminates on its own — and it is bounded by
    a hard iteration ceiling with assertions inside the loop, so a regression *fails* rather than hangs
  - **a ring of 8 distinct lanes**, where every pair is unique so only the hop budget can stop it
- **`project-channel.test.ts` +8**: one row not two, `posted · delivered`, each brake named, never
  actionable, an undelivered reply still reads as merely `posted`, newest record wins, no cross-fold
  onto a different reply, and a delivery record stays invisible to the fan-out collapse.
- **`dev/drive-project-channel.mjs` groups 13–20**, all green against the mock:

```
13 label "Agent↔agent paused" · aria-pressed false · 0 writes · chip "posted · agent↔agent paused"
14 human→lane STILL WORKS while paused: 1 write
15 flips to live · persisted "0" · delivered exactly 1 · prefix "[Operator · message from Code] "
15 …to the right lane (t2) · chip "posted · delivered"
16 idle target: 0 writes · 0 spawns · chip "posted · queued · behind current task"
17 ping-pong STOPPED at hop 6 · 5 delivered · the 6th refused
18 pair SUSPENDED on message 5 · 4 delivered in the window · a different pair still delivers
19 a 3008-char reply TRIMMED to 2048 bytes, ending "…truncated at 2000 chars — the full message is in this project's channel"
20 switching it back off halts delivery again: 0 writes
```

- **`drive-theme-pass` — 6 palettes, 0 below floor**, and it caught a real defect: raw
  `var(--color-warning)` at the switch's 9px measured **2.44 / 2.42 / 1.49** on the three light
  palettes. Fixed with the same 55%-toward-`--fg` blend the chips use (`WARN_INK`) → 3.64–11.21 live,
  4.16–7.03 paused. The switch's border is also **static**, with the state on the ink: a
  colour-changing border on a radiused element re-rasterizes in WKWebView, and this one changes on a
  click.
- `drive-dispatch-authority`, `drive-layout-shift` — pass; neither the approval gate nor the
  scrollbar structure moved.

## Fixture note

`dev/mock-bridge.ts` gained `onOrchestratorReply` + `window.__mockReply()` and a real
`projectReplies` store. It **persists then emits**, the order the tailer guarantees, because the
channel's re-read depends on it. Rows are keyed by project internally rather than carrying a
`projectId` field — the real rows don't have one, and a fixture with an extra field is how a consumer
starts depending on something reality won't give it.

## Not verified against a real lane

The only live lane is this session; delivering a message to my own pty mid-task would inject text into
the conversation executing the brief. The mock exercises the whole path to the `submitQueue` boundary
with real records, real decisions and the real feed. **The first real agent↔agent exchange is still
worth watching by hand** — and it costs nothing to try, because it is off until you switch it on.
