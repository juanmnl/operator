# Brief — Electron S2/S3 acceptance: prove the rest of the port the way S1 was proven

**Verify + fix on your branch. Output: `dev/briefs/2026-08-21-electron-s2-s3-acceptance-RESULT.md`.**
**No GUI launches on this machine, no installs, no tags** — headless probes, unit/scenario tests,
and comparisons against files the Tauri build already wrote. If a check truly needs a window,
write the exact steps for the user instead.

S1 set the bar (`dev/briefs/2026-08-20-electron-s1-transcript-tailer-RESULT.md`): parity measured
against the Tauri build's own outputs on real data, divergences found and fixed. The port claims
85/91 seam methods native (`electron/PORT-LEDGER.md`); only S1 has been accepted that way. Do the
same for S2 and S3, module by module, against `src-tauri/src/*.rs` as the reference:

- **S2 — sessions/projects/folderprefs/agents/role defaults:** round-trip `~/.operator/{sessions,
  projects,role-defaults}.json` through the Node store and diff byte-for-byte against what the
  Rust side writes for the same in-memory state (use COPIES; never write the live files).
  `.claude/agents/*.md` frontmatter parse/serialize parity; `folder_prefs_*` on a temp project.
- **S3 — worktree:** `worktree_create/status/diff/commit/merge/discard/remove` + reap dry-run on a
  throwaway repo in `/tmp`; compare command sequences and outputs with `worktree.rs` (and the
  Orca-derived name sanitisation if adopted). **usage/plan limits:** same jsonl in, same numbers
  out as `usage.rs`/`planlimits.rs` (cache-read/cache-write split — the commit message says this
  was a trap). **mcp/artifacts:** `--mcp-serve` against a COPY of `artifacts.db`: `report`,
  `task_status`, `brief` produce the same rows as `mcp.rs`/`artifacts.rs`; two-writer discipline
  holds. **dispatch/reply tailing:** covered by S1's sentinel probe — cite it. **quit guard:**
  unit-test the decision (`quit.ts` vs `quit.rs` scenarios), no real quit. **tray/dock:** code
  review + a rasterisation test of `tray_anim` frames vs the Rust output if feasible. **preview
  inspector / drop guard:** unit-level (preload IPC path, `will-navigate` veto) + the user-steps
  list for the visual part. **updater:** the feed parsing only (inert by design).
- **Gridterm:** confirm the six mocked methods fail soft (no throw) when the renderer calls them.

Report shape: one table — module · what was compared · rows/cases · diffs found · fixed? — then
the divergences in detail, then the explicit list of what only the user can verify (with steps).
`npm test` in `electron/` and root green; tsc clean. Commit per fix, cherry-pickable.
