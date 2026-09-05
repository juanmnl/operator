# Brief: settings prune (Code lane) — 2026-09-05

Source: `dev/results/simplify-audit.md` part 2. Most settings are real; this is a small cut.

1. Remove the per-project "Effort Level" field from
   `src/renderer/components/preferences/GeneralSection.tsx` (writes `settings.effortLevel`, which
   only governs CLI sessions started outside Operator; lanes get `--effort` at launch). Remove
   `SETTINGS_EFFORT_LEVELS`/`settingsEffort` from `lib/effort.ts` if nothing else uses them,
   and any test that only covers the removed field. Do NOT touch the roster's per-role effort
   picker or the launch flag path.
2. `compacting` phase: the audit found the UI supports it everywhere but `derive_phase()` in
   src-tauri/src/transcript.rs (and the Electron mirror electron/src/main/transcript.ts) can
   only return running/waiting, so it is never emitted. Make it real: emit `compacting` on a
   `type:"system", subtype:"compact_boundary"` record until the next assistant record. Keep the
   existing tests green; add one for the boundary. (This also serves the usage view brief:
   count boundaries per session.)
3. Nothing else in Settings is removed. If, while in there, a control is provably unwired, list
   it in the result rather than deleting it.

Done: tests + tsc + build green in both shells; `dev/results/settings-prune.md`; call
`mcp__operator__report`. Commit on your branch; do not merge. Take this after the port fix.
