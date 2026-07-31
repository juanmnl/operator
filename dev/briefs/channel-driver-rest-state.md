# Brief — the channel driver tests delivery with delivery switched off

**Lane: QA.** Write your result to `dev/briefs/channel-driver-rest-state-RESULT.md`.

## What happened

`dev/drive-project-channel.mjs` fails phases 13–20 on `main`. I reported this as a product
regression in the agent↔agent brakes. **That was wrong, and the wrongness is the interesting
part** — I read the driver's tail instead of its middle, saw four "expect" lines unmet, and
concluded the brakes were inert.

The actual output:

```
13 switch label at rest: Agent↔agent live   (expect "Agent↔agent paused")
15 label flips:          Agent↔agent paused (expect "Agent↔agent live")
```

`c0c392c` ("Agent↔agent delivery ships ON, and the brakes proved in the app") flipped the DEFAULT
from paused to live. That was the whole point of the commit. The driver still assumes it starts
paused, so its phase-15 flip now switches delivery **off**, and phases 15–19 then measure delivery
behaviour with delivery disabled. Every "0 delivered, expected N" cascades from that one stale
assumption about the rest state.

Confirming evidence, so nobody re-litigates this: the driver PASSES at `294c395` (v0.11.2) and
fails at `ec16365`. `c0c392c` sits between them. Phase 20 — the one phase that asserts a count
rather than a label — passes.

## Why it matters more than a red driver usually does

This is the ONLY automated coverage of the chain-hop limit, the per-pair rate suspension and the
2000-char reply trim. Right now it exercises none of them, and it is loud enough that the next
person to run it will either believe the brakes are broken (as I did) or stop running it. A driver
nobody trusts is worse than no driver.

## What I want

1. Invert the rest-state assumption so the driver reflects the shipped default, and make it
   **assert the default explicitly** rather than assume it — phase 13 should read "at rest,
   agent↔agent is LIVE, because c0c392c shipped it on", so the next flip of that default fails
   one clear assertion instead of cascading through six phases.
2. Re-establish real coverage of the three brakes with delivery ON: hop limit stops at 6, a pair
   suspends after 4 in the 60s window while a different pair still delivers, a 3008-char reply is
   trimmed to ≤2032 with a "truncated" pointer.
3. Keep one phase that genuinely tests the PAUSED path (that is what the kill switch is for) —
   but have it flip explicitly from a known state rather than relying on where it started.
4. Phase 14 ("human→lane unaffected by the kill switch") — I could not tell from the output alone
   whether this is drift or real. A human message is supposed to deliver regardless of the switch.
   Determine which it is and say so plainly in the result. If it is a real defect, do NOT fix it —
   report it, it belongs to Code.

## Do not

Do not change product code to make the driver green. If anything in `2`–`4` turns out to be a real
defect, the driver stays red and the result file says exactly what broke and where.

## Done means

`node dev/drive-project-channel.mjs` runs clean against a vite server on the main checkout, every
phase's expectation matches shipped behaviour, and the result file states which of the 20 phases
were drift and which (if any) were real.
