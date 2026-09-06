# Brief: verify `operator/e78fc0` behaviour (QA lane) — 2026-09-05

Branch `operator/e78fc0` (7 commits; results in dev/results/*.md). Real-window GUI is the user's;
you verify everything that can be driven headless. Do not assume; run.

1. Run every harness that exists: `npm test`, `cd electron && npm test`, `cargo test`, and the
   Playwright harnesses (`verify:visual`, `verify:input`, whatever `package.json` lists). Report
   exact counts and any harness that no longer runs because chat.html was deleted.
2. Drive the session toolbar's new model/effort chips through the dev/qa-real bridge
   (`dev/qa-real.html`, `dev/drive-*.mjs` pattern): open each menu, pick a value, confirm the
   pty receives `/effort <level>\r` and `/model <id>\r` as a typed line (not a bracketed paste),
   and that the value survives a tab switch. Confirm the menus are not window-drag handles.
3. Drive the Dev servers panel in Worktrees preferences with a fixture `ps` table containing all
   four owner classes plus postgres-with-tags; confirm the confirm dialog wording, that nothing is
   killed on cancel, and that no select-all exists.
4. Spawn args: assert the built argv for an operator role and a code role (settings file content
   + `--remote-control` adjacency to the prompt).
5. Port allocation against real sockets: bind a throwaway server on the first free port in the
   window, launch two lanes in the same cwd and one in another; assert the ports handed out.

Write `dev/results/qa-simplify-batch.md` with pass/fail per item and the commands used; call
`mcp__operator__report`. No code changes except test fixtures/drivers under dev/.
