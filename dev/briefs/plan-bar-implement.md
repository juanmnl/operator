# Brief: implement the session bottom bar reading (Code lane) — 2026-09-06

Design is settled: `dev/results/plan-meter-bottom-bar.md` + mock `dev/plan-bar-preview.html`.
Branch from main (b521fc6, the simplify batch is merged). New branch; explicit-path commits.

Build exactly the design: three cells at the right of `SessionInfoBar.tsx`:
1. `ctx <used> / <window> ↺<compactions>` for the ACTIVE session. Used = the latest main-thread
   assistant record's input + cache_read + cache_write (add it to the tailer's session payload
   in both tailers, lockstep — do not reuse the cumulative `usage`); window = 200k, 1M for
   `[1m]` model ids; compactions from the capture already on main. TONE_FILL past 75/90.
   "Compacting…" is a text swap while phase is compacting.
2. `<Model> · <Effort>` — the live effort captured from the transcript when present, else the
   launch pin; same source as the toolbar chips.
3. `Session 17%  Week 42%  Fable 66%` — every limit named, the binding one marked as designed
   (name to --fg, bar in TONE_FILL, 1px rule), others muted; reset clause verbatim on hover;
   `no reading` chip when absent or stale, never 0%. Data from `usePlanLimits` / `lib/plan-limits.ts`.
4. Click on the reading opens the Tuning page. Remove the rail-foot ring + popover (`PlanMeter.tsx`)
   only if the design says so; otherwise reduce it to what the design keeps.
Style rules as always. Tests: context computation from a synthetic jsonl, binding-limit marking,
no-reading state. `dev/results/plan-bar-implement.md`; `mcp__operator__report`. Do not merge.
