# Result — garble-heal-gap.md, lead 1

Scope: trace only whether the ticking elapsed-timer/token-count status line
bumps `lastDataAtRef`. No code changed (research only).

## Verdict: the gate is not the bug. Lead 1 dies.

## The code-level chain (fully traced, not inferred)

`lastDataAtRef` (`TerminalPane.tsx:50`) has exactly one writer in the whole
file — `writeLive()`:

```ts
// TerminalPane.tsx:380-381
const writeLive = (data: string) => {
  lastDataAtRef.current = Date.now() // gate fits while output is streaming
```

This line runs **unconditionally**, first thing, before any check of
content, chunk size, or pane visibility (`activeRef.current` is only
consulted afterward, to choose render-now vs. buffer-while-hidden — it does
not gate the timestamp bump itself). `writeLive` is called from every
`window.operator.onTerminalData` event for this `terminalId`
(`TerminalPane.tsx:405-409`), i.e. from every chunk of raw pty bytes the
backend hands the frontend for this session.

On the Rust side (`src-tauri/src/lib.rs:195-232`), the pty reader thread
emits `terminal:data` **per successful blocking read**, with no batching,
coalescing, or throttling window — whatever the child `claude` process
writes to its stdout is relayed to the frontend essentially as soon as the
OS delivers it.

So mechanically: **any byte the CLI writes to the pty — for any reason,
including a partial in-place status-line redraw — reaches `writeLive` and
bumps `lastDataAtRef`, with zero filtering.** There is no code path in
Operator that would let a redraw "not count."

## The one thing code tracing alone can't settle

Whether the CLI's ticking timer line ("Working… (16m 18s · ↓ 49.1k tokens)")
actually *redraws* — i.e. actually emits fresh pty bytes — every second (or
at least every <6s) during a long silent-of-tool-output thinking phase, or
whether it goes fully silent between some other event. That's the external
CLI's behavior, not something visible in Operator's source.

This project's own prior research already settled that empirically, though,
and I didn't have to re-derive it: `dev/garble-triage.md` — written from
real live captures, not speculation — states the reproduction trigger as "a
real multi-second running tool call, **ticking its elapsed-timer/token count
in place many times**" (`garble-triage.md:28-29`), and separately documents
that current garble captures show "**in-place elapsed-timer ticks**"
(`garble-triage.md:93-95`) as the CLI's actual redraw pattern — as distinct
from, and contrasted against, the old full-row rewrites. An "in-place tick"
is only observable in a screenshot because it *is* a redraw — bytes reached
the terminal and were rendered. That is direct evidence the timer line does
write to the pty repeatedly over the course of a long operation, not just
update some client-side-only clock invisible to Operator.

## Putting the two together

Given (a) `lastDataAtRef` bumps on every single pty byte with no filtering,
and (b) this repo's own capture evidence that the elapsed-timer line does
redraw in place repeatedly during exactly this kind of long operation, the
heal loop's `Date.now() - lastDataAtRef.current < 6000` gate was almost
certainly **open (true) throughout** the 16m18s sighting in the brief — the
CLI kept ticking, so `hardRepaint()` kept firing on the 1s interval the
whole time. Silence-past-6s is not what happened here.

That also lines up with the brief's own title — "the heal runs, and it
still garbles" — read literally: the heal loop executing is not in
question; its effect on the stale rect is. This shifts weight onto **lead
2** (`0.02px` possibly collapsed by pixel-snapping, so `hardRepaint`'s forced
recomposite is a no-op even though it's running on schedule) as the live
thread, not the gate.

## Caveat / what's still open

I did not capture the live pty stream at the exact moment of the 2026-07-29
sighting, so I can't produce a byte-for-byte timeline proving `lastDataAtRef`
specifically for that 16-minute window — that would need the ⌘K buffer-dump
(or a raw pty capture) taken live, which the brief separately flags as never
having been run. What's established here is the mechanism (unconditional,
unfiltered, no-batching relay) plus this repo's own prior empirical evidence
that the timer line does tick/redraw live. Absent a contrary live capture
showing a genuine >6s byte gap during a "Working…" phase, treat the gate as
cleared and don't spend further effort hardening it against session-phase
(`running`/`compacting`) as the brief's fallback plan describes — that fix
would address a cause that isn't occurring at this sighting.

## What would flip this verdict

A future live sighting where the ⌘K buffer-dump's timestamp, or a raw pty
capture, shows a >6s gap with no bytes immediately preceding visible garble.
If that ever turns up, lead 1 is alive after all and the phase-based
keep-alive the brief describes is the right fix.
