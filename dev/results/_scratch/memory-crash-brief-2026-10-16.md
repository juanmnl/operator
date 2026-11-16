# Brief: Operator memory footprint after the 2026-10-16 crash

## What happened (established by the coordinator)
- 12:00 local: macOS jetsam event, `/Library/Logs/DiagnosticReports/JetsamEvent-2026-10-16-120029.ips`.
  About 60 GB resident on a 24 GB Mac. Largest: Chrome about 25 GB, Umbra about 5.7 GB (with UmbraDecoder).
- 12:19 shutdown stall (`shutdown_stall_2026-10-16-121920_studio.shutdownStall`), Mac booted 12:23,
  Operator relaunched 12:26 (`~/.operator/last-run.json` has `clean: false`). No Operator .ips crash report.
- Operator's coalition (127360) at 12:00, about 7.4 GB in total:
  - 19 Claude CLI processes ("2.1.301"), 220–333 MB each, about 4.9 GB
  - renderer 942 MB (lifetime max 1.4 GB)
  - one "Operator Helper" at 398 MB with a lifetime max of 2.8 GB (pid 8752, started with the app; probably GPU or a utility process)
  - main "Operator" 247 MB
  - per lane: one extra "Operator" process (about 29 MB) and two "Operator Helper" processes (11 MB and 7 MB), started at the same time as each CLI. That is about 19 × 47 MB, roughly 0.9 GB.

## Questions
1. What are the per-lane "Operator" (about 29 MB) and "Operator Helper" processes? Name the code that spawns them
   (MCP server via ELECTRON_RUN_AS_NODE? hook helper? pty host?). Can they be shared across lanes or replaced by something lighter?
2. What is the 2.8 GB-peak helper (pid 8752)? GPU process, utility process, Preview webview? What drives that peak?
3. Renderer at 942 MB: what holds it (terminal scrollback buffers per lane, transcripts, hidden panes)?
   Are there caps, and are they enforced for lanes that are not visible?
4. Lanes: how many of the 19 were idle? Does Operator do anything to bound lane count or memory
   (end idle lanes, `--resume` on demand)? What would idle-lane suspension cost, given that sessions resume from transcripts?
5. Does Operator observe memory pressure at all (`app.getAppMetrics()`, `process.getSystemMemoryInfo()`, macOS memory-pressure
   notifications)? Could it warn the user or act before macOS starts killing processes?

## Deliverable
Write `/Users/juanmnl/Developer/operator/dev/results/memory-footprint-research-2026-10-16.md`. Include file:line evidence,
measured numbers, and a ranked list of fixes with the expected MB saved for each. Do not change code.
You may read the jetsam .ips with `python3 -I`. The JSON body starts on line 2, and pageSize is 16384.
