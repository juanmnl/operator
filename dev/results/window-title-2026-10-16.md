# Window title — 2026-10-16

- **Change:** `electron/index.html` `<title>` went from "Operator — Electron shell" to "Operator". Branch `operator/170940`, commit 2cc08b4, not merged.
- **Why:** macOS uses the page title as the window title, and Google Meet's window picker showed "Operator — Electron shell", which read as "Electron".
- **Checks:** no code or test reads the old string. The renderer never sets `document.title`, the main process never calls `setTitle` or handles `page-title-updated`, and `BrowserWindow` has no `title` option, so the HTML title is the only source. The `index.html` references in `navigation`, `preview-cdp` and `renderer-recovery` tests are URL fixtures, not titles. `electron/bench.html` ("Operator — terminal bench") is a dev bench page and was left alone.
- **Typecheck:** `npm run typecheck` passed.
- **Tests:** `npm test` gave 944 passed and 5 failed (2 files). A rerun of `worktree-cleanup-gaps.test.ts` alone gave 27 passed and 12 failed. Most failures were 30-second timeouts on git subprocesses while the machine's load average was about 311. Two failed sooner: "a clone that hits the time cap is reported as a timeout" and "a prompt AFTER the release cancels it", both of which depend on timing. None of those tests touches `index.html`. Rerun them on an idle machine to confirm.
- **Not verified:** the built app's window title, and the title in Meet's picker. Both need a build.
