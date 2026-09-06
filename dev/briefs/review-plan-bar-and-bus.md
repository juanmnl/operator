# Brief: review `operator/plan-bar` (983e44f) and `operator/dispatch-bus` (0554ffa) (Review lane) — 2026-09-06

Both branch from main df7bc46, independent. Accounts: dev/results/plan-bar-implement.md,
dev/results/dispatch-over-bus.md. Adversarial; do not fix; one verdict per branch.

plan-bar: the new per-record context field in BOTH tailers (lockstep; latest main-thread
assistant record only; sidechain excluded; 1M window detection); binding-limit marking and the
no-reading state (never 0%); SessionInfoBar.tsx deletion (confirm it was dead); the rail-foot
change (ring removed, Tuning takes the slot — check lib/rail-foot's invariants and the fold);
click target; style rules (no stacked opacity on --fg-muted, no solid fills).

dispatch-bus: this is the one to spend time on.
- mcp-serve.ts `dispatch`/`reply` tools + the request/verdict row protocol through the artifact
  store (sync poll, 15s timeout): can a verdict be applied twice, lost, or attached to the wrong
  request? What happens if the app is not running or the store is locked (SQLite busy)?
- Route-before-brakes ordering: can `launching` be used to bypass the hop budget (launch, then
  message)? Can a lane dispatch to a lane in ANOTHER project through any path?
- session-bus.ts: matching descriptors by sessionId and reading messagingSocketPath — stale
  descriptors after a crash, two descriptors with the same sessionId (resume), permissions.
- The tailer's tool_result → task outcome mapping: unrecognised = failed; a SendMessage the lane
  makes for its OWN reasons must not be attributed to a dispatch.
- The system-prompt two-step text: does a model reading it do the right thing on `send`,
  `launching`, `refused`? Is the sentinel path really unchanged?
`dev/results/review-plan-bar-and-bus.md`; call `mcp__operator__report`.
