// The entry a lane's MCP server runs from: `out/main/mcp-serve.cjs`, started by Electron's own
// binary with `ELECTRON_RUN_AS_NODE=1` (see `mcpConfigArg`).
//
// WHY A SEPARATE ENTRY. `index.ts` loads the `electron` module before it can look at argv, and a
// full Electron process starts a GPU helper and a network helper even when it never opens a
// window: about 46 MB and 3 processes per lane. Run as node, the same binary is one process of
// about 15 MB (dev/results/memory-footprint-research-2026-10-16.md). Node mode has no `electron`
// module to import, so nothing reachable from here may import it; `build-main.mjs` fails the
// build if anything does.
//
// `--mcp-serve` in `index.ts` still works, for lanes started by an older build whose config
// still names that flag.
import { serve } from './mcp-serve'

serve()
