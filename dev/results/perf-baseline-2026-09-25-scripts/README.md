Scripts behind dev/results/perf-baseline-2026-09-25.md. They were run from a scratchpad, so paths are absolute
to that session and need editing: `lib.mjs` (BASE port, playwright resolved from the repo), `vite.mock.mjs`
(builds dev/mock.html to `OUT`, `MIN=0` for an unminified build), tbench*.mjs need
`esbuild electron/src/main/transcript.ts --bundle --platform=node --format=esm --outfile=transcript.bundle.mjs`.
Serve the build output with `python3 -m http.server 1429 --bind 127.0.0.1`.
