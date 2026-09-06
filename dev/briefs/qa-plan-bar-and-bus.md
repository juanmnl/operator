# Brief: verify `operator/plan-bar` (983e44f) and `operator/dispatch-bus` (0554ffa) (QA lane) — 2026-09-06

Explicit-path commits only; never copy a real transcript; synthetic fixtures only.
1. Suites + harnesses on each branch with exact counts.
2. plan-bar via the qa-real bridge: context cell for 12k/200k, 184k/200k (red), a `[1m]` model
   at 400k/1M, compacting phase text swap, ↺ count; plan cells with session/week/model-cap
   fixtures where each in turn is binding; absent/stale → `no reading`; click opens Tuning;
   rail foot has no ring and Tuning in the slot at both widths.
3. dispatch-bus: unit-level round trip of the request/verdict protocol against a real temp
   SQLite store: app answers `send` / `launching` / `refused`; timeout path; verdict never
   applied twice. Tailer mapping with a synthetic jsonl containing a SendMessage tool_use +
   tool_result success, failure, and an unrelated SendMessage. NOTE the end-to-end (a live lane
   calling mcp__operator__dispatch) needs a packaged build with two lanes; if you can run the
   electron dev shell headless with two fake lanes, do; otherwise state exactly what is unproven.
`dev/results/qa-plan-bar-and-bus.md`; call `mcp__operator__report`.
