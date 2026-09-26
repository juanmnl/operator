# Dev-instance port ranges — 2026-09-25

Branch **`operator/d91080-dev-ports`**, cut from `operator/d91080` at `58c402a`. `operator/d91080` itself is untouched, because Review is verifying it at 58c402a. Commit: 863dd11. Not merged, not verified in the running app.

## The problem

A dev instance of Operator keeps its own `dev-leases.json` under its own `OPERATOR_DIR`, so it cannot see the installed app's reservations. It allocated lane dev ports and CDP ports from the same windows as the installed app. A test lane in one got :1422, which a live mantel lane in the installed app had been given that week.

The allocators already bind-test every candidate (`port-alloc.ts` `scan` → `isFree`, and `allocateCdpPort` → `isPortFree`, which binds both loopbacks). So the collision was a **reservation whose server was not running at that moment**. That passes any bind test; only the lease file knows about it. That is why the fix is separate windows, with the bind test kept as the second guard.

## The windows (one place: `electron/src/main/port-ranges.ts`)

| | Lane dev servers (`OPERATOR_DEV_PORT`) | Electron CDP (`OPERATOR_CDP_PORT`) |
|---|---|---|
| Installed app (packaged, default `~/.operator`) | 1420–1520 (unchanged) | 9340–9440 (unchanged) |
| Dev instance (unpackaged, or a non-default `OPERATOR_DIR`) | **1620–1720** | **9540–9640** |
| `npm run dev`'s own Vite renderer (`OPERATOR_ELECTRON_PORT` default) | **1610** (was 1450) | — |

- **Chosen as:** the installed windows moved up by 200, at the same width, so a number says which kind of instance handed it out. No window overlaps another, and 1610 lies outside all four; a test checks both.
- **What counts as a dev instance** (`isDevInstance`): `!app.isPackaged`, or `resolve(OPERATOR_DIR) !== resolve(~/.operator)`. It is read at each allocation (`activePortRanges()` in `terminals.ts`), not at import.
- **Boot log line:** `[ports] dev instance: lane dev ports 1620-1720, CDP ports 9540-9640` (or `installed app: …`).

## Second guard: the bind test

This is unchanged, and it now applies inside whichever window is active. Before a port is handed out:
- **Dev ports:** the scan skips this process's own reservations and every lease, then binds `127.0.0.1` and `::1` exclusively (`isPortFree`).
- **CDP ports:** each candidate is bind-tested the same way.
- **When a window is exhausted:** it returns no port. It never spills into the other instance's window; a test covers this.

This needs no per-process inspection and no `lsof`.

## Hardcoded assumptions checked

| Where | Finding | Change |
|---|---|---|
| `port-alloc.ts` (`PORT_BASE`/`PORT_MAX`, scan, `windowPorts`) | Hardcoded 1420–1520 | Now takes `range` from its deps, defaulting to the installed window. The constants are re-exported from `port-ranges.ts` for existing tests. |
| `preview-cdp-port.ts` (`CDP_PORT_BASE`/`MAX`) | Hardcoded 9340–9440 | Constants come from `port-ranges.ts`; `terminals.ts` passes the active CDP window. |
| `port-probe.ts` `retryScanWithoutV6` | Gets its port list from the allocator | It now receives the active window, so no change there. |
| `electron/scripts/dev.mjs`, `electron/vite.config.ts` | Default 1450, **inside** the installed app's lane window. A hand-started dev renderer could take a port the installed app had reserved for a lane that was not serving yet. | Default 1610. The two files, `DEV_RENDERER_DEFAULT_PORT` and the README agree, and a test reads both files. |
| `electron/README.md` | Said 1450 | 1610, plus the dev-instance windows. |
| Launch note text (`buildCommand`, `cdpLaunchNote`) | States the allocated port, no range | Unchanged. |
| `reap.ts`, `index.ts`, `terminals.ts`, `port-probe.ts` comments mentioning 1420 | Historical examples | Unchanged. |
| Tests using `PORT_BASE`/`CDP_PORT_BASE` | Still the installed windows | Pass unchanged. |
| Root `vite.config.ts` (1420 default) and `scripts/visual` etc. (1421) | The Tauri-era renderer config and headless harnesses. They hand out no lane ports and are not the Electron app. | Not changed. |

## Tests

- **`port-ranges.test.ts`** (10 tests):
  - the installed app keeps its windows, including with a trailing slash on `OPERATOR_DIR`;
  - an unpackaged build, and a packaged build on another `OPERATOR_DIR`, are dev instances;
  - no two windows overlap;
  - 1610 is outside all of them, and `dev.mjs` and `vite.config.ts` both say 1610;
  - a dev instance allocates 1620, 1621, 1622, never 1422;
  - a bound port is skipped with no lease anywhere;
  - an exhausted dev window returns no port and does not spill;
  - CDP comes from 9540–9640, bind-tested.
- **`port-ranges-active.test.ts`** (3 tests, with `electron` mocked): `activePortRanges()` gives the dev windows when unpackaged and when `OPERATOR_DIR` is non-default, and the installed windows only for packaged plus the default dir.

## Verification

- `electron`: typecheck exit 0; vitest 44 files, **775 passed**.
- Root: `tsc --noEmit` exit 0; vitest 103 files, **1536 passed**.
- Not run: an actual dev instance next to the installed app. The next check is to launch one with an isolated `OPERATOR_DIR`, look for the `[ports] dev instance` log line, and confirm a lane there gets 16xx and 95xx ports.

## Left out

- **The boot reapers of a dev instance** (`reapOrphanedDevServers`, the live-app sweep) that share the machine with the installed app. These are gated on leases and `OPERATOR_APP_PID`, not on port windows. Not in this brief.
- **Lanes already running** keep the ports they were given.

## Follow-up: Review B1, `npm run dev` now uses the lane's leased port

`scripts/dev.mjs` and `vite.config.ts` resolve the renderer port through one function, `rendererPort()` in `electron/scripts/renderer-port.mjs`:
1. `OPERATOR_ELECTRON_PORT`;
2. then `OPERATOR_DEV_PORT`, the port Operator leased to the lane running the build;
3. then 1610.

A value that is not a port number (empty, non-numeric, 0, above 65535, fractional) is skipped. `strictPort` is kept, so a taken port still fails loudly.

Before this, two lanes each starting a dev build both reached for 1610 and the second failed.

**Tests:**
- in `port-ranges.test.ts`: the order of precedence, and that invalid values are skipped;
- a check that both files call `rendererPort(process.env)` and have no second, inline resolution.

**Also checked:**
- `node --check scripts/dev.mjs` passes;
- `vite build --config vite.config.ts` into a scratch directory succeeds, so Vite's config loader accepts the import.
