# Agent comms fixes — RESULT

Coordinator, 2026-09-14. Branch `operator/comms-fixes` on top of `main` = `2dcb9af`. Fixes the P1
brake defects, the P2 report backlog, and two P3 items from
`dev/results/agent-comms-audit-2026-09-14.md`. Built by the coordinator because the brake being
fixed was refusing dispatches to Code. **Not verified in a real window.**

## What changed

| Audit # | Fix | Where |
|---|---|---|
| B1 | Brake state keyed by project + role (`laneKey`), not role alone, on every path: bus dispatch, `OPERATOR-REPLY` delivery, and both human resets | `agent-delivery.ts` `laneKey`; `dispatch-bus.ts` `resolveDispatch`; `DashboardView.tsx` reply delivery, `dispatchToRole`, `sendProjectTask` |
| B2 | Pressing Enter in a lane's terminal resets that lane's budget | `TerminalPane.tsx` `onData` → `onHumanSubmit`; `TerminalSurface.tsx`; `DashboardView.tsx` terminal render |
| B3 | A brake refusal of a bus dispatch shows a toast; for the send budget / hop chain it has a "Let it continue" action that resets the sender (a toast with an action stays until dismissed). Not for the user's own pause switch | `DashboardView.tsx` bus tick; verdict carries `brake` (`dispatch-bus.ts`) |
| B4 | Brake notes name lanes by their roster names and say how to continue ("type into its terminal or press Send → on a board task") | `agent-delivery.ts` `evaluateDelivery` (`fromLabel`/`toLabel`) |
| B5 | An MCP `reply` no longer creates a running board task | `DashboardView.tsx` bus tick (`r.kind !== 'reply'`) |
| B6 | "Running but not reachable on the session bus yet" no longer charges the sender's budget | `dispatch-bus.ts` |
| B8 | The MCP timeout text no longer tells lanes to fall back to the unbraked `OPERATOR-DISPATCH` sentinel | `mcp-serve.ts` |
| R1/R2 | Reports older than 12 h are expired instead of announced: marked delivered without being typed, still in the Comms log, one toast says how many | `chat-store.ts` `expireUndelivered`; `ipc.ts`/`operator-api.ts`/`env.d.ts`/`operator-bridge.ts` `artifactExpireUndelivered`; `comms.ts` `REPORT_ANNOUNCE_MAX_AGE_MS`, `announceCutoff`; `DashboardView.tsx` announce pass |
| T1 | Bus dispatches are no longer truncated at 2000 characters (the pty cap stays for pty delivery) | `dispatch-bus.ts` |

## Not in this branch

- **B7** (count on confirmed `SendMessage` delivery rather than on the verdict).
- **R3/R4** (an unconfirmed announcement stops the pass; one app-wide `announcingRef`) — inferred, not reproduced.
- **R5/R6** (report ↔ direct-message dedupe; `to_role` never written).
- **The 61-hour "Operator did not answer in time" outage** (mantel, 09-11..13) — cause undetermined; needs its own investigation.
- **T2** (report tool rejecting 4–10 KB input) and **T3** (terminal ids reused across projects).
- The `OPERATOR-DISPATCH` sentinel is still unbraked (only the advice pointing to it was removed).

## Checks

- Renderer: 84 files, 1307 passed, 0 failed (was 1297; +10). Root `tsc --noEmit`: clean.
  - `agent-delivery.test.ts`: `laneKey` keeps projects apart; a budget spent in p1 leaves p2's
    coordinator free; the reset is per project; notes use labels and name the way to continue.
  - `dispatch-bus.test.ts`: 24 sends braked p2's coordinator while p1's still sends; `brake` is set
    on brake refusals only; unreachable refusal charges nothing; a 5000-character task is sent whole.
  - `comms-expiry.test.ts`: 12 h cutoff; the 9-day-old #623 timestamp falls before it, a same-day one after.
- Electron: 32 files, 559 passed, 0 failed (+1: `expireUndelivered` expires only old rows of the
  given project, leaves them listed, and is idempotent). `npm run typecheck`: exit 0. `build-main.mjs`: ok.

## Unverified — needs the running app

1. Pressing Enter in a braked coordinator's terminal lets its next dispatch through.
2. A brake refusal shows the toast, and "Let it continue" lets the next dispatch through.
3. On the first idle of a coordinator with an old backlog, the toast appears and no old report is typed in.
4. Brake state is in memory, so installing this build (an app restart) clears today's refusals by itself.
