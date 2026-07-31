# Agent↔agent ships ON, and the brakes proved in the app — RESULT

**Status: done. `tsc` clean · `npm run build` clean · 521 tests (508 → 521). Committed on
`operator/c48bd8` as `c0c392c`.**

Two findings the unit tests could not have produced. Both are in the code now; both are the
reason the brief said "the logic is proven, the integration is not."

---

## Part 1 — the default

`chatterPausedFrom(stored)` extracted from `DashboardView` into `lib/agent-delivery`, so all three
cases are testable rather than inline in a `useState` initialiser.

| stored | means | before | after |
|---|---|---|---|
| absent | never touched | paused | **LIVE** |
| `'1'` | explicitly OFF | paused | paused |
| `'0'` | explicitly ON | live | live |

Plus a fourth case I added: junk (`''`, `'true'`, `'yes'`, `'2'`) reads as *no opinion*, not as
paused — only the exact string the toggle writes counts as a decision, so a hand-edited store
can't silently disable the feature.

Both rationale comments corrected — `DashboardView` and `ProjectChannel` both still argued for the
opposite of the code, which is exactly how a default gets "restored" later as a bug fix. The switch
stays, and the label rule stands.

---

## Part 2 — each brake, in the live app

**What was real:** the entire delivery path in the shipping renderer — `evaluateDelivery`, the live
`deliveryStateRef`, outcome records, the channel feed and its chips, the toasts, the submit queue,
and the new default. **What was mocked:** the pty (writes recorded, nothing typed), the transcript
tailer (`onOrchestratorReply` fired directly rather than parsed from JSONL), and the agents — so
*hop timing in the driver is mine, not a model's*. That last gap is why I measured real latency
separately (§4). Driver: `dev/drive-chatter-brakes.mjs`.

Each brake gets a **fresh app**. My first pass shared state across sections and measured the wrong
brake twice — the "human reset" failure was really a pair suspension left over from the hop-limit
chain. Worth recording, because it is the same class of mistake as a too-generous fixture.

### 1 · Hop limit — fires at 6, but it is **not a hard stop**

```
code>research:sent     research>code:sent     code>research:sent
research>code:sent     code>research:sent     research>code:HOP-LIMIT   ← hop 6
code>research:sent  ←  still delivering
research>code:HOP-LIMIT
code>research:PAIR-BRAKE   ← what actually ended it
```

The 6th message is blocked, **recorded, and visible in the channel** as `posted · chain limit
reached` — not silently dropped. That half works.

**But the chain does not stop.** A blocked delivery never advances the *recipient's* inherited hop
(nothing was delivered into them), so the other lane's budget is untouched and its next message
goes. The chain alternates blocked/delivered at half rate rather than ending — measured: **1 of the
3 messages after the first block still delivered**. In this run the **pair brake** is what actually
stopped it, not the hop limit.

That is consistent with the design (`inheritedHop` is documented as a conservative heuristic), and
it is not a hole in the pure function — `agent-delivery.test.ts` never asserts "the chain ends",
only that an over-budget delivery is blocked. I have **not changed the behaviour**: it needs a
decision about what a chain-limit should mean (block that lane's *sends* too? decay the budget?),
and inventing one unasked in the brake layer is not mine to make. **Flagging it as the headline
finding.**

### 2 · Human reset — works

Spending the budget needs a **three-lane cycle**: a two-lane chain reaches 4-in-window on one
ordered pair before it reaches hop 6, so the pair brake fires first and the reset is unobservable.
With `operator → code → research → operator` rotating, the chain stopped on `hop-limit`, a human
message was sent from the channel composer, and the very next reply delivered:

```
2 hop budget spent: [... research>operator:hop-limit]
2 …and it was the HOP limit that stopped it: true
2 outcome after a human message: ["research>operator:sent"]   ← recovered
```

### 3 · Pair brake — fires exactly on the 5th, and stays local

```
code>research: sent, sent, sent, sent, PAIR-BRAKE        (4 in window, 5th blocked)
research>code: sent      ← reverse direction unaffected
operator>code: sent      ← a different pair unaffected
```

Per **ordered** pair, as designed. Toast: *"Not delivered to Research — code → research sent 4
messages in under a minute."*

**Release after `PAIR_SUSPEND_MS` (5 min real time) — confirmed.** Probed every 20s in a live app
with no injected clock, `RELEASE=1 node dev/drive-chatter-brakes.mjs`:

```
+20s … +286s   still suspended   (14 consecutive probes, each one blocked)
3b released after: 307s
3b within a minute of the 300s constant: true
```

It releases on its own and does not stay stuck. 307s against a 300s constant is the 20s probe
interval plus the driver's own per-message pacing — the suspension itself expired on time.

### 4 · The brakes vs. real latency — the pair brake is **reachable**

The brief asked whether real agents are simply too slow to trip 4-per-minute. Measured against a
**real `claude` session through a real pty**, timing user-turn → completed assistant turn from the
session's own JSONL:

```
n=6   min 1.58s   median 1.69s   max 1.85s
```

A full hop is that plus the tailer's ~1s poll plus the submit-queue gap ≈ **3s floor**. Four hops
in sixty seconds needs ≤15s each, so **the pair brake is comfortably reachable — it is not dead
code.**

**The caveat that matters:** 1.69s is a *trivial* turn ("reply with exactly OK"). A substantive
agent reply — reading files, thinking, calling tools — is tens of seconds to minutes, so in real
working conversation the pair brake will rarely trip and **the hop limit is the operative guard**.
Which makes finding §1 more important, not less: the guard that will actually fire in practice is
the leaky one.

*(Methodology note: my first harness reported ~180s per hop. That was the harness, not the model —
it resolved the transcript path before the file existed, so every trial ran to its timeout. The
numbers above are read from the transcript's own timestamps, which is why they are trustworthy.)*

### 5 · The kill switch still stops everything

Toggling wrote `'1'` and the next reply recorded `paused` with nothing delivered. The switch you
now have to *reach for* still works, which is the whole argument for keeping it.

---

## Legibility — a real bug, found and fixed

The brief asked me to confirm a braked message isn't confusable with a delivered one. **It was.**
Every chip in the feed measured the same colour:

```
posted · delivered              color(srgb 0.521 0.915 0.761)
posted · chain limit reached    color(srgb 0.521 0.915 0.761)   ← identical
posted · pair sending too fast  color(srgb 0.521 0.915 0.761)   ← identical
```

`chipForOutcome` has always toned the brakes `warn` — the pure layer was right. `ProjectChannel`'s
`TONE` map flattened it: `warn: ACCENT_INK`, the *same value* as `accent`. So a message the system
deliberately refused to hand on rendered exactly like one that arrived.

Fixed to `warn: 'var(--color-warning)'` — present in all six palettes, and deliberately not
`--status-compacting`, which is already `progress` in that same map. After:

```
posted · delivered              color(srgb 0.521 0.915 0.761)   green
posted · pair sending too fast  rgb(255, 180, 84)               amber
```

Screenshot: `/tmp/operator-shots/chatter-brakes.png`. This also fixes `undelivered` (`sent · never
started`), which was toned `warn` and equally invisible.

---

## Not verified

- **A chain between two genuinely autonomous agents.** I did not start one. Per the brief's own
  warning I kept every message driver-issued and every session under my control; nothing ran
  unattended and nothing was pattern-killed. The consequence is honest: the brakes are proven
  against the real delivery path and real state, **not** against two models talking to each other.
  Given finding §1, that is the test I would want next — and it should be watched, not left.
