# Brief: review `operator/e78fc0` (Review lane) — 2026-09-05

Branch `operator/e78fc0`, 7 commits ahead of main (`ae8e44c`..`03c41a8`), 82 files, +2978/−5819.
Results in dev/results/: remove-chat-files, port-allocation-fix, settings-prune, orphan-reaper-fix,
remote-control-operator-only. Review adversarially; find defects, do not fix.

Focus, in order of damage if wrong:
1. **Kill paths** (orphan-reaper-fix): `dev-servers.ts` classification, `abandonedLaneRows`, the
   10-minute `sweepAbandoned`, and the removal of the `devPort` mismatch refusal in `refuseStray`.
   Can any of these kill a process that is not ours (another Operator instance, a lane opened
   during the sweep interval, a stranger that inherited tags, postgres)? Is `live-lane` ever
   killable without the confirm?
2. **Port allocation** (port-alloc.ts, port-probe.ts, `shouldReleaseCwdPort`, the promise-chain
   serialization): races between two launches, a failed bind leaving state, the fail-closed
   ownership check making every shared port re-allocate.
3. **Session toolbar model/effort chips** (unbriefed part 2 of remove-chat-files): `/model` and
   `/effort` sent as bare line + CR straight to the pty, bypassing `submitQueue`. What happens
   mid-turn? While a permission prompt is up? With `normalizeModelId` on odd input?
4. **Remote Control**: `--remote-control <name>` placement before the prompt; `remoteControlAtStartup:false`
   written for every non-operator role — including resumed sessions and lanes with a custom
   role? Does an existing session that was already registered get de-registered on relaunch?
5. **compacting phase**: the pty-active override change in both tailers — can a session get
   stuck in `compacting` (boundary with no following main-thread assistant record)?
6. Removal completeness: anything Chat/Files left reachable (palette, keybinding, IPC channel
   still registered in operator-api SPEC or preload allowlist)?

Write `dev/results/review-simplify-batch.md`: findings ranked by severity with file:line and a
concrete failure scenario each; end with a merge verdict. Call `mcp__operator__report`.
