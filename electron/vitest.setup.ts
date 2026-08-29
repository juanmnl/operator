import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// EVERY TEST IN THIS SUITE GETS A THROWAWAY `~/.operator`.
//
// This exists because the updater tests wrote 71 entries — fake `sha512 mismatch` errors, a fake
// `ENOSPC`, and vite stack traces — straight into the user's REAL `~/.operator/updater.log`. The
// module reads `process.env.OPERATOR_DIR || ~/.operator` exactly as `store.ts` documents, and the
// test file simply never set it.
//
// Setting it per-file would have fixed that one file and left the next one to rediscover the
// problem. Everything under `src/main` that touches user data goes through `operatorDir()`, so one
// sandbox at the suite level closes the whole class: a test cannot reach the real store even by
// forgetting to think about it.
//
// A fresh directory per RUN, not per file: the files that want isolation from each other already
// make their own `mkdtemp` inside it (`store.test.ts`, `leases.test.ts`), and a shared root is
// what lets a test assert on a path another module wrote.
process.env.OPERATOR_DIR = mkdtempSync(join(tmpdir(), 'operator-test-home-'))
