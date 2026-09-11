# Block the Badging API for previewed content

## Problem (verified 2026-09-11)
Operator's Dock icon showed a red "3". Operator never sets a badge: no `setBadgeCount`,
`dock.setBadge` or `setAppBadge` in `src/`, `electron/src/`, or the installed 0.21.0 bundle,
and Notification Center holds no badge for `com.operator.app.tauri`. The Electron framework ships
Chromium's Badging API (`NavigatorBadge`), so ANY web page rendered inside the Operator process can
badge Operator's Dock tile. The caller was the mantel project, shown in the Preview pane:
`~/Developer/mantel/apps/web/src/App.tsx:295` calls `navigator.setAppBadge(reservasCount)`.
el-encanto does the same. A previewed project must not be able to badge the host app.

## Where preview content runs
- `src/renderer/components/session/AppPreviewPanel.tsx:690` — an `<iframe src={display}>` inside the main renderer.
- Inspect mode embeds a native child `<webview>` over the frame; `electron/src/main/index.ts:75` handles `will-attach-webview`.

## Task
Make the Badging API a no-op for previewed content in BOTH hosts, without touching Operator's own
renderer capabilities. Pick the mechanism after checking what Electron 3x actually does; candidates:
1. A preload that runs in subframes (`nodeIntegrationInSubFrames` + `webFrame.executeJavaScript` in the
   frame's main world) that removes `Navigator.prototype.setAppBadge`/`clearAppBadge` for non-Operator
   origins. Isolated-world deletion does NOT reach the page — verify in the main world.
2. If Chromium refuses badging from cross-origin iframes anyway, prove it (it evidently did not here)
   before relying on it.
3. As a backstop, if Electron exposes no hook for the Chromium badge service, reset the badge
   (`app.setBadgeCount(0)`) when it changes — only if 1 is impossible; say so in the result.
Also clear the stale "3" on startup so the currently shown badge disappears after update.

## Constraints
- Do not change Operator's iframe sandboxing in a way that breaks preview annotations/inspect.
- Add a test where the mechanism is testable (renderer suite `npm test`, electron suite in `electron/`).
- Run: `npm test`, `cd electron && npm test`, `npm run build` (tsc), all green.
- Then commit on your branch, merge into `main`, and PUSH `main` (user authorised the push:
  "we are still long away from service hours so push when done"). Do NOT tag or release.
- Commit trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Output
Write `dev/results/preview-badge-block-RESULT.md`: mechanism chosen and why, files changed, test
output tail, the merge commit hash on main, and anything not done. Then `mcp__operator__report`.
