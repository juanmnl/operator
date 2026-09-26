# pty batching measurement

Headless: bundles the real `TerminalManager` (electron aliased to `electron-stub.cjs`) and runs it
under plain Node with real node-pty (N-API, loads outside Electron) and 4 real login shells.

    cd electron
    npx esbuild ../dev/results/pty-batching-2026-09-25-scripts/measure.ts --bundle --platform=node \
      --format=cjs --external:node-pty --external:better-sqlite3 \
      --alias:electron=$PWD/../dev/results/pty-batching-2026-09-25-scripts/electron-stub.cjs --outfile=/tmp/measure.cjs
    BENCH=$PWD/../dev/results/pty-batching-2026-09-25-scripts FIXTURE=<main checkout>/scripts/width-audit/claude-stream.bin \
      MODE=paced NODE_PATH=$PWD/node_modules node /tmp/measure.cjs

For "before", build against `git show 9b2bbae:electron/src/main/terminals.ts`.
